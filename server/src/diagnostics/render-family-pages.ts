import path from 'node:path';
import fs from 'node:fs/promises';
import { renderCards, closeRenderer, type Card } from '../generate/cards.js';
import { MEDIA_DIR } from '../config.js';

/**
 * 按**指定模板族**渲染一组内页，用于人工比对。
 *
 *   node server/dist/diagnostics/render-family-pages.js [family]
 *
 * 每个族出一张：同样的内容，不同的族 —— 用来确认
 * 「族」确实改变了画面（编号形态、标题位置、条带），而不是只换了标签。
 */
const family = (process.argv[2] ?? 'wow-title-top-v1') as
  | 'wow-ip-trend-v1'
  | 'wow-brand-case-v1'
  | 'wow-label-dark-v1'
  | 'wow-title-top-v1'
  | 'wow-blue-tag-v1';

const cards: Card[] = [
  {
    layout: 'list',
    index: 1,
    family,
    blocks: {
      title: '视觉符号，先定一个能被记住的',
      eyebrow: 'BRAND ASSETS',
      items: [
        { text: '视觉符号', note: '一个能被记住的视觉元素' },
        { text: '品牌色彩', note: '消费者能联想到你的颜色' },
        { text: '独特字体', note: '字形本身就在传达品牌性格' },
      ],
    },
  },
];

const outDir = path.join(MEDIA_DIR, 'diagnostics', `family-${family}`);
await fs.mkdir(outDir, { recursive: true });
const paths = await renderCards(cards, { sourceId: 10, outputDir: outDir });
console.log(`${family}: ${paths[0]}`);
await closeRenderer();
