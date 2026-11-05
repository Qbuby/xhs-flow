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

export interface BrowseBudget {
  kind: 'scrape' | 'publish' | 'healthcheck' | 'login';
  ok: boolean;
  reason?: string;
  used: number;
  limit: number;
  waitMin?: number;
}

export interface Health {
  ok: boolean;
  llm: { profile: string; baseURL: string; model: string; hasKey: boolean };
  llmConfigured: boolean;
  llmMissing: string[];
  stockProviders: { name: string; keyless: boolean }[];
  browser: { running: boolean; hasSession: boolean; unknown?: boolean; missingCookies: string[]; lastCheckedAt?: string | null };
  signer: { ready: boolean; diagnostic: string };
  risk?: {
    quietHours: string;
    inQuietHours: boolean;
    useRealChrome: boolean;
    cooldown: { active: boolean; until?: string; untilLocal?: string; leftHours?: number };
    budget: BrowseBudget[];
  };
  scheduler: {
    running: boolean;
    generate: string;
    /** 实际已注册的 cron。设置有值 ≠ 已注册，界面必须看这个。 */
    registeredCrons: Record<string, string>;
    generateRegistered: boolean;
    rescrapeRegistered: boolean;
    pending: number;
    running_jobs: number;
    failed: number;
    lastCompose: string | null;
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

/* ----------------------------- 语料库导入导出 ----------------------------- */

export interface CorpusOverview {
  sources: number;
  notes: number;
  images: number;
  styles: number;
  topics: number;
}

export interface CorpusImportSummary {
  sourcesAdded: number;
  sourcesMerged: number;
  notesAdded: number;
  notesSkipped: number;
  imagesAdded: number;
  imagesSkipped: number;
  stylesAdded: number;
  stylesSkipped: number;
  profilesAdded: number;
  profilesSkipped: number;
  topicsAdded: number;
  topicsSkipped: number;
  filesWritten: number;
  imagesWithoutFile: number;
}

/**
 * 导出语料库为 zip 并触发浏览器下载。
 *
 * 走 fetch → blob 而不是直接 window.open：出错时服务端返回的是 JSON，
 * 用 location 跳过去会看到一屏裸错误；blob 方式能把错误接进 toast。
 */
export async function exportCorpus(sourceId: number | 'all'): Promise<void> {
  const res = await fetch(`/api/corpus/export?sourceId=${sourceId}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  // 服务端给的文件名在 Content-Disposition 里；fetch 拿不到跨域头，这里自己拼
  const blob = await res.blob();
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `xhsflow-corpus-${sourceId}-${stamp}.zip`;
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/**
 * 导入语料库 zip。不走 api.post（那个会把 body JSON 序列化），
 * 直接把 File 原样作为请求体、标 application/zip 发出去。
 */
export async function importCorpus(file: File): Promise<CorpusImportSummary> {
  const res = await fetch('/api/corpus/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: file,
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    summary?: CorpusImportSummary;
  };
  if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  if (!body.summary) throw new Error('导入完成但没有返回结果明细');
  return body.summary;
}

export function describeImport(s: CorpusImportSummary): string {
  const parts = [
    `来源 +${s.sourcesAdded}`,
    `笔记 +${s.notesAdded}`,
    `图片 ${s.filesWritten} 张`,
  ];
  if (s.sourcesMerged) parts.push(`来源合并 ${s.sourcesMerged}`);
  if (s.notesSkipped) parts.push(`跳过已有笔记 ${s.notesSkipped}`);
  if (s.imagesWithoutFile) parts.push(`缺图 ${s.imagesWithoutFile}`);
  return parts.join(' · ');
}

/* ----------------------------- 品牌套件（模板调整） ----------------------------- */

/** 套件里的一项素材（logo 图形）。同一张原图派生深色/浅色两版。 */
export interface BrandKitAsset {
  /** 相对 data/brand-kits/ 的文件名 */
  file: string;
  /** 原始上传文件名，界面展示用 */
  originalName?: string;
  width: number;
  height: number;
  uploadedAt: string;
  /** cutout = 抠成透明底；plain = 原样保留 */
  mode: 'cutout' | 'plain';
  cutoutThreshold?: number;
}

/** 品牌套件：账号视觉系统之上的身份覆盖层。字段可空 = 沿用模板族原值。 */
export interface BrandKit {
  sourceId: number;
  brandName?: string;
  brandTagline?: string;
  logoDark?: BrandKitAsset;
  logoLight?: BrandKitAsset;
  accent?: string;
  updatedAt: string;
}

/** 一条「原值 → 新值」。 */
export interface BrandKitDiff {
  field: 'brandName' | 'brandTagline' | 'logo' | 'accent';
  label: string;
  from: string;
  to: string;
}

/** 模板族里实测出来的身份基线，用于展示「改之前是什么样」。 */
export interface BrandKitBaseline {
  brandName: string;
  brandTagline: string;
  accent: string;
  hasLogo: boolean;
  family: string;
}

/** GET /api/sources/:id/brand-kit */
export interface BrandKitState {
  sourceId: number;
  kit: BrandKit;
  /** 套件是否真的覆盖了什么（空套件不算启用） */
  active: boolean;
  overrideCount: number;
  diff: BrandKitDiff[];
  baseline: BrandKitBaseline;
  /** 服务端给的说明：套件只改身份层，版式几何不动 */
  note: string;
}

/** 自然语言解析出来的修正项。 */
export interface BrandKitPatch {
  brandName?: string;
  brandTagline?: string;
  accent?: string;
  /** 用户提到了「用这张图」，需要前端上传后才生效 */
  wantsLogoUpload?: boolean;
  /** 用户要求还原的字段 */
  clear?: Array<'brandName' | 'brandTagline' | 'logo' | 'accent'>;
  /** 给用户看的解释 */
  reply: string;
}

/** POST /api/sources/:id/brand-kit/chat 的返回（不落库，只是预览） */
export interface BrandKitChatResult {
  patch: BrandKitPatch;
  /** 应用 patch 后的套件，仅用于界面预览 */
  draftKit: BrandKit;
  diff: BrandKitDiff[];
  /** 需要用户上传素材才能完成的部分 */
  needsUpload: boolean;
}

/** POST /api/sources/:id/brand-kit/apply */
export interface BrandKitApplyResult {
  ok: boolean;
  kit: BrandKit;
  active: boolean;
  diff: BrandKitDiff[];
}

/** POST /api/sources/:id/brand-kit/logo */
export interface BrandKitLogoResult {
  ok: boolean;
  kit: BrandKit;
  prepared: { width: number; height: number; inkRatio: number };
  diff: BrandKitDiff[];
}

/** POST /api/sources/:id/brand-kit/preview */
export interface BrandKitPreviewResult {
  ok: boolean;
  files: Array<{ layout: string; url: string; width: number; height: number }>;
}