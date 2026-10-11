import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { PROFILE_DIR, config } from '../config.js';

/**
 * 反检测自检。
 *
 * 只打开 about:blank 与一个本地 data: 页面，**不碰小红书**，
 * 所以在账号处于处置期时也可以跑。它回答的是：
 *   1. 到底用的是真 Chrome 还是 Playwright 自带的 Chromium？
 *   2. UA 里的版本号和实际内核一致吗？
 *   3. navigator.webdriver / plugins / languages / window.chrome 看起来正常吗？
 *
 * 这些都是可以**离线判定**的特征 —— 风控不需要看行为，只看这些就知道
 * 「这不是真人用的浏览器」。所以它们对不上时，后面的拟人节奏做得再好也白搭。
 */

const CHROME_PATHS = [
  process.env.XHSFLOW_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter((p): p is string => Boolean(p));

function findRealChrome(): string | undefined {
  return CHROME_PATHS.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

function chromeMajorVersion(chromePath: string): string | undefined {
  const override = process.env.XHSFLOW_CHROME_VERSION;
  if (override && /^\d+$/.test(override)) return override;
  try {
    const dir = path.dirname(chromePath);
    const versions = fs
      .readdirSync(dir)
      .map((name) => /^(\d+)\.\d+\.\d+\.\d+$/.exec(name)?.[1])
      .filter((v): v is string => Boolean(v))
      .map(Number)
      .sort((a, b) => b - a);
    if (versions.length > 0) return String(versions[0]);
  } catch {
    /* ignore */
  }
  return undefined;
}

const ANTI_DETECT = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  Object.defineProperty(navigator, 'languages', {
    get: () => ['zh-CN', 'zh', 'en'],
    configurable: true,
  });
  if (!navigator.plugins || navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }],
      configurable: true,
    });
  }
  const w = window as unknown as { chrome?: Record<string, unknown> };
  if (!w.chrome) w.chrome = { runtime: {} };
};

async function main(): Promise<void> {
  const chromePath = config.risk.useRealChrome ? findRealChrome() : undefined;
  const major = chromePath ? chromeMajorVersion(chromePath) : undefined;

  console.log('─'.repeat(66));
  console.log('反检测自检（不访问小红书，只用 about:blank）');
  console.log('─'.repeat(66));
  console.log('XHSFLOW_USE_REAL_CHROME :', config.risk.useRealChrome);
  console.log('找到的真实 Chrome       :', chromePath ?? '(无，将使用 Playwright Chromium)');
  console.log('自动读出的主版本号      :', major ?? '(读不到)');
  console.log('');

  const width = 1380 + Math.floor(Math.random() * 120);
  const height = 860 + Math.floor(Math.random() * 80);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width, height },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: chromePath
      ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major ?? '131'}.0.0.0 Safari/537.36`
      : undefined,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-infobars',
      '--no-first-run',
      '--no-service-autorun',
      '--password-store=basic',
      '--disable-dev-shm-usage',
      '--disable-popup-blocking',
    ],
    ...(chromePath ? { executablePath: chromePath } : {}),
  });
  await ctx.addInitScript(ANTI_DETECT);

  const page = await ctx.newPage();
  await page.goto('about:blank');

  const probe = (await page.evaluate(() => {
    const w = window as unknown as { chrome?: unknown };
    return {
      ua: navigator.userAgent,
      webdriver: navigator.webdriver,
      webdriverType: typeof navigator.webdriver,
      languages: navigator.languages,
      pluginCount: navigator.plugins.length,
      hasWindowChrome: Boolean(w.chrome),
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
    };
  })) as Record<string, unknown>;

  // 内核真实版本：从 CDP 的 browserVersion 拿，比 UA 可靠
  const cdp = await page
    .context()
    .newCDPSession(page)
    .then((s) => s.send('Browser.getVersion'))
    .catch(() => null);
  const realProduct = (cdp as { product?: string } | null)?.product ?? '(拿不到)';

  console.log('内核真实标识 (CDP)      :', realProduct);
  console.log('页面看到的 UA           :', probe.ua);
  console.log('');
  console.log('navigator.webdriver     :', probe.webdriverType, `(${String(probe.webdriver)})`);
  console.log('navigator.languages     :', JSON.stringify(probe.languages));
  console.log('navigator.plugins.length:', probe.pluginCount);
  console.log('window.chrome           :', probe.hasWindowChrome);
  console.log('platform                :', probe.platform);
  console.log('hardwareConcurrency     :', probe.hardwareConcurrency);
  console.log('deviceMemory            :', probe.deviceMemory);
  console.log('');

  // ── 判定 ──
  const uaMajor = /Chrome\/(\d+)\./.exec(String(probe.ua))?.[1];
  const kernelMajor = /Chrome\/(\d+)\./.exec(realProduct)?.[1]
    ?? /HeadlessChrome\/(\d+)\./.exec(realProduct)?.[1];

  const problems: string[] = [];
  if (!chromePath) {
    problems.push('没找到真实 Chrome —— 现在跑的是 Playwright 自带 Chromium，「非真人浏览器」可以离线判定。');
  }
  if (probe.webdriver !== undefined) {
    problems.push('navigator.webdriver 没有被摘掉（initScript 没生效？）。');
  }
  if (uaMajor && kernelMajor && uaMajor !== kernelMajor) {
    problems.push(`UA 说自己是 Chrome/${uaMajor}，实际内核是 ${kernelMajor} —— 对不上，等于自曝。`);
  }
  if (!probe.hasWindowChrome) {
    problems.push('window.chrome 缺失。');
  }
  if (probe.pluginCount === 0) {
    problems.push('navigator.plugins 为空。');
  }
  if (/HeadlessChrome/i.test(realProduct)) {
    problems.push('内核标识里带 HeadlessChrome —— 这不是有头模式该有的值。');
  }

  if (problems.length === 0) {
    console.log('✓ 反检测基线检查通过：真 Chrome + UA 与内核对齐 + 指纹补齐。');
  } else {
    console.log('✗ 发现问题：');
    for (const p of problems) console.log('  ·', p);
  }

  await ctx.close();
  console.log('\n（本次只打开 about:blank，未访问小红书）');
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('自检失败：', err);
  process.exit(1);
});
