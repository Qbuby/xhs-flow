/**
 * 逐页证据提取 + 覆盖率报告（阶段 C）。
 *
 *   node server/dist/diagnostics/extract-page-evidence.js [sourceId] [--limit N]
 *
 * 做什么：
 *   1. 扫描 data/media/corpus 下的本地图片（不联网、不碰小红书）
 *   2. 逐页像素测量 + 族分类（server/src/visual/evidence/extract.ts）
 *   3. 落库 page_evidence（含提取器版本、哈希、族、置信度）
 *   4. 打印三项**互相独立**的覆盖率（报告 2.2 的要求，不能合成一个数）
 *
 * 三项覆盖率：
 *   - 文本蒸馏覆盖率   ：note_styles / notes
 *   - 逐页视觉覆盖率   ：page_evidence / note_images
 *   - 已验证模板覆盖率 ：verified=1 的页 / 已分类的页
 *
 * 生产只用 verified 页；unknown 进校准队列，不虚报完成。
 */

import { all, get, run } from '../db/index.js';
import { MEDIA_DIR } from '../config.js';
import path from 'node:path';
import {
  EXTRACTOR_VERSION,
  classify,
  listCorpusImages,
  measurePage,
} from '../visual/evidence/extract.js';
import { logger } from '../logger.js';

const args = process.argv.slice(2);
const sourceId = Number(args.find((a) => /^\d+$/.test(a)) ?? 10);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

const corpusDir = path.join(MEDIA_DIR, 'corpus');

/** 落库一条证据（同 image+版本覆盖写）。 */
function upsertEvidence(row: {
  imageId: number;
  sourceId: number;
  noteId: number;
  pageIndex: number;
  sha256: string | null;
  width: number;
  height: number;
  family: string;
  confidence: number;
  evidence: unknown;
  failure: string | null;
}): void {
  run(
    `INSERT INTO page_evidence
       (image_id, source_id, note_id, page_index, sha256, width, height,
        family, confidence, extractor_version, evidence, failure, verified, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0, datetime('now'))
     ON CONFLICT(image_id, extractor_version) DO UPDATE SET
       sha256=excluded.sha256, width=excluded.width, height=excluded.height,
       family=excluded.family, confidence=excluded.confidence,
       evidence=excluded.evidence, failure=excluded.failure,
       updated_at=excluded.updated_at`,
    row.imageId, row.sourceId, row.noteId, row.pageIndex, row.sha256,
    row.width, row.height, row.family, row.confidence, EXTRACTOR_VERSION,
    JSON.stringify(row.evidence), row.failure,
  );
}

async function main(): Promise<void> {
  const images = all<{ id: number; note_id: number; idx: number; local_path: string | null; sha256: string | null; source_id: number; is_cover: number }>(
    `SELECT ni.id, ni.note_id, ni.idx, ni.local_path, ni.sha256, n.source_id, ni.is_cover
       FROM note_images ni JOIN notes n ON n.id = ni.note_id
      WHERE n.source_id = ? ORDER BY ni.note_id, ni.idx`,
    sourceId,
  );
  if (images.length === 0) {
    console.log(`来源 ${sourceId} 无本地图片，先抓取再提取。`);
    return;
  }

  console.log(`提取器 ${EXTRACTOR_VERSION}｜来源 ${sourceId}｜共 ${images.length} 页｜corpus=${corpusDir}`);

  const stats: Record<string, number> = { 'wow-ip-trend-v1': 0, 'wow-brand-case-v1': 0, 'wow-label-dark-v1': 0, unknown: 0, error: 0 };
  let done = 0;
  const failures: string[] = [];

  for (const img of images.slice(0, limit === Infinity ? undefined : limit)) {
    if (!img.local_path) {
      stats["error"] = (stats["error"] ?? 0) + 1;
      failures.push(`note ${img.note_id} 页 ${img.idx}: local_path 为空`);
      continue;
    }
    try {
      const m = await measurePage(img.local_path);
      const cls = classify(m, img.is_cover === 1);
      stats[cls.family] = (stats[cls.family] ?? 0) + 1;
      upsertEvidence({
        imageId: img.id,
        sourceId: img.source_id,
        noteId: img.note_id,
        pageIndex: img.idx,
        sha256: img.sha256,
        width: m.width,
        height: m.height,
        family: cls.family,
        confidence: cls.confidence,
        evidence: { measurement: m, reason: cls.reason },
        failure: cls.family === 'unknown' ? cls.reason : null,
      });
    } catch (err) {
      stats["error"] = (stats["error"] ?? 0) + 1;
      failures.push(`note ${img.note_id} 页 ${img.idx}: ${(err as Error).message}`);
      upsertEvidence({
        imageId: img.id,
        sourceId: img.source_id,
        noteId: img.note_id,
        pageIndex: img.idx,
        sha256: img.sha256,
        width: 0,
        height: 0,
        family: 'unknown',
        confidence: 0,
        evidence: null,
        failure: `提取异常：${(err as Error).message}`,
      });
    }
    done++;
    if (done % 25 === 0) console.log(`  …${done}/${Math.min(images.length, limit)}`);
  }

  /* --- 三项覆盖率 --- */
  const totalNotes = get<{ c: number }>('SELECT COUNT(*) AS c FROM notes WHERE source_id = ?', sourceId)?.c ?? 0;
  const distilled = get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM note_styles ns JOIN notes n ON n.id = ns.note_id WHERE n.source_id = ?',
    sourceId,
  )?.c ?? 0;
  const totalPages = images.length;
  const evidencePages = get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM page_evidence WHERE source_id = ? AND extractor_version = ?',
    sourceId, EXTRACTOR_VERSION,
  )?.c ?? 0;
  const verifiedPages = get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM page_evidence WHERE source_id = ? AND extractor_version = ? AND verified = 1",
    sourceId, EXTRACTOR_VERSION,
  )?.c ?? 0;

  const pct = (a: number, b: number): string => (b ? `${Math.round((a / b) * 100)}% (${a}/${b})` : 'n/a');

  console.log('\n── 覆盖率（三项独立，不可相加） ──');
  console.log(`  文本蒸馏覆盖率    ${pct(distilled, totalNotes)}`);
  console.log(`  逐页视觉覆盖率    ${pct(evidencePages, totalPages)}`);
  console.log(`  已验证模板覆盖率  ${pct(verifiedPages, Math.max(1, evidencePages - stats['unknown']!))}`);
  console.log(`  族分布            ip-trend=${stats['wow-ip-trend-v1']}  brand-case=${stats['wow-brand-case-v1']}  label-dark=${stats['wow-label-dark-v1']}  unknown=${stats['unknown']}  error=${stats['error'] ?? 0}`);

  const unknownRows = all<{ note_id: number; page_index: number; failure: string | null }>(
    `SELECT note_id, page_index, failure FROM page_evidence
      WHERE source_id = ? AND extractor_version = ? AND family = 'unknown'
      ORDER BY note_id, page_index LIMIT 12`,
    sourceId, EXTRACTOR_VERSION,
  );
  if (unknownRows.length > 0) {
    console.log('\n── unknown 校准队列（前 12） ──');
    for (const u of unknownRows) console.log(`  note ${u.note_id} 页 ${u.page_index}: ${u.failure ?? '未分类'}`);
  }
  if (failures.length > 0) {
    console.log('\n── 提取失败 ──');
    for (const f of failures.slice(0, 10)) console.log(`  ${f}`);
  }
  logger.info({ sourceId, ...stats }, '逐页视觉证据提取完成');
}

await main();
process.exit(0);
