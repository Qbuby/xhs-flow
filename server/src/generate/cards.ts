import type { Page } from 'playwright';
import sharp from 'sharp';
import { browser } from '../xhs/browser.js';
import { MEDIA_DIR } from '../config.js';
import { getStyleProfile } from '../corpus/profile.js';
import { stripEmoji } from '../util/text.js';
import { logger } from '../logger.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { searchStock, toSearchHint } from '../media/stock.js';
import type { StockImage } from '../media/stock.js';
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

/** HTML 转义 + 换行转 <br>。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '<br/>');
}

/**
 * 把模型给的强调标记 `[[词]]` 渲染成 accent 样式的 span。
 *
 * ⚠️ `accent_style: 'none'` 旧实现是坏的 —— 会掉进 else 分支变成高亮。
 * 这里显式处理：`none` 就只去掉标记、不加任何样式。
 */
function highlightHtml(text: string, spec: ResolvedSpec): string {
  // 先按 [[ ]] 切开，只对非标记段做转义，避免转义把方括号搞乱
  const parts: string[] = [];
  let last = 0;
  const re = /\[\[(.+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    parts.push(escapeHtml(text.slice(last, m.index)));
    const inner = escapeHtml(m[1] ?? '');
    parts.push(inner ? `<span class="hl">${inner}</span>` : '');
    last = m.index + m[0].length;
  }
  parts.push(escapeHtml(text.slice(last)));
  // 没有标记时也别留下空 span
  const out = parts.join('');
  return out || (spec.accentStyle === 'none' ? escapeHtml(text) : out);
}

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

/** 带强调标记的文案。 */
function rich(v: unknown): string {
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

  return `
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    html,body{width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px;overflow:hidden}

    :root{
      --bg:${bg};
      --ink:${opts.photoDataUri ? '#FFFFFF' : p.ink};
      --ink-soft:${opts.photoDataUri ? 'rgba(255,255,255,.82)' : p.inkSoft};
      --accent:${p.accent};
      --accent-soft:${hexAlpha(p.accent, dark ? 0.22 : 0.13)};
      --on-accent:${isDark(p.accent) ? '#FFFFFF' : p.deep};
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
      background-image:${opts.photoDataUri ? 'none' : backgroundCss({ bg: p.bg, palette: p, dark })};
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
      position:absolute;left:${d.paddingX}px;right:${d.paddingX}px;bottom:${Math.round(d.paddingY * 0.62)}px;
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

export function buildCardHtml(
  card: Card,
  spec: ResolvedSpec,
  photoDataUri?: string,
): string {
  const dark = isDark(spec.palette.bg);
  const b = card.blocks;

  const motifCtx: MotifContext = {
    palette: spec.palette,
    dark,
    fontMono: `ui-monospace, Consolas, "Cascadia Mono", monospace`,
    fontBody: spec.fontBody,
    pageNo: typeof b.watermark === 'string' ? b.watermark : undefined,
    tag: typeof b.eyebrow === 'string' ? b.eyebrow : undefined,
  };

  const pageNo = typeof b.watermark === 'string' ? b.watermark : badgeText(0);

  // 三层：纹理 → 装饰 → 内容。装饰与纹理都绝对定位、不吃布局，
  // 所以内容层可以自由改版式而不用管它们。
  const texture = textureLayer({
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

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>${baseCss(spec, { photoDataUri: isPhoto ? photoDataUri : undefined })}</style></head>
<body><div class="card">
  ${texture}
  ${motifLayer(spec.motifs, motifCtx, motifZone(card.layout))}
  <div style="position:relative;z-index:2;height:100%">${content}</div>
  ${
    // 图卡的页脚会压在图上看不清，交给 cta / 内容层自己处理
    isPhoto
      ? ''
      : `<div class="footer"><span>${esc(b.brand ?? '')}</span><span>${esc(b.watermark ?? '')}</span></div>`
  }
</div></body></html>`;
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
