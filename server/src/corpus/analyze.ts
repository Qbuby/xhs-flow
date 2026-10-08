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

const ANALYZE_SYSTEM = `你是一位小红书内容策略分析师，正在为一个"仿写指定博主风格"的系统做语料标注。

你的任务：把一篇真实的小红书图文笔记，拆解成可复用的创作方法论。

铁律：
1. 只描述**你在这篇里真实看到的东西**。看不到的字段就说"这篇没有体现"，绝不脑补。
2. 给出的公式必须是可套用的模板，不是形容词堆砌。
3. 语气、话术要具体到可以直接复用的措辞。
4. 客观指标（字数、emoji 数、主色板、亮度）由程序统计，以它为准。

【最重要的要求】
严格按照下面这份 JSON 结构输出，**字段名必须完全一致**，不要自创、不要改名、不要增删顶层字段。
每个字段的值用你自己的话写；拿不准的写"这篇未体现"。

\`\`\`json
${JSON.stringify(asTemplate(NoteStyleSchema), null, 2)}
\`\`\`

只输出 JSON 对象本身，不要解释文字，不要代码块围栏。`;

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
    maxTokens: 8_192,
  });

  const parsed = NoteStyleSchema.safeParse(style);
  const final: NoteStyle = parsed.success
    ? parsed.data
    : (logger.warn({ notePk, issues: parsed.error.issues.slice(0, 5) }, '蒸馏结果字段不完整，原样保存'),
      style);

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

  let done = 0;
  let failed = 0;
  const reasons: string[] = [];

  for (const row of pending) {
    try {
      await analyzeNote(row.id);
      done++;
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      if (reasons.length < 3) reasons.push(msg.slice(0, 240));
      // 第一次失败就把原因记进事件流，别等到全部跑完才让人发现
      if (failed === 1) {
        logEvent('error', `蒸馏第一篇就失败了：${msg.slice(0, 200)}`, { severity: 'error' });
      }
      logger.error({ notePk: row.id, err }, '单篇蒸馏失败');
      // 模型不通就别把剩下的笔记全试一遍了 —— 同一把钥匙开所有锁，
      // 连挂 3 篇基本可以断定是配置问题而不是单篇内容的问题
      if (failed >= 3 && done === 0) {
        reasons.push(`（连续 3 篇失败且零成功，提前中止：${pending.length - 3} 篇未处理）`);
        break;
      }
    }
  }

  // 一篇都没成功就必须把原因抛出去 —— 否则任务会被记成 done，
  // 界面上「已蒸馏 0」却什么都不显示，看起来像点了没反应
  if (done === 0 && failed > 0) {
    throw new Error(
      `${failed} 篇全部蒸馏失败，没有一篇成功。原因：${reasons.join(' | ') || '未知'}`,
    );
  }

  logger.info({ sourceId, done, failed }, '语料蒸馏完成');
  return { done, failed, reasons };
}