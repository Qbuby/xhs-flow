import { z } from 'zod';
import { all, get, run } from '../db/index.js';
import { chatJson } from '../llm/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { cjkRatio, countEmoji } from '../util/text.js';

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
  card_template_spec: CardTemplateSpecSchema,
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

const PROFILE_SYSTEM = `你是一位视觉设计总监 + 小红书内容策略师，正在为一个自动创作系统提炼某个博主的可复刻风格档案。

最关键的一条：**card_template_spec 必须是渲染器能直接执行的规格**，不是设计形容词。
- 色值必须是具体 #hex，不能写"米色""奶油色"
- 字号必须是 px 数字，考虑卡片宽度 1080px
- accent_style / decoration / background_image 必须从给定枚举里选
如果这个博主的风格本身不适合做成卡片，选一个接近的并保持诚实。

其余字段要求具体、可复用，忌空话。所有判断都必须能追溯到下面的样稿证据。`;

function hexOr(value: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim().toUpperCase() : fallback;
}

/** 模型偶尔会给出非 hex 的颜色描述，这里兜底纠正，不至于让渲染器崩掉。 */
function sanitizeSpec(spec: CardTemplateSpec): CardTemplateSpec {
  return {
    ...spec,
    background: hexOr(spec.background, '#FFF9F2'),
    text_primary: hexOr(spec.text_primary, '#2B2320'),
    text_secondary: hexOr(spec.text_secondary, '#7A6A60'),
    accent: hexOr(spec.accent, '#E8604C'),
    palette: spec.palette.map((c) => hexOr(c, '#FFF9F2')).slice(0, 5),
    title_size: clamp(spec.title_size, 48, 120),
    body_size: clamp(spec.body_size, 24, 48),
    line_height: clamp(spec.line_height, 1.2, 2.2),
    radius: clamp(spec.radius, 0, 48),
    text_ratio: clamp(spec.text_ratio, 0.1, 0.95),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : (lo + hi) / 2;
}

/** 汇总某作者下所有已蒸馏的样稿，产出聚合画像。 */
export async function buildStyleProfile(sourceId: number): Promise<StyleProfile | null> {
  const samples = all<SampleNote>(
    `SELECT n.id, n.title, n.desc, n.tags, n.liked_count, n.published_at, ns.analysis
     FROM notes n JOIN note_styles ns ON ns.note_id = n.id
     WHERE n.source_id = ?
     ORDER BY n.liked_count DESC
     LIMIT 40`,
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
      let a: unknown;
      try {
        a = JSON.parse(s.analysis);
      } catch {
        a = {};
      }
      return [
        `--- 样稿 ${i + 1}（点赞 ${s.liked_count}）---`,
        `标题：${s.title}`,
        `正文：${s.desc.slice(0, 300)}${s.desc.length > 300 ? '…' : ''}`,
        `话题：${JSON.parse(s.tags || '[]').join('、') || '无'}`,
        `字数：${text.length}，emoji ${countEmoji(text)} 个`,
        `结构化标注：${JSON.stringify(a)}`,
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
  ].join('\n');

  const raw = await chatJson<StyleProfile>({
    system: PROFILE_SYSTEM,
    user,
    temperature: 0.35,
    maxTokens: 4096,
  });

  const parsed = StyleProfileSchema.safeParse(raw);
  const profile: StyleProfile = parsed.success
    ? { ...parsed.data, card_template_spec: sanitizeSpec(parsed.data.card_template_spec) }
    : {
        ...raw,
        card_template_spec: sanitizeSpec(raw.card_template_spec ?? ({} as CardTemplateSpec)),
      };

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