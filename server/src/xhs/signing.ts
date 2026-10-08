import type { Page } from 'playwright';
import { logger } from '../logger.js';
import { logEvent } from '../db/index.js';

/**
 * 签名层。
 *
 * 【为什么不在这里实现 x-s 算法】
 * 小红书的 x-s 签名是逆向出来的纯算术方案，但它会定期轮换 —— 生态里
 * 维护签名器的仓库（xhshow / redbook / MediaCrawler）本质上都在追这个轮换。
 *
 * 我们的浏览器本来就停在 xiaohongshu.com 上，页面自己就带着**最新版**的签名器。
 * 所以这里不去复刻算法，而是运行时探测页面暴露的全局函数并调用它：
 *   - 零逆向成本
 *   - 小红书一改算法，页面自动跟着改，我们不用动代码
 *   - 没有任何第三方代码被复制进来（算法逆向产物本身没有干净的授权路径）
 *
 * 探测在首次成功后会缓存在 window 上，后续请求直接复用。
 */

export interface SignatureHeaders {
  'X-s': string;
  'X-t': string;
  'x-s-common'?: string;
}

type SignFn = (url: string, data: string) => unknown;

const SIGNER_CACHE_KEY = '__xhsflow_signer';

interface SignerProbe {
  found: boolean;
  name?: string;
  /** 已知的调用形态 */
  shape?: string;
  /** 探测时看到的候选全局，便于诊断 */
  candidates: string[];
}

/**
 * 在页面里跑的探测脚本。
 *
 * 写成真正的函数（而不是字符串表达式）：Playwright 会把它序列化后调用。
 * 之前用字符串写成了箭头函数 *表达式*，求值出来是个函数对象、根本没被调用。
 * 这些函数体内不得引用任何 Node 侧变量，只能用字面量。
 */
function PROBE_SCRIPT() {
  const cache = (w: Record<string, unknown>) => w['__xhsflow_signer'];
  if (cache(window as unknown as Record<string, unknown>)) return { hit: true };

  // 已知候选：_webmsxyw（cookie 名同名）、_webmsxyw 的各种大小写变体，
  // 以及历史上出现过的其他全局。
  const w = window as unknown as Record<string, unknown>;
  const names = ['_webmsxyw', '_webmsxyw2', 'webmsxyw', '_xhs_sign', '__xhs_sign', 'xhsSign', '_sign'];
  const present = names.filter((n) => typeof w[n] === 'function');
  const broad = Object.keys(window).filter((k) => /msxyw|sign/i.test(k)).slice(0, 40);

  if (present.length === 0) {
    return { hit: false, candidates: broad };
  }

  // 逐个试各种调用形态，直到产出一个像签名的对象
  const probeUrl = 'https://edith.xiaohongshu.com/api/sns/web/v1/config';
  const shapes = [
    (fn: unknown, u: string) => (fn as (...a: unknown[]) => unknown)(u, ''),
    (fn: unknown, u: string) => (fn as (...a: unknown[]) => unknown)(u),
    (fn: unknown, u: string) => (fn as (...a: unknown[]) => unknown)({ url: u, data: '' }),
    (fn: unknown, u: string) => (fn as (...a: unknown[]) => unknown)({ path: u, data: '' }),
    (fn: unknown, u: string) => (fn as (...a: unknown[]) => unknown)({ uri: u, data: '' }),
    // 实测 _webmsxyw.length === 0：可能是工厂，先调它拿到内层签名器再签
    (fn: unknown, u: string) => {
      const r = (fn as () => unknown)();
      if (typeof r !== 'function') return null;
      for (const inner of [
        (x: string, d: string) => (r as (...a: unknown[]) => unknown)(x, d),
        (x: string) => (r as (...a: unknown[]) => unknown)(x),
        (x: string) => (r as (...a: unknown[]) => unknown)({ url: x, data: '' }),
      ]) {
        try {
          const v = inner(u, '');
          if (v) return v;
        } catch {
          /* 换下一个 */
        }
      }
      return null;
    },
  ];

// 归一化：把 x-s / x_s / X-S / xs 统一成 'xs'，否则返回 {x_s, x_t} 会漏掉
  const norm = (k: string) => k.toLowerCase().replace(/[-_]/g, '');
  const pick = (
    v: unknown,
  ): { s: unknown; t: unknown; common?: unknown } | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return null;
    if (Array.isArray(v)) {
      for (const el of v) {
        const r = pick(el);
        if (r) return r;
      }
      return null;
    }
    if (typeof v === 'object') {
      const out: { s?: unknown; t?: unknown; common?: unknown } = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const lk = norm(k);
        if (lk === 'xs') out.s = val;
        else if (lk === 'xt') out.t = val;
        else if (lk === 'xscommon' || lk === 'scommon') out.common = val;
      }
      if (out.s !== undefined && out.t !== undefined) {
        return out as { s: unknown; t: unknown; common?: unknown };
      }
    }
    return null;
  };

  const attempts: unknown[] = [];
  for (const name of present) {
    for (let i = 0; i < shapes.length; i++) {
      try {
        const raw = shapes[i]!(w[name], probeUrl);
        const got = pick(raw);
        attempts.push({
          name,
          shape: i,
          outcome: got ? 'ok' : 'no-sign',
          sLen: got ? String(got.s).length : undefined,
          tLen: got ? String(got.t).length : undefined,
          sHead: got ? String(got.s).slice(0, 16) : undefined,
          rawKeys:
            raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 6) : String(raw).slice(0, 40),
        });
        if (got && typeof got.s === 'string' && got.s.length > 0) {
          w['__xhsflow_signer'] = { name, shape: i };
          return { hit: true, name, shape: i, attempts };
        }
      } catch (e) {
        attempts.push({ name, shape: i, outcome: 'throw', raw: String(e).slice(0, 80) });
      }
    }
  }
  return { hit: false, candidates: broad, present, attempts };
}

/** 用已发现的形态对真实 URL 签名。同样必须是真函数，且不得引用 Node 侧变量。 */
function SIGN_SCRIPT(args: { url: string; data: string; name: string; shape: number }) {
  const { url, data, name, shape } = args;
  const fn = (window as unknown as Record<string, unknown>)[name];
  if (typeof fn !== 'function') return null;
  const call = fn as (...a: unknown[]) => unknown;

  const shapes = [
    (u: string) => call(u, data),
    (u: string) => call(u),
    (u: string) => call({ url: u, data }),
    (u: string) => call({ path: u, data }),
    (u: string) => call({ uri: u, data }),
    (u: string) => {
      const r = call();
      if (typeof r !== 'function') return null;
      for (const inner of [
        (x: string, d: string) => (r as (...a: unknown[]) => unknown)(x, d),
        (x: string) => (r as (...a: unknown[]) => unknown)(x),
        (x: string) => (r as (...a: unknown[]) => unknown)({ url: x, data: '' }),
      ]) {
        try {
          const v = inner(u, data);
          if (v) return v;
        } catch {
          /* 换下一个 */
        }
      }
      return null;
    },
  ];

  let raw: unknown;
  try {
    raw = shapes[shape]!(url);
  } catch (e) {
    return { error: String(e) };
  }

  const norm = (k: string) => k.toLowerCase().replace(/[-_]/g, '');
  const pick = (v: unknown): { s: unknown; t: unknown; common?: unknown } | null => {
    if (v === null || v === undefined || typeof v === 'string') return null;
    if (Array.isArray(v)) {
      for (const el of v) {
        const r = pick(el);
        if (r) return r;
      }
      return null;
    }
    if (typeof v === 'object') {
      const out: { s?: unknown; t?: unknown; common?: unknown } = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const lk = norm(k);
        if (lk === 'xs') out.s = val;
        else if (lk === 'xt') out.t = val;
        else if (lk === 'xscommon' || lk === 'scommon') out.common = val;
      }
      if (out.s !== undefined && out.t !== undefined) {
        return out as { s: unknown; t: unknown; common?: unknown };
      }
    }
    return null;
  };

  const got = pick(raw);
  // X-t 实测是 number（13 位时间戳），X-s 是 string —— 都要归一成字符串
  return got
    ? { s: String(got.s), t: String(got.t), common: got.common ? String(got.common) : null }
    : null;
}

export interface SignerState {
  ready: boolean;
  name?: string;
  shape?: number;
  diagnostic: string;
}

let cachedState: SignerState = { ready: false, diagnostic: '尚未探测' };

export function signerState(): SignerState {
  return cachedState;
}

export async function probeSigner(page: Page): Promise<SignerState> {
  // 页面脚本有时是懒加载的，给它一点时间把签名器塞进 window
  let lastAttempts: unknown[] = [];
  let presentNames: string[] = [];

  for (let attempt = 0; attempt < 6; attempt++) {
    const res = (await page.evaluate(PROBE_SCRIPT)) as
      | { hit: true; name: string; shape: number }
      | { hit: false; candidates: string[]; present?: string[]; attempts?: unknown[] }
      | null;

    if (res?.hit) {
      cachedState = {
        ready: true,
        name: res.name,
        shape: res.shape,
        diagnostic: `已发现页面签名器 ${res.name}（调用形态 #${res.shape}）`,
      };
      logger.info(cachedState.diagnostic);
      logEvent('signature', cachedState.diagnostic);
      return cachedState;
    }

    if (res && !res.hit) {
      if (res.attempts) lastAttempts = res.attempts;
      if (res.present) presentNames = res.present;
    }

    await page.waitForTimeout(2000 * (attempt + 1));
  }

  // 区分「压根没这个全局」和「有但没试对调用形态」——两者的修法完全不同
  const diag = presentNames.length
    ? `找到签名函数 [${presentNames.join(', ')}] 但所有调用形态都没产出签名；形态尝试：${JSON.stringify(lastAttempts).slice(0, 400)}`
    : `页面未暴露签名函数。相关全局：${JSON.stringify(lastAttempts).slice(0, 300)}`;

  cachedState = { ready: false, diagnostic: diag };
  logEvent('signature', diag, { severity: 'warn' });
  return cachedState;
}

/** 为某个请求签名。签名不可用时返回 null，由调用方决定降级策略。 */
export async function sign(
  page: Page,
  url: string,
  data = '',
): Promise<SignatureHeaders | null> {
  if (!cachedState.ready) {
    const ok = await probeSigner(page);
    if (!ok.ready) return null;
  }

  const res = (await page.evaluate(SIGN_SCRIPT, {
    url,
    data,
    name: cachedState.name as string,
    shape: cachedState.shape as number,
  })) as { s: string; t: string; common: string | null } | { error: string } | null;

  if (!res || 'error' in res || !res.s || !res.t) {
    logEvent('signature', `签名调用失败：${res && 'error' in res ? res.error : '返回为空'}`, {
      severity: 'warn',
    });
    return null;
  }

  const headers: SignatureHeaders = { 'X-s': res.s, 'X-t': res.t };
  if (res.common) headers['x-s-common'] = res.common;
  return headers;
}

/** 重置缓存，用于页面刷新后重新探测。 */
export function resetSigner(): void {
  cachedState = { ready: false, diagnostic: '尚未探测' };
}