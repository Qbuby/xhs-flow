/**
 * 渲染器自检 / 视觉对比样张。
 *
 *   node server/dist/diagnostics/render-sample.js            # 当前规格 × 7 版式
 *   node server/dist/diagnostics/render-sample.js --themes   # 三套视觉语言 × 7 版式矩阵
 *
 * 输出到 `data/media/_sample/`，都是 PNG（生产路径是 JPEG，样张用 PNG 便于对比细节）。
 * 同时导出一份 `preview.html`，可以直接在浏览器里看合成后的效果。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { PROFILE_DIR, MEDIA_DIR } from '../config.js';
import {
  buildCardHtml,
  CARD_WIDTH,
  CARD_HEIGHT,
  toResolved,
} from '../generate/cards.js';
import { THEMES } from '../generate/design/index.js';
import { CARDS, THEME_CONTRACTS } from './sample-cards.js';

async function renderAll(
  ctx: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  outDir: string,
  prefix: string,
  specInput: unknown,
): Promise<string[]> {
  const spec = toResolved(specInput);
  const files: string[] = [];

  for (const [i, card] of CARDS.entries()) {
    const html = buildCardHtml(card, spec);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: CARD_WIDTH, height: CARD_HEIGHT });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<void> } }).fonts?.ready);
    await page.waitForTimeout(150);
    const out = path.join(outDir, `${prefix}${String(i + 1).padStart(2, '0')}-${card.layout}.png`);
    await page.screenshot({ path: out });
    await page.close();
    files.push(out);
    console.log('✓', path.basename(out));
  }
  return files;
}

async function main(): Promise<void> {
  const outDir = path.join(MEDIA_DIR, '_sample');
  await fs.mkdir(outDir, { recursive: true });
  const withThemes = process.argv.includes('--themes');

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    locale: 'zh-CN',
    viewport: { width: CARD_WIDTH, height: CARD_HEIGHT },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    if (withThemes) {
      // 三套视觉语言 × 7 版式。文件名前缀区分，便于并排对比。
      for (const theme of THEMES) {
        console.log(`\n── ${theme} ──`);
        await renderAll(ctx, outDir, `${theme}-`, THEME_CONTRACTS[theme]);
      }

      // 一份并排预览：每个主题一列，7 版式竖排
      const cols: string[] = [];
      for (const theme of THEMES) {
        const spec = toResolved(THEME_CONTRACTS[theme]);
        const cards = CARDS.map(
          (c) =>
            `<div style="width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px;overflow:hidden;margin-bottom:24px">${buildCardHtml(c, spec)}</div>`,
        ).join('');
        cols.push(
          `<div><h2 style="font:600 28px/1.4 sans-serif;margin:0 0 16px">${theme}</h2>${cards}</div>`,
        );
      }
      await fs.writeFile(
        path.join(outDir, 'preview-themes.html'),
        `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:24px;background:#e9e9ea;display:flex;gap:24px;align-items:flex-start">${cols.join('')}</body>`,
      );
      console.log('\n预览（三列并排）：', path.join(outDir, 'preview-themes.html'));
    } else {
      await renderAll(ctx, outDir, '', THEME_CONTRACTS['still-paper']);
      const spec = toResolved(THEME_CONTRACTS['still-paper']);
      await fs.writeFile(
        path.join(outDir, 'preview.html'),
        CARDS.map(
          (c) =>
            `<div style="width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px;overflow:hidden;margin-bottom:20px">${buildCardHtml(c, spec)}</div>`,
        ).join(''),
      );
      console.log('\n预览：', path.join(outDir, 'preview.html'));
    }
  } finally {
    await ctx.close();
  }

  console.log(`\n共 ${CARDS.length} 张/主题，输出到 ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
