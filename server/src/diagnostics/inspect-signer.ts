/**
 * 直接在页面里调 _webmsxyw，把真实返回值原样打印出来。
 * 用于确定签名器的确切调用形态和返回类型。
 *
 *   node server/dist/diagnostics/inspect-signer.js
 */
import { chromium } from 'playwright';
import { PROFILE_DIR } from '../config.js';

const XHS = 'https://www.xiaohongshu.com';

async function main(): Promise<void> {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();
  await page.goto(`${XHS}/explore`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(7000);

  const out = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const fn = w['_webmsxyw'] as (...a: unknown[]) => unknown;
    if (typeof fn !== 'function') return { error: 'no function' };

    const safe = (f: () => unknown): unknown => {
      try {
        return f();
      } catch (e) {
        return `THROW: ${String(e)}`;
      }
    };

    const describe = (v: unknown) => ({
      jsType: typeof v,
      isArray: Array.isArray(v),
      ctor: v && typeof v === 'object' ? (v as object).constructor?.name : undefined,
      keys: v && typeof v === 'object' ? Object.keys(v as object) : undefined,
      valueTypes:
        v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>).map(([k, val]) => [
                k,
                `${typeof val}:${String(val).length}`,
              ]),
            )
          : undefined,
      strHead: String(v).slice(0, 80),
    });

    const url = 'https://edith.xiaohongshu.com/api/sns/web/v1/config';
    const results: Record<string, unknown> = {};
    results['fn(url, "")'] = describe(safe(() => fn(url, '')));
    results['fn(url)'] = describe(safe(() => fn(url)));
    results['fn()'] = describe(safe(() => fn()));
    results['fn("")'] = describe(safe(() => fn('')));
    results['fn({url,data})'] = describe(safe(() => fn({ url, data: '' })));

    const bare = safe(() => fn(url, ''));
    return { results, bare: describe(bare), bareRaw: JSON.stringify(bare).slice(0, 300) };
  });

  console.log(JSON.stringify(out, null, 2));
  await ctx.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});