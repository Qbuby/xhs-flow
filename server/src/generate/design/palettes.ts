import type { DensitySpec, Palette, TypeScaleSpec } from './contract.js';

/**
 * 三套视觉语言。
 *
 * 参考 blcaptain-style-skill（NOASSERTION，**只借鉴方法论、不拷代码**）的核心论点：
 * 「大多数 AI 工具做的是网页，不是杂志。图文卡片的本质和海报、画报、
 * 专辑封面是同一种东西。」它把审美拆成「1 个引擎 + N 套视觉语言」而不是
 * 「一套模板 + 换颜色」，因为换颜色只是在同一张脸上涂不同的漆。
 *
 * 我们的三套：
 *
 *   still-paper    静纸 —— 暖纸底 + 衬线大字 + 朱砂点 + 大留白。
 *                  最贴合小红书品牌/生活方式类语料，也是原本的取向，做精。
 *
 *   signal-proof   实证 —— 奶白档案纸 + 电蓝 + 细分隔线 + 等宽元信息 + 印章。
 *                  为「品牌营销/方法论」类语料准备的：像一份可引用的证据文件，
 *                  而不是一张海报。适合讲流程、数据、结论的内容。
 *
 *   bridge-canvas  图桥 —— 满铺影像 + 黑边字幕 + 电影感。
 *                  给 photo_text 主导的内容；没有好图时退化成暗底大字。
 *
 * 色板刻意**固定**：给无限的颜色选择只会做出难看的东西。
 * 模型只能选「第几套」，不能填 hex。
 */

/* ------------------------------------------------------------------ */
/* 色板                                                                */
/* ------------------------------------------------------------------ */

const STILL_PAPER_PALETTES: Palette[] = [
  {
    name: '雾野',
    bg: '#F7F3EC',
    ink: '#26221E',
    inkSoft: '#6E645C',
    accent: '#C4553C',
    tint: '#EFE6D8',
    deep: '#2C2723',
  },
  {
    name: '素瓷',
    bg: '#FBF9F6',
    ink: '#1F1D1B',
    inkSoft: '#78716C',
    accent: '#8C6A4A',
    tint: '#F1EBE2',
    deep: '#33302C',
  },
  {
    name: '青苔',
    bg: '#F4F5F0',
    ink: '#22271F',
    inkSoft: '#666E60',
    accent: '#4F6B4A',
    tint: '#E7EBE0',
    deep: '#2A3226',
  },
  {
    name: '夜读',
    bg: '#26231F',
    ink: '#F5F0E8',
    inkSoft: '#B4AAA0',
    accent: '#E0A860',
    tint: '#332F29',
    deep: '#141210',
  },
  {
    name: '藕荷',
    bg: '#F8F1F2',
    ink: '#2B2225',
    inkSoft: '#7A6A70',
    accent: '#A05068',
    tint: '#F0E2E6',
    deep: '#332229',
  },
  {
    name: '沙砾',
    bg: '#F2EDE4',
    ink: '#2B2620',
    inkSoft: '#736A5C',
    accent: '#B07A34',
    tint: '#E9E0D2',
    deep: '#302A22',
  },
];

const SIGNAL_PAPER_PALETTES: Palette[] = [
  {
    name: '档案蓝',
    bg: '#F7F8FA',
    ink: '#111827',
    inkSoft: '#5B6472',
    accent: '#1D4ED8',
    tint: '#E8EDF9',
    deep: '#0F172A',
  },
  {
    name: '校对红',
    bg: '#FAF8F5',
    ink: '#1A1A1A',
    inkSoft: '#606060',
    accent: '#C2261E',
    tint: '#F2E9E6',
    deep: '#1C1917',
  },
  {
    name: '终端绿',
    bg: '#F6F8F6',
    ink: '#141915',
    inkSoft: '#5A665C',
    accent: '#177245',
    tint: '#E4EEE7',
    deep: '#101713',
  },
  {
    name: '墨炭',
    bg: '#1A1C1F',
    ink: '#F2F4F7',
    inkSoft: '#9AA4B0',
    accent: '#4DA3FF',
    tint: '#242830',
    deep: '#0B0D10',
  },
  {
    name: '图纸黄',
    bg: '#FBF9F0',
    ink: '#1F1D14',
    inkSoft: '#6B6550',
    accent: '#9A6A00',
    tint: '#F1EBD6',
    deep: '#28251A',
  },
];

const BRIDGE_CANVAS_PALETTES: Palette[] = [
  {
    name: '银幕',
    bg: '#101012',
    ink: '#FAFAFA',
    inkSoft: '#B9B9BF',
    accent: '#E8B44A',
    tint: '#1C1C20',
    deep: '#000000',
  },
  {
    name: '蓝调',
    bg: '#0E1218',
    ink: '#F2F6FA',
    inkSoft: '#A9B6C4',
    accent: '#5AA9E6',
    tint: '#161C25',
    deep: '#05080C',
  },
  {
    name: '暖褐',
    bg: '#18130F',
    ink: '#F7F1E9',
    inkSoft: '#BFAE9D',
    accent: '#D98E48',
    tint: '#221B15',
    deep: '#0A0705',
  },
  {
    name: '墨绿',
    bg: '#0D1412',
    ink: '#EFF5F1',
    inkSoft: '#A6B6AE',
    accent: '#6FBF9B',
    tint: '#141C19',
    deep: '#050807',
  },
];

export const PALETTES: Record<string, readonly Palette[]> = {
  'still-paper': STILL_PAPER_PALETTES,
  'signal-proof': SIGNAL_PAPER_PALETTES,
  'bridge-canvas': BRIDGE_CANVAS_PALETTES,
};

/* ------------------------------------------------------------------ */
/* 字号阶梯                                                            */
/* ------------------------------------------------------------------ */

/**
 * 字号阶梯。
 *
 * ⚠️ 命名注意：本文件导出的 `TYPE_SCALES` 是**规格记录**（键 → 具体 px），
 * 而 `contract.ts` 导出的同名 `TYPE_SCALES` 是**枚举数组**（可选档位列表）。
 * 两者在 `design/index.ts` 里会撞车，那边显式让本文件的记录版胜出，
 * 需要「列出所有档位」的地方请用 `TYPE_SCALE_IDS`（见 contract.ts）。
 *
 * 中文卡片在 1080px 宽下的字号节奏。
 *
 * ⚠️ 中文的字距必须是 0 —— 加 tracking 会让汉字之间出现难看的缝隙。
 * 需要 tracking 的只有拉丁小字（eyebrow / 元信息 / 页码），所以
 * `latinTracking` 单独一个字段，绝不用在中文上。
 *
 * （这条规则参照 heti（MIT，https://github.com/sivan/heti）的中西文分治：
 *  它显式给 `p { letter-spacing: $letter-spacing-medium }` 但
 *  `@include non-cjk-block { letter-spacing: normal }`，两边独立验证同一结论。）
 */
export const TYPE_SCALES: Record<string, TypeScaleSpec> = {
  compact: {
    display: 84,
    title: 60,
    body: 32,
    caption: 22,
    meta: 20,
    titleLineHeight: 1.28,
    bodyLineHeight: 1.68,
    latinTracking: '0.1em',
  },
  standard: {
    display: 104,
    title: 72,
    body: 34,
    caption: 23,
    meta: 21,
    titleLineHeight: 1.24,
    bodyLineHeight: 1.62,
    latinTracking: '0.12em',
  },
  display: {
    display: 132,
    title: 88,
    body: 36,
    caption: 24,
    meta: 22,
    titleLineHeight: 1.16,
    bodyLineHeight: 1.58,
    latinTracking: '0.14em',
  },
};

/* ------------------------------------------------------------------ */
/* 密度                                                                */
/* ------------------------------------------------------------------ */

export const DENSITY_SPECS: Record<string, DensitySpec> = {
  airy: { paddingY: 112, paddingX: 96, gap: 40, maxItems: 4, maxBodyLines: 4 },
  standard: { paddingY: 96, paddingX: 88, gap: 32, maxItems: 5, maxBodyLines: 5 },
  dense: { paddingY: 76, paddingX: 72, gap: 24, maxItems: 7, maxBodyLines: 7 },
};

/* ------------------------------------------------------------------ */
/* 字体栈                                                              */
/* ------------------------------------------------------------------ */

/**
 * 字体。
 *
 * 优先用真正存在的品牌字体/开源字体，最后退回系统栈。
 * 注意 Windows 上微软雅黑是 `.ttc`（字体集合），这也是本项目当初
 * 不选 satori 的原因 —— 那段论证仍然有效，Chromium 能直接用系统字体。
 *
 * 衬线：本机 `C:\Windows\Fonts\NotoSerifSC-VF.ttf` 实测存在，
 * 所以「衬线大字」这条设计手段不用捆绑字体就能用。
 * 缺失时自动退到宋体/思源宋体，再退到无衬线 —— 版式不会崩，只是气质弱一点。
 */
export const FONT_SERIF = [
  '"Noto Serif SC"',
  '"Source Han Serif SC"',
  '"Songti SC"',
  'SimSun',
  'serif',
].join(', ');

export const FONT_SANS = [
  '"Microsoft YaHei"',
  '"微软雅黑"',
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  '"Noto Sans SC"',
  '"Source Han Sans SC"',
  'sans-serif',
].join(', ');

/** 等宽：给「实证」主题的元信息块用。中文在等宽字体下也正常。 */
export const FONT_MONO = [
  'ui-monospace',
  '"SF Mono"',
  'Consolas',
  '"Cascadia Mono"',
  '"Noto Sans Mono CJK SC"',
  'monospace',
].join(', ');
