/**
 * 渲染器自检：把 7 种版式各渲染一张，肉眼确认中文、配色、层级都对。
 *
 *   node server/dist/diagnostics/render-sample.js
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { PROFILE_DIR, MEDIA_DIR } from '../config.js';
import { renderCard, buildCardHtml, DEFAULT_SPEC, CARD_WIDTH, CARD_HEIGHT } from '../generate/cards.js';
import type { Card } from '../generate/cards.js';

const SPEC = {
  ...DEFAULT_SPEC,
  background: '#FFF6EE',
  text_primary: '#2B2320',
  text_secondary: '#7A6A60',
  accent: '#E8604C',
  palette: ['#FFF6EE', '#F7E3D0', '#E8604C'],
  title_size: 72,
  body_size: 34,
  accent_style: 'highlight' as const,
  decoration: 'emoji' as const,
  background_image: 'gradient' as const,
  font_family: '"Microsoft YaHei", "微软雅黑", "PingFang SC", sans-serif',
};

const CARDS: Card[] = [
  {
    layout: 'cover',
    blocks: {
      eyebrow: '小户型改造',
      title: '厨房只有 [[3㎡]]\n还能装下什么？',
      items: ['真实住过的 6 个方案', '每一版的踩坑记录', '预算控制在 2000 内'],
      hint: '建议先收藏再看 ↓',
      brand: '小家研究所',
      watermark: '01',
    },
  },
  {
    layout: 'quote',
    blocks: {
      text: '不是厨房太小，\n是你没把台面[[让出来]]',
      note: '把灶台往里推 15cm，操作台立刻多出 40cm。',
      attribution: '装修第三年的我',
      brand: '小家研究所',
      watermark: '02',
    },
  },
  {
    layout: 'list',
    blocks: {
      eyebrow: '重点',
      title: '这 5 样东西，[[真别买]]',
      items: [
        { text: '免打孔置物架', note: '承重差，掉下来砸过脚' },
        { text: '网红分层收纳盒', note: '尺寸全是一个模子，买回来全是浪费' },
        { text: '折叠沥水篮', note: '洗一次就卡住' },
        { text: '小台面微波炉架', note: '抬高 10cm 就能用，省一大块台面' },
        { text: '磁吸刀架', note: '唯一一个回购的' },
      ],
      brand: '小家研究所',
      watermark: '03',
    },
  },
  {
    layout: 'steps',
    blocks: {
      eyebrow: '怎么做',
      title: '三步把厨房[[清空]]',
      items: [
        { text: '全部搬出来，分类', note: '按「用得上 / 用不上 / 不知道」分三堆' },
        { text: '用不上的直接扔', note: '这一步会扔掉一半' },
        { text: '留下的按使用频率分层', note: '每天用的放最顺手的那一层' },
      ],
      brand: '小家研究所',
      watermark: '04',
    },
  },
  {
    layout: 'compare',
    blocks: {
      eyebrow: '对比',
      title: '改造前 [[vs]] 改造后',
      left: { title: '❌ 之前', items: ['台面堆满杂物', '找不到铲子', '洗菜要挪三样东西'] },
      right: { title: '✓ 之后', items: ['台面常年清空', '所有工具挂墙上', '站着就能完成'] },
      conclusion: '差别不在收纳盒，在[[有没有减法]]',
      brand: '小家研究所',
      watermark: '05',
    },
  },
  {
    layout: 'photo_text',
    blocks: {
      title: '关于[[断舍离]]\n我踩过的坑',
      subtitle: '扔东西真的会上瘾，但别扔到半夜。',
      brand: '小家研究所',
      watermark: '06',
    },
  },
  {
    layout: 'cta',
    blocks: {
      emoji: '👋',
      title: '你家厨房\n最大的问题是啥？',
      action: '评论区告诉我，我帮你看看怎么改',
      brand: '小家研究所',
      watermark: '07',
    },
  },
];

async function main(): Promise<void> {
  const outDir = path.join(MEDIA_DIR, '_sample');
  await fs.mkdir(outDir, { recursive: true });

  // 自带一个浏览器实例，renderCard 依赖全局 browser 会话
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    locale: 'zh-CN',
    viewport: { width: CARD_WIDTH, height: CARD_HEIGHT },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // 让 renderCard 复用这个上下文
  const { browser } = await import('../xhs/browser.js');
  (browser as unknown as { ctx: unknown }).ctx = ctx;

  for (const [i, card] of CARDS.entries()) {
    const html = buildCardHtml(card, SPEC);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: CARD_WIDTH, height: CARD_HEIGHT });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<void> } }).fonts?.ready);
    await page.waitForTimeout(150);
    const out = path.join(outDir, `${String(i + 1).padStart(2, '0')}-${card.layout}.png`);
    await page.screenshot({ path: out });
    await page.close();
    console.log('✓', out);
  }

  // 同时导出一份 HTML 方便肉眼对照
  await fs.writeFile(path.join(outDir, 'preview.html'), CARDS.map((c) => `<div style="width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px;overflow:hidden;margin-bottom:20px">${buildCardHtml(c, SPEC)}</div>`).join(''));

  await ctx.close();
  console.log(`\n共 ${CARDS.length} 张，输出到 ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});