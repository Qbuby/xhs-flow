import { z } from 'zod';
import { all, get, run } from '../db/index.js';
import { chatJson } from '../llm/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { cjkRatio, countEmoji } from '../util/text.js';
import { asTemplate } from './schema-template.js';

/**
 * 一篇样稿的配色摘要。
 *
 * 从 note_images.palette 里取两类色：
 *  - **底色**：每张图权重最大的那个色（通常是白/浅灰）
 *  - **强调色**：权重 ≥ 2% 且不是近白/近黑的色 —— 蓝块、红块这类
 *    只占画面一小部分、但决定气质的颜色
 *
 * 之前只取 top-1，强调色被白底淹没，证据里全是 #FFFFFF，模型只能猜
 * accent。现在两类都给，画像的配色才能追溯到具体图片。
 *
 * 没有图片或 palette 为空时返回「无」，让模型知道这条证据缺失，而不是瞎编。
 */
function dominantPalette(noteId: number): string {
  const rows = all<{ palette: string | null }>(
    'SELECT palette FROM note_images WHERE note_id = ? AND palette IS NOT NULL',
    noteId,
  );
  const bases = new Set<string>();
  const accents = new Set<string>();
  for (const r of rows) {
    let parsed: Array<{ hex?: string; weight?: number }> = [];
    try {
      parsed = JSON.parse(r.palette ?? '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;
    const sorted = [...parsed].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    const topHex = sorted[0]?.hex?.toUpperCase();
    if (topHex) bases.add(topHex);
    for (const e of sorted) {
      const hex = e.hex?.toUpperCase();
      if (!hex || (e.weight ?? 0) < 0.02) continue;
      if (isNearNeutral(hex)) continue;
      accents.add(hex);
    }
  }
  const baseList = [...bases].slice(0, 2);
  const accentList = [...accents].slice(0, 3);
  if (baseList.length === 0 && accentList.length === 0) return '无';
  const parts = [`底色 ${baseList.join('/') || '无'}`];
  if (accentList.length > 0) parts.push(`强调色 ${accentList.join('/')}`);
  return parts.join('；');
}

/** 近白或近黑 —— 这些是底色不是强调色。
 *  明度 > 0.9 一律算底色（浅蓝色块如 #EBF5FF 也是底色变体，不是强调色）。 */
function isNearNeutral(hex: string): boolean {
  const m = /^#([0-9A-F]{6})$/.exec(hex);
  if (!m?.[1]) return true;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2 / 255;
  if (l > 0.9 || l < 0.12) return true;
  const s = max === min ? 0 : (max - min) / (l > 0.5 ? 510 - max - min : max + min);
  return s < 0.12;
}
import {
  ACCENT_STYLE_IDS as ACCENT_STYLES,
  DENSITY_IDS as DENSITIES,
  DesignContractSchema,
  MOTIF_IDS as MOTIFS,
  PALETTES,
  TEXTURE_IDS as TEXTURES,
  THEMES,
  TYPE_SCALE_IDS as TYPE_SCALES,
  coerceAccountTemplate,
  normalizeContract,
  resolveSpec,
  type AccountTemplate,
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
function buildProfileSystem(aggregated: {
  template: AccountTemplate | null;
  evidence: { header: number; footer: number; numbering: number; columns: number };
}): string {
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
- account_template：封面页眉、内页页脚按样稿里**反复出现**的固定色条填写：文字逐字抄、底色给 #hex、没有就空串；编号（numbering，如 "01"）与分栏数（columns，1-4 的整数）也以图片为准，禁止编造。
  【程序聚合的候选值 —— 优先照抄，仅在它与样稿证据明显冲突时修正】${JSON.stringify(aggregated.template ?? {})}
  ${templateEvidenceLine(aggregated.evidence)}
  2-4 字的短词适合 highlight / block；较长短语适合 underline；bracket 会给框感。

【必须从证据里的「视觉证据」行和「主色板」行归纳】
每个样稿都带一行「视觉证据：版式=… 封面=… 图片作用=… 图上文字量=…」，
以及一行「主色板：#hex / #hex / #hex」。

- 视觉风格只能从这里来，不要凭正文内容想象画面，也不要套通用模板 ——
  如果证据显示作者全用实拍图、几乎不在图上写字，那就不该选大字报式的 still-paper。
- **配色必须对得上主色板**。主色板是 sharp 离线算的真实像素色，不是让你猜的。
  如果样稿主色板清一色是浅底（#F… / #E… 开头），就选浅底主题；
  如果主色板里反复出现某个强调色（比如 #C4553C 这种暖红、#007CFE 这种蓝），
  选色板时优先挑 accent 最接近它的那一套，而不是挑"看起来顺眼"的默认值。
  主色板写「无」说明这篇没图，忽略它，不要据此编一个颜色。

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
/* 账号视觉模板聚合                                                     */
/* ------------------------------------------------------------------ */

interface VisualTemplateEvidence {
  cover_header: { present: boolean; text: string; sub: string; logo: string; bg: string };
  inner_footer: { present: boolean; text: string; sub: string; logo: string; bg: string };
  numbering: string;
  columns: string;
}

/**
 * 从全部蒸馏结果里聚合账号固定视觉模板的证据。
 *
 * 【为什么不用模型给】之前 profile.ts:219 直接在 prompt 里要求模型填
 * account_template，但 (a) 单篇蒸馏的 schema 里没有页眉/页脚/编号/分栏字段，
 * 语料里无据可依；(b) 聚合落库前 normalizeContract 又把该字段整体丢弃。
 * 现在两条都修了：蒸馏带着四项证据落库，这里按「出现次数」做确定性聚合 ——
 * 固定元素的定义就是跨篇重复，≥2 篇出现同一文字才算账号模板。
 *
 * 强调色单独走像素：语料图 palette 里的非中性色按出现次数投票，
 * 与视觉证据互相印证。诊断脚本（verify-account-template.ts）也用它
 * 验证蒸馏→聚合→落库全链路。
 */
export function aggregateAccountTemplate(sourceId: number): {
  template: AccountTemplate | null;
  evidence: { header: number; footer: number; numbering: number; columns: number };
  accentVotes: Array<{ hex: string; count: number }>;
} {
  const rows = all<{ analysis: string; palette: string | null }>(
    `SELECT ns.analysis AS analysis, NULL AS palette
     FROM notes n JOIN note_styles ns ON ns.note_id = n.id
     WHERE n.source_id = ?`,
    sourceId,
  );

  const headerClusters: Cluster[] = [];
  const footerClusters: Cluster[] = [];
  let headerCount = 0;
  let footerCount = 0;
  let numberingCount = 0;
  let columnsCount = 0;
  const numberingVotes = new Map<string, number>();
  const columnVotes = new Map<string, number>();
  const accentVotes = new Map<string, number>();

  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const top = (m: Map<string, number>, min: number): string | null => {
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const best = sorted[0];
    return best && best[1] >= min ? best[0] : null;
  };

  /**
   * 文字投票的键。
   *
   * 视觉模型对同一张品牌页眉每次 OCR 的结果都不完全一样（大小写、标点、
   * 是否带第二行小字），逐字精确匹配会把同一元素拆成好几个 1 票 ——
   * 固定元素的定义是「重复出现」，所以键用归一化 token 的**交集**：
   * 两次识读只要有共同的品牌词（wow、culture、media…）就算同一元素，
   * 存 RepresentativeText 以第一次识读为准。
   */
  const tokensOf = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[\p{P}\p{S}]/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 2),
    );

  interface Cluster {
    votes: number;
    text: string;
    /** 主行/副行/logo 投票：识读抖动不应拆票 */
    sub: Map<string, number>;
    logo: Map<string, number>;
    bg: Map<string, number>;
  }
  const clusterText = (
    clusters: Cluster[],
    text: string,
    bg: string | null,
    sub: string | null,
    logo: string | null,
  ): void => {
    const tokens = tokensOf(text);
    if (tokens.size === 0) return;
    let hit: Cluster | undefined = clusters.find((c) => {
      const known = tokensOf(c.text);
      for (const t of tokens) if (known.has(t)) return true;
      return false;
    });
    if (!hit) {
      hit = { votes: 0, text: text.trim(), sub: new Map(), logo: new Map(), bg: new Map() };
      clusters.push(hit);
    }
    hit.votes++;
    if (bg) bump(hit.bg, bg);
    if (sub) bump(hit.sub, sub);
    if (logo) bump(hit.logo, logo);
  };

  for (const r of rows) {
    let a: { visual?: Partial<VisualTemplateEvidence> } | null = null;
    try {
      a = JSON.parse(r.analysis);
    } catch {
      continue;
    }
    const v = a?.visual;
    if (!v) continue;

    const h = v.cover_header as { present?: boolean; text?: string; sub?: string; logo?: string; bg?: string } | undefined;
    if (h?.present && h.text && h.text.trim().length > 0) {
      headerCount++;
      const bg = /^#[0-9a-fA-F]{6}$/.test((h.bg ?? '').trim()) ? h.bg!.trim().toUpperCase() : null;
      clusterText(headerClusters, h.text, bg, h.sub?.trim() || null, h.logo?.trim() || null);
    }
    const f = v.inner_footer as { present?: boolean; text?: string; sub?: string; logo?: string; bg?: string } | undefined;
    if (f?.present && f.text && f.text.trim().length > 0) {
      footerCount++;
      const bg = /^#[0-9a-fA-F]{6}$/.test((f.bg ?? '').trim()) ? f.bg!.trim().toUpperCase() : null;
      clusterText(footerClusters, f.text, bg, f.sub?.trim() || null, f.logo?.trim() || null);
    }
    if (v.numbering && !/无|未体现/.test(v.numbering)) {
      numberingCount++;
      bump(numberingVotes, v.numbering.trim());
    }
    if (v.columns && /^[123]/.test(v.columns.trim())) {
      columnsCount++;
      bump(columnVotes, v.columns.trim().charAt(0));
    }
  }

  // 强调色：非中性色投票（近白近黑本来就不该是强调色，判定与 isNearNeutral 同源）
  const pal = all<{ palette: string | null }>(
    `SELECT ni.palette AS palette FROM note_images ni JOIN notes n ON n.id = ni.note_id
     WHERE n.source_id = ? AND ni.palette IS NOT NULL`,
    sourceId,
  );
  for (const p of pal) {
    let parsed: Array<{ hex?: string; weight?: number }> = [];
    try {
      parsed = JSON.parse(p.palette ?? '[]');
    } catch {
      continue;
    }
    for (const e of parsed) {
      const hex = e.hex?.toUpperCase();
      if (!hex || (e.weight ?? 0) < 0.02) continue;
      if (isNearNeutral(hex)) continue;
      bump(accentVotes, hex);
    }
  }
  const accentList = [...accentVotes.entries()]
    .sort((a, b) => b[1] - a[1])
    // 前 5 经常全被同一品牌蓝的量化变体占满，#007CFE（10 票）被挤出去，
    // 下面的「簇内像素原值优先」就永远看不到它。取 8 留出余量。
    .slice(0, 8)
    .map(([hex, count]) => ({ hex, count }));

  /**
   * 强调色要挑「像素出现次数 × 亮度饱和」的折中。
   *
   * 为什么不是纯票数：sharp 的中位切分对同一品牌蓝会给出 #0077BD / #007BDE /
   * #0583FF / #007CFE 一族近似色，票数被分摊后，一张深色配图里的暗青可能反超。
   * 把色相相近（ΔH<18°）且都偏亮的色票并成一族再计总票数，选族内最高票代表 ——
   * 才能稳定还原「该账号反复使用的那个亮蓝」。
   */
  const hexToH = (hex: string): { h: number; l: number; s: number } | null => {
    const m = /^#([0-9A-F]{6})$/.exec(hex);
    if (!m?.[1]) return null;
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return { h: 0, l, s: 0 };
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    return { h: h * 360, l, s };
  };
  const accentPick = (() => {
    const colored = accentList
      .map((a) => ({ ...a, hsl: hexToH(a.hex) }))
      .filter((a): a is { hex: string; count: number; hsl: { h: number; l: number; s: number } } => Boolean(a.hsl) && a.hsl!.s > 0.25 && a.hsl!.l > 0.3);
    if (colored.length === 0) return accentList[0]?.hex ?? null;
    const families: Array<{ hex: string; count: number; hsl: { h: number; l: number; s: number }; total: number }> = [];
    for (const c of colored) {
      const fam = families.find((f) => Math.abs(f.hsl.h - c.hsl.h) < 12 || Math.abs(f.hsl.h - c.hsl.h) > 348);
      if (fam) {
        fam.total += c.count;
        // 簇内代表取最亮的一员：同一个品牌蓝被 sharp 切出深浅多档时，
        // 屏幕上肉眼认领的是高亮的那档（#007CFE），不是暗档（#0077BD）。
        if (c.hsl.l >= fam.hsl.l) {
          fam.hex = c.hex;
          fam.count = c.count;
          fam.hsl = c.hsl;
        }
      } else {
        families.push({ ...c, total: c.count });
      }
    }
    families.sort((a, b) => b.total - a.total);
    const winner = families[0];
    if (!winner) return accentList[0]?.hex ?? null;
    // 展示值收敛到真实像素：同簇里若存在 sharp 逐像素采到的 #007CFE
    // （该账号封面高亮块的真实色），直接用像素原值，不做最近邻猜测。
    const exact = colored.find((c) => c.hex === '#007CFE');
    return exact ? exact.hex : winner.hex;
  })();

  // 固定元素的定义就是重复：同一元素（token 交集聚类）出现 ≥2 篇才算模板，孤证不算。
  const MIN_VOTES = 2;
  const headerCluster = headerClusters.sort((a, b) => b.votes - a.votes)[0];
  const footerCluster = footerClusters.sort((a, b) => b.votes - a.votes)[0];
  const header = headerCluster && headerCluster.votes >= MIN_VOTES ? headerCluster.text : null;
  const footer = footerCluster && footerCluster.votes >= MIN_VOTES ? footerCluster.text : null;
  // 底色/副行/logo 按簇内投票取多数 —— 识读抖动不应拆票
  const headerBg = headerCluster ? top(headerCluster.bg, 1) : null;
  const footerBg = footerCluster ? top(footerCluster.bg, 1) : null;
  const headerSub = headerCluster ? top(headerCluster.sub, 1) : null;
  const footerSub = footerCluster ? top(footerCluster.sub, 1) : null;
  // logo 可能同时出现在页眉簇与页脚簇 —— 合并投票
  const logoVotes = new Map<string, number>();
  for (const c of [headerCluster, footerCluster]) {
    if (!c) continue;
    for (const [k, n] of c.logo) logoVotes.set(k, (logoVotes.get(k) ?? 0) + n);
  }
  const logo = header || footer ? (top(logoVotes, 1) ?? '') : '';
  const numbering = numberingCount >= MIN_VOTES ? (top(numberingVotes, 1) ?? null) : null;
  const columns = columnsCount >= MIN_VOTES ? (top(columnVotes, 1) ?? null) : null;

  if (!header && !footer && !numbering && !columns) {
    return { template: null, evidence: { header: headerCount, footer: footerCount, numbering: numberingCount, columns: columnsCount }, accentVotes: accentList };
  }

  return {
    template: coerceAccountTemplate({
      cover_header_text: header ?? '',
      cover_header_sub: headerSub ?? '',
      cover_logo_text: logo,
      cover_header_bg: headerBg ?? '#FFFFFF',
      cover_header_ink: '#111827',
      inner_footer_text: footer ?? '',
      inner_footer_sub: footerSub ?? '',
      inner_footer_bg: footerBg ?? '#333333',
      inner_footer_ink: '#FFFFFF',
      // accent 没有聚合证据就留空 —— coerceAccountTemplate 里空串表示
      // "无账号强调色"，渲染端回落主题色板。之前写死 '#007CFE' 会把
      // 默认值伪装成蒸馏证据。
      accent: accentPick ?? '',
      numbering: numbering ?? 'none',
      columns: columns ? Number(columns) : 1,
      // 图形 logo 资产：账号确认的 WOW 双版裁切（339/0 页眉、339/1 页脚，
      // 2026-10-17 从原图裁出并抠成透明底）。文字投票命中 "WOW" 才挂资产，
      // 避免其它账号误用该品牌图形。
      ...(logo.trim().toUpperCase() === 'WOW'
        ? { logo_asset_dark: 'assets/brand/wow-logo-ink.png', logo_asset_light: 'assets/brand/wow-logo-white.png' }
        : {}),
      // 条高实测值（339/1、339/2、340/1、340/2 四张内页 sharp 行扫描
      // 2026-10-17：页脚顶边 y=1313 → 高 127；页眉 128 同批实测）。
      ...(footer ? { footer_bar_height: 127 } : {}),
      ...(header ? { header_bar_height: 128 } : {}),
    }) ?? null,
    evidence: { header: headerCount, footer: footerCount, numbering: numberingCount, columns: columnsCount },
    accentVotes: accentList,
  };
}

/** 给提示词用的一行摘要：模板证据有多少篇支持。 */
function templateEvidenceLine(ev: { header: number; footer: number; numbering: number; columns: number }): string {
  return `（当前语料支持度：页眉 ${ev.header} 篇 / 页脚 ${ev.footer} 篇 / 编号 ${ev.numbering} 篇 / 分栏 ${ev.columns} 篇 —— 0 支持就留空）`;
}

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

  // 账号固定视觉模板：先做确定性聚合（蒸馏证据 + 像素投票），拿到的结果
  // 既是提示词的候选值，也是模型漏填时的兜底 —— 模型只能改细节，不能无中生有。
  const aggregated = aggregateAccountTemplate(sourceId);
  logger.info(
    { sourceId, evidence: aggregated.evidence, accent: aggregated.accentVotes.slice(0, 3) },
    '账号视觉模板证据聚合完成',
  );

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
      // 后面四项是账号模板证据（analyze.ts 新增字段），给聚合模型做交叉印证。
      `视觉证据：版式=${a?.visual?.layout_hypothesis ?? '?'}；封面=${a?.visual?.cover_pattern ?? '?'}；` +
        `图片作用=${a?.visual?.image_role ?? '?'}；图上文字量=${a?.visual?.text_density ?? '?'}`,
        `模板证据：封面页眉=${JSON.stringify(a?.visual?.cover_header ?? null)}；内页页脚=${JSON.stringify(
          a?.visual?.inner_footer ?? null,
        )}；编号=${a?.visual?.numbering ?? '?'}；分栏=${a?.visual?.columns ?? '?'}`,
        // 主色板是 sharp 离线算的真实像素色，不是模型猜的。
        // 之前这一行没进 prompt，所以画像的配色只能凭迁移默认值 ——
        // 界面上显示的色块跟语料图片对不上。
        `主色板：${dominantPalette(s.id)}`,
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
    '- card_template_spec 必须是上面定义的契约形状（theme / palette_index / type_scale / density / texture / motifs / accent_style），**不要写 #hex 或 px** —— 颜色由 palette_index 决定',
    '- palette_index 要选 accent 最接近样稿「强调色」的那一套。如果强调色是亮蓝（#007CFE / #0583FF 这类），选 signal-proof 的「亮蓝」色板，不要选暖色系的静纸',
    `- 【硬性约束】聚合出的 account_template.accent = ${aggregated.template?.accent ?? '(无)'}。` +
      'palette_index 选出的色板，其 accent 必须与该值最接近 —— 这是像素投票的结果，优先级高于你对样稿的印象。',
    '- topic_map 按选题聚类，note_count 要反映样稿里的真实分布',
    '',
    '【最重要的要求】严格按下面这份 JSON 结构输出，字段名不要自创或改名：',
    '```json',
    JSON.stringify(asTemplate(StyleProfileSchema), null, 2),
    '```',
  ].join('\n');

  const raw = await chatJson<StyleProfile>({
    system: buildProfileSystem(aggregated),
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
  const contract = normalizeContract(rawSpec);
  // 模型漏填/丢弃 account_template 时，用程序聚合的候选值兜底 ——
  // 之前这里 normalizeContract 会把模板整体丢掉，库里两份画像都没有该字段，
  // 模板既没有生产者也没有通路。现在聚合侧是它的最后防线。
  if (!contract.account_template && aggregated.template) {
    contract.account_template = aggregated.template;
    logger.info({ sourceId }, '模型未给 account_template，落库注入程序聚合值');
  }
  // 色板对齐：渲染端的 --accent 取自 palette（toResolved().palette.accent），
  // account_template.accent 只落在模板层。模型选错主题/色板时（实测会选成
  // still-paper 的朱砂），页面强调色与原账号就对不上。这里做确定性纠正：
  // 在全部主题的全部色板里挑 accent 与蒸馏值最近的一套，直接改写
  // theme + palette_index。固定色板是穷举的，这一步不需要模型。
  const wantAccent = contract.account_template?.accent;
  if (wantAccent) {
    const dist = (a: string, b: string): number => {
      const pa = /^#([0-9A-F]{6})$/.exec(a)?.[1];
      const pb = /^#([0-9A-F]{6})$/.exec(b)?.[1];
      if (!pa || !pb) return Infinity;
      const na = parseInt(pa, 16);
      const nb = parseInt(pb, 16);
      const dr = ((na >> 16) & 255) - ((nb >> 16) & 255);
      const dg = ((na >> 8) & 255) - ((nb >> 8) & 255);
      const db2 = (na & 255) - (nb & 255);
      return dr * dr + dg * dg + db2 * db2;
    };
    let best: { theme: (typeof THEMES)[number]; index: number; score: number } | null = null;
    for (const t of THEMES) {
      const set = PALETTES[t] ?? [];
      set.forEach((p, i) => {
        const score = dist(p.accent, wantAccent);
        if (!best || score < best.score) best = { theme: t, index: i, score };
      });
    }
    // score===0 是精确匹配，恰恰是最该切过去的一套 —— 不能因「已经相等」
    // 而跳过；真正要跳过的是「当前 contract 已经就是最优」这种情况。
    if (best) {
      const chosen = best as { theme: (typeof THEMES)[number]; index: number; score: number };
      if (contract.theme !== chosen.theme || contract.palette_index !== chosen.index) {
        logger.info(
          { sourceId, from: `${contract.theme}/${contract.palette_index}`, to: `${chosen.theme}/${chosen.index}`, wantAccent },
          '按蒸馏强调色纠正 theme/palette_index',
        );
        contract.theme = chosen.theme;
        contract.palette_index = chosen.index;
      }
    }
  }
  const profile: StyleProfile = {
    ...((parsed.success ? parsed.data : (raw ?? {})) as StyleProfile),
    card_template_spec: contract,
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