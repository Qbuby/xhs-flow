const BASE = '';

/**
 * 注意：只有**真的带 body** 时才设 Content-Type。
 * Fastify 收到 application/json + 空 body 会直接抛
 * FST_ERR_CTP_EMPTY_JSON_BODY，请求根本进不到路由 ——
 * 表现就是「点了没反应」，而且报错完全指不到真实原因。
 */
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init.body !== null;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  const body = (await res.json()) as T & { error?: string; hint?: string };
  if (!res.ok || body.error) {
    // 把后端附带的 hint 一并带出去，界面上才能给出可操作的下一步，
    // 而不是只甩一句「HTTP 400」
    const err = new Error(body.error ?? `HTTP ${res.status}`) as Error & { hint?: string };
    if (body.hint) err.hint = body.hint;
    throw err;
  }
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
  stockProviders: { name: string; keyless: boolean }[];
  browser: { running: boolean; hasSession: boolean; unknown?: boolean; missingCookies: string[]; lastCheckedAt?: string | null };
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
  available_count: number | null;
  auto_scrape: number;
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
  published_at: string | null;
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

/**
 * 把库里存的绝对路径转成前端可访问的 URL。
 *
 * 注意：服务端把媒体挂在 "/media/" 下，不是 "/data/media/"，
 * 所以这里必须把 "/data/media/" 这段前缀去掉，
 * 否则拼出来的是 /data/media/xxx，直接 404（图会塌成一条线）。
 *
 * ⚠️ 注释里千万别写 markdown 加粗路径（如把斜杠路径用星号包起来），
 * 星号紧挨斜杠会提前闭合块注释，剩余内容被当成代码执行，
 * 报 "xxx is not defined"。这种 bug 编译期完全看不出来。
 */
export function mediaUrl(localPath: string | null | undefined): string | null {
  if (!localPath) return null;
  const norm = localPath.replace(/\\/g, '/');
  const marker = '/data/media/';
  const idx = norm.indexOf(marker);
  if (idx === -1) {
    // 已经就是 /media/ 开头的话直接用
    return norm.startsWith('/media/') ? norm : null;
  }
  return '/media/' + norm.slice(idx + marker.length);
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