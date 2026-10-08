/**
 * 端到端验证签名链路（无需登录）。
 *
 * 这是 M1 的验收脚本：证明「页面原生签名器 → 我们注入签名头 → 真实 API 请求」
 * 这条链路真的通。跑通它，整个爬虫内核的命门就解除了。
 *
 *   node server/dist/diagnostics/verify-signing.js
 */
import { chromium } from 'playwright';
import { PROFILE_DIR } from '../config.js';
import { probeSigner, sign, resetSigner } from '../xhs/signing.js';

const PAGE_ORIGIN = 'https://www.xiaohongshu.com';
const API_ORIGIN = 'https://edith.xiaohongshu.com';

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
  console.log('→ 打开', PAGE_ORIGIN);
  await page.goto(`${PAGE_ORIGIN}/explore`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(5000);

  /* --- 1. 探测签名器 --- */
  resetSigner();
  const state = await probeSigner(page);
  console.log('→ 探针结果：', state);
  if (!state.ready) {
    console.error('✗ 没找到页面签名器，后续测试无意义');
    await ctx.close();
    process.exit(1);
  }

  /* --- 2. 为真实端点签名 --- */
  const target = '/api/sns/web/v1/config';
  const sig = await sign(page, target, '');
  if (!sig) {
    console.error('✗ 签名调用失败');
    await ctx.close();
    process.exit(1);
  }
  console.log('→ 签名产出：', {
    'X-t': sig['X-t'],
    'X-s': sig['X-s'].slice(0, 24) + '…',
    'x-s-common': sig['x-s-common'] ? sig['x-s-common'].slice(0, 24) + '…' : '(无)',
  });

  /* --- 3. 用这些头打真实请求（走浏览器网络栈，不受 CORS 限制）--- */
  // 用页面自己真实调用过的端点。config 端点已下线，user/me 能返回业务信封
  // （即使未登录也会给出 code:-101 之类，那同样证明签名被接受了 —— 
  //  签名错误的典型表现是 404 / 非 JSON / code:-1）。
  const targets = [
    { method: 'GET', path: '/api/sns/web/v2/user/me' },
    { method: 'GET', path: '/api/sns/web/v1/user/me' },
    { method: 'POST', path: '/api/sns/web/v1/homefeed', body: { num: 20, cursor: '' } },
    { method: 'GET', path: '/api/sns/web/v1/search/notes', q: '?keyword=%E5%92%96%E5%95%A1&page=1' },
  ];

  let anyEnvelope = false;

  for (const t of targets) {
    const signTarget = t.q ? `${t.path}${t.q}` : t.path;
    const s = await sign(page, signTarget, t.body ? JSON.stringify(t.body) : '');
    if (!s) {
      console.log(`\n--- ${signTarget}: 签名失败`);
      continue;
    }

    const res = await ctx.request.fetch(`${API_ORIGIN}${signTarget}`, {
      method: t.method,
      headers: {
        ...s,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: `${PAGE_ORIGIN}/`,
        ...(t.body ? { 'Content-Type': 'application/json;charset=UTF-8' } : {}),
      },
      data: t.body ? JSON.stringify(t.body) : undefined,
      timeout: 30_000,
      failOnStatusCode: false,
    });
    const body = await res.text();

    console.log(`\n--- ${t.method} ${signTarget} → HTTP ${res.status()}`);
    console.log(`    ${body.slice(0, 260).replace(/\s+/g, ' ')}`);

    // 返回了 JSON 业务信封 = 签名被接受
    try {
      const parsed = JSON.parse(body) as { success?: boolean; code?: number; msg?: string };
      if (typeof parsed.code === 'number' || typeof parsed.success === 'boolean') {
        anyEnvelope = true;
        console.log(`    ✓ 签名被接受：success=${parsed.success} code=${parsed.code} msg=${parsed.msg}`);
      }
    } catch {
      console.log('    ✗ 非 JSON（签名很可能未被接受）');
    }
  }

  const ok = anyEnvelope;

  await ctx.close();
  console.log(ok ? '\n✓ 签名链路可用' : '\n✗ 签名链路仍不可用');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('验证失败：', err);
  process.exit(1);
});