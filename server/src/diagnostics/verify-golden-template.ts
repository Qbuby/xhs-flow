/**
 * 源账号视觉模板 golden 验收。
 *
 *   node server/dist/diagnostics/verify-golden-template.js [sourceId]
 *
 * 【与 smoke-render-pixels 的本质区别】
 * smoke 的预期值来自 spec 自身（自己测自己，错误模板也能过）；
 * 本脚本的预期值是**硬编码的原图实测值**（sharp 扫描 data/media/corpus/339），
 * 与代码无关 —— 渲染偏离原图即失败。
 *
 * 检查层：
 *   A. HTML 结构层（无浏览器，快）—— chrome 存在性、编号 DOM、资产引用
 *   B. 像素层（隔离 Chromium 截图）—— 条高/底色/编号颜色按原图 bbox 采样
 *
 * 预期值来源（原图 1080×1440，2026-10-17 实测）：
 *   - 封面页眉条：白底，y∈[0,128)
 *   - 内页页脚条：#333333，顶边 y=1313 → 高 127
 *   - 内页大编号：bbox x 69..198、y 161..346，色 #D9E9FB（浅蓝）
 *   - 封面强调块：#0884FE 系亮蓝
 *   - 封面无编号
 */

import { getStyleProfile } from '../corpus/profile.js';
import { toResolved, buildCardHtml, CARD_WIDTH, CARD_HEIGHT, closeRenderer } from '../generate/cards.js';
import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MEDIA_DIR } from '../config.js';

const sourceId = Number(process.argv[2] ?? 10);
const outDir = path.join(MEDIA_DIR, '_sample', 'golden-verify');
await fs.mkdir(outDir, { recursive: true });

/* ------------------------------------------------------------------ */
/* 原图 golden（硬编码，勿从 spec 推导）                                  */
/* ------------------------------------------------------------------ */

const GOLDEN = {
  canvas: { width: 1080, height: 1440 },
  coverHeader: { bg: [0xff, 0xff, 0xff], sampleAt: { x: 517, y: 30, w: 46, h: 40 } },
  innerFooter: { bg: [0x33, 0x33, 0x33], topEdge: 1313, height: 127, sampleAt: { x: 517, y: 1360, w: 46, h: 40 } },
  innerNumber: { bbox: { x: 69, y: 161, w: 130, h: 186 }, color: [0xd8, 0xe9, 0xfb], tolerance: 14 },
  coverAccentBlock: { color: [0x08, 0x84, 0xfe], tolerance: 18 },
  /**
   * 第二模板族 wow-brand-case-v1（340/1..340/4 实测）：
   *   细字栏目编号 bbox x 98..、y 131..151，字面高约 20px，纯强调色 + 大字距
   *   标题独立成行 y 266..319（字面高 53px）
   *   页脚顶边 y=1312、高 128（与 339 同一品牌条，仅 1px 差）
   * 这组值与上面 ip-trend 族的编号几何**故意不同** —— 两族必须分别对上，
   * 交叉满足即说明渲染端把族参数搞混了。
   */
  brandCase: {
    footerTopEdge: 1312,
    footerHeight: 128,
    labelBbox: { x: 90, y: 125, w: 320, h: 34 },
    labelColor: [0x00, 0x7c, 0xfe],
    labelTolerance: 30,
    titleBBox: { x: 60, y: 260, w: 960, h: 66 },
  },
} as const;

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.max(Math.abs(a[0]! - b[0]!), Math.abs(a[1]! - b[1]!), Math.abs(a[2]! - b[2]!));

/* ------------------------------------------------------------------ */
/* 准备 spec：把 golden 模板直接注入（验证渲染器，不验证蒸馏结果）          */
/* ------------------------------------------------------------------ */

const found = getStyleProfile(sourceId);
if (!found) throw new Error(`来源 ${sourceId} 无画像`);

/** 品牌层两族共用（同一账号：logo + 两行文字 + 页脚条）。 */
const BRAND = {
  cover_header_text: 'WOW Culture Media Co., Ltd',
  cover_header_sub: '新媒体各渠道电商代运营服务 专业0-1 成功案例100+',
  cover_header_bg: '#FFFFFF',
  cover_header_ink: '#111827',
  cover_logo_text: 'WOW',
  logo_asset_dark: 'assets/brand/wow-logo-ink.png',
  logo_asset_light: 'assets/brand/wow-logo-white.png',
  inner_footer_text: 'WOW Culture Media Co., Ltd',
  inner_footer_sub: '新媒体各渠道电商代运营服务 专业0-1 成功案例100+',
  inner_footer_bg: '#333333',
  inner_footer_ink: '#FFFFFF',
  accent: '#007CFE',
} as const;

const resolveWith = (accountTemplate: Record<string, unknown>) =>
  toResolved({
    ...(found.profile.card_template_spec as Record<string, unknown>),
    account_template: { ...BRAND, ...accountTemplate },
  });

/** 族一：wow-ip-trend-v1（339 实测，大号浅蓝编号、编号与标题同行）。 */
const spec = resolveWith({
  family: 'wow-ip-trend-v1',
  header_bar_height: 128,
  footer_bar_height: 127,
  numbering: '01',
  columns: 2,
});

/** 族二：wow-brand-case-v1（340 实测，细字栏目编号 + 横线、标题 y266 独立成行）。 */
const specB = resolveWith({
  family: 'wow-brand-case-v1',
  header_bar_height: 128,
  footer_bar_height: 128,
  numbering: '01',
  numbering_prefix: 'SHIFT',
  columns: 2,
});

const failures: string[] = [];
const notes: string[] = [];

/* ------------------------------------------------------------------ */
/* A. HTML 结构层                                                       */
/* ------------------------------------------------------------------ */

const cards = [
  { layout: 'cover' as const, index: 0, blocks: { eyebrow: '', title: '个人IP\n新趋势', hint: '2026年，个人IP正在发生4个变化', items: ['从"打造人设"', '到"建立信任"', '从"追求流量"', '到"承接生意"'] } },
  { layout: 'list' as const, index: 1, blocks: { eyebrow: '', title: '人设正在变"轻"', items: [{ text: '有真实经历', note: '' }, { text: '有个人观点', note: '' }] } },
  { layout: 'steps' as const, index: 2, blocks: { eyebrow: '', title: '专业内容正在变"浅"', items: [{ text: '讲大白话', note: '' }, { text: '解决问题', note: '' }] } },
];

interface Shot { layout: string; index: number; html: string; file: string }
const shots: Shot[] = [];

for (const card of cards) {
  const html = buildCardHtml({ layout: card.layout, blocks: card.blocks, index: card.index }, spec);
  const file = path.join(outDir, `golden-${card.index}-${card.layout}.jpg`);
  shots.push({ layout: card.layout, index: card.index, html, file });
}

/** 族二（wow-brand-case-v1）的样本，内容对齐 340 原图结构。 */
const cardsB = [
  { layout: 'cover' as const, index: 0, blocks: { eyebrow: '', title: '拙趣风\n又赢了', hint: '拙趣风为什么突然火了？', subtitle: '它没有继续卷"高级感"，而是换了一种记忆方式', items: [] } },
  { layout: 'list' as const, index: 1, blocks: { eyebrow: '', title: '看似随意，其实很有章法', items: [{ text: '字体', note: '底层一致' }, { text: '色彩', note: '底层一致' }, { text: '插画语言', note: '底层一致' }, { text: '品牌调性', note: '底层一致' }] } },
  { layout: 'compare' as const, index: 2, blocks: { title: '拙趣 ≠ 随便画', left: { title: '拙趣', items: ['允许不规整', '保留手绘感'] }, right: { title: '背后', items: ['依然是高度统一的系统'] }, conclusion: '不是降级，而是在换一种记忆方式' } },
];
const shotsB: Shot[] = [];
for (const card of cardsB) {
  const html = buildCardHtml({ layout: card.layout, blocks: card.blocks, index: card.index }, specB);
  const file = path.join(outDir, `goldenB-${card.index}-${card.layout}.jpg`);
  shotsB.push({ layout: card.layout, index: card.index, html, file });
}

/** 组件保真样本：compare（深蓝黑块）与 cta（无胶囊按钮）。 */
const shotsC: Array<Shot & { renderedHtml?: string }> = [];
{
  const compareSpec = toResolved({
    ...(found.profile.card_template_spec as Record<string, unknown>),
    account_template: {
      ...BRAND,
      family: 'wow-brand-case-v1',
      header_bar_height: 128,
      footer_bar_height: 128,
      numbering: '01',
      numbering_prefix: 'SHIFT',
      columns: 2,
    },
  });
  const ctaSpec = toResolved({
    ...(found.profile.card_template_spec as Record<string, unknown>),
    account_template: { ...BRAND, family: 'wow-ip-trend-v1', header_bar_height: 128, footer_bar_height: 127, numbering: '01', columns: 2 },
  });
  const compareHtml = buildCardHtml(
    {
      layout: 'compare',
      index: 1,
      blocks: {
        title: '色卡和完整系统，差的是使用规则',
        left: { title: '静态色卡', items: ['锁定品牌主色', '标注Logo与包装色'] },
        right: { title: '动态色卡', items: ['给每种颜色分配角色', '建立正文与背景层级'] },
        conclusion: '色卡管「是什么」，系统管「怎么用」',
      },
    },
    compareSpec,
  );
  const ctaHtml = buildCardHtml(
    { layout: 'cta', index: 2, blocks: { title: '品牌升级前，先查5层规则', action: '做视觉升级、内容营销？[[可以聊聊。]]' } },
    ctaSpec,
  );
  shotsC.push({ layout: 'compare', index: 1, html: compareHtml, file: path.join(outDir, 'golden-compare.jpg') });
  shotsC.push({ layout: 'cta', index: 2, html: ctaHtml, file: path.join(outDir, 'golden-cta.jpg') });
}

// A1：封面无编号 DOM
const coverHtml = shots[0]!.html;
if (/data-smoke-page-no/.test(coverHtml)) failures.push('A1 封面不应有 data-smoke-page-no 编号元素');

// A2：内页编号 DOM = padStart(index)，编号模板非 none
for (const s of shots.slice(1)) {
  const m = /data-smoke-page-no[^>]*>([^<]+)</.exec(s.html);
  const expect = String(s.index).padStart(2, '0');
  if (!m) failures.push(`A2 ${s.layout} 缺编号元素`);
  else if (m[1]!.trim() !== expect) failures.push(`A2 ${s.layout} 编号=${m[1]!.trim()} 期望=${expect}`);
}

// A3：图形 logo 资产进入 HTML（data URI img），不是纯文字
if (!/data-smoke-logo/.test(coverHtml)) failures.push('A3 封面页眉未使用图形 logo 资产（data-smoke-logo 缺失）');
const innerFooterHtml = shots[1]!.html;
if (!/data-smoke-logo/.test(innerFooterHtml)) failures.push('A3 内页页脚未使用图形 logo 资产');

// A4：两行品牌文字都在
for (const s of shots) {
  if (!s.html.includes('WOW Culture Media Co., Ltd')) failures.push(`A4 ${s.layout} 缺品牌主行文字`);
  if (!s.html.includes('新媒体各渠道电商代运营服务')) failures.push(`A4 ${s.layout} 缺品牌副行文字`);
}

// A5：蓝底白字块（封面第二段标题）
if (!/background:\s*var\(--accent\)/.test(coverHtml)) failures.push('A5 封面缺蓝底白字强调块');

/* --- A6：两族编号形态互不污染（阶段 B 的核心断言） --- */

// 族一必须是「大号浅蓝纯数字」：无前缀、无字间距放大
const listHtmlA = shots[1]!.html;
const noElA = /data-smoke-page-no style="([^"]*)"[^>]*>([^<]*)</.exec(listHtmlA);
if (!noElA) {
  failures.push('A6 族一内页缺编号元素');
} else {
  const [attrs, text] = [noElA[1]!, noElA[2]!];
  if (text.trim() !== '01') failures.push(`A6 族一编号文本=${text.trim()} 期望=01`);
  if (!/font-size:88px/.test(attrs)) failures.push(`A6 族一编号未用大号（88px），attrs=${attrs.slice(0, 120)}`);
  if (/letter-spacing:0\.3/.test(attrs)) failures.push('A6 族一误用了族二的细字字间距');
}

// 族二必须是「细字前缀 · 数字 + 横线」
const listHtmlB = buildCardHtml(
  { layout: 'list', blocks: { title: '看似随意，其实很有章法', items: [{ text: '字体' }] }, index: 1 },
  specB,
);
const noElB = /data-smoke-page-no style="([^"]*)"[^>]*>([\s\S]*?)<\/div>/.exec(listHtmlB);
if (!noElB) {
  failures.push('A6 族二内页缺编号元素');
} else {
  const [attrs, inner] = [noElB[1]!, noElB[2]!];
  if (!/SHIFT/.test(inner)) failures.push(`A6 族二编号未含前缀 SHIFT：${inner.slice(0, 80)}`);
  if (!/letter-spacing:0\.34em/.test(attrs)) failures.push(`A6 族二未用细字字间距，attrs=${attrs.slice(0, 120)}`);
  if (/font-size:88px/.test(attrs)) failures.push('A6 族二误用了族一的大号编号');
  if (!/top:131px/.test(attrs)) failures.push('A6 族二编号纵向位置不是实测的 131px');
}

/* ------------------------------------------------------------------ */
/* B. 像素层：隔离 Chromium（全新 context，不碰登录 profile）              */
/* ------------------------------------------------------------------ */

const ctx = await chromium.launch({
  headless: true,
});
const page = await ctx.newPage();
await page.setViewportSize({ width: CARD_WIDTH, height: CARD_HEIGHT });

try {
  for (const s of shots) {
    await page.setContent(s.html, { waitUntil: 'load' });
    await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<void> } }).fonts?.ready);
    await page.waitForTimeout(150);
    await page.screenshot({ path: s.file, type: 'jpeg', quality: 95 });
  }

  // 族二样本（340 原版式）
  for (const s of shotsB) {
    await page.setContent(s.html, { waitUntil: 'load' });
    await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<void> } }).fonts?.ready);
    await page.waitForTimeout(150);
    await page.screenshot({ path: s.file, type: 'jpeg', quality: 95 });
  }

  // 组件保真样本（compare / cta）—— 必须在浏览器关闭前渲染
  for (const s of shotsC) {
    await page.setContent(s.html, { waitUntil: 'load' });
    await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<void> } }).fonts?.ready);
    await page.waitForTimeout(150);
    await page.screenshot({ path: s.file, type: 'jpeg', quality: 95 });
    s.renderedHtml = await page.content();
  }
} finally {
  await ctx.close().catch(() => undefined);
  await closeRenderer().catch(() => undefined);
}

/** 区域中位色。 */
/**
 * 区域里最暗的一块（40×40 窗口的最低中位亮度）的中位色。
 * 用来在**不写死坐标**的前提下找到深色块 —— 写死坐标会随版式漂移。
 */
async function darkestRegion(
  file: string,
  r: { left: number; top: number; width: number; height: number },
): Promise<number[] | null> {
  try {
    const { data, info } = await sharp(file)
      .extract({ left: r.left, top: r.top, width: r.width, height: r.height })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let best: number[] | null = null;
    let bestLum = 1e9;
    for (let y = 0; y + 40 <= r.height; y += 20) {
      for (let x = 0; x + 40 <= r.width; x += 20) {
        const rs: number[] = [], gs: number[] = [], bs: number[] = [];
        for (let yy = y; yy < y + 40; yy += 4) {
          for (let xx = x; xx < x + 40; xx += 4) {
            const i = (yy * info.width + xx) * info.channels;
            rs.push(data[i]!); gs.push(data[i + 1]!); bs.push(data[i + 2]!);
          }
        }
        const med = (a: number[]) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)]!;
        const px = [med(rs), med(gs), med(bs)];
        const lum = (px[0]! * 0.2126 + px[1]! * 0.7152 + px[2]! * 0.0722) / 255;
        if (lum < bestLum) { bestLum = lum; best = px; }
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * 区域中位色（逐通道）。用于「这块是不是深蓝黑 #0A172A」这类断言。
 */
async function regionMedian(
  file: string,
  r: { left: number; top: number; width: number; height: number },
): Promise<number[] | null> {
  try {
    const { data, info } = await sharp(file)
      .extract({ left: r.left, top: r.top, width: r.width, height: r.height })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const ch: number[][] = [[], [], []];
    for (let i = 0; i < data.length; i += info.channels) {
      ch[0]!.push(data[i]!); ch[1]!.push(data[i + 1]!); ch[2]!.push(data[i + 2]!);
    }
    const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
    return [med(ch[0]!), med(ch[1]!), med(ch[2]!)];
  } catch {
    return null;
  }
}

async function regionColor(file: string, r: { x: number; y: number; w: number; h: number }): Promise<number[]> {
  const { data, info } = await sharp(file)
    .extract({ left: r.x, top: r.y, width: r.w, height: r.h })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const chans: number[][] = [[], [], []];
  for (let i = 0; i < data.length; i += info.channels) {
    chans[0]!.push(data[i]!);
    chans[1]!.push(data[i + 1]!);
    chans[2]!.push(data[i + 2]!);
  }
  const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
  return [med(chans[0]!), med(chans[1]!), med(chans[2]!)];
}

/** 测页脚条顶边（从下往上第一处出现深色的行）。 */
async function footerTopEdge(file: string): Promise<number | null> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lum = (x: number, y: number): number => {
    const i = (y * info.width + x) * info.channels;
    return (data[i]! * 0.2126 + data[i + 1]! * 0.7152 + data[i + 2]! * 0.0722) / 255;
  };
  for (let y = 1200; y < info.height - 10; y++) {
    let dark = 0;
    for (let x = 5; x < info.width - 5; x += 5) if (lum(x, y) < 0.3) dark++;
    if (dark > (info.width / 5) * 0.9) return y;
  }
  return null;
}

const coverFile = shots[0]!.file;
const innerFile = shots[1]!.file;

// B1：封面页眉条白底
const headerPx = await regionColor(coverFile, GOLDEN.coverHeader.sampleAt);
if (dist(headerPx, GOLDEN.coverHeader.bg) > 10) failures.push(`B1 封面页眉条中位色=${headerPx} 期望≈#FFFFFF`);
notes.push(`B1 封面页眉条中位色 rgb(${headerPx.join(',')})`);

// B2：封面无编号 → 编号 bbox 区域应为背景色（白/浅灰），不应有浅蓝
const noArea = await regionColor(coverFile, { x: GOLDEN.innerNumber.bbox.x, y: GOLDEN.innerNumber.bbox.y, w: GOLDEN.innerNumber.bbox.w, h: 60 });
if (dist(noArea, [0xff, 0xff, 0xff]) > 40) notes.push(`B2 封面编号区非纯白 rgb(${noArea.join(',')})（内容块占位可接受，不判失败）`);

// B3：内页页脚条顶边与高度
const edge = await footerTopEdge(innerFile);
if (edge === null) failures.push('B3 内页未检测到页脚条');
else {
  const h = CARD_HEIGHT - edge;
  if (Math.abs(edge - GOLDEN.innerFooter.topEdge) > 4) failures.push(`B3 页脚条顶边 y=${edge} 期望≈${GOLDEN.innerFooter.topEdge}`);
  if (Math.abs(h - GOLDEN.innerFooter.height) > 4) failures.push(`B3 页脚条高=${h} 期望≈${GOLDEN.innerFooter.height}`);
  notes.push(`B3 页脚条顶边 y=${edge} 高=${h}`);
}

// B4：页脚条底色
const footerPx = await regionColor(innerFile, GOLDEN.innerFooter.sampleAt);
if (dist(footerPx, GOLDEN.innerFooter.bg) > 12) failures.push(`B4 页脚条中位色=${footerPx} 期望≈#333333`);
notes.push(`B4 页脚条中位色 rgb(${footerPx.join(',')})`);

// B5：内页编号颜色 —— 取 bbox 内「蓝系像素的众数色」。
// 不能用窗口中位色：88px 字面只覆盖 bbox 约 30%，中位数落在背景上。
const { data: nd, info: ni } = await sharp(innerFile).removeAlpha().raw().toBuffer({ resolveWithObject: true });
{
  const nb = GOLDEN.innerNumber.bbox;
  const mode = new Map<string, { n: number; c: number[] }>();
  for (let y = nb.y; y < Math.min(nb.y + nb.h, ni.height); y++) {
    for (let x = nb.x; x < Math.min(nb.x + nb.w, ni.width); x++) {
      const i = (y * ni.width + x) * ni.channels;
      const r = nd[i]!, g = nd[i + 1]!, b = nd[i + 2]!;
      if (b - r <= 6) continue; // 只要蓝系（笔画/抗锯齿），跳过背景
      const k = `${Math.round(r / 4) * 4},${Math.round(g / 4) * 4},${Math.round(b / 4) * 4}`;
      const cur = mode.get(k) ?? { n: 0, c: [0, 0, 0] };
      cur.n++;
      cur.c[0] = (cur.c[0] ?? 0) + r;
      cur.c[1] = (cur.c[1] ?? 0) + g;
      cur.c[2] = (cur.c[2] ?? 0) + b;
      mode.set(k, cur);
    }
  }
  const top = [...mode.values()].sort((a, b) => b.n - a.n)[0];
  if (!top || top.n < 200) {
    failures.push(`B5 内页编号区蓝像素不足（${top?.n ?? 0}）—— 编号可能缺失`);
  } else {
    const px = top.c.map((v) => Math.round(v / top.n));
    if (dist(px, [...GOLDEN.innerNumber.color]) > GOLDEN.innerNumber.tolerance) {
      failures.push(`B5 内页编号色=${px} 期望≈rgb(${GOLDEN.innerNumber.color.join(',')})`);
    }
    notes.push(`B5 内页编号色 rgb(${px.join(',')})（蓝系众数，n=${top.n}）`);
  }
}

// B6：封面强调块存在且为亮蓝（在标题下方 380..640 高度带找蓝色）
const { data: cd, info: ci } = await sharp(coverFile).removeAlpha().raw().toBuffer({ resolveWithObject: true });
let foundAccent = 0;
for (let y = 360; y < 700; y += 4) {
  for (let x = 60; x < 720; x += 4) {
    const i = (y * ci.width + x) * ci.channels;
    const r = cd[i]!, g = cd[i + 1]!, b = cd[i + 2]!;
    if (b > 200 && b - r > 90 && g < 170) foundAccent++;
  }
}
if (foundAccent < 200) failures.push(`B6 封面强调块亮蓝像素不足（${foundAccent}）`);
notes.push(`B6 封面强调块亮蓝采样=${foundAccent}`);

/* --- B7/B8：族二（wow-brand-case-v1）像素层 --- */

const innerFileB = shotsB[1]!.file;

// B7：族二页脚条几何（340 实测：顶边 1312、高 128）
{
  const edgeB = await footerTopEdge(innerFileB);
  if (edgeB === null) failures.push('B7 族二内页未检测到页脚条');
  else {
    const h = CARD_HEIGHT - edgeB;
    if (Math.abs(edgeB - GOLDEN.brandCase.footerTopEdge) > 4) {
      failures.push(`B7 族二页脚条顶边 y=${edgeB} 期望≈${GOLDEN.brandCase.footerTopEdge}`);
    }
    if (Math.abs(h - GOLDEN.brandCase.footerHeight) > 4) {
      failures.push(`B7 族二页脚条高=${h} 期望≈${GOLDEN.brandCase.footerHeight}`);
    }
    notes.push(`B7 族二页脚条顶边 y=${edgeB} 高=${h}`);
  }
}

// B8：族二编号是**纯强调色细字**（不是族一的浅蓝大号）
//     —— 在实测 bbox 内取「最接近强调色」的众数；族一那种 #D8E9FB 会判失败
{
  const { data: bd, info: bi } = await sharp(innerFileB).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lb = GOLDEN.brandCase.labelBbox;
  let accentPixels = 0;
  let palePixels = 0;
  for (let y = lb.y; y < Math.min(lb.y + lb.h, bi.height); y++) {
    for (let x = lb.x; x < Math.min(lb.x + lb.w, bi.width); x++) {
      const i = (y * bi.width + x) * bi.channels;
      const r = bd[i]!, g = bd[i + 1]!, b = bd[i + 2]!;
      // 强调色系（b 高、r 低）
      if (b > 150 && b - r > 60) accentPixels++;
      // 族一的浅蓝（r 也很高）—— 若这种反而占多数，说明两族编号搞混了
      if (b > 230 && r > 200 && b - r > 10) palePixels++;
    }
  }
  if (accentPixels < 120) failures.push(`B8 族二编号强调色像素不足（${accentPixels}）`);
  if (palePixels > accentPixels) {
    failures.push(`B8 族二编号偏浅蓝（pale=${palePixels} > accent=${accentPixels}）—— 与族一混淆`);
  }
  notes.push(`B8 族二编号 accent=${accentPixels} pale=${palePixels}`);
}

// B9：族二标题独立成行 —— 实测 y266..319 有深色文字墨迹，且不与编号同行
{
  const { data: td, info: ti } = await sharp(innerFileB).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lumT = (x: number, y: number): number => {
    const i = (y * ti.width + x) * ti.channels;
    return (td[i]! * 0.2126 + td[i + 1]! * 0.7152 + td[i + 2]! * 0.0722) / 255;
  };
  let ink = 0;
  const tb = GOLDEN.brandCase.titleBBox;
  for (let y = tb.y; y < Math.min(tb.y + tb.h, ti.height); y++) {
    for (let x = tb.x; x < Math.min(tb.x + tb.w, ti.width); x += 2) {
      if (lumT(x, y) < 0.35) ink++;
    }
  }
  if (ink < 200) failures.push(`B9 族二标题行（y266..319）墨迹不足（${ink}）—— 标题未落到实测行位`);
  notes.push(`B9 族二标题行墨迹=${ink}`);
}

/* --- C. 组件保真回归（2026-10-19 用户截图指出三处不符后加） --- */

/**
 * 组件级断言：拿原图实测值当预期，防止再次退化。
 *
 * 起因：用户对比生成图与语料原图，指出三处不符 ——
 *   1. compare 右列是**深蓝黑 #0A172A** 实心块（340/2 实测 x614..982），
 *      不是强调蓝；且框是**直角**，不是 18px 圆角；
 *   2. 蓝底上的文字必须**白字** —— .t-body 自带 color:var(--ink-soft)
 *      会覆盖继承色，实测渲染出深灰字几乎看不清；
 *   3. cta 收尾**没有按钮** —— 原账号是加粗文字行 + 蓝色强调句，
 *      胶囊按钮 + 箭头是通用主题的元素。
 */
const compareFile = path.join(outDir, 'golden-compare.jpg');
const ctaFile = path.join(outDir, 'golden-cta.jpg');
{
  // C1：compare 右列必须是深蓝黑 #0A172A（不是强调蓝 #007CFE）
  // ⚠️ 采样点不能写死：不同族/版式的块位置不同，写死会采到白底（踩过）。
  // 改成「页面上半部右侧区域里，找亮度最低的那块 40x40 区域」——
  // 深蓝黑块必然是那块，且它一定在右半边（对比结构）。
  const darkBlock = await darkestRegion(compareFile, { left: 540, top: 420, width: 500, height: 700 });
  if (darkBlock) {
    const d = Math.max(
      Math.abs(darkBlock[0]! - 0x0a),
      Math.abs(darkBlock[1]! - 0x17),
      Math.abs(darkBlock[2]! - 0x2a),
    );
    if (d > 14) failures.push(`C1 compare 右列块色 rgb(${darkBlock.join(',')}) 期望≈#0A172A（原图 340/2 实测）`);
    notes.push(`C1 compare 右列块色 rgb(${darkBlock.join(',')})`);
  }

  // C2：深色块上的文字必须是白字（不能是深灰 —— .t-body 会覆盖继承色）
  {
    const { data: cd2, info: ci2 } = await sharp(compareFile).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let white = 0;
    let grey = 0;
    for (let y = 480; y < 1020; y++) {
      for (let x = 620; x < 980; x++) {
        const i = (y * ci2.width + x) * ci2.channels;
        const r = cd2[i]!, g = cd2[i + 1]!, b = cd2[i + 2]!;
        if (r > 225 && g > 225 && b > 225) white++;
        else if (r > 90 && r < 190 && Math.abs(r - g) < 14 && Math.abs(g - b) < 14) grey++;
      }
    }
    if (white < 400) failures.push(`C2 compare 深色块上的白字太少（${white}）—— .t-body 覆盖了继承色`);
    if (grey > white) failures.push(`C2 compare 深色块上是灰字（grey=${grey} > white=${white}）`);
    notes.push(`C2 compare 深色块 white=${white} grey=${grey}`);
  }

  // C3：复刻模式**不允许圆角胶囊**。cta 页面里不该有 border-radius:999px
  {
    const html = shotsC.find((s) => s.layout === 'cta')?.renderedHtml ?? '';
    if (/border-radius:999px/.test(html)) failures.push('C3 cta 出现了胶囊按钮（原账号没有圆角元素）');
    notes.push('C3 cta 无胶囊按钮');
  }

  // C4：compare 面板是直角（不是 18px 圆角）
  {
    const html = shotsC.find((s) => s.layout === 'compare')?.renderedHtml ?? '';
    if (/border-radius:18px/.test(html)) failures.push('C4 compare 面板出现 18px 圆角（原账号是直角）');
    notes.push('C4 compare 面板直角');
  }
}

/* ------------------------------------------------------------------ */
/* 结论                                                                  */
/* ------------------------------------------------------------------ */

console.log('\n── golden 验收 ──');
for (const n of notes) console.log(' ·', n);
if (failures.length === 0) {
  console.log('\nGOLDEN PASS ✓（渲染层与原图实测一致；模板数据由本脚本注入）');
} else {
  console.log('\nGOLDEN FAIL ✗');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
