import path from 'node:path';
import fs from 'node:fs/promises';
import { renderCards, closeRenderer, type Card } from '../generate/cards.js';
import { RECIPES, buildPageRecipe, type RecipeId } from '../generate/design/recipes.js';
import { MEDIA_DIR } from '../config.js';

/**
 * 把 10 种页面配方各渲染一张，验证**画面构成真的不同**。
 *
 *   node server/dist/diagnostics/render-all-recipes.js
 *
 * 这是「出的图很雷同」的直接验收：
 * 之前不管换多少版式，画出来都是「大标题 + 一列字」；
 * 现在 10 种配方应该画出 10 种明显不同的构成。
 */
const outDir = path.join(MEDIA_DIR, 'diagnostics', 'recipes');
await fs.mkdir(outDir, { recursive: true });

const blocks = {
  eyebrow: 'BRAND · 01',
  title: '先把"品牌长什么样"统一',
  subtitle: '这是 VI 的地基，先定标准再谈设计',
  hint: '把视觉真正用到日常场景里',
  conclusion: '让每个触点都指向同一个印象',
  items: [
    { text: '品牌定位', note: '先解决"你是谁"' },
    { text: '视觉识别', note: '让人一眼认出' },
    { text: '标准字体', note: '字形本身在传达性格' },
    { text: '标准色', note: '能被复述的颜色' },
    { text: '应用系统', note: '名片 / 包装 / 门头' },
    { text: '最小尺寸', note: '落地时不失真' },
  ],
  left: { title: '以前', items: ['干净', '极简', '高级'] },
  right: { title: '现在', items: ['手绘', '随意', '不规整'] },
};

const cards: Card[] = [];
const ids = Object.keys(RECIPES) as RecipeId[];
for (const [i, id] of ids.entries()) {
  const recipe = buildPageRecipe(id, blocks, String(i + 1).padStart(2, '0'));
  cards.push({
    layout: 'list',
    index: i + 1,
    family: 'wow-title-top-v1',
    recipeId: id,
    blocks,
  });
  console.log(`${id.padEnd(4)} ${RECIPES[id].name.padEnd(24)} ${recipe.steps.length} 个构件: ${recipe.steps.map((s) => s.kind).join(' → ')}`);
}

const paths = await renderCards(cards, { sourceId: 10, outputDir: outDir });
console.log('\n—— 渲染 ——');
paths.forEach((p, i) => {
  console.log(`  ${ids[i]}  ${p ? path.basename(p) : '✗ 失败'}`);
});
console.log(`\n${paths.filter(Boolean).length}/${paths.length} 张 → ${outDir}`);

await closeRenderer();
