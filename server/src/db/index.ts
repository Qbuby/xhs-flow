import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR } from '../config.js';
import { MIGRATIONS } from './migrations.js';

const DB_PATH = path.join(DATA_DIR, 'xhsflow.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

// 迁移按顺序执行；用户自定义表都已用 IF NOT EXISTS，重跑是幂等的。
for (const sql of MIGRATIONS) {
  try {
    db.exec(sql);
  } catch (err) {
    // ALTER TABLE ADD COLUMN 在列已存在时会报错，这属于「已经迁移过了」，
    // 不该让整个服务起不来。
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name|already exists/i.test(msg)) {
      console.warn('[db] 迁移失败:', msg.slice(0, 120));
    }
  }
}

/* ------------------------------------------------------------------ */
/* 查询辅助                                                            */
/* ------------------------------------------------------------------ */

export type Row = Record<string, unknown>;

/** node:sqlite 的 statement.all() 返回 unknown[]，这里收窄一下。 */
export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

/**
 * 取第一行第一列的计数。
 * COUNT(*) 在 node:sqlite 里返回的是 bigint，直接当 number 用会拿到
 * BigInt，所以在这里统一转掉 —— 否则 `?? 0` 这类兜底判断全部失效。
 */
export function count(sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...(params as never[])) as Record<string, unknown> | undefined;
  if (!row) return 0;
  const v = Object.values(row)[0];
  return typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export function run(sql: string, ...params: unknown[]): RunResult {
  const r = db.prepare(sql).run(...(params as never[]));
  return {
    changes: Number(r.changes),
    lastInsertRowid: Number(r.lastInsertRowid),
  };
}

export function exec(sql: string): void {
  db.exec(sql);
}

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 设置项                                                              */
/* ------------------------------------------------------------------ */

export function getSetting(key: string): string | undefined {
  return get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
}

export function setSetting(key: string, value: string): void {
  run(
    `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    key,
    value,
  );
}

export function allSettings(): Record<string, string> {
  const rows = all<{ key: string; value: string }>('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/* ------------------------------------------------------------------ */
/* 长任务进度                                                           */
/* ------------------------------------------------------------------ */

export interface JobProgress {
  jobId: number;
  phase: 'distill' | 'profile';
  done: number;
  failed: number;
  total: number;
  noteId: number | null;
  noteTitle: string | null;
  updatedAt: string;
}

type ProgressRow = {
  job_id: number;
  phase: string;
  done: number;
  failed: number;
  total: number;
  note_id: number | null;
  note_title: string | null;
  updated_at: string;
};

function toProgress(r: ProgressRow): JobProgress {
  return {
    jobId: r.job_id,
    phase: (r.phase === 'profile' ? 'profile' : 'distill'),
    done: r.done,
    failed: r.failed,
    total: r.total,
    noteId: r.note_id,
    noteTitle: r.note_title,
    updatedAt: r.updated_at,
  };
}

/** 起跑前先占一行，界面才不会在「已入队」和「开始处理」之间出现空窗。 */
export function startJobProgress(jobId: number, phase: JobProgress['phase'], total: number): void {
  run(
    `INSERT INTO job_progress(job_id, phase, done, failed, total, updated_at)
     VALUES (?, ?, 0, 0, ?, datetime('now'))
     ON CONFLICT(job_id) DO UPDATE SET
       phase = excluded.phase, done = 0, failed = 0, total = excluded.total,
       note_id = NULL, note_title = NULL, updated_at = datetime('now')`,
    jobId,
    phase,
    total,
  );
}

export function updateJobProgress(
  jobId: number,
  patch: Partial<Pick<JobProgress, 'phase' | 'done' | 'failed' | 'total' | 'noteId' | 'noteTitle'>>,
): void {
  const cur = get<ProgressRow>('SELECT * FROM job_progress WHERE job_id = ?', jobId);
  if (!cur) return;
  const next = { ...toProgress(cur), ...patch };
  run(
    `UPDATE job_progress SET phase=?, done=?, failed=?, total=?, note_id=?, note_title=?,
     updated_at=datetime('now') WHERE job_id=?`,
    next.phase,
    next.done,
    next.failed,
    next.total,
    next.noteId,
    next.noteTitle,
    jobId,
  );
}

export function clearJobProgress(jobId: number): void {
  run('DELETE FROM job_progress WHERE job_id = ?', jobId);
}

export function getJobProgress(jobId: number): JobProgress | null {
  const r = get<ProgressRow>('SELECT * FROM job_progress WHERE job_id = ?', jobId);
  return r ? toProgress(r) : null;
}

/* ------------------------------------------------------------------ */
/* 事件（降级 / 诊断）                                                  */
/* ------------------------------------------------------------------ */

export type EventKind = 'fallback' | 'signature' | 'cookie' | 'risk' | 'publish' | 'corpus' | 'error';
export type EventSeverity = 'info' | 'warn' | 'error';

export function logEvent(
  kind: EventKind,
  message: string,
  opts: { severity?: EventSeverity; detail?: unknown } = {},
): void {
  run(
    'INSERT INTO events(kind, severity, message, detail) VALUES (?, ?, ?, ?)',
    kind,
    opts.severity ?? 'info',
    message,
    opts.detail === undefined ? null : JSON.stringify(opts.detail),
  );
}

export function recentEvents(limit = 50): Row[] {
  return all('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit);
}

/* ------------------------------------------------------------------ */
/* 运行日志                                                            */
/* ------------------------------------------------------------------ */

export function recordRunLog(level: string, scope: string, message: string, detail?: unknown): void {
  run(
    'INSERT INTO run_logs(level, scope, message, detail) VALUES (?, ?, ?, ?)',
    level,
    scope,
    message,
    detail === undefined ? null : JSON.stringify(detail),
  );
}

export function recentRunLogs(limit = 200): Row[] {
  return all('SELECT * FROM run_logs ORDER BY id DESC LIMIT ?', limit);
}

export function closeDb(): void {
  try {
    db.close();
  } catch {
    /* 已经关了就无所谓 */
  }
}