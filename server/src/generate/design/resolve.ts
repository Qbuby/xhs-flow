import {
  DENSITY_SPECS,
  FONT_MONO,
  FONT_SANS,
  FONT_SERIF,
  PALETTES,
  TYPE_SCALES,
} from './palettes.js';
import {
  coerceContract,
  type DesignContract,
  type DensitySpec,
  type Motif,
  type Palette,
  type ResolvedSpec,
  type Texture,
  type ThemeName,
  type TypeScaleSpec,
} from './contract.js';

/**
 * 契约 → 具体 token。
 *
 * 职责边界：契约（模型产出的）是「选了什么」，ResolvedSpec 是「渲染器要用的
 * 具体值」。中间这一层负责三件事：
 *
 *  1. **越界收敛** —— palette_index 可能超范围，取模而不是报错（模型不知道
 *     每个主题有几套色板）
 *  2. **主题白名单** —— 每套视觉语言只接受「语义上不打架」的纹理与装饰。
 *     比如「实证」主题给个柔焦光晕就荒唐了，「图桥」主题加发丝网格也多余。
 *     模型选错就回落到该主题的第一个允许项，不让它把版面搞乱。
 *  3. **字体按语义分派** —— 标题和正文可能用不同字体族（静纸：衬线标题 + 无衬线正文）
 *
 * 每套主题还带一个「版式配方」：不同视觉语言的边距、留白、标题行数上限
 * 本来就该不一样。「实证」是档案风，信息密度天然更高；「静纸」要大留白。
 */

interface ThemeRecipe {
  paletteSet: readonly Palette[];
  /** 允许的纹理；模型选的不在列表里就取第一项 */
  textures: readonly Texture[];
  /** 允许的装饰件；模型选的取交集，空则用主题默认 */
  motifs: readonly Motif[];
  defaultMotifs: readonly Motif[];
  fontTitle: string;
  fontBody: string;
  /** 密度基线：主题会整体调松/调紧一档 */
  densityBias: number;
  /** 标题最多几行（超过就要在生成端截短，见 pipeline 的视觉约束块） */
  maxTitleLines: number;
}

const RECIPES: Record<ThemeName, ThemeRecipe> = {
  /**
   * 静纸：暖纸底 + 衬线大字 + 朱砂点 + 大留白。
   * 杂志/画册的气质，信息克制，靠留白与字号对比立住。
   */
  'still-paper': {
    paletteSet: PALETTES['still-paper']!,
    textures: ['paper-grain', 'film-grain', 'haze-blob', 'none'],
    motifs: ['rule', 'rule-fade', 'badge', 'page-num', 'bracket', 'dots', 'vertical-tag', 'corner'],
    defaultMotifs: ['rule', 'page-num'],
    fontTitle: FONT_SERIF,
    fontBody: FONT_SANS,
    densityBias: +1, // 往松里调一档
    maxTitleLines: 3,
  },

  /**
   * 实证：奶白档案纸 + 电蓝 + 细线 + 等宽元信息 + 印章。
   * 像一份可引用的结论文件，而不是海报 —— 适合讲流程/数据/判断的内容。
   */
  'signal-proof': {
    paletteSet: PALETTES['signal-proof']!,
    textures: ['hairline-grid', 'halftone', 'paper-grain', 'none'],
    motifs: ['rule', 'rule-fade', 'badge', 'seal', 'ticker', 'bracket', 'page-num', 'dots'],
    defaultMotifs: ['rule-fade', 'badge', 'page-num'],
    fontTitle: FONT_SANS,
    fontBody: FONT_SANS,
    densityBias: -1, // 档案风天然更密
    maxTitleLines: 4,
  },

  /**
   * 图桥：满铺影像 + 黑边字幕 + 电影感。
   * 靠图吃饭；没有好图时退化成暗底大字，仍然成立。
   */
  'bridge-canvas': {
    paletteSet: PALETTES['bridge-canvas']!,
    textures: ['film-grain', 'none'],
    motifs: ['ticker', 'vertical-tag', 'corner', 'page-num'],
    defaultMotifs: ['ticker'],
    fontTitle: FONT_SERIF,
    fontBody: FONT_SANS,
    densityBias: 0,
    maxTitleLines: 3,
  },
};

/** 密度档位按主题偏移。bias 为 +1 表示「往松里推一档」。 */
const DENSITY_ORDER = ['dense', 'standard', 'airy'] as const;

function shiftDensity(base: keyof typeof DENSITY_SPECS, bias: number): DensitySpec {
  const i = DENSITY_ORDER.indexOf(base as (typeof DENSITY_ORDER)[number]);
  const j = Math.max(0, Math.min(DENSITY_ORDER.length - 1, i + bias));
  return DENSITY_SPECS[DENSITY_ORDER[j]!]!;
}

/** 契约 → 可渲染的具体规格。永远不会抛。 */
export function resolveSpec(raw: unknown): ResolvedSpec {
  const contract: DesignContract = coerceContract(raw);
  const recipe = RECIPES[contract.theme];

  // palette_index 越界取模 —— 模型不知道每个主题有几套
  const paletteSet = recipe.paletteSet;
  const palette = paletteSet[contract.palette_index % paletteSet.length]!;

  // 主题白名单收敛
  const texture: Texture = recipe.textures.includes(contract.texture)
    ? contract.texture
    : (recipe.textures[0] ?? 'none');

  const picked = contract.motifs.filter((m) => recipe.motifs.includes(m));
  const motifs: Motif[] = picked.length > 0 ? picked : [...recipe.defaultMotifs];

  const type = TYPE_SCALES[contract.type_scale] ?? TYPE_SCALES['standard']!;
  const density = shiftDensity(contract.density, recipe.densityBias);

  return {
    contract,
    theme: contract.theme,
    palette,
    type,
    density,
    fontTitle: recipe.fontTitle,
    fontBody: recipe.fontBody,
    allowedTextures: recipe.textures,
    allowedMotifs: recipe.motifs,
    texture,
    motifs,
    accentStyle: contract.accent_style,
  };
}

/** 主题标题行数上限，生成端用来约束标题长度。 */
export function maxTitleLines(theme: ThemeName): number {
  return RECIPES[theme].maxTitleLines;
}

/** 给提示词用：列出该主题能选的纹理/装饰，让模型知道边界。 */
export function describeThemeOptions(theme: ThemeName): {
  textures: readonly Texture[];
  motifs: readonly Motif[];
  palettes: readonly Palette[];
  fontMonoish: string;
} {
  const r = RECIPES[theme];
  return {
    textures: r.textures,
    motifs: r.motifs,
    palettes: r.paletteSet,
    fontMonoish: FONT_MONO,
  };
}

export { RECIPES as THEME_RECIPES };
