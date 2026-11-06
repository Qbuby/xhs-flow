import {
  corpusGenreDistribution,
  detectGenre,
  GENRE_SPECS,
  pickUnderrepresentedGenre,
  type Genre,
} from '../generate/design/genre.js';
import { closeRenderer } from '../generate/cards.js';

/**
 * 体裁偏差验收 —— 「每篇都很雷同」的直接量化。
 *
 *   node server/dist/diagnostics/check-genre-balance.js [sourceId]
 *
 * 三件事：
 *   1. 语料里各体裁的真实占比（逐篇判，不经过画像压缩）
 *   2. 成稿里各体裁的占比，与语料的偏离
 *   3. 模拟「按欠配补体裁」连排 12 篇，看体裁是否铺开
 */
const sourceId = Number(process.argv[2] ?? '10');

const dist = corpusGenreDistribution(sourceId);
console.log(`=== 语料体裁分布（逐篇判定，共 ${dist.total} 篇）===`);
for (const c of dist.counts) {
  console.log(
    `  ${c.name.padEnd(8)} ${String(c.count).padStart(3)} 篇  ${(c.ratio * 100).toFixed(0).padStart(3)}%  例：${c.examples[0] ?? ''}`,
  );
}

/**
 * 模拟连续排产：每轮按"欠配最多"补一个体裁，
 * 把结果投进窗口再算下一轮 —— 与生产链同一套逻辑。
 */
console.log('\n=== 模拟连排 12 篇（每轮补最欠的体裁）===');
const window: Genre[] = [];
const seq: Genre[] = [];
for (let i = 0; i < 12; i++) {
  const g = pickUnderrepresentedGenre(sourceId, window);
  seq.push(g);
  window.push(g);
  console.log(`  ${String(i + 1).padStart(2)}. ${GENRE_SPECS[g].name}`);
}

const counts = new Map<Genre, number>();
for (const g of seq) counts.set(g, (counts.get(g) ?? 0) + 1);
console.log('\n  分布：' + [...counts.entries()].map(([g, n]) => `${GENRE_SPECS[g].name}×${n}`).join('  '));
console.log(`  不同体裁数：${counts.size} / ${dist.counts.length} 种`);

// 与语料占比对照
console.log('\n=== 连排 12 篇 vs 语料占比 ===');
let maxDelta = 0;
for (const c of dist.counts) {
  const n = counts.get(c.genre) ?? 0;
  const r = n / 12;
  const d = r - c.ratio;
  if (Math.abs(d) > Math.abs(maxDelta)) maxDelta = d;
  console.log(
    `  ${c.name.padEnd(8)} 语料 ${(c.ratio * 100).toFixed(0).padStart(3)}%  连排 ${(r * 100).toFixed(0).padStart(3)}%  ${d >= 0 ? '+' : ''}${(d * 100).toFixed(0)}pt`,
  );
}
console.log(`\n最大偏离 ${(maxDelta * 100).toFixed(0)}pt（越小越接近语料）`);

// 现有成稿的体裁
console.log('\n=== 现有成稿的体裁（诊断旧数据）===');
const { all } = await import('../db/index.js');
const drafts = all<{ title: string }>(
  'SELECT title FROM drafts WHERE source_id = ? ORDER BY id DESC LIMIT 40',
  sourceId,
);
const dc = new Map<Genre, number>();
for (const d of drafts) {
  const g = detectGenre(d.title);
  dc.set(g, (dc.get(g) ?? 0) + 1);
}
for (const [g, n] of [...dc.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${GENRE_SPECS[g].name.padEnd(8)} ${String(n).padStart(2)} 篇  ${((n / drafts.length) * 100).toFixed(0)}%`);
}

await closeRenderer();
