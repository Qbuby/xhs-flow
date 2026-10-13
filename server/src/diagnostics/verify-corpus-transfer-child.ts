/**
 * verify-corpus-transfer.ts 的沙盒子进程。
 *
 * 必须是独立进程：XHSFLOW_DATA_DIR 要在 config/db 加载**之前**生效，
 * 同进程内做不到（db 是模块加载时初始化的单例）。
 * 用法：node verify-corpus-transfer-child.js <zipPath> <import|reimport>
 */
import fsSync from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { all, get, type Row } from '../db/index.js';
import { importCorpusZip, type ImportSummary } from '../corpus/transfer.js';

const zipPath = process.argv[2] ?? '';
const mode = process.argv[3] ?? 'import';

function result(payload: unknown): void {
  console.log('RESULT:' + JSON.stringify(payload));
}

try {
  const buf = fsSync.readFileSync(zipPath);
  const summary: ImportSummary = await importCorpusZip(buf);

  const count = (sql: string, ...params: unknown[]): number =>
    Number((get<Row>(sql, ...params)?.c ?? 0));
  const counts = {
    sources: count('SELECT COUNT(*) AS c FROM sources'),
    notes: count('SELECT COUNT(*) AS c FROM notes'),
    images: count('SELECT COUNT(*) AS c FROM note_images'),
    styles: count('SELECT COUNT(*) AS c FROM note_styles'),
    profiles: count('SELECT COUNT(*) AS c FROM style_profiles'),
    topics: count('SELECT COUNT(*) AS c FROM topics'),
  };

  /* 图片落盘校验：DB 里的 local_path 必须真实存在、大小对得上，
     且落在沙盒目录里 —— 最后这条专门验证「导入重写了绝对路径」：
     路径若还指着原项目的 data/，就是导入没干活。 */
  const rows = all<Row>('SELECT local_path, bytes FROM note_images WHERE local_path IS NOT NULL');
  let compared = 0;
  let missingOnDisk = 0;
  const mismatched: string[] = [];
  const sandboxRoot = path.resolve(process.env.XHSFLOW_DATA_DIR ?? '');
  for (const r of rows) {
    const p = String(r.local_path);
    if (!fsSync.existsSync(p)) {
      missingOnDisk++;
      continue;
    }
    if (fsSync.statSync(p).size !== Number(r.bytes ?? -1)) {
      mismatched.push(p);
      continue;
    }
    if (!p.startsWith(sandboxRoot)) {
      mismatched.push('路径未重写: ' + p);
      continue;
    }
    compared++;
  }

  /* FTS：导入后必须能按 trigram 搜到笔记。
     用语料自身标题的 4 字片段当查询词 —— 不假设语料内容，
     且 trigram 分词要求 ≥3 字，短了永远 0 命中（那是测试错，不是导入错）。 */
  let ftsHit = -1;
  let ftsTerm = '';
  try {
    const firstNote = get<Row>("SELECT title FROM notes WHERE title IS NOT NULL AND title <> '' ORDER BY id LIMIT 1");
    const rawTitle = String(firstNote?.title ?? '');
    ftsTerm = rawTitle.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 4);
    if (ftsTerm.length >= 3) {
      ftsHit = count(`SELECT COUNT(*) AS c FROM notes_fts WHERE notes_fts MATCH ?`, ftsTerm);
    }
  } catch {
    ftsHit = -1; // FTS 表/分词器不可用
  }

  result({ ok: true, summary, counts, imageCheck: { compared, mismatched, missingOnDisk }, ftsHit, ftsTerm });
  process.exit(0);
} catch (err) {
  result({ ok: false, error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
