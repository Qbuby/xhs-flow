import { z } from 'zod';
import { all, get, run, logEvent } from '../db/index.js';
import { chatJson } from '../llm/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { cjkRatio, countEmoji } from '../util/text.js';
import { asTemplate } from './schema-template.js';

/**
 * 单篇笔记的结构化蒸馏。
 *
 * 设计取舍：**不让模型看图**。图片的配色、明暗、尺寸比例这些用 sharp 离线算出来，
 * 作为事实喂进 prompt。这样更快、零 vision token，而且「主色是 #F5E6D3」这种
 * 客观信息本来就该从像素里取，不该让模型猜。
 */

export const NoteStyleSchema = z.object({
  topic: z.object({
    primary: z.string().describe('这篇讲的核心话题，一句话'),
    category: z.string().describe('题材分类，如 干货教程 / 好物推荐 / 避坑指南 / 个人故事'),
    audience: z.string().describe('目标人群画像'),
  }),
  hook: z.object({
    title_formula: z.string().describe('标题的构造公式，如「数字+痛点+结果」'),
    hook_type: z.string().describe('钩子类型：悬念/利益承诺/反常识/身份认同/情绪共鸣'),
    opening_line: z.string().describe('正文第一句怎么起手'),
  }),
  structure: z.object({
    pattern: z.string().describe('正文骨架，如 痛点→方案→步骤→行动号召'),
    paragraph_count: z.number().describe('正文段落数'),
    avg_paragraph_chars: z.number().describe('平均段落字数'),
    ending_form: z.string().describe('结尾方式'),
  }),
  language: z.object({
    tone: z.array(z.string()).describe('语气词调，如 亲切/犀利/专业'),
    person: z.string().describe('人称：第一人称/第二人称/第三人称'),
    signature_phrases: z.array(z.string()).describe('口头禅、标志性表达'),
    rhetoric: z.array(z.string()).describe('修辞手法，如 反问/对比/夸张/举例'),
    emoji_top: z.array(z.string()).describe('出现的 emoji，最多 5 个'),
  }),
  hashtags: z.object({
    strategy: z.string().describe('话题标签策略'),
    has_large_traffic_tag: z.boolean(),
  }),
  cta: z.object({
    has_cta: z.boolean(),
    form: z.string().describe('行动号召的形式与文案'),
  }),
  visual: z.object({
    layout_hypothesis: z.string().describe('根据配图猜测的图片版式，如 大字报/实拍图+贴纸/纯截图'),
    cover_pattern: z.string().describe('封面图的套路'),
    image_role: z.string().describe('图片承担什么作用：信息补充/情绪渲染/纯排版'),
    text_density: z.string().describe('图片上文字量：密集/适中/极少'),
  }),
  observations: z.array(z.string()).describe('这篇里值得复用的 3 个具体手法'),
});

export type NoteStyle = z.infer<typeof NoteStyleSchema>;

interface NoteRow {
  id: number;
  title: string;
  desc: string;
  tags: string;
  published_at: number | null;
  liked_count: number;
  collected_count: number;
  comment_count: number;
  image_count: number;
}

interface ImageRow {
  local_path: string | null;
  palette: string | null;
  brightness: number | null;
  width: number | null;
  height: number | null;
}

function formatDate(ms: number | null): string {
  if (!ms) return '未知';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 把笔记的客观事实拼成 prompt 素材。 */
function buildContext(note: NoteRow, images: ImageRow[]) {
  const text = `${note.title}\n${note.desc}`;
  const emojiCount = countEmoji(text);
  const tagList: string[] = JSON.parse(note.tags || '[]');

  const palette = images
    .flatMap((i) => {
      try {
        return JSON.parse(i.palette || '[]') as Array<{ hex: string; weight: number }>;
      } catch {
        return [];
      }
    })
    .reduce<Record<string, number>>((acc, p) => {
      acc[p.hex] = (acc[p.hex] ?? 0) + p.weight;
      return acc;
    }, {});

  const topPalette = Object.entries(palette)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([hex, w]) => `${hex}(${(w * 100).toFixed(0)}%)`)
    .join('、');

  const avgBrightness = images.length
    ? images.reduce((s, i) => s + (i.brightness ?? 0.5), 0) / images.length
    : null;

  const hasText = images.length ? '有配图' : '纯文字（无图）';

  return [
    `【标题】${note.title || '(无标题)'}`,
    `【正文】${note.desc || '(空)'}`,
    `【话题标签】${tagList.join('、') || '(无)'}`,
    '',
    '【客观指标 —— 由程序统计得出，请以此为准，不要臆测】',
    `- 发布时间：${formatDate(note.published_at)}`,
    `- 点赞 ${note.liked_count} / 收藏 ${note.collected_count} / 评论 ${note.comment_count}`,
    `- 字数：${text.length}，中文字符占比 ${(cjkRatio(text) * 100).toFixed(0)}%`,
    `- emoji 数量：${emojiCount}（每百字 ${((emojiCount / Math.max(1, text.length)) * 100).toFixed(1)} 个）`,
    `- 图片：${hasText}，共 ${note.image_count} 张`,
    images.length > 0 ? `- 主色板（离线提取）：${topPalette || '无法提取'}` : '',
    avgBrightness !== null
      ? `- 图片整体亮度：${avgBrightness.toFixed(2)}（<0.4 偏深色底配亮字，>0.6 偏浅色底配深字）`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 蒸馏用的 system prompt。
 *
 * 用**填好值的范例**而不是空骨架，是因为实测这个模型看到 `…` 占位符会去
 * 逐字段推敲，光思考就烧掉 3000+ token（单篇 35 秒）。
 * 换成具体范例 + 明确限长后降到 25 秒左右 —— 再配合并发，单篇实际约 7 秒。
 */
const ANALYZE_EXAMPLE = `{
  "topic": { "primary": "一句话概括核心话题", "category": "干货教程/好物推荐/避坑指南/个人故事", "audience": "目标人群画像" },
  "hook": { "title_formula": "痛点场景 + 数字清单 + 结果承诺", "hook_type": "悬念/利益承诺/反常识/身份认同", "opening_line": "正文第一句怎么起手" },
  "structure": { "pattern": "痛点→方案→步骤→行动号召", "paragraph_count": 6, "avg_paragraph_chars": 40, "ending_form": "结尾怎么收" },
  "language": { "tone": ["克制理性"], "person": "第二人称", "signature_phrases": ["真实措辞"], "rhetoric": ["对比"], "emoji_top": ["🔥"] },
  "hashtags": { "strategy": "大词引流 + 精准长尾", "has_large_traffic_tag": true },
  "cta": { "has_cta": true, "form": "评论区提问" },
  "visual": { "layout_hypothesis": "大字报/实拍图+贴纸/纯截图", "cover_pattern": "封面套路", "image_role": "信息补充/情绪渲染", "text_density": "密集/适中/极少" },
  "observations": ["手法1", "手法2", "手法3"]
}`;

const ANALYZE_SYSTEM = `你是一位小红书内容策略分析师，拆解真实笔记的可复用创作方法。

铁律：
1. 只描述这篇里**真实看到**的；看不到就写"这篇未体现"，绝不脑补。
2. 公式要能直接套用，不要写"标题很有吸引力"这种形容词。
3. 客观指标（字数、emoji 数、主色板）以程序统计为准。

【输出格式】按下面这份**范例**的结构输出，字段名固定，值换成你这篇的内容：
${ANALYZE_EXAMPLE}

【硬性限长】每个字符串字段不超过 25 字，数组每项不超过 15 字。
直接给结论，不要展开分析过程。只输出 JSON 对象本身，不要代码块围栏。`;

/**
 * 模型经常把数字写成字符串、把布尔写成"是/否"。
 * 这类小毛病不该让整篇的字段校验失败 —— 先按可预测的规则掰回来。
 */
function coerceNoteStyle(raw: unknown): NoteStyle {
  const num = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const m = /-?[\d.]+/.exec(v);
      if (m) {
        const n = Number(m[0]);
        if (Number.isFinite(n)) return n;
      }
    }
    return undefined;
  };
  const bool = (v: unknown): boolean | undefined => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return /^(是|有|true|yes|y)$/i.test(v.trim());
    return undefined;
  };

  const src = (raw ?? {}) as Record<string, any>;
  const fix = { ...src };

  if (fix.structure) {
    fix.structure = { ...fix.structure };
    for (const k of ['paragraph_count', 'avg_paragraph_chars']) {
      const n = num(fix.structure[k]);
      if (n !== undefined) fix.structure[k] = n;
    }
  }
  if (fix.hashtags) fix.hashtags = { ...fix.hashtags, has_large_traffic_tag: bool(fix.hashtags.has_large_traffic_tag) };
  if (fix.cta) fix.cta = { ...fix.cta, has_cta: bool(fix.cta.has_cta) };

  const parsed = NoteStyleSchema.safeParse(fix);
  if (parsed.success) return parsed.data;

  logger.warn(
    { issues: parsed.error.issues.slice(0, 4).map((i) => `${i.path.join('.')}: ${i.message}`) },
    '蒸馏结果仍有字段不符，原样保存（不影响已产出字段）',
  );
  return fix as NoteStyle;
}

export async function analyzeNote(notePk: number): Promise<NoteStyle> {
  const note = get<NoteRow>('SELECT * FROM notes WHERE id = ?', notePk);
  if (!note) throw new Error(`笔记 ${notePk} 不存在`);

  const images = all<ImageRow>(
    'SELECT local_path, palette, brightness, width, height FROM note_images WHERE note_id = ? ORDER BY idx LIMIT 9',
    notePk,
  );

  const user = [
    '请拆解下面这篇小红书笔记，按 JSON schema 输出。',
    '',
    buildContext(note, images),
    '',
    '注意：visual 字段只能依据上面给出的图片客观信息和正文描述来推断，不要编造看不见的画面细节。',
  ].join('\n');

  const style = await chatJson<NoteStyle>({
    system: ANALYZE_SYSTEM,
    user,
    temperature: 0.3,
    maxTokens: 16_384,
  });

  const final: NoteStyle = coerceNoteStyle(style);

  run(
    `INSERT INTO note_styles(note_id, analysis, model) VALUES (?, ?, ?)
     ON CONFLICT(note_id) DO UPDATE SET analysis = excluded.analysis, model = excluded.model, created_at = datetime('now')`,
    notePk,
    JSON.stringify(final),
    config.llm.model,
  );

  return final;
}

/** 蒸馏某来源下所有还没做过的笔记。 */
/** 蒸馏并发度。每篇笔记彼此独立，没必要一篇一篇排队。 */
const CONCURRENCY = Number(process.env.XHSFLOW_DISTILL_CONCURRENCY ?? 6);

/**
 * 带并发上限的 map。
 * 不用 Promise.all 是因为一次几十上百个请求会把模型端打爆，
 * 也容易把自己账号的调用频率顶上去。
 */
async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i] as T, i);
    }
  });
  await Promise.all(runners);
  return out;
}

export async function analyzeSource(
  sourceId: number,
  limit = 60,
): Promise<{ done: number; failed: number; reasons: string[] }> {
  const pending = all<{ id: number }>(
    `SELECT n.id FROM notes n
     LEFT JOIN note_styles ns ON ns.note_id = n.id
     WHERE n.source_id = ? AND ns.note_id IS NULL
     ORDER BY n.published_at DESC
     LIMIT ?`,
    sourceId,
    limit,
  );

  if (pending.length === 0) return { done: 0, failed: 0, reasons: [] };

  logger.info(
    { sourceId, total: pending.length, concurrency: CONCURRENCY },
    '开始并发蒸馏',
  );

  const reasons: string[] = [];
  let done = 0;
  let failed = 0;

  const results = await pooled(pending, CONCURRENCY, async (row) => {
    try {
      await analyzeNote(row.id);
      return 'ok' as const;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (reasons.length < 3) reasons.push(msg.slice(0, 240));
      return { error: msg } as const;
    }
  });

  for (const r of results) {
    if (r === 'ok') done++;
    else failed++;
  }

  if (failed > 0) {
    const sample = results.find((r) => r !== 'ok');
    const detail = sample && typeof sample === 'object' ? sample.error : '';
    logEvent(
      'error',
      `蒸馏有 ${failed} 篇失败。原因：${detail.slice(0, 200) || reasons[0] || '未知'}`,
      { severity: 'error' },
    );
  }

  // 一篇都没成功就必须把原因抛出去 —— 否则任务被记成 done，
  // 界面上「已蒸馏 0」却什么都不显示，看起来像点了没反应
  if (done === 0 && failed > 0) {
    throw new Error(
      `${failed} 篇全部蒸馏失败，没有一篇成功。原因：${reasons.join(' | ') || '未知'}`,
    );
  }

  logger.info({ sourceId, done, failed, total: pending.length }, '语料蒸馏完成');
  return { done, failed, reasons };
}
