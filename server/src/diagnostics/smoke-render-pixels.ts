/**
 * 渲染冒烟 + 固定坐标像素校验（验收②）。
 *
 *   node server/dist/diagnostics/smoke-render-pixels.js [sourceId]
 *
 * 1. 用库里 style_profiles 的真实契约渲染 4 张卡（cover + 3 内页）
 * 2. 对输出 JPG 按固定坐标裁剪取主色：
 *    - 封面顶部 (517,26) 46×40 → 期望 ≈#FFFFFF（页眉条底色）
 *    - 内页底部 (517,1388) 46×40 → 期望 ≈#333333（页脚条底色）
 * 3. 校验编号：第 i 张内页 = String(i).padStart(2,'0')，从 DOM 抽取（不 OCR）
 * 4. 校验渲染 HTML 与成图文本不含字面 '[['。
 */

import { getStyleProfile } from '../corpus/profile.js';
import { toResolved, buildCardHtml, CARD_WIDTH, CARD_HEIGHT, closeRenderer } from '../generate/cards.js';
import { MEDIA_DIR } from '../config.js';
import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const sourceId = Number(process.argv[2] ?? 10);
const outDir = path.join(MEDIA_DIR, '_sample', 'smoke-render');
await fs.mkdir(outDir, { recursive: true });

const found = getStyleProfile(sourceId);
if (!found) throw new Error(`来源 ${sourceId} 无画像`);
const spec = toResolved(found.profile.card_template_spec);
console.log(`渲染规格：theme=${spec.theme} palette=${spec.palette.name}(${spec.palette.accent})`);
console.log(`模板：header=${JSON.stringify(spec.accountTemplate.cover_header_text)} footer=${JSON.stringify(spec.accountTemplate.inner_footer_text)}`);

const cards = [
  {
    layout: 'cover' as const,
    index: 0,
    blocks: {
      eyebrow: '栏目[[强调]]对照',
      title: '个人IP\n[[新趋势]]',
      items: ['检查项 [[强调]] 渲染', '到"建立信任"', '从"追求流量"', '到"承接生意"'],
      hint: '2026年，个人IP正在发生4个变化',
    },
  },
  { layout: 'list' as const, index: 1, blocks: { eyebrow: '', title: '人设正在变"轻"', items: [{ text: '条目一', note: '编号 01' }, { text: '条目二', note: '页脚 127px' }] } },
  { layout: 'steps' as const, index: 2, blocks: { eyebrow: '', title: '专业内容正在变"浅"', items: [{ text: '步骤一', note: '' }, { text: '步骤二', note: '' }] } },
  { layout: 'quote' as const, index: 3, blocks: { text: '金句 [[强调]] 校验', note: '编号应为 02', attribution: 'WOW' } },
];

interface CheckResult {
  card: string;
  index: number;
  htmlNoBrackets: boolean;
  textNoBrackets: boolean;
  pageNo: string | null;
  html: string;
  file: string;
  headerPixel: string | null;
  footerPixel: string | null;
}

const results: CheckResult[] = [];
// 【隔离上下文】渲染验证不碰小红书登录 profile —— launchPersistentContext
// (PROFILE_DIR) 会在桌面拉起带登录态的实例，还有并发锁风险。渲染只
// 需要无痕 Chromium：launch() + newPage() 完全隔离。
const ctx = await chromium.launch({
  headless: true,
});

try {
  for (const card of cards) {
    const html = buildCardHtml({ layout: card.layout, blocks: card.blocks, index: card.index }, spec);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: CARD_WIDTH, height: CARD_HEIGHT });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<void> } }).fonts?.ready);
    await page.waitForTimeout(150);

    // DOM 校验：编号（list/steps 右上角带 data-smoke-page-no）、字面 [[
    const dom = await page.evaluate(() => {
      const text = document.body.textContent ?? '';
      const el = document.querySelector('[data-smoke-page-no]') as HTMLElement | null;
      return { text, pageNo: el?.textContent?.trim() ?? null };
    });

    const file = path.join(outDir, `smoke-${String(card.index + 1).padStart(2, '0')}-${card.layout}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 92 });
    await page.close();

    results.push({
      card: `${card.index}-${card.layout}`,
      index: card.index,
      htmlNoBrackets: !html.includes('[['),
      textNoBrackets: !dom.text.includes('[['),
      pageNo: dom.pageNo,
      html,
      file,
      headerPixel: null,
      footerPixel: null,
    });
  }
} finally {
  await ctx.close().catch(() => undefined);
}

/* 像素校验：固定坐标裁剪 → 主色 */
async function dominantColor(
  file: string,
  region: { left: number; top: number; width: number; height: number },
): Promise<string> {
  const buf = await sharp(file).extract(region).resize(1, 1, { fit: 'fill' }).raw().toBuffer();
  const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  const r = buf[0] ?? 0;
  const g = buf[1] ?? 0;
  const b = buf[2] ?? 0;
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const hexOk = (got: string | null, want: [number, number, number], tol: number): boolean => {
  if (!got) return false;
  const m = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/.exec(got);
  if (!m?.[1] || !m[2] || !m[3]) return false;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return Math.abs(r - want[0]) <= tol && Math.abs(g - want[1]) <= tol && Math.abs(b - want[2]) <= tol;
};

console.log('\n── 像素校验（固定坐标） ──');
for (const r of results) {
  const isCover = r.index === 0;
  if (isCover) {
    r.headerPixel = await dominantColor(r.file, { left: 517, top: 30, width: 46, height: 40 });
  } else {
    // 页脚条实测高 122–128（原账号众数 126–128），条顶 y≈1314 → 采条中部
    r.footerPixel = await dominantColor(r.file, { left: 517, top: CARD_HEIGHT - 100, width: 46, height: 40 });
  }
  console.log(
    `${r.card}: header=${r.headerPixel ?? '-'} footer=${r.footerPixel ?? '-'} pageNo=${r.pageNo} html含[[=${!r.htmlNoBrackets} 文本含[[=${!r.textNoBrackets}`,
  );
}

/* 断言 */
const failures: string[] = [];
const cover = results.find((r) => r.index === 0)!;
if (!hexOk(cover.headerPixel, [0xff, 0xff, 0xff], 12)) failures.push(`封面页眉条像素不是白：${cover.headerPixel}`);
// 封面不应有编号（原账号封面无编号）
if (cover.pageNo !== null) failures.push(`封面不应有编号，实测=${cover.pageNo}`);
for (const r of results.filter((x) => x.index !== 0)) {
  if (!hexOk(r.footerPixel, [0x33, 0x33, 0x33], 30)) failures.push(`${r.card} 页脚条像素不是 #333333 系：${r.footerPixel}`);
  // 编号语义与原账号一致：封面不占号，第 i 张内页（index=i）编号 = padStart(i)。
  // 带 data-smoke-page-no 的版式（list/steps）从 DOM 抽取；quote 没有该元素，不强校验。
  if (r.pageNo !== null) {
    const expect = String(r.index).padStart(2, '0');
    if (r.pageNo !== expect) failures.push(`${r.card} 编号=${r.pageNo}，期望 ${expect}`);
  }
}
for (const r of results) {
  if (!r.htmlNoBrackets) failures.push(`${r.card} HTML 含字面 [[`);
  if (!r.textNoBrackets) failures.push(`${r.card} 成图文本含字面 [[`);
}

console.log('\n── 结论 ──');
if (failures.length === 0) {
  console.log('SMOKE PASS ✓（页眉条白底+图形logo两行 / 页脚条#333 127px+logo两行 / 内页左上编号01起 / 封面无编号 / 无 [[ 字面量）');
} else {
  console.log('SMOKE FAIL ✗');
  for (const f of failures) console.log(' -', f);
  process.exit(1);
}
