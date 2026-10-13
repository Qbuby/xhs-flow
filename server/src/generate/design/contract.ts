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

export const DesignContractSchema = z.object({
  theme: z.enum(THEMES).describe('视觉语言：still-paper 静纸 / signal-proof 实证 / bridge-canvas 图桥'),
  palette_index: z
    .number()
    .int()
    .min(0)
    .describe('从该主题的固定色板组里选第几套（越界会自动取模）'),
  type_scale: z.enum(TYPE_SCALES).describe('字号阶梯：compact 紧凑 / standard 标准 / display 展示级'),
  density: z.enum(DENSITIES).describe('密度：airy 留白多 / standard / dense 信息密集'),
  texture: z.enum(TEXTURES).describe('纹理层，建议按主题给的可选项里挑'),
  motifs: z.array(z.enum(MOTIFS)).describe('装饰件，0-3 个即可，不要堆'),
  accent_style: z.enum(ACCENT_STYLES).describe('强调词的处理方式'),
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

/** 还没生成画像时的默认契约。 */
export const DEFAULT_CONTRACT: DesignContract = {
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
}

/* ------------------------------------------------------------------ */
/* 兜底                                                                */
/* ------------------------------------------------------------------ */

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

  return {
    theme: pick(o.theme, THEMES, DEFAULT_CONTRACT.theme),
    palette_index: Number.isFinite(indexRaw) && indexRaw >= 0 ? Math.floor(indexRaw) : 0,
    type_scale: pick(o.type_scale, TYPE_SCALES, DEFAULT_CONTRACT.type_scale),
    density: pick(o.density, DENSITIES, DEFAULT_CONTRACT.density),
    texture: pick(o.texture, TEXTURES, DEFAULT_CONTRACT.texture),
    motifs: motifs.length > 0 ? motifs : [...DEFAULT_CONTRACT.motifs],
    accent_style: pick(o.accent_style, ACCENT_STYLES, DEFAULT_CONTRACT.accent_style),
  };
}
