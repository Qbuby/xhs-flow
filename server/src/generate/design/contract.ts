import { z } from 'zod';

/**
 * 设计契约。
 *
 * 【为什么要从「自由填 hex/px」改成「在合同内选择」】
 *
 * 旧 spec 有 18 个字段，允许模型自由给任意 `#hex` 和任意 px 字号。结果是：
 *  - 八个字段是坏的（`text_ratio` 渲染器一行没读、`palette[3..4]` 没人用、
 *    `accent_style:'none'` 掉进 else、`background_image:'photo'` 是个死值、
 *    `radius` 被 JPEG 无透明通道吃掉）
 *  - 剩下十个字段能表达的只有「颜色 + 字号 + 圆角 + 一种强调样式 + 一条线性渐变」
 *  - 而「给无限的颜色与字号选择，更容易做出难看的东西」——
 *    实测产出确实就是每张卡都长一个样、没有任何装饰元素
 *
 * 参考 blcaptain-style-skill（NOASSERTION，仅借鉴方法论、不拷代码）的做法：
 * 把设计系统写成**机器可读的合同**，让模型在合同内做**选择**而不是自由发挥。
 * 色板是固定的（选第几套），字号是阶梯（选哪一档），密度决定边距与条数上限。
 *
 * 【与旧数据的兼容】
 * 已存的 `style_profiles.card_template_spec` 是旧形状，通过
 * `design/migrate.ts` 的 `migrateSpec()` 自动映射到新契约，不需要重新蒸馏。
 */

/* ------------------------------------------------------------------ */
/* 枚举                                                                */
/* ------------------------------------------------------------------ */

/** 三套视觉语言。每套是一份完整的配方，不是换皮。 */
export const THEMES = ['still-paper', 'signal-proof', 'bridge-canvas'] as const;
export type ThemeName = (typeof THEMES)[number];

/** 字号阶梯。具体 px 由 themes.ts 按主题给出，模型只选档位。 */
export const TYPE_SCALES = ['compact', 'standard', 'display'] as const;
export type TypeScale = (typeof TYPE_SCALES)[number];

/** 密度：一起决定外边距、内容间距、每卡条数上限。 */
export const DENSITIES = ['airy', 'standard', 'dense'] as const;
export type Density = (typeof DENSITIES)[number];

/**
 * 纹理层。**每个卡必须声明一个**（可以是 'none'）。
 *
 * 这一层是「廉价大色块」与「有质感的纸/胶片」之间的分界线：
 * 一层 feTurbulence 噪点 + `mix-blend-mode: overlay` 就能去掉渐变的塑料感。
 */
export const TEXTURES = [
  'none',
  'paper-grain', // 细颗粒暖纸
  'film-grain', // 更粗的胶片颗粒
  'halftone', // 半调网点
  'hairline-grid', // 发丝网格（向角落淡出）
  'haze-blob', // 柔焦光晕色团
] as const;
export type Texture = (typeof TEXTURES)[number];

/**
 * 装饰件。旧实现整个渲染器只有两个 div（一个 CSS 三角、三个「·」字符），
 * 这里给出一批可组合的 SVG/CSS 装饰件，由模型按卡挑选。
 */
export const MOTIFS = [
  'rule', // 短横线
  'rule-fade', // 渐隐分隔线
  'badge', // 编号徽章
  'corner', // 角标
  'bracket', // 左右括号
  'seal', // 印章
  'ticker', // 走马灯条
  'vertical-tag', // 竖排标签
  'page-num', // 页码
  'dots', // 点阵
] as const;
export type Motif = (typeof MOTIFS)[number];

/** 强调词的视觉处理。`none` 现在是**真的 none**（旧实现掉进 else 变成高亮）。 */
export const ACCENT_STYLES = ['underline', 'block', 'highlight', 'bracket', 'none'] as const;
export type AccentStyle = (typeof ACCENT_STYLES)[number];

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

/**
 * 账号模板族（template family）。
 *
 * 【为什么不能只有一份账号模板】
 * 同一个账号内部有多套真实版式。source 10 实测（2026-10-17 sharp 扫描）：
 *   - wow-ip-trend-v1（339）：内页编号是**大号浅蓝** `01`（bbox 69,161 →
 *     130×186，#D9E9FB），封面是黑字标题 + 蓝底白字强调块 + 2×2 比较矩阵
 *   - wow-brand-case-v1（340）：内页编号是**细字** `SHIFT · 01`
 *     （bbox 98,131 → 字面高约 20px、字母间距拉开、纯强调色），封面是
 *     黑字主题 + 蓝底白字 + 大幅案例配图
 *
 * 把两套压成一份「账号模板」，结果是投票互相淘汰 —— 得到的版式原账号
 * 根本没在用。所以模板按族并存，渲染时选族，不做全局平均。
 *
 * `id` 是稳定标识（落库、选版、报告都用它）；`label` 给人看。
 */
export const TEMPLATE_FAMILIES = [
  'wow-ip-trend-v1',
  'wow-brand-case-v1',
  'wow-label-dark-v1',
  'wow-title-top-v1',
  'wow-blue-tag-v1',
  'generic-enum-v1',
] as const;
export type TemplateFamilyId = (typeof TEMPLATE_FAMILIES)[number];

export const AccountTemplateSchema = z.object({
  /** 该模板所属的版式族；旧数据无此字段时按文本特征推断。 */
  family: z.enum(TEMPLATE_FAMILIES).optional().describe('版式族标识：wow-ip-trend-v1 大号浅蓝编号 / wow-brand-case-v1 细字栏目编号 / generic-enum-v1 通用'),
  cover_header_text: z.string().describe('封面页眉右对齐主行文字；没有则空字符串'),
  cover_header_sub: z.string().describe('封面页眉右对齐第二行小字；没有则空字符串'),
  cover_header_bg: z.string().describe('封面页眉底色 #hex'),
  cover_header_ink: z.string().describe('封面页眉文字色 #hex'),
  cover_logo_text: z.string().describe('页眉/页脚左侧的品牌 logo 文字（如 WOW）；没有则空字符串'),
  inner_footer_text: z.string().describe('内页页脚右对齐主行文字；没有则空字符串'),
  inner_footer_sub: z.string().describe('内页页脚右对齐第二行小字；没有则空字符串'),
  inner_footer_bg: z.string().describe('内页页脚底色 #hex'),
  inner_footer_ink: z.string().describe('内页页脚文字色 #hex'),
  accent: z.string().describe('内容强调色 #hex'),
  numbering: z.string().describe('编号样式：内页左上大号浅蓝序号（如 01）则填 "01"；无则 "none"'),
  columns: z.number().int().min(1).max(4).describe('内页常见分栏数'),
  /**
   * 图形 Logo 资产（相对 server/assets/ 的路径），有证据才填。
   *
   * 为什么必须有：WOW 的图形 logo（斜切 W、O 上的缺口）用普通粗体字
   * 根本画不出来 —— 模型/字体都只是"像"。原账号 logo 从语料原图裁切、
   * 抠成透明底后按原图标称尺寸摆放，才是 1:1。没有资产时渲染端
   * 退回文字 logo（视觉近似，但验收会标注 logo_textual）。
   */
  logo_asset_dark: z.string().optional().describe('深色前景 logo（用于浅色底）的资产路径'),
  logo_asset_light: z.string().optional().describe('浅色前景 logo（用于深色底）的资产路径'),
  /** 页脚条实测高度 px；蒸馏端用 sharp 扫描原图得出（原账号 127）。 */
  footer_bar_height: z.number().int().min(80).max(220).optional().describe('内页页脚条实测高度 px'),
  /** 页眉条实测高度 px（原账号 128）。 */
  header_bar_height: z.number().int().min(60).max(220).optional().describe('封面页眉条实测高度 px'),
  /**
   * 编号前缀标签（如 "SHIFT"）。原图 340 的内页编号是 `SHIFT · 01`：
   * 细字 + 强调色 + 字间距，不是数字。只有 339 那样纯数字时留空。
   */
  numbering_prefix: z.string().optional().describe('编号前缀（如 SHIFT）；纯数字编号留空'),
  /** 该族内页正文首行的起始 y（实测），用于标题对位。 */
  inner_body_top: z.number().int().min(80).max(600).optional().describe('内页正文区起始 y px（实测）'),
});
export type AccountTemplate = z.infer<typeof AccountTemplateSchema>;

export const DEFAULT_ACCOUNT_TEMPLATE: AccountTemplate = {
  family: 'generic-enum-v1',
  cover_header_text: '',
  cover_header_sub: '',
  cover_header_bg: '#FFFFFF',
  cover_header_ink: '#111827',
  cover_logo_text: '',
  inner_footer_text: '',
  inner_footer_sub: '',
  inner_footer_bg: '#111827',
  inner_footer_ink: '#FFFFFF',
  accent: '',
  numbering: 'none',
  columns: 1,
};

/**
 * 模板族 → 编号渲染形态。
 *
 * `big-number`    = 大号浅蓝数字（wow-ip-trend-v1，339 实测）
 * `label-accent`  = 细字「前缀 · 数字」，强调色 + 通栏横线（wow-brand-case-v1，340 实测）
 * `label-dark`    = 细字「前缀 · 数字」，**深灰**正文色、无横线（wow-label-dark-v1，
 *                   351/366/372 实测：`05 — TAKEAWAY`、bbox x98,y153 附近、颜色 #333）
 * `none`          = 不画编号（wow-title-top-v1：这一族的内页**没有页码**，
 *                   顶部 y≈153 直接是标题行，条目序号在正文里 —— 342/1 实测）
 *
 * 编号是**族特征**，不能跨族复用：把细字画成大号浅蓝、或把深灰细字画成
 * 强调蓝横线版，都是原账号从未出现过的版式。
 *
 * 第三族是 2026-10-19 全量提取（664 页）时从 unknown 队列里校准出来的：
 * 它的位置与 brand-case 相同、字距相同，**只有颜色不同** —— 说明「编号形态」
 * 与「编号颜色」是两个独立维度，之前把它们捆在一起才导致漏判。
 */
export const FAMILY_NUMBERING = {
  'wow-ip-trend-v1': 'big-number',
  'wow-brand-case-v1': 'label-accent',
  'wow-label-dark-v1': 'label-dark',
  'wow-title-top-v1': 'none',
  'wow-blue-tag-v1': 'blue-tag',
  'generic-enum-v1': 'none',
} as const satisfies Record<TemplateFamilyId, string>;

export type NumberingStyle = (typeof FAMILY_NUMBERING)[TemplateFamilyId];

/**
 * 账号 chrome 条的**兜底**几何（模板没带实测值时用）。
 *
 * 众数来自 source 10 原始内页的 sharp 行扫描：页脚条上边界 y=1311–1313 →
 * 高 122–128，取 127；页眉同理取 128。模板自带 footer_bar_height /
 * header_bar_height 时以模板为准（实测优先于兜底）。
 */
export const HEADER_BAR_HEIGHT = 128;
export const FOOTER_BAR_HEIGHT = 127;

export const DesignContractSchema = z.object({
  theme: z.enum(THEMES).describe('视觉语言：still-paper 静纸 / signal-proof 实证 / bridge-canvas 图桥'),
  palette_index: z.number().int().min(0).describe('从该主题的固定色板组里选第几套（越界会自动取模）'),
  type_scale: z.enum(TYPE_SCALES).describe('字号阶梯：compact 紧凑 / standard 标准 / display 展示级'),
  density: z.enum(DENSITIES).describe('密度：airy 留白多 / standard / dense 信息密集'),
  texture: z.enum(TEXTURES).describe('纹理层，建议按主题给的可选项里挑'),
  motifs: z.array(z.enum(MOTIFS)).describe('装饰件，0-3 个即可，不要堆'),
  accent_style: z.enum(ACCENT_STYLES).describe('强调词的处理方式'),
  account_template: AccountTemplateSchema.optional().describe('从真实配图蒸馏出的账号固定视觉模板'),
});

export type DesignContract = z.infer<typeof DesignContractSchema>;

/**
 * 枚举数组的**别名**。
 *
 * 原因：`palettes.ts` 也导出一个 `TYPE_SCALES`，但那是**规格记录**
 * （键 → 具体 px），与这里的**枚举数组**同名。`design/index.ts` 里
 * 显式让记录版胜出，所以需要「列出所有档位」的地方（提示词、校验）
 * 必须用下面这些别名，否则会拿到一个记录对象却当函数/数组用。
 */
export {
  TYPE_SCALES as TYPE_SCALE_IDS,
  DENSITIES as DENSITY_IDS,
  TEXTURES as TEXTURE_IDS,
  MOTIFS as MOTIF_IDS,
  ACCENT_STYLES as ACCENT_STYLE_IDS,
  // THEMES 目前没有同名冲突，别名只为跟上面对齐 ——
  // 见到 `*_IDS` 就是「枚举数组」，见到裸名字可能是规格记录。
  THEMES as THEME_IDS,
};

/** 还没生成画像时的默认契约。 */export const DEFAULT_CONTRACT: DesignContract = {
  theme: 'still-paper',
  palette_index: 0,
  type_scale: 'standard',
  density: 'standard',
  texture: 'paper-grain',
  motifs: ['rule', 'page-num'],
  accent_style: 'highlight',
};

/* ------------------------------------------------------------------ */
/* 解析后的具体 token —— 渲染器只消费这个，不再直接读契约                */
/* ------------------------------------------------------------------ */

/** 色板：一套固定的 6 色，语义化命名。模型选不出自由 hex，只能选整套。 */
export interface Palette {
  name: string;
  /** 页面底色 */
  bg: string;
  /** 主文字 */
  ink: string;
  /** 次级文字 */
  inkSoft: string;
  /** 强调色（高亮、编号、装饰） */
  accent: string;
  /** 浅色衬底（色块、徽章底） */
  tint: string;
  /** 深色块（印章、走马灯、深色卡） */
  deep: string;
}

export interface TypeScaleSpec {
  /** 展示级大字（封面主标题、金句） */
  display: number;
  /** 标题 */
  title: number;
  /** 正文 */
  body: number;
  /** 注释/说明 */
  caption: number;
  /** eyebrow / 元信息 */
  meta: number;
  /** 标题行高 */
  titleLineHeight: number;
  /** 正文行高 */
  bodyLineHeight: number;
  /** 字距：中文保持 0，只有拉丁/元信息才加 */
  latinTracking: string;
}

export interface DensitySpec {
  /** 卡片内边距（上下 / 左右） */
  paddingY: number;
  paddingX: number;
  /** 块之间的间距 */
  gap: number;
  /** 每卡最多几条（list / steps / compare 用） */
  maxItems: number;
  /** 正文每段最多几行 */
  maxBodyLines: number;
}

export interface ResolvedSpec {
  contract: DesignContract;
  theme: ThemeName;
  palette: Palette;
  type: TypeScaleSpec;
  density: DensitySpec;
  /** 字体族：标题可能走衬线，正文走无衬线 */
  fontTitle: string;
  fontBody: string;
  /** 允许该主题使用的纹理集合（模型选了别的会被回落到第一个允许项） */
  allowedTextures: readonly Texture[];
  /** 允许该主题使用的装饰件 */
  allowedMotifs: readonly Motif[];
  texture: Texture;
  motifs: Motif[];
  accentStyle: AccentStyle;
  /**
   * 账号固定视觉模板（有蒸馏证据才存在）。
   *
   * 之前它只躺在 `contract.account_template` 里，编号样式与分栏数
   * 从不进任何渲染路径。提到顶层后，布局层（layouts.ts）可以直接读
   * `spec.accountTemplate.columns` / `.numbering`，渲染端才有生产者。
   */
  accountTemplate: AccountTemplate;
}

/* ------------------------------------------------------------------ */
/* 兜底                                                                */
/* ------------------------------------------------------------------ */

/** 非法 hex → null；合法则归一成大写 #RRGGBB。 */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  return m?.[1] ? `#${m[1].toUpperCase()}` : null;
}

/**
 * 收敛账号视觉模板。
 *
 * 【为什么必须有】profile.ts 的聚合 prompt 要求模型产出这个对象，但模型
 * 会给「白色」「rgb(255,255,255)」这类非法色值 —— 直接放行的话渲染端
 * 会把 `background:white` 写进 style 里，整条 CSS 失效。这里逐字段校验，
 * 有证据才收，没有任何字段能收就返回 undefined（调用方走默认回退）。
 *
 * 部分合法也**尽量保留**：比如页眉字段齐全、页脚缺失时，页眉仍值得渲染。
 */
export function coerceAccountTemplate(raw: unknown): AccountTemplate | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;

  const str = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.trim().replace(/\s+/g, ' ');
    return s.length > 0 ? s.slice(0, max) : null;
  };
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
  };

  const coverText = str(o.cover_header_text, 60);
  const coverSub = str(o.cover_header_sub, 60);
  const coverLogo = str(o.cover_logo_text, 20);
  const footerText = str(o.inner_footer_text, 60);
  const footerSub = str(o.inner_footer_sub, 60);
  const accent = normalizeHex(o.accent);
  const numbering =
    typeof o.numbering === 'string'
      ? ['none', '①', '№'].includes(o.numbering.trim()) || /^\d{2}$/.test(o.numbering.trim())
        ? o.numbering.trim()
        : null
      : null;
  const columns = num(o.columns);

  // 资产路径：只接受 assets/ 下的相对路径，防路径穿越。
  const assetPath = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return /^assets\/[\w\-./]+\.png$/.test(s) ? s : null;
  };
  const barHeight = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) && Number.isInteger(n) && n >= 60 && n <= 220 ? n : null;
  };
  const logoDark = assetPath(o.logo_asset_dark);
  const logoLight = assetPath(o.logo_asset_light);
  const headerH = barHeight(o.header_bar_height);
  const footerH = barHeight(o.footer_bar_height);
  const innerBodyTop = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) && Number.isInteger(n) && n >= 80 && n <= 600 ? n : null;
  };
  const bodyTop = innerBodyTop(o.inner_body_top);
  const prefix = str(o.numbering_prefix, 16);

  // 族标识：显式值优先；旧数据没这字段时按编号形态推断 ——
  // 有前缀（SHIFT·01 型）→ brand-case；纯数字大号 → ip-trend。
  // 判不出就落 generic，不硬套品牌族（错族比不套更糟）。
  const familyRaw = typeof o.family === 'string' ? o.family.trim() : '';
  const family: TemplateFamilyId =
    (TEMPLATE_FAMILIES as readonly string[]).includes(familyRaw)
      ? (familyRaw as TemplateFamilyId)
      : prefix
        ? 'wow-brand-case-v1'
        : numbering === 'none'
          ? 'generic-enum-v1'
          : 'wow-ip-trend-v1';

  // 一处真实证据都没有就不产出模板 —— 调用方回落到默认（无页眉无页脚）。
  if (!coverText && !footerText && !accent && !numbering && !columns) return undefined;

  return {
    family,
    cover_header_text: coverText ?? '',
    cover_header_sub: coverSub ?? '',
    cover_header_bg: normalizeHex(o.cover_header_bg) ?? DEFAULT_ACCOUNT_TEMPLATE.cover_header_bg,
    cover_header_ink: normalizeHex(o.cover_header_ink) ?? DEFAULT_ACCOUNT_TEMPLATE.cover_header_ink,
    cover_logo_text: coverLogo ?? '',
    inner_footer_text: footerText ?? '',
    inner_footer_sub: footerSub ?? '',
    inner_footer_bg: normalizeHex(o.inner_footer_bg) ?? DEFAULT_ACCOUNT_TEMPLATE.inner_footer_bg,
    inner_footer_ink: normalizeHex(o.inner_footer_ink) ?? DEFAULT_ACCOUNT_TEMPLATE.inner_footer_ink,
    // accent 没有证据就保持空 —— 空表示"无账号强调色"，渲染端回落主题色板。
    // 之前默认 '#007CFE' 会让无模板账号也被蓝色污染（无证据字段伪装成有证据）。
    accent: accent ?? '',
    numbering: numbering ?? DEFAULT_ACCOUNT_TEMPLATE.numbering,
    columns: columns ?? DEFAULT_ACCOUNT_TEMPLATE.columns,
    ...(logoDark ? { logo_asset_dark: logoDark } : {}),
    ...(logoLight ? { logo_asset_light: logoLight } : {}),
    ...(headerH ? { header_bar_height: headerH } : {}),
    ...(footerH ? { footer_bar_height: footerH } : {}),
    ...(prefix ? { numbering_prefix: prefix } : {}),
    ...(bodyTop ? { inner_body_top: bodyTop } : {}),
  };
}

/**
 * 把任意输入收成一个合法契约。
 *
 * 为什么必须有：模型输出经常缺字段、给出不存在的枚举值、或把数字写成字符串。
 * 旧代码在这条路上直接崩（`sanitizeSpec` 里 `spec.palette.map` 遇到 undefined
 * 就抛 TypeError，异常冒到定时任务层）。这里的契约是**永远能返回一个可用值**。
 */
export function coerceContract(raw: unknown): DesignContract {
  const o = (raw ?? {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
  };

  const indexRaw = Number(o.palette_index);
  const motifsRaw = Array.isArray(o.motifs) ? o.motifs : [];
  const motifs = motifsRaw
    .map((m) => (typeof m === 'string' ? m.trim().toLowerCase() : ''))
    .filter((m): m is Motif => (MOTIFS as readonly string[]).includes(m))
    .slice(0, 3);

  // account_template 必须穿过这条兜底 —— 之前只重建 7 个枚举字段，
  // 蒸馏/聚合产出的账号模板在这里被静默丢弃，渲染端拿不到（证据见
  // normalizeContract 的运行时断言：带完整模板输入 → account_template === null）。
  const account_template = coerceAccountTemplate(o.account_template);

  return {
    theme: pick(o.theme, THEMES, DEFAULT_CONTRACT.theme),
    palette_index: Number.isFinite(indexRaw) && indexRaw >= 0 ? Math.floor(indexRaw) : 0,
    type_scale: pick(o.type_scale, TYPE_SCALES, DEFAULT_CONTRACT.type_scale),
    density: pick(o.density, DENSITIES, DEFAULT_CONTRACT.density),
    texture: pick(o.texture, TEXTURES, DEFAULT_CONTRACT.texture),
    motifs: motifs.length > 0 ? motifs : [...DEFAULT_CONTRACT.motifs],
    accent_style: pick(o.accent_style, ACCENT_STYLES, DEFAULT_CONTRACT.accent_style),
    ...(account_template ? { account_template } : {}),
  };
}
