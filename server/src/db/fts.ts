import { run, transaction } from './index.js';

/**
 * 笔记进 FTS 全文索引（trigram 分词，中文可搜）。
 *
 * 单独成一个文件，是因为它有两类调用方：
 *  - xhs/scrape.ts：抓到新笔记时（各自独立小事务）
 *  - corpus/transfer.ts：导入时（在导入的大事务里逐条执行）
 *
 * 这也是为什么拆成两层：transaction() 里再开 BEGIN 会直接报
 * "cannot start a transaction within a transaction"，导入侧必须用
 * 不自带事务的statements 版本。
 */

/** 裸语句版：调用方自己保证在事务里（或接受非原子）。 */
export function indexNoteFtsStatements(notePk: number, title: string, desc: string, tags: string[]): void {
  run('DELETE FROM notes_fts WHERE rowid = ?', notePk);
  run('DELETE FROM notes_fts_map WHERE rowid = ?', notePk);
  run(
    'INSERT INTO notes_fts(rowid, title, desc, tags) VALUES (?, ?, ?, ?)',
    notePk,
    title,
    desc,
    tags.join(' '),
  );
  run('INSERT INTO notes_fts_map(rowid, note_pk) VALUES (?, ?)', notePk, notePk);
}

/** 自带小事务版：单篇笔记的索引维护是原子的。 */
export function indexNoteFts(notePk: number, title: string, desc: string, tags: string[]): void {
  transaction(() => indexNoteFtsStatements(notePk, title, desc, tags));
}
