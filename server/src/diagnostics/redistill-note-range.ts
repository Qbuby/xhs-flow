/**
 * 对指定来源重新蒸馏（不清空），用于模板字段扩展后的增量补齐。
 * 与生产 analyzeSource 相同函数；与 redistill-source10 的差异：
 * 这里**不清空** note_styles —— 但 analyzeSource 只处理还没有蒸馏的笔记，
 * 所以先按参数删掉指定 idx 范围的行，让它们重新进队列。
 *
 *   node server/dist/diagnostics/redistill-note-range.js 10 0 30
 *   （sourceId, 首个 noteIdx, 数量 —— 按喜欢数排序取前 N 篇）
 */
import { all, run } from '../db/index.js';
import { analyzeNote } from '../corpus/analyze.js';

const sourceId = Number(process.argv[2] ?? 10);
const start = Number(process.argv[3] ?? 0);
const limit = Number(process.argv[4] ?? 20);

const notes = all<{ id: number; title: string }>(
  `SELECT n.id, n.title FROM notes n
   WHERE n.source_id = ?
   ORDER BY n.liked_count DESC LIMIT ? OFFSET ?`,
  sourceId,
  limit,
  start,
);

console.log(`重蒸馏 source ${sourceId} 第 ${start}..${start + limit} 名共 ${notes.length} 篇`);
let ok = 0;
let failed = 0;
for (const n of notes) {
  try {
    run('DELETE FROM note_styles WHERE note_id = ?', n.id);
    await analyzeNote(n.id);
    ok++;
    if (ok % 5 === 0) console.log(`  ${ok}/${notes.length}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ note ${n.id}:`, err instanceof Error ? err.message.slice(0, 120) : String(err));
  }
}
console.log(`完成：成功 ${ok}，失败 ${failed}`);
process.exit(0);
