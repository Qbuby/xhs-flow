import { z } from 'zod';
import { all, get, run } from '../db/index.js';
import { chatJson } from '../llm/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { cjkRatio, countEmoji } from '../util/text.js';
import { asTemplate } from './schema-template.js';
import {
  ACCENT_STYLE_IDS as ACCENT_STYLES,
  DENSITY_IDS as DENSITIES,
  DesignContractSchema,
  MOTIF_IDS as MOTIFS,
  PALETTES,
  TEXTURE_IDS as TEXTURES,
  THEMES,
  TYPE_SCALE_IDS as TYPE_SCALES,
  normalizeContract,
  resolveSpec,
} from '../generate/design/index.js';

/**
 * 作者级聚合画像。
 *
 * 这是"图片设计风格"真正落地的关键：聚合结果里的 `card_template_spec`
 * 必须是渲染器能直接消费的规格（具体色值、字号、圆角、阴影），
 * 而不是一句"清新文艺风"——那种东西没法执行。
 */

export const CardTemplateSpecSchema = z.object({
  background: z.string().describe('背景色 #hex，或渐变写法'),
  text_primary: z.string().describe('主文字色 #hex'),
  text_secondary: z.string().describe('次级文字/说明色 #hex'),
  accent: z.string().describe('强调色（高亮词、角标）#hex'),
  palette: z.array(z.string()).describe('整体配色板，2-5 个 #hex'),
  title_size: z.number().describe('大标题字号 px，卡片 1080 宽下的值'),
  body_size: z.number().describe('正文字号 px'),
  line_height: z.number().describe('行高倍数'),
  font_family: z.string().describe('中文字体栈，如 "Microsoft YaHei"'),
  font_weight_bold: z.number().describe('粗体字重'),
  radius: z.number().describe('卡片圆角 px'),
  accent_style: z
    .enum(['underline', 'block', 'highlight', 'bracket', 'none'])
    .describe('强调词的视觉处理方式'),
  decoration: z
    .enum(['none', 'emoji', 'dots', 'corner_mark'])
    .describe('装饰元素'),
  background_image: z
    .enum(['none', 'photo', 'gradient', 'texture'])
    .describe('背景是纯色/照片/渐变/纹理'),
  text_ratio: z.number().describe('文字占画面比例 0-1'),
});

export const StyleProfileSchema = z.object({
  persona: z.object({
    one_liner: z.string().describe('一句话概括这个博主的调性'),
    tone: z.array(z.string()),
    audience: z.string(),
    content_categories: z.array(z.string()).describe('常做的题材分布'),
  }),
  language: z.object({
    title_formulas: z.array(z.string()).describe('归纳出的标题公式，最多 5 条'),
    avg_title_chars: z.number(),
    emoji_per_100_chars: z.number(),
    signature_phrases: z.array(z.string()),
    opening_patterns: z.array(z.string()),
    ending_patterns: z.array(z.string()),
    rhetoric: z.array(z.string()),
    body_chars_range: z.string().describe('如 "400-800 字"'),
  }),
  hashtag_strategy: z.object({
    count_range: z.string(),
    mix: z.string().describe('大流量词与长尾词的比例'),
    examples: z.array(z.string()),
  }),
  visual: z.object({
    dominant_layouts: z.array(z.string()).describe('最常用的图片版式'),
    cover_patterns: z.array(z.string()),
    palette_summary: z.string(),
    brightness_profile: z.string(),
    emoji_as_decoration: z.boolean(),
  }),
  // 新契约 OR 旧 18 字段，两者都能解析。
  //
  // 为什么要 union：库里已经存的画像是旧形状，若这里只收新契约，
  // `safeParse` 会失败，整份画像退化成"补空"，反而更糟。声明成联合之后
  // 读旧数据不报错，而**提示词里给模型的模板只有新契约那一支**
  // （见 schema-template.ts 对 ZodUnion 的处理），模型从此只产出新契约。
  card_template_spec: z.union([DesignContractSchema, CardTemplateSpecSchema]),
  do_list: z.array(z.string()).describe('模仿时必须做的具体动作'),
  dont_list: z.array(z.string()).describe('必须避免的'),
  topic_map: z.array(
    z.object({
      topic: z.string(),
      note_count: z.number(),
      avg_liked: z.number(),
    }),
  ).describe('选题地图，用于后续找选题'),
});

export type StyleProfile = z.infer<typeof StyleProfileSchema>;
export type CardTemplateSpec = z.infer<typeof CardTemplateSpecSchema>;

interface SampleNote {
  id: number;
  title: string;
  desc: string;
  tags: string;
  liked_count: number;
  published_at: number | null;
  analysis: string;
}

/**
 * 聚合提示词。
 *
 * 【为什么这一段必须有】
 * 旧的 PROFILE_SYSTEM 教模型"填具体 #hex 和 px"。新的契约改成"在合同内选择"
 * 之后，模型必须知道**合同里有哪些选项**，否则只会瞎猜（实测会返回
 * `theme: "warm-paper"` 这类不存在的值，然后被 coerceContract 静默回落到默认，
 * 导致所有作者的画像最后都长一样）。
 *
 * 所以下面把三套主题的**真实选项**从代码里读出来注入提示词 ——
 * 提示词与实现共用一份数据源，改色板不用改两处。
 */
function buildProfileSystem(): string {
  const themeLines = THEMES.map((t) => {
    const r = resolveSpec({ theme: t });
    const palettes = PALETTES[t] ?? [];
    const names = palettes.map((p, i) => `${i}=${p.name}(${p.bg}/${p.accent})`).join(' ');
    return [
      `    · ${t}  —— ${THEME_BLURB[t]}`,
      `      色板：${names}`,
      `      可用纹理：${r.allowedTextures.join(' / ')}`,
      `      可用装饰：${r.allowedMotifs.join(' / ')}`,
    ].join('\n');
  }).join('\n');

  return `你是一位视觉设计总监 + 小红书内容策略师，正在为一个自动创作系统提炼某个博主的可复刻风格档案。

最关键的一条：**card_template_spec 必须是渲染器能直接执行的规格**，不是设计形容词。
你不再自由填颜色和字号，而是**在一套固定合同里做选择** ——
给无限的颜色与字号选择只会做出难看的东西，所以下面这些选项就是全部：

【theme 视觉语言 —— 三选一，语义不同，不是换皮】
${themeLines}

【其余字段】
- palette_index：从该主题的色板组里选第几号（0 起）。**你不能写 hex**。
- type_scale：${TYPE_SCALES.join(' / ')} —— 字号阶梯，不是具体 px。
- density：${DENSITIES.join(' / ')} —— 一起决定边距与每卡最多几条。
- texture：${TEXTURES.join(' / ')}。一层极淡的颗粒或网点能把"廉价大色块"变成"印刷品"，
  **建议总是给一个非 none**。
- motifs：0-3 个即可，**不要堆**。可选 ${MOTIFS.join(' / ')}。
  rule 短横线 / rule-fade 渐隐线 / badge 编号徽章 / corner 角标 / bracket 括号 /
  seal 印章 / ticker 走马灯条 / vertical-tag 竖排标签 / page-num 页码 / dots 点阵。
- accent_style：${ACCENT_STYLES.join(' / ')} —— [[方括号]] 里的强调词怎么呈现。
  2-4 字的短词适合 highlight / block；较长短语适合 underline；bracket 会给框感。

【必须从证据里的「视觉证据」行归纳】
每个样稿都带一行「视觉证据：版式=… 封面=… 图片作用=… 图上文字量=…」。
视觉风格只能从这里来，不要凭正文内容想象画面，也不要套通用模板 ——
如果证据显示作者全用实拍图、几乎不在图上写字，那就不该选大字报式的 still-paper。

其余字段（persona / language / hashtag_strategy / do_list / dont_list / topic_map）
要求具体、可复用，忌空话。所有判断都必须能追溯到下面的样稿证据。

不允许出现任何 emoji —— 包括在 don_list 里描述"作者爱用 emoji"时也只写文字描述。`;
}

const THEME_BLURB: Record<(typeof THEMES)[number], string> = {
  'still-paper': '静纸。暖纸底 + 衬线大字 + 大留白，杂志画册气质。品牌/生活方式/生活记录类。',
  'signal-proof':
    '实证。档案纸 + 细线 + 等宽元信息 + 印章，像一份可引用的文件。品牌营销/方法论/流程/数据结论类。',
  'bridge-canvas': '图桥。满铺影像 + 黑边字幕 + 电影感。实拍配图占主导、图上文字极少的内容。',
};

/* ------------------------------------------------------------------ */
/* 旧规格（只读兼容）                                                   */
/* ------------------------------------------------------------------ */
// hexOr / numOr / clamp / sanitizeSpec 曾在这里做「兜底纠正 18 个字段」。
//
// 它们已经删掉了：新版落库走 `normalizeContract()`（自由字段直接映射到契约），
// 旧形状数值不再进入渲染路径，所以那些 clamp 全是死代码。
// 唯一仍在用的是上面的 `CardTemplateSpecSchema` —— 它留在 union 里，
// 让库里已有的画像还能被解析出来；模型那边只会看到新契约的形状。


/** 汇总某作者下所有已蒸馏的样稿，产出聚合画像。 */
export async function buildStyleProfile(sourceId: number): Promise<StyleProfile | null> {
  const samples = all<SampleNote>(
    `SELECT n.id, n.title, n.desc, n.tags, n.liked_count, n.published_at, ns.analysis
     FROM notes n JOIN note_styles ns ON ns.note_id = n.id
     WHERE n.source_id = ?
     ORDER BY n.liked_count DESC
     LIMIT 15`,
    sourceId,
  );

  if (samples.length < 3) {
    logger.warn({ sourceId, n: samples.length }, '样稿不足 3 篇，无法聚合风格画像');
    return null;
  }

  const source = get<{ nickname: string | null; note_count: number }>(
    'SELECT nickname, note_count FROM sources WHERE id = ?',
    sourceId,
  );

  const evidence = samples
    .map((s, i) => {
      const text = `${s.title}\n${s.desc}`;
      let a: any;
      try {
        a = JSON.parse(s.analysis);
      } catch {
        a = {};
      }
      // 旧实现在这里直接 JSON.parse(s.tags || '[]') —— 正文里出现过半个方括号
      // 就会抛，整个画像任务失败。tags 本来就是"有更好、没有也行"，不该致命。
      let tags: string[] = [];
      try {
        const parsedTags = JSON.parse(s.tags || '[]');
        tags = Array.isArray(parsedTags) ? parsedTags : [];
      } catch {
        tags = [];
      }
      return [
        `--- 样稿 ${i + 1}（点赞 ${s.liked_count}）---`,
        `标题：${s.title}`,
        `正文：${s.desc.slice(0, 300)}${s.desc.length > 300 ? '…' : ''}`,
        `话题：${tags.join('、') || '无'}`,
        `字数：${text.length}，emoji ${countEmoji(text)} 个`,
        `标注摘要：标题公式=${a?.hook?.title_formula ?? '?'}；语气=${JSON.stringify(
          a?.language?.tone ?? [],
        )}；骨架=${a?.structure?.pattern ?? '?'}`,
        // 视觉证据。
        //
        // 这四行是**图片设计风格唯一的来源** —— 旧实现的聚合 prompt 里
        // `a?.visual` 一个字都没进（写了但没人读），所以模型只能凭正文瞎猜
        // 视觉方向，产出的 card_template_spec 与原作者实际版面无关。
        `视觉证据：版式=${a?.visual?.layout_hypothesis ?? '?'}；封面=${a?.visual?.cover_pattern ?? '?'}；` +
          `图片作用=${a?.visual?.image_role ?? '?'}；图上文字量=${a?.visual?.text_density ?? '?'}`,
      ].join('\n');
    })
    .join('\n\n');

  const user = [
    `博主：${source?.nickname ?? '未知'}，共抓取 ${source?.note_count ?? samples.length} 篇，以下是其中 ${samples.length} 篇高互动样稿的完整标注。`,
    '',
    '=== 证据开始 ===',
    evidence,
    '=== 证据结束 ===',
    '',
    '请综合以上全部样稿，输出该博主的风格档案 JSON。',
    '要求：',
    '- title_formulas / signature_phrases / do_list / dont_list 要从证据里归纳，引用真实措辞',
    '- card_template_spec 必须给出可直接渲染的 #hex 色值与 px 字号',
    '- topic_map 按选题聚类，note_count 要反映样稿里的真实分布',
    '',
    '【最重要的要求】严格按下面这份 JSON 结构输出，字段名不要自创或改名：',
    '```json',
    JSON.stringify(asTemplate(StyleProfileSchema), null, 2),
    '```',
  ].join('\n');

  const raw = await chatJson<StyleProfile>({
    system: buildProfileSystem(),
    user,
    temperature: 0.35,
    maxTokens: 24_576,
  });

  const parsed = StyleProfileSchema.safeParse(raw);
  // 解析失败也要能存下一个**可用**的画像 —— 顶层字段缺了就补空，不让它崩。
  const legacy = (raw ?? {}) as { card_template_spec?: unknown };
  const rawSpec = parsed.success
    ? parsed.data.card_template_spec
    : legacy.card_template_spec;
  // 落库一律**归一成新契约**：模型给了旧形状就当场迁移，以后库里只有一种形状。
  const profile: StyleProfile = {
    ...((parsed.success ? parsed.data : (raw ?? {})) as StyleProfile),
    card_template_spec: normalizeContract(rawSpec),
  } as StyleProfile;

  run(
    `INSERT INTO style_profiles(source_id, profile, sample_count, model, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(source_id) DO UPDATE SET
       profile = excluded.profile, sample_count = excluded.sample_count,
       model = excluded.model, updated_at = datetime('now')`,
    sourceId,
    JSON.stringify(profile),
    samples.length,
    config.llm.model,
  );

  logger.info({ sourceId, samples: samples.length }, '风格画像已生成');
  return profile;
}

export function getStyleProfile(sourceId: number): { profile: StyleProfile; sampleCount: number } | null {
  const row = get<{ profile: string; sample_count: number }>(
    'SELECT profile, sample_count FROM style_profiles WHERE source_id = ?',
    sourceId,
  );
  if (!row) return null;
  try {
    return { profile: JSON.parse(row.profile) as StyleProfile, sampleCount: row.sample_count };
  } catch {
    return null;
  }
}

/** 画像里图片风格的文字摘要，给 UI 用。 */
export function visualSummary(p: StyleProfile): string {
  const c = p.visual;
  return [
    c.dominant_layouts.join(' / '),
    `主色 ${c.palette_summary}`,
    c.brightness_profile,
    c.emoji_as_decoration ? 'emoji 作装饰' : '不用 emoji 装饰',
  ]
    .filter(Boolean)
    .join(' · ');
}

export { cjkRatio };