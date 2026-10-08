const BASE = '';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const api = {
  get: <T,>(p: string) => req<T>(p),
  post: <T,>(p: string, body?: unknown) =>
    req<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
};

/* ----------------------------- 类型 ----------------------------- */

export interface Health {
  ok: boolean;
  llm: { profile: string; baseURL: string; model: string; hasKey: boolean };
  llmConfigured: boolean;
  llmMissing: string[];
  stockProviders: string[];
  browser: { running: boolean; hasSession: boolean; missingCookies: string[] };
  signer: { ready: boolean; diagnostic: string };
  scheduler: {
    running: boolean;
    generate: string;
    publish: string;
    autoPublish: boolean;
    pending: number;
    running_jobs: number;
    failed: number;
  };
}

export interface Source {
  id: number;
  profile_url: string;
  user_id: string | null;
  nickname: string | null;
  avatar_url: string | null;
  note_count: number;
  status: string;
  last_error: string | null;
  last_scraped_at: string | null;
  styled: number;
}

export interface NoteRow {
  id: number;
  note_id: string;
  title: string;
  image_count: number;
  liked_count: number;
  collected_count: number;
  published_at: number | null;
  type: string;
  styled: number;
}

export interface Draft {
  id: number;
  source_id: number | null;
  title: string;
  body: string;
  tags: string;
  status: string;
  rendered: number;
  review_note: string | null;
  publish_error: string | null;
  published_url: string | null;
  created_at: string;
  nickname: string | null;
}

export interface DraftCard {
  id: number;
  idx: number;
  layout: string;
  content: string;
  image_path: string | null;
}

export interface Topic {
  id: number;
  title: string;
  angle: string;
  brief: string;
  status: string;
  origin: string;
}

export interface EventRow {
  id: number;
  ts: string;
  kind: string;
  severity: string;
  message: string;
  detail: string | null;
}

export interface JobRow {
  id: number;
  type: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  finished_at: string | null;
}

/** 把本地绝对路径转成前端可访问的 /media URL */
export function mediaUrl(localPath: string | null | undefined): string | null {
  if (!localPath) return null;
  const norm = localPath.replace(/\\/g, '/');
  const idx = norm.indexOf('/data/media/');
  if (idx === -1) return null;
  return norm.slice(idx);
}

export function fmtDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtNum(n: number | null | undefined): string {
  if (!n) return '0';
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}