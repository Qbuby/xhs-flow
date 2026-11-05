import { corpusPhotoPool, pickCorpusPhoto } from '../visual/templates/corpus-photo-match.js';
import { closeRenderer } from '../generate/cards.js';
import path from 'node:path';

/**
 * 检查语料配图匹配是否真的「按内容相关」。
 *
 *   node server/dist/diagnostics/check-photo-match.js [sourceId]
 *
 * 三件事：
 *   1. 池子里有什么（来源笔记 + 尺寸）
 *   2. 与某篇语料标题高度相关的文案 → 应该选中那篇的图
 *   3. 与任何语料都无关的文案 → 应该一张都不选（宁可纯文字，不配无关图）
 */
const sourceId = Number(process.argv[2] ?? '10');

const pool = corpusPhotoPool(sourceId);
console.log(`配图池：${pool.length} 张，来自 ${new Set(pool.map((p) => p.noteId)).size} 篇语料\n`);
for (const p of pool.slice(0, 20)) {
  console.log(`  note ${p.noteId} 页 ${p.pageIndex}  ${path.basename(p.file)}  ${p.tiles} 格  《${p.noteTitle.slice(0, 26)}》`);
}

/**
 * 相关用例：用 pool 里某张图的**来源笔记标题**作为文案 ——
 * 相关度应该接近 1.0，必须选中那张图。
 */
console.log('\n—— 应命中（用来源笔记标题当文案）——');
let hit = 0;
for (const p of pool.slice(0, 6)) {
  const picked = pickCorpusPhoto(sourceId, p.noteTitle);
  const ok = picked !== null && path.basename(picked).startsWith(`${p.noteId}-`);
  if (ok) hit++;
  console.log(`  《${p.noteTitle.slice(0, 24)}》 → ${picked ? path.basename(picked) : 'null'}  ${ok ? '✓' : '✗'}`);
}
console.log(`  命中 ${hit}/6`);

/**
 * 无关用例：与这个账号业务无关的文案 —— 必须返回 null。
 */
console.log('\n—— 应拒绝（与语料无关的文案）——');
const unrelated = [
  '今天中午吃什么好呢',
  '周末去哪玩比较合适',
  '如何学习编程入门',
  '汽车保养注意事项',
];
let rejected = 0;
for (const t of unrelated) {
  const picked = pickCorpusPhoto(sourceId, t);
  if (picked === null) rejected++;
  console.log(`  「${t}」 → ${picked ? path.basename(picked) : 'null'}  ${picked === null ? '✓' : '✗'}`);
}
console.log(`  拒绝 ${rejected}/${unrelated.length}`);

await closeRenderer();
