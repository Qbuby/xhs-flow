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
  db.exec(sql);
}

/* ------------------------------------------------------------------ */
/* 查询辅助                                                            */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

/** node:sqlite 的 statement.all() 返回 unknown[]，这里收窄一下。 */
export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
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
/* 事件（降级 / 诊断）                                                  */
/* ------------------------------------------------------------------ */

export type EventKind = 'fallback' | 'signature' | 'cookie' | 'risk' | 'publish' | 'error';
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