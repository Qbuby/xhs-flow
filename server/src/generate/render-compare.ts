import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { buildCardHtml, CARD_WIDTH, CARD_HEIGHT, type Card } from './cards.js';
import type { ResolvedSpec } from './design/index.js';

/**
 * 渲染对照图（诊断专用，不进生产管线）。
 *
 * 与生产 renderCards 的差异：独立起一个 **headless 无痕** Chromium
 * （launch() + newPage()，不用 launchPersistentContext —— 那会碰小红书
 * 登录 profile，诊断既不需要登录也不该有并发锁风险）。
 * 输出 PNG 便于对比细节。
 */

interface CompareCard {
  layout: Card['layout'];
  blocks: Record<string, unknown>;
}

/** 渲染一组对照卡：第 1 张封面 + 其余内页，编号 01/02/03… 递增。 */
export async function renderAccountComparison(
  spec: ResolvedSpec,
  outDir: string,
  cards?: CompareCard[],
): Promise<string[]> {
  const list: CompareCard[] = cards ?? [
    {
      layout: 'cover',
      blocks: {
        eyebrow: '栏目 · [[强调]]标记对照',
        title: '品牌咨询的第一性原理\n[[为什么]]大多数方案落不了地',
        items: ['这条用于检查 [[强调]] 是否被渲染成 accent 样式', '页眉应出现在卡顶 92px'],
        hint: 'WOW 对照样张',
      },
    },
    {
      layout: 'list',
      blocks: {
        eyebrow: '检查点',
        title: '内页要点：编号与页脚',
        items: [
          { text: '左上角应有大号浅蓝编号', note: '编号随卡片顺序递增：本张是 02' },
          { text: '底部应有 78px 深色页脚条', note: '页脚文字与底色来自蒸馏的 account_template' },
          { text: '强调色应来自蒸馏值', note: '如 #007CFE 而非契约色板默认' },
        ],
      },
    },
    {
      layout: 'steps',
      blocks: {
        eyebrow: '检查点',
        title: '内页步骤：页脚避让',
        items: [
          { text: '老 .footer 已上移', note: '不再压在页脚条上' },
          { text: '页眉条只出现在封面', note: '内页只有页脚条' },
          { text: '编号 03', note: '恒为 01 的问题已修复' },
        ],
      },
    },
  ];

  await fs.mkdir(outDir, { recursive: true });
  const ctx = await chromium.launch({ headless: true });

  const files: string[] = [];
  try {
    for (const [i, card] of list.entries()) {
      const html = buildCardHtml({ ...card, index: i }, spec);
      const page = await ctx.newPage();
      await page.setViewportSize({ width: CARD_WIDTH, height: CARD_HEIGHT });
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<void> } }).fonts?.ready);
      await page.waitForTimeout(150);
      const out = path.join(outDir, `compare-${String(i + 1).padStart(2, '0')}-${card.layout}.png`);
      await page.screenshot({ path: out });
      await page.close();
      files.push(out);
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }
  return files;
}
