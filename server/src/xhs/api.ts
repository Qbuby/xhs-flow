import type { Page } from 'playwright';
import { browser, XHS_ORIGIN, XHS_API_ORIGIN } from './browser.js';
import { sign } from './signing.js';
import { logger } from '../logger.js';
import { logEvent } from '../db/index.js';
import { throttle } from '../util/throttle.js';

/**
 * 传输层。
 *
 * 关键设计：请求在**真实浏览器页面里**发出，而不是 Node 的 fetch。
 * 原因很硬 —— 小红书靠 TLS ClientHello 指纹识别非浏览器客户端，
 * 成熟方案都是用 curl_cffi 之类的库伪装，而 Node 没有等价能力。
 * 我们已经有 Chromium 了，让它自己发最省事也最稳：TLS 是真 Chrome、
 * cookie 自动带、CORS 同源。
 */

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
  /** 走了哪条降级路径，成功时为 'signed-api' */
  via: string;
}

interface XhsEnvelope<T> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

const COMMON_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  // Referer/Origin 用网页域，因为请求实际是 www 页面里发往 edith 子域
  Referer: `${XHS_ORIGIN}/`,
  Origin: XHS_ORIGIN,
};

let warnedAboutSigning = false;

/**
 * 签名 API 调用。签名不可用时返回 null，调用方走降级链。
 */
export async function signedFetch<T>(
  path: string,
  opts: { method?: 'GET' | 'POST'; params?: Record<string, string>; body?: unknown } = {},
): Promise<ApiResponse<T> | null> {
  const method = opts.method ?? 'GET';
  const page = await browser.transportPage_();

  const qs = new URLSearchParams(opts.params ?? {}).toString();
  const fullUrl = qs ? `${XHS_API_ORIGIN}${path}?${qs}` : `${XHS_API_ORIGIN}${path}`;
  // 小红书签的是「路径 + query」，不含 origin
  const signTarget = qs ? `${path}?${qs}` : path;

  await throttle();

  const bodyText = opts.body === undefined ? '' : JSON.stringify(opts.body);
  const sig = await sign(page, signTarget, bodyText);

  if (!sig) {
    if (!warnedAboutSigning) {
      warnedAboutSigning = true;
      logEvent('signature', '签名不可用，API 请求将降级到 SSR 页面解析', { severity: 'warn' });
    }
    return null;
  }

  const headers: Record<string, string> = {
    ...COMMON_HEADERS,
    ...sig,
    'Content-Type': 'application/json;charset=UTF-8',
  };

  const res = await browser.rawFetch(
    fullUrl,
    { method, headers, body: method === 'POST' ? bodyText : undefined },
    path,
  );

  let parsed: XhsEnvelope<T> | undefined;
  try {
    parsed = JSON.parse(res.body) as XhsEnvelope<T>;
  } catch {
    return {
      ok: false,
      status: res.status,
      error: `响应不是 JSON（前 200 字：${res.body.slice(0, 200)}）`,
      via: 'signed-api',
    };
  }

  if (!parsed.success || (parsed.code !== 0 && parsed.code !== undefined)) {
    return {
      ok: false,
      status: res.status,
      error: `业务错误 code=${parsed.code} msg=${parsed.msg}`,
      via: 'signed-api',
    };
  }

  return { ok: true, status: res.status, data: parsed.data, via: 'signed-api' };
}

/** 无需签名的公开页面请求（SSR HTML）。 */
export async function fetchHtml(url: string): Promise<string | null> {
  await throttle();
  const res = await browser.rawFetch(url, { headers: COMMON_HEADERS }, url);
  return res.status === 200 ? res.body : null;
}

/** 打开一个真实页面（用于需要执行 JS / 滚动的场景）。 */
export async function withPage<T>(fn: (page: Page) => Promise<T>, url?: string): Promise<T> {
  return browser.withPage(fn, url);
}

/* ------------------------------------------------------------------ */
/* 端点                                                                */
/* ------------------------------------------------------------------ */

export const ENDPOINTS = {
  /** 作者主页信息 */
  userProfile: '/api/sns/web/v1/user',
  /** 作者已发布笔记 —— 全行业公认脆弱，端点有两套命名 */
  userPostedA: '/api/sns/web/v1/user_posted',
  userPostedB: '/api/sns/web/v1/user/posted',
  /** 单篇笔记详情 */
  feed: '/api/sns/web/v1/feed',
  noteDetail: '/api/sns/web/v1/note',
  /** 搜索（用于昵称反查的降级路径） */
  search: '/api/sns/web/v1/search/notes',
} as const;

/** 从各种形态的小红书链接里抽出 user_id 和 xsec_token。 */
export function parseProfileUrl(url: string): { userId: string | null; xsecToken: string | null } {
  const u = new URL(url);
  // /user/profile/<id>?xsec_token=...&xsec_source=...
  const profileMatch = /\/user\/profile\/([^/?#]+)/.exec(url);
  const userId = profileMatch?.[1] ?? null;
  const xsecToken = u.searchParams.get('xsec_token');
  return { userId, xsecToken };
}

export function noteUrl(noteId: string, xsecToken?: string | null): string {
  const base = `${XHS_ORIGIN}/explore/${noteId}`;
  return xsecToken ? `${base}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_feed` : base;
}

/** 小红书业务错误码 → 人话。风控类必须能一眼看出来，不然用户只会看到「降级链失败」。 */
export function explainCode(code: number, msg?: string): string {
  switch (code) {
    case 300011:
      return '账号被风控标记（300011 当前账号存在异常）—— 请换个账号，或等风控解除后再抓';
    case 300012:
      return 'IP 被风控（300012 IP存在风险）—— 请切换网络环境';
    case -101:
      return '未登录或登录态已过期 —— 请重新扫码登录';
    case -1:
      return '请求被拒绝（code=-1）—— 通常是签名失效或账号异常';
    case -104:
      return '账号权限受限（-104）—— 该账号可能没有抓取权限';
    default:
      return msg ? `业务错误 code=${code}：${msg}` : `业务错误 code=${code}`;
  }
}

/**
 * 逐个尝试一串同义端点，第一个成功的就用它。
 * 小红书在 user_posted / user/posted 之间反复横跳，这个降级是刚需。
 *
 * 失败原因会被收集起来 —— 排查时「到底为什么不行」比「失败了」有用得多。
 */
export async function tryEndpoints<T>(
  paths: readonly string[],
  opts: { method?: 'GET' | 'POST'; params?: Record<string, string>; body?: unknown },
): Promise<{ result: ApiResponse<T>; via: string } | null> {
  const failures: string[] = [];
  for (const p of paths) {
    const result = await signedFetch<T>(p, opts);
    if (result?.ok && result.data) {
      logger.info({ path: p }, '端点可用');
      return { result, via: p };
    }
    if (result) {
      failures.push(`${p}: ${result.error ?? `HTTP ${result.status}`}`);
      logEvent('fallback', `${p} 不可用：${result.error}`, {
        severity: 'info',
        detail: { path: p, status: result.status },
      });
    } else {
      failures.push(`${p}: 签名不可用`);
    }
  }
  lastEndpointFailures = failures;
  return null;
}

let lastEndpointFailures: string[] = [];
export function takeEndpointFailures(): string[] {
  const out = lastEndpointFailures;
  lastEndpointFailures = [];
  return out;
}