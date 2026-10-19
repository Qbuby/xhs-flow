import type { Page } from 'playwright';
import sharp from 'sharp';
import { browser } from '../xhs/browser.js';
import { MEDIA_DIR } from '../config.js';
import { getStyleProfile } from '../corpus/profile.js';
import { stripEmoji } from '../util/text.js';
import { logger } from '../logger.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { searchStock, toSearchHint } from '../media/stock.js';
import type { StockImage } from '../media/stock.js';
import { escapeHtml, highlightHtml } from './card-text.js';
import {
  DEFAULT_CONTRACT,
  backgroundCss,
  badgeText,
  motifLayer,
  photoScrim,
  resolveSpec,
  textureLayer,
  toResolved,
  type MotifContext,
  type ResolvedSpec,
} from './design/index.js';
import { layoutBody, motifZone } from './layouts.js';
import {
  DEFAULT_ACCOUNT_TEMPLATE,
  FAMILY_NUMBERING,
  FOOTER_BAR_HEIGHT,
  HEADER_BAR_HEIGHT,
  type AccountTemplate,
} from './design/contract.js';

/**
 * 卡片渲染器。
 *
 * 走 Playwright + HTML/CSS 而不是 satori：satori 不支持 .ttc 字体集合，
 * 而 Windows 上默认的中文字体（微软雅黑 msyh.ttc）恰好就是 .ttc，
 * 走那条路必踩字体坑。用 Chromium 则系统字体栈免费拿，
 * 中文断行、grid、阴影、渐变、blend mode、SVG 全都正常。
 *
 * 尺寸固定 1080×1440 —— 小红书原生 3:4。
 *
 * ── 2026-10 重构：从「简约到生硬」到有设计感的版面 ────────────────────
 *
 * 之前的问题不是"CSS 写得不够好"，而是**架构上只允许那么多元素**：
 *   - 7 种版式共用一个 `body > .card > [decoration, .content, .footer]` 骨架，
 *     `.content` 是 flex column + justify-center，所以每张卡都长一个样
 *   - 装饰只有「一个 CSS 三角」或「三个 · 字符」两种
 *   - 旧的卡级 `radius` 是死字段：截图不带 omitBackground，JPEG 没透明通道，
 *     圆角只会被白角吃掉（重做时直接取消了这个字段，卡片四角就是方的，
 *     需要"圆角感"的地方由装饰件自己做内衬框）
 *   - 清洗管线还顺手删掉了作者有意放的 ①②③、❌、✓、↓
 *
 * 现在分成三层，各自独立可换：
 *   1. **纹理层**（design/textures.ts）—— 纸张/胶片颗粒、半调网点、发丝网格、
 *      柔焦光晕。一层 feTurbulence 噪点就能把"廉价大色块"变成"印刷品"。
 *   2. **装饰层**（design/motifs.ts）—— 可组合的内联 SVG 件（分隔线、编号徽章、
 *      印章、走马灯条、竖排标签、页码…），绝对定位、不参与布局，所以永远不会
 *      把内容挤变形。
 *   3. **内容层**（layouts.ts）—— 每个版式**自持骨架**，不再共用居中一列。
 *
 * 设计参数来自**契约**（design/contract.ts）：模型不再自由填 hex 和 px，
 * 而是在「三套视觉语言 × 固定色板 × 字号阶梯 × 密度档」里做选择。
 * 旧画像（18 字段的 CardTemplateSpec）通过 design/migrate.ts 自动映射，不用重蒸馏。
 */

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1440;

// 页眉/页脚条高度常量收进 design/contract.ts（HEADER_BAR_HEIGHT=128、
// FOOTER_BAR_HEIGHT=126，实测值）；这里 re-export 保持旧引用（diagnostics）可用。
export { HEADER_BAR_HEIGHT, FOOTER_BAR_HEIGHT } from './design/contract.js';

export const LAYOUTS = ['cover', 'quote', 'list', 'steps', 'compare', 'photo_text', 'cta'] as const;
export type Layout = (typeof LAYOUTS)[number];

export interface CardContent {
  layout: Layout;
  /** 版式相关的文案块，字段由各版式自行解释 */
  blocks: Record<string, unknown>;
  /** photo_text 用的检索关键词（渲染时去图库取图） */
  photoQuery?: string;
  /** 已下载好的底图（本地绝对路径），有则优先用它 */
  photoPath?: string;
}

export interface Card {
  layout: Layout;
  blocks: Record<string, unknown>;
  photoUrl?: string;
  imagePath?: string;
  /**
   * 卡片在整组图中的序号（0 起）。编号样式为 "01" 时渲染成
   * `String(index + 1).padStart(2, '0')` —— 第 i 张内页就是 01/02/03…，
   * 不再恒为 '01'。调用方不给时按 0 处理。
   */
  index?: number;
}

/* ------------------------------------------------------------------ */
/* 默认规格                                                            */
/* ------------------------------------------------------------------ */

/**
 * 还没有画像时用的默认规格。
 *
 * 注意这里给的是**新契约**（`DEFAULT_CONTRACT`），不是旧那 18 个字段 ——
 * 旧形状的 `DEFAULT_SPEC` 已经删了：它的最后一个调用方（/api/sources/:id）
 * 现在直接调 `toResolved()`，不需要一个假的旧 spec 当中转。
 * 库里仍可能有旧画像，那由 `toResolved()` 内的迁移负责。
 */
export const DEFAULT_RESOLVED: ResolvedSpec = resolveSpec(DEFAULT_CONTRACT);

/**
 * 取某个来源的视觉规格。
 *
 * 三种输入都能吃：新契约、旧画像、什么都没有。**永不抛** ——
 * 上游可能拿到坏 JSON 或缺字段的对象，渲染一张图不该因此失败。
 */
export function specForSource(sourceId: number | null): ResolvedSpec {
  if (!sourceId) return DEFAULT_RESOLVED;
  try {
    const found = getStyleProfile(sourceId);
    return toResolved(found?.profile.card_template_spec);
  } catch (err) {
    logger.warn({ err, sourceId }, '读取风格规格失败，用默认规格');
    return DEFAULT_RESOLVED;
  }
}

/* ------------------------------------------------------------------ */
/* 文本                                                                */
/* ------------------------------------------------------------------ */

/**
 * 文本管线（escapeHtml / highlightHtml / rich / richWith）已经搬进
 * `card-text.ts` —— layouts.ts 也要用同一套 `[[ ]]` 处理，而 cards.ts
 * import layouts.ts，反向导出会成环。这里 re-export 保持旧引用可用。
 */
export { escapeHtml, highlightHtml } from './card-text.js';

/**
 * 卡片文案的统一入口：清 emoji、去标记、转义。
 *
 * emoji 必须在渲染入口清掉（而不是只靠 prompt）：卡片是矢量排版，
 * 彩色 emoji 走位图字体，跟字重和配色完全不搭，一出现就破坏版面统一。
 * 注意 `stripEmoji` 现在保留了 ①②③ / ❌ / ✓ / → 这类单色符号（见 util/text.ts）。
 */
function esc(v: unknown): string {
  return escapeHtml(stripEmoji(String(v ?? '')));
}

/** 默认规格下的强调标记文案（历史上给过 diagnostics 用，保留导出）。 */
export function rich(v: unknown): string {
  return highlightHtml(stripEmoji(String(v ?? '')), DEFAULT_RESOLVED);
}

/**
 * 按当前规格渲染含 `[[强调]]` 的文案。
 *
 * 需要 spec 是因为 `accent_style` 决定强调怎么画 —— 这个信息在
 * `esc()` 那一层拿不到。
 */
function richWith(v: unknown, spec: ResolvedSpec): string {
  return highlightHtml(stripEmoji(String(v ?? '')), spec);
}

/* ------------------------------------------------------------------ */
/* CSS                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 强调色的 CSS 片段。
 *
 * 五种样式各自的适用场景不同，这是给生成端写提示词时的依据：
 *   underline 下划线  —— 适合短语（4-8 字）
 *   block     色块反白 —— 只适合 2-4 字
 *   highlight 荧光笔  —— 适合 2-5 字短词
 *   bracket   左侧竖线 —— 适合一句短句
 *   none      不加修饰 —— 强调靠语义本身
 */
function accentCss(spec: ResolvedSpec): string {
  const a = 'var(--accent)';
  switch (spec.accentStyle) {
    case 'none':
      return `.hl{font-weight:inherit}`;
    case 'underline':
      return `.hl{box-shadow:inset 0 -0.24em 0 ${a};padding-bottom:0.04em}`;
    case 'block':
      return `.hl{background:${a};color:var(--on-accent);padding:0 .18em;border-radius:.14em;box-decoration-break:clone;-webkit-box-decoration-break:clone}`;
    case 'bracket':
      return `.hl{box-shadow:inset .18em 0 0 ${a};padding-left:.3em;color:var(--accent)}`;
    case 'highlight':
    default:
      return `.hl{background:linear-gradient(transparent 58%, color-mix(in srgb, ${a} 42%, transparent) 58%);}`;
  }
}

/**
 * 全局 CSS。
 *
 * 【中文排版规则】—— 参照 heti（MIT，https://github.com/sivan/heti）的中西文分治：
 *
 *  1. **汉字不加字距**。给汉字加 `letter-spacing` 会让字与字之间出现难看的
 *     缝隙（印刷上的"散字"）。只有纯拉丁才加 tracking，所以这里分成
 *     `.cjk`（=0）和 `.latin`（加 tracking）两个类。
 *     heti 里的对应写法是：`letter-spacing: $medium` 但
 *     `@include non-cjk-block { letter-spacing: normal }`。
 *  2. **中文禁用斜体**。`font-style: italic` 会让汉字发生仿斜变形，很难看；
 *     强调改用字重 / 颜色 / 着重号。
 *  3. **中文段落 justify，西文左对齐**。
 *  4. **`text-wrap: balance`** 给大标题，避免出现「一行只有三四个字」的碎片断行。
 */
function baseCss(spec: ResolvedSpec, opts: { photoDataUri?: string } = {}): string {
  const p = spec.palette;
  const t = spec.type;
  const d = spec.density;
  const dark = isDark(p.bg);
  const bg = opts.photoDataUri ? p.deep : p.bg;

  // 账号模板带蒸馏出的强调色时，覆盖契约色板 —— 原账号的亮蓝 #007CFE
  // 之前被 palette_index 的固定色板顶掉，验收要求 toResolved().palette.accent
  // 能拿到蒸馏色。CSS 变量只在这里定义一次，改这里全卡生效。
  // 空字符串 = 无账号强调色证据 → 严格回落主题色板，不再有默认蓝污染。
  const accent = spec.accountTemplate.accent || p.accent;
  // 有账号模板 = 复刻模式：**禁用通用渐变背景**。原账号内页是平涂
  // #FAFAFA、封面纯白 —— signal-proof 主题的 #EAF3FF 渐变会把 rgba
  // 编号等前景色整体染浅（实测编号从 #D6EAFF 变 #F0F7FF），也让底色
  // 偏离原图。渐变只属于通用主题的"设计感"，复刻模式没有它。
  const templateActive = !!(spec.accountTemplate.cover_header_text || spec.accountTemplate.inner_footer_text);
  // 内页有页脚条时，老的 .footer（署名/水印行）必须让开**整条高度**再加间距，
  // 否则压在条上。之前只加了 paddingY 的 62%（约 47-70px），dense 档下
  // 内容区仍与条顶重叠 50px —— 修复为条高优先。
  const hasFooterBar = !!(spec.accountTemplate.inner_footer_text);
  const footerH = spec.accountTemplate.footer_bar_height ?? FOOTER_BAR_HEIGHT;
  const footerBottom = hasFooterBar
    ? footerH + 28
    : Math.round(d.paddingY * 0.62);

  return `
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    html,body{width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px;overflow:hidden}

    :root{
      --bg:${bg};
      --ink:${opts.photoDataUri ? '#FFFFFF' : p.ink};
      --ink-soft:${opts.photoDataUri ? 'rgba(255,255,255,.82)' : p.inkSoft};
      --accent:${accent};
      --accent-soft:${hexAlpha(accent, dark ? 0.22 : 0.13)};
      --on-accent:${isDark(accent) ? '#FFFFFF' : p.deep};
      --tint:${p.tint};
      --deep:${p.deep};
      --panel:${dark ? hexAlpha('#FFFFFF', 0.06) : hexAlpha(p.deep, 0.045)};
      --hairline:${dark ? hexAlpha('#FFFFFF', 0.16) : hexAlpha(p.deep, 0.13)};
      --gap:${d.gap}px;
      --font-title:${spec.fontTitle};
      --font-body:${spec.fontBody};
      --scrim:${photoScrim(dark ? 0.82 : 0.74)};
    }

    body{
      font-family:var(--font-body);
      -webkit-font-smoothing:antialiased;
      text-rendering:optimizeLegibility;
      color:var(--ink);
      background-color:var(--bg);
      background-image:${opts.photoDataUri || templateActive ? 'none' : backgroundCss({ bg: p.bg, palette: p, dark })};
    }

    .card{
      width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px;position:relative;
      padding:${d.paddingY}px ${d.paddingX}px;
      overflow:hidden;
    }

    /* ---- 排版语义类 ---- */
    .t-title{
      font-weight:800;
      line-height:${t.titleLineHeight};
      /* 汉字不加字距 —— 加了会散字 */
      letter-spacing:0;
    }
    /* 只有纯拉丁标题才收紧字距（拉丁字母在大字号下需要负字距） */
    .t-title.latin{letter-spacing:-0.02em}
    .balance{text-wrap:balance}

    .t-body{
      font-size:${t.body}px;
      line-height:${t.bodyLineHeight};
      letter-spacing:0;
      color:var(--ink-soft);
      font-weight:400;
      font-style:normal; /* 中文禁用斜体 */
    }

    .t-meta{
      font-size:${t.meta}px;
      letter-spacing:${t.latinTracking};
      text-transform:uppercase;
      color:var(--accent);
      font-weight:700;
      line-height:1.4;
    }

    /* 中文段落两端对齐；西文左对齐（justify 会把英文单词间距拉散） */
    .cjk{text-align:justify;text-justify:inter-ideograph}
    .latin{text-align:left}

    .rule-fade{height:1px;background:linear-gradient(90deg,var(--accent) 0%,${hexAlpha(p.accent, 0.28)} 36%,transparent 100%)}

    .footer{
      position:absolute;left:${d.paddingX}px;right:${d.paddingX}px;bottom:${footerBottom}px;
      display:flex;justify-content:space-between;align-items:flex-end;
      font-size:${t.caption}px;line-height:1.4;
      color:var(--ink-soft);opacity:.72;z-index:4;
    }

    /* 强调样式 */
    ${accentCss(spec)}
  `;
}

function isDark(hex: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  // 相对亮度（sRGB 加权），比简单平均更接近人眼感受
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}

/** #RRGGBB + alpha → rgba()。 */
function hexAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return `rgba(0,0,0,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/* ------------------------------------------------------------------ */
/* HTML 组装                                                           */
/* ------------------------------------------------------------------ */

/**
 * 品牌 logo 资产缓存：进程内读一次，buildCardHtml（同步）直接取 data URI。
 *
 * 为什么不走 HTTP：渲染用 page.setContent（无 base URL），相对路径解析不了；
 * file:// 又要绕 notAllowedReload。资产总共几 KB，内存缓存最省事。
 * 找不到文件时回落文字 logo，渲染不该因资产缺失而失败。
 */
const brandAssetCache = new Map<string, string | null>();

function brandAssetDataUri(relPath: string): string | null {
  if (brandAssetCache.has(relPath)) return brandAssetCache.get(relPath)!;
  let uri: string | null = null;
  try {
    // relPath 形如 assets/brand/wow-logo-ink.png（coerceAccountTemplate 已校验格式）。
    // 从本文件位置反推仓库根：编译后是 dist/generate/cards.js，向上三级是仓库根。
    // 不能用 process.cwd()：服务可能从仓库根或 server/ 两种目录启动。
    // file: URL 必须经 fileURLToPath —— Windows 下 pathname 是 /D:/...，直接
    // path.resolve 会得到 D:\D:\...（实测踩过）。
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '..', '..', '..');
    const abs = path.join(repoRoot, 'server', relPath);
    const buf = fsSync.readFileSync(abs);
    uri = `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    uri = null;
  }
  brandAssetCache.set(relPath, uri);
  return uri;
}

/**
 * 账号 chrome：logo + 右对齐两行（主行 + 小字行）。
 *
 * 结构逐像素对照原账号（339/0.jpg 页眉、339/1.jpg 页脚，实测）：
 *   - 左：图形 logo 资产（有 logo_asset_* 时）或文字 logo；bbox 原图
 *     x≈63..239、y≈63..117 → 显示尺寸约 176×54，垂直居中于条内
 *   - 右：主行 + 第二行小字，两行右对齐，文字块 bbox x≈550..1005
 *   - 条高：模板实测值优先（原账号页眉 128 / 页脚 127），否则常量兜底
 * 封面只出页眉条，内页只出页脚条 —— 与原账号一致。
 *
 * 返回 { html, barHeight }：布局层要按同一高度扣除安全区，不能各算各的。
 */
function accountChrome(
  template: AccountTemplate,
  cover: boolean,
): { html: string; barHeight: number } {
  const headerH = template.header_bar_height ?? HEADER_BAR_HEIGHT;
  const footerH = template.footer_bar_height ?? FOOTER_BAR_HEIGHT;
  const barHeight = cover ? headerH : footerH;

  const main = cover ? template.cover_header_text : template.inner_footer_text;
  const sub = cover ? template.cover_header_sub : template.inner_footer_sub;
  const bg = cover ? template.cover_header_bg : template.inner_footer_bg;
  const ink = cover ? template.cover_header_ink : template.inner_footer_ink;
  const logo = template.cover_logo_text;

  if (!main && !sub && !logo) return { html: '', barHeight };

  const pos = cover ? 'top:0;left:0;right:0' : 'bottom:0;left:0;right:0';

  // 图形 logo：透明底 PNG，按原 bbox 标称尺寸等比放。深色条用浅色版。
  // 资产读不到（或路径非法）时回落文字 logo —— 渲染不因资产缺失而失败，
  // 但验收脚本会区分 logo_asset / logo_textual 两种保真等级。
  const dark = isDark(bg);
  const asset = dark ? template.logo_asset_light : template.logo_asset_dark;
  const safeAsset = asset && /^assets\/[\w\-./]+\.png$/.test(asset) ? asset : null;
  const dataUri = safeAsset ? brandAssetDataUri(safeAsset) : null;
  const logoHtml = dataUri
    ? `<img src="${dataUri}" alt="${esc(logo)}" data-smoke-logo
         style="height:54px;width:auto;display:block" />`
    : logo
      ? `<span style="font-size:44px;font-weight:800;letter-spacing:.02em;line-height:1">${esc(logo)}</span>`
      : '<span></span>';

  return {
    barHeight,
    html: `<div style="position:absolute;${pos};height:${barHeight}px;z-index:6;display:flex;align-items:center;justify-content:space-between;padding:0 66px;background:${bg};color:${ink}">
      ${logoHtml}
      <span style="display:flex;flex-direction:column;align-items:flex-end;text-align:right">
        ${main ? `<span style="font-size:28px;font-weight:800;letter-spacing:.02em;line-height:1.25">${esc(main)}</span>` : ''}
        ${sub ? `<span style="font-size:16px;font-weight:500;letter-spacing:.02em;line-height:1.4;opacity:.85;margin-top:4px">${esc(sub)}</span>` : ''}
      </span>
    </div>`,
  };
}

/**
 * 内页编号：**按模板族**渲染两种真实形态。
 *
 * wow-ip-trend-v1（339/1 实测）：大号浅蓝纯数字
 *   bbox 69..198 × 161..346，字面高约 88px，色 #D9E9FB
 *
 * wow-brand-case-v1（340/1 实测）：细字「前缀 · 数字」
 *   bbox 98..393 × 131..151，字面高约 20px，纯强调色 #007CFE、字间距拉开
 *   横向细线紧跟其后（原图是一条 1px 浅灰线通栏）
 *
 * 形态是**族特征**：把 340 画成大号浅蓝、或把 339 画成细字，都是原账号
 * 从未出现过的版式。numbering='none' 的族不画编号。
 *
 * ⚠️ 定位语义实测澄清：absolute 的包含块是 .card 的 **padding box**，
 * 原点 = border 内沿 = 画布原点（padding 不参与偏移）——
 * 之前按"从 padding 之后算"推成 top:10/left:-3，编号画到了画布左上角
 * 外沿（Playwright getBoundingClientRect 实证）。所以直接写画布坐标。
 */
function accountPageNumber(
  spec: ResolvedSpec,
  pageNo: string,
  isCover: boolean,
): string {
  if (isCover || !pageNo) return '';
  const t = spec.accountTemplate;
  if (t.numbering === 'none') return '';
  const style = FAMILY_NUMBERING[t.family ?? 'generic-enum-v1'];

  // blue-tag：顶部蓝底反白标签 + 白字（357/2 实测 bbox 99..324 × 99..166，
  // 约 226×68px）。标签本身即章节标记，不再叠加页码。
  if (style === 'blue-tag') {
    const prefix = t.numbering_prefix ?? '';
    const label = prefix ? `${prefix} ${pageNo}` : pageNo;
    return `<div aria-hidden="true" data-smoke-page-no style="position:absolute;
      top:99px;left:99px;display:inline-flex;align-items:center;justify-content:center;
      padding:0 26px;height:68px;
      background:var(--accent);color:var(--on-accent);
      font-size:30px;font-weight:800;line-height:1;
      z-index:5">${escapeHtml(label)}</div>`;
  }

  if (style === 'label-accent' || style === 'label-dark') {
    // 细字「PREFIX · NN」。brand-case 带后接通栏横线且用强调色；
    // label-dark 是正文深灰、无横线（351/366/372 实测）。
    const prefix = t.numbering_prefix ?? '';
    const label = prefix ? `${prefix} · ${pageNo}` : pageNo;
    const isAccent = style === 'label-accent';
    return `<div aria-hidden="true" data-smoke-page-no style="position:absolute;
      top:${isAccent ? 131 : 140}px;left:${isAccent ? 98 : 98}px;
      display:flex;align-items:center;gap:28px;width:calc(100% - 196px);
      font-size:20px;font-weight:700;letter-spacing:0.34em;text-transform:uppercase;
      line-height:1;color:${isAccent ? 'var(--accent)' : 'var(--ink)'};z-index:5">
      <span style="flex:0 0 auto;font-variant-numeric:tabular-nums">${escapeHtml(label)}</span>
      ${isAccent ? '<span style="flex:1;height:1px;background:var(--hairline)"></span>' : ''}
    </div>`;
  }

  // big-number（大号浅蓝纯数字）
  return `<div aria-hidden="true" data-smoke-page-no style="position:absolute;
    top:161px;left:69px;
    font-variant-numeric:tabular-nums;font-size:88px;font-weight:800;
    line-height:1;letter-spacing:0.01em;
    color:rgba(0,124,254,0.16);z-index:5">${escapeHtml(pageNo)}</div>`;
}

export function buildCardHtml(
  card: Card,
  spec: ResolvedSpec,
  photoDataUri?: string,
): string {
  const dark = isDark(spec.palette.bg);
  const b = card.blocks;

  // 编号语义与原账号一致（339/0=无编号、339/1=01、339/2=02，实测）：
  // 封面不占号，第一张内页（index=1）是 01。模型给的 watermark 仍优先。
  const modelWatermark = typeof b.watermark === 'string' ? b.watermark.trim() : '';
  const idx = card.index ?? 0;
  const pageNo = modelWatermark || (card.layout === 'cover' ? '' : badgeText(Math.max(0, idx - 1)));

  const motifCtx: MotifContext = {
    palette: spec.palette,
    dark,
    fontMono: `ui-monospace, Consolas, "Cascadia Mono", monospace`,
    fontBody: spec.fontBody,
    pageNo,
    tag: typeof b.eyebrow === 'string' ? b.eyebrow : undefined,
  };

  // 三层：纹理 → 装饰 → 内容。装饰与纹理都绝对定位、不吃布局，
  // 所以内容层可以自由改版式而不用管它们。
  // 复刻模式（有账号模板）关闭纹理与通用装饰：原账号内页没有噪点/网格，
  // 半透明纹理层会扰动像素验收（页脚条中位色、编号混色都被它移动）。
  const templateActive = !!(spec.accountTemplate.cover_header_text || spec.accountTemplate.inner_footer_text);
  const texture = templateActive
    ? ''
    : textureLayer({
        texture: spec.texture,
        bg: spec.palette.bg,
        accent: spec.palette.accent,
        tint: spec.palette.tint,
        dark,
        zIndex: 1,
      });

  const content = layoutBody(card.layout, {
    blocks: b,
    spec,
    photoDataUri,
    pageNo,
    motifCtx,
  });

  // 图卡自己铺底图，纹理层要压在底图之上、内容之下
  const isPhoto = card.layout === 'photo_text' && Boolean(photoDataUri);

  const template = spec.accountTemplate.cover_header_text || spec.accountTemplate.inner_footer_text
    ? spec.accountTemplate
    : (spec.contract.account_template ?? DEFAULT_ACCOUNT_TEMPLATE);
  // 有封面页眉条时，内容整体下移让出**整条高度**——之前 dense 档 paddingY=76
  // 小于条高 128，标题/装饰会顶进页眉条里；现在条高优先再加 24px 呼吸。
  // 内页同理让出页脚条：内容可用高度 = 画布 - 条高，而不是让绝对定位的
  // 条盖在内容上装作看不见。
  const chrome = accountChrome(template, card.layout === 'cover');
  const coverBarH = template.cover_header_text ? chrome.barHeight : 0;
  const footerBarH = !isCoverPage(card.layout) && template.inner_footer_text ? template.footer_bar_height ?? FOOTER_BAR_HEIGHT : 0;
  const topPad = coverBarH > 0
    ? Math.max(spec.density.paddingY, coverBarH + 24)
    : spec.density.paddingY;
  const chromeCss = `<style>.card{
    padding-top:${topPad}px !important;
    ${footerBarH > 0 ? `padding-bottom:${footerBarH + 28}px !important;` : ''}
  }
  /* 内容层的坐标原点 = .card 的 padding box 内沿 = 画布原点 + 顶部 padding。
     复刻版式要按**画布坐标**落位（标题 y=266 是原图实测），所以把
     注入的顶部 padding 暴露成变量，布局层用 calc 抵扣，不靠硬编码密度值。 */
  :root{--pad-top:${topPad}px;--pad-x:${spec.density.paddingX}px}
  </style>`;

  // 编号在 chrome 层画（画布坐标，见 accountPageNumber 注释）
  const pageNoHtml = accountPageNumber(spec, pageNo, isCoverPage(card.layout));

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">${chromeCss}<style>${baseCss(spec, { photoDataUri: isPhoto ? photoDataUri : undefined })}</style></head>
<body><div class="card">
  ${texture}
  ${motifLayer(spec.motifs, motifCtx, motifZone(card.layout))}
  <div style="position:relative;z-index:2;height:100%">${content}</div>
  ${pageNoHtml}
  ${chrome.html}
  ${
    // 图卡的页脚会压在图上看不清，交给 cta / 内容层自己处理
    isPhoto
      ? ''
      : `<div class="footer"><span>${esc(b.brand ?? '')}</span><span>${esc(b.watermark ?? '')}</span></div>`
  }
</div></body></html>`;
}

/** 封面判定：cover 版式是封面；photo_text/cta 也可能作为收尾内页。 */
function isCoverPage(layout: string): boolean {
  return layout === 'cover';
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

async function toDataUri(localPath: string): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(localPath);
    const mime = localPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** 共享的渲染页，避免每张卡都新建 Chromium page。 */
let renderPage: Page | null = null;

async function getRenderPage(): Promise<Page> {
  if (renderPage && !renderPage.isClosed()) return renderPage;
  const ctx = await browser.ensureLaunched();
  renderPage = await ctx.newPage();
  await renderPage.setViewportSize({ width: CARD_WIDTH, height: CARD_HEIGHT });
  return renderPage;
}

export interface RenderOptions {
  sourceId: number | null;
  outputDir: string;
  allowStock?: boolean;
}

/** 为 photo_text 取底图并归一化，失败返回 undefined（退化成暗底大字）。 */
async function resolvePhoto(
  card: Card,
  opts: RenderOptions,
  spec: ResolvedSpec,
): Promise<string | undefined> {
  if (card.layout !== 'photo_text') return undefined;

  // 1. 本地已有图
  if (card.blocks.photoPath) {
    const uri = await toDataUri(String(card.blocks.photoPath));
    if (uri) return uri;
  }

  // 2. 指定 URL / 3. 去图库搜
  const query = String(card.blocks.photoQuery ?? '');
  let picked: StockImage | undefined;
  if (card.photoUrl) {
    picked = {
      url: String(card.photoUrl),
      thumbUrl: '',
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      author: '',
      sourceProvider: 'preset',
      sourceUrl: '',
      license: '',
    };
  } else if (opts.allowStock !== false) {
    picked = (await searchStock(toSearchHint(query), 1))[0];
  }
  if (!picked) return undefined;

  await fs.mkdir(opts.outputDir, { recursive: true });
  const tmp = path.join(opts.outputDir, `.photo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`);
  try {
    const res = await fetch(picked.url, { headers: { 'User-Agent': 'xhsflow/0.1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    // 底图统一按 3:4 裁切，并轻微降低饱和度/提对比 —— 让照片退成"氛围层"，
    // 不与前景文字抢注意力。这是"实拍图+字幕"这种构图的常见处理。
    const norm = await sharp(buf)
      .resize(CARD_WIDTH, CARD_HEIGHT, { fit: 'cover', position: 'centre' })
      .modulate({ saturation: 0.94 })
      .linear(1.04, -6)
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
    await fs.writeFile(tmp, norm);
    const uri = await toDataUri(tmp);
    await fs.unlink(tmp).catch(() => undefined);
    return uri;
  } catch (err) {
    logger.warn({ err, query, url: picked.url }, '配图下载失败，退回纯文字排版');
    return undefined;
  }
}

export async function renderCard(card: Card, opts: RenderOptions): Promise<string> {
  const spec = specForSource(opts.sourceId);
  const page = await getRenderPage();
  const photoUri = await resolvePhoto(card, opts, spec);

  const html = buildCardHtml(card, spec, photoUri);
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<void> } }).fonts?.ready);
  // 等一帧，让噪点/混合模式这些合成层稳定下来再截图
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(80);

  await fs.mkdir(opts.outputDir, { recursive: true });
  const out = path.join(
    opts.outputDir,
    `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`,
  );

  const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
  await fs.writeFile(out, buf);
  return out;
}

/**
 * 批量渲染。
 *
 * ⚠️ 返回数组**与输入等长**，失败的位置是 `null`。
 *
 * 旧实现失败时直接跳过 push，返回数组比输入短 —— 而调用方
 * （pipeline.renderDraftCards）是 `rows.forEach((r, i) => paths[i])` 按下标回写，
 * 于是「第 2 张失败」会让第 3 张的图写进第 2 行，静默的图片错位。
 * 这里用占位保住下标对齐。
 */
export async function renderCards(cards: Card[], opts: RenderOptions): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (const c of cards) {
    try {
      out.push(await renderCard(c, opts));
    } catch (err) {
      logger.error({ err, layout: c.layout }, '卡片渲染失败');
      out.push(null);
    }
  }
  return out;
}

/**
 * 关掉渲染用的浏览器会话。
 *
 * 只关 page 是不够的：`renderCards()` 走的是 `browser.ensureLaunched()` 启动的
 * **共享**持久化上下文（发布/抓取也用同一个），所以 page 关掉之后 Chromium
 * 依然活着，Node 的事件循环被它钉住，脚本跑完不退出、桌面还留一个空窗口。
 * 诊断脚本用完必须连上下文一起关。
 */
export async function closeRenderer(): Promise<void> {
  await renderPage?.close().catch(() => undefined);
  renderPage = null;
  await browser.close();
}

/** 让渲染器能拿到媒体目录（卡片内嵌底图时要用）。 */
export { MEDIA_DIR };

/** 供诊断脚本使用：把契约/旧规格直接转成可渲染规格。 */
export { toResolved, type ResolvedSpec };
export { DEFAULT_CONTRACT };
