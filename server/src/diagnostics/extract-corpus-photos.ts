import { extractCorpusPhotos } from '../visual/templates/corpus-photos.js';
import { closeRenderer } from '../generate/cards.js';

/**
 * 抽取语料配图池。
 *
 *   node server/dist/diagnostics/extract-corpus-photos.js [sourceId]
 *
 * 把语料页面里的实拍/案例图抠出来存进 data/media/corpus-photos/，
 * 并写进 corpus_photos 表。之后创作时按内容相关度从中挑图，
 * 不再走免费图库。
 */
const args = process.argv.slice(2);
const sourceId = Number(args.find((a) => /^\d+$/.test(a)) ?? '10');

const photos = await extractCorpusPhotos(sourceId);
console.log(`来源 ${sourceId}：抽出 ${photos.length} 张语料案例图`);
for (const p of photos.slice(0, 40)) {
  console.log(
    `  note ${p.noteId} 页 ${p.pageIndex}：${p.w}×${p.h} @(${p.x},${p.y})  面积 ${p.tiles} 格`,
  );
}

await closeRenderer();
