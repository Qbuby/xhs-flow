import { config } from '../config.js';

/**
 * 对数正态分布的等待时长。
 *
 * 这个形状是照抄小红书生态里成熟爬虫的防限流做法：均值固定、方差可调，
 * 请求间隔围绕 6 秒上下浮动。纯均匀分布反而容易被风控的规律性检测出来。
 *
 * @param avgDelayMs 中位数延迟
 * @param sigma      对数空间标准差，0.6 左右时波动大约在 0.55x ~ 1.8x
 */
export function logNormalDelay(avgDelayMs = config.scrape.avgDelayMs, sigma = config.scrape.delaySigma): number {
  if (sigma <= 0) return avgDelayMs;
  // Box-Muller
  const u1 = Math.max(Number.EPSILON, Math.random());
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const ms = avgDelayMs * Math.exp(sigma * z);
  return Math.min(Math.max(ms, 500), avgDelayMs * 6);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 请求之间自动插入对数正态等待。 */
export async function throttle(signal?: AbortSignal): Promise<void> {
  await sleep(logNormalDelay(), signal);
}

/** 串行限流执行，保证同一时刻只有一个在跑。 */
let chain: Promise<unknown> = Promise.resolve();
export function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  // 吞掉错误以免打断后续任务，真正的错误通过返回值传出
  chain = next.catch(() => undefined);
  return next;
}