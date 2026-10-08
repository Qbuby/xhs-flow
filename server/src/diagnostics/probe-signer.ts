/**
 * 一次性诊断脚本：检查小红书页面到底暴露了哪些可用于签名的全局函数。
 *
 * 签名层是整个爬虫的命门 —— 如果页面没暴露签名器，我们就得全靠 SSR 解析降级。
 * 这个脚本把页面里所有疑似签名相关的全局捞出来打印，方便改探针时对照。
 *
 *   node --experimental-strip-types server/src/diagnostics/probe-signer.ts
 */
import { chromium } from 'playwright';
import { PROFILE_DIR } from '../config.js';

const XHS = 'https://www.xiaohongshu.com';

async function main(): Promise<void> {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await ctx.newPage();
  console.log('→ 打开', XHS);
  await page.goto(`${XHS}/explore`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(6000);

  const report = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    // 1. 所有疑似签名相关的全局
    out.signLikeGlobals = Object.keys(window)
      .filter((k) => /msxyw|sign|encrypt|shield|token|xhs/i.test(k))
      .slice(0, 60)
      .map((k) => ({
        key: k,
        type: typeof w[k],
        arity: typeof w[k] === 'function' ? (w[k] as (...a: unknown[]) => unknown).length : null,
      }));

    // 2. 已知候选是否存在
    out.knownCandidates = [
      '_webmsxyw',
      '_webmsxyw2',
      'webmsxyw',
      '__webmsxyw',
      '_xhs_sign',
      'xhsSign',
    ].map((n) => ({ name: n, present: typeof w[n] === 'function' }));

    // 3. cookie 现状
    out.cookies = document.cookie
      .split(';')
      .map((s) => s.trim().split('=')[0])
      .filter(Boolean);

    // 4. 页面自己发出的签名请求头长什么样（最有价值的线索）
    return out;
  });

  // 抓一次页面自己发出的 API 请求，直接看它带了哪些签名头
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  page.on('request', (req) => {
    const u = req.url();
    if (!u.includes('/api/sns/web/')) return;
    const h = req.headers();
    const picked: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      if (/^(x-s|x-t|x-s-common|x-b3-traceid)$/i.test(k)) picked[k] = v;
    }
    seen.push({ url: u, headers: picked });
  });

  // 触发一次搜索，让页面自己发请求
  console.log('→ 触发页面自身 API 请求');
  try {
    await page.goto(`${XHS}/explore`, { waitUntil: 'networkidle', timeout: 30_000 });
  } catch {
    /* 超时没关系 */
  }
  await page.waitForTimeout(5000);

  console.log('\n=== 疑似签名全局 ===');
  console.table(report.signLikeGlobals);
  console.log('\n=== 已知候选 ===');
  console.table(report.knownCandidates);
  console.log('\n=== cookie 名 ===');
  console.log((report.cookies as string[]).join(', '));
  console.log('\n=== 页面自身请求携带的签名头 ===');
  console.log(seen.length ? JSON.stringify(seen.slice(0, 3), null, 2) : '(未捕获到 API 请求)');

  await ctx.close();
}

main().catch((err) => {
  console.error('诊断失败：', err);
  process.exit(1);
});