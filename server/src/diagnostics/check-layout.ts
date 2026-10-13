/**
 * 版面几何自检。
 *
 * 起因：视觉验收（visual-judge）在本次不可用，而「文字溢出画布」「元素互相压住」
 * 是卡片最常见的两类硬伤 —— 它们恰好都是**可以量化的**，不必靠肉眼。
 *
 * 这个脚本把 21 张样例（3 主题 × 7 版式）逐个渲染，然后用
 * `getBoundingClientRect` 量三件事：
 *   1. 出画布：任何可见元素的 rect 超出 1080×1440
 *   2. 文字被裁：`scrollHeight > clientHeight` 且 `overflow != visible`
 *   3. 压字：装饰层（z-index 高于内容层且 pointer-events:none 的那层）里
 *      的不透明小块，与内容层里有文字的元素的 rect 相交
 *
 * 只报「坐标级证据」，不猜风格好坏 —— 风格归人看，几何归机器。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { MEDIA_DIR, PROFILE_DIR } from '../config.js';
import { buildCardHtml, CARD_WIDTH, CARD_HEIGHT } from '../generate/cards.js';
import { toResolved } from '../generate/design/index.js';
import { CARDS } from './sample-cards.js';

const THEMES = ['still-paper', 'signal-proof', 'bridge-canvas'] as const;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Finding {
  kind: 'overflow' | 'clipped' | 'overlap';
  detail: string;
  rect: Rect;
}

/** 在页面里量几何。返回原始数据，判断留在 Node 侧做，方便打日志。 */
const PROBE = ({ W, H }: { W: number; H: number }) => {
  const EPS = 1.5;
  const findings: Array<{ kind: string; detail: string; rect: Rect }> = [];

  const label = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(' ').join('.')}` : '';
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 22);
    return `${tag}${cls}${text ? ` "${text}"` : ''}`;
  };

  const isVisible = (el: Element, cs: CSSStyleDeclaration): boolean => {
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (Number(cs.opacity) === 0) return false;
    return true;
  };

  const all = Array.from(document.querySelectorAll('body *'));

  // 1) 出画布
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (!isVisible(el, cs)) continue;
    // data-bleed="1" 是**有意出血**的装饰（金句卡的超大引号），故意压在画布边上，
    // 这类元素由设计上负责「只露一半」，不算硬伤。
    if (el.closest('[data-bleed="1"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.left < -EPS || r.top < -EPS || r.right > W + EPS || r.bottom > H + EPS) {
      findings.push({
        kind: 'overflow',
        detail: `${label(el)} → left=${r.left.toFixed(1)} top=${r.top.toFixed(1)} right=${r.right.toFixed(1)} bottom=${r.bottom.toFixed(1)}`,
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      });
    }
  }

  // 2) 文字被裁
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (!isVisible(el, cs)) continue;
    if (cs.overflow === 'visible' || cs.overflowY === 'visible') continue;
    if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) {
      findings.push({
        kind: 'clipped',
        detail: `${label(el)} → scroll=${el.scrollWidth}×${el.scrollHeight} client=${el.clientWidth}×${el.clientHeight}`,
        rect: (() => {
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        })(),
      });
    }
  }

  // 3) 压字：装饰层里「有可见底色/边框」的小元素 vs 带文字的文本节点容器
  const textRects: Array<{ el: Element; r: DOMRect }> = [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (!isVisible(el, cs)) continue;
    const direct = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0,
    );
    if (!direct) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    textRects.push({ el, r });
  }

  const hit = (a: DOMRect, b: DOMRect): boolean =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 3 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 3;

  for (const el of all) {
    const cs = getComputedStyle(el);
    if (!isVisible(el, cs)) continue;
    if (el.closest('.texture-layer')) continue;
    // 只关心「实心装饰」：有背景色或边框，且自己不承载文字
    const hasFill =
      (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') ||
      cs.borderTopWidth !== '0px' ||
      cs.borderLeftWidth !== '0px';
    if (!hasFill) continue;
    if ((el.textContent ?? '').trim().length > 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) continue;
    // 只查装饰层与前景层之间的碰撞
    const decorLayer = el.closest('.motif-layer');
    if (!decorLayer) continue;
    for (const t of textRects) {
      if (t.el.closest('.motif-layer')) continue;
      if (hit(r, t.r)) {
        findings.push({
          kind: 'overlap',
          detail: `${label(el)} 压住 ${label(t.el)}`,
          rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        });
      }
    }
  }

  // 4) 衬线是否真的生效（still-paper 的标题）
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;font-family:var(--font-title);font-size:100px';
  probe.textContent = '国的';
  document.body.appendChild(probe);
  const usedTitle = getComputedStyle(probe).fontFamily;
  const titleEl = document.querySelector('.t-title');
  const usedOnTitle = titleEl ? getComputedStyle(titleEl).fontFamily : '';
  probe.remove();

  return {
    findings,
    fonts: {
      declared: usedTitle,
      onTitle: usedOnTitle,
    },
  };
};

async function main(): Promise<void> {
  const outDir = path.join(MEDIA_DIR, '_sample');
  await fs.mkdir(outDir, { recursive: true });

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    locale: 'zh-CN',
    viewport: { width: CARD_WIDTH, height: CARD_HEIGHT },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  let total = 0;
  const byKind: Record<string, number> = {};
  const themeFonts = new Map<string, string>();

  try {
    for (const theme of THEMES) {
      const spec = toResolved({
        theme,
        palette_index: 0,
        type_scale: 'standard',
        density: 'standard',
      });
      console.log(`\n── ${theme} ──`);

      for (const [i, card] of CARDS.entries()) {
        const html = buildCardHtml(card, spec);
        const page = await ctx.newPage();
        await page.setViewportSize({ width: CARD_WIDTH, height: CARD_HEIGHT });
        await page.setContent(html, { waitUntil: 'load' });
        await page.evaluate(
          () => (document as Document & { fonts?: { ready: Promise<void> } }).fonts?.ready,
        );
        const res = (await page.evaluate(PROBE, { W: CARD_WIDTH, H: CARD_HEIGHT })) as {
          findings: Finding[];
          fonts: { declared: string; onTitle: string };
        };
        const cardName = `${String(i + 1).padStart(2, '0')}-${card.layout}`;
        themeFonts.set(`${theme}/${cardName}`, res.fonts.onTitle || res.fonts.declared);

        if (res.findings.length === 0) {
          console.log(`  ✓ ${cardName}`);
        } else {
          console.log(`  ✗ ${cardName}`);
          for (const f of res.findings) {
            console.log(`      [${f.kind}] ${f.detail}`);
            byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
            total++;
          }
        }
        await page.close();
      }
    }
  } finally {
    await ctx.close();
  }

  console.log('\n──────── 汇总 ────────');
  console.log(`问题总数：${total}`);
  for (const [k, v] of Object.entries(byKind)) console.log(`  ${k}: ${v}`);

  const titleFonts = new Set(themeFonts.values());
  console.log(`标题字体栈：${[...titleFonts].join(' | ')}`);
  if (total > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
