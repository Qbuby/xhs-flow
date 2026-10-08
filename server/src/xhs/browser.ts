import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import path from 'node:path';
import { PROFILE_DIR, config } from '../config.js';
import { logger } from '../logger.js';
import { logEvent } from '../db/index.js';
import { sleep } from '../util/throttle.js';
import { sign } from './signing.js';

export const XHS_ORIGIN = 'https://www.xiaohongshu.com';
/**
 * 私有 API 的真实主机。抓包确认：小红书网页自身的请求全部打向 edith 子域，
 * 不是 www。早期版本写成 www 会导致所有请求静默失败。
 */
export const XHS_API_ORIGIN = 'https://edith.xiaohongshu.com';
export const CREATOR_ORIGIN = 'https://creator.xiaohongshu.com';

/** 小红书会话真正需要的那几个 cookie。a1 是签名算法的输入，缺了就签不了。 */
export const REQUIRED_COOKIES = ['a1', 'webId', 'web_session', '_webmsxyw'] as const;

export interface CookieSnapshot {
  cookies: Record<string, string>;
  hasSession: boolean;
  missing: string[];
  webSession: string | null;
}

const HEADLESS = /^(1|true|yes|on)$/i.test(process.env.XHSFLOW_BROWSER_HEADLESS ?? 'false');

/**
 * 清理占着 profile 锁的僵尸浏览器。
 *
 * launchPersistentContext 在 userDataDir 被占用时会直接失败（"已有浏览器会话打开"），
 * 上一次进程被强杀/崩溃就会留下这种情况，服务将永远起不来。
 *
 * 关键：**只杀命令行里带我们 profile 路径的进程**，绝不能碰用户自己的 Chrome。
 */
async function killStaleProfileBrowsers(): Promise<number> {
  if (process.platform !== 'win32') return 0;

  const { execFile } = await import('node:child_process');
  // PowerShell 单引号串里只有 ' 需要转义（写两个），反斜杠是字面量 —— 不能翻倍，
  // 否则模式永远匹配不上真实的命令行。
  const marker = PROFILE_DIR.replace(/'/g, "''");

  const pids = await new Promise<number[]>((resolve) => {
    const child = execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'"`
          + ` | Where-Object { $_.CommandLine -like '*${marker}*' };`
          + ` $p | ForEach-Object { $_.ProcessId }`,
      ],
      { timeout: 15_000 },
      (_err, stdout) => resolve([...stdout.matchAll(/\d+/g)].map((m) => Number(m[0]))),
    );
    child.on('error', () => resolve([]));
  });

  if (pids.length === 0) return 0;

  logger.warn({ count: pids.length }, '发现残留浏览器占用 profile，正在清理');

  // 逐个杀，带 /T 连子进程一起清掉。合成一条 taskkill 传多个 PID 是不可靠的。
  await Promise.all(
    pids.map(
      (pid) =>
        new Promise<void>((resolve) => {
          const child = execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 15_000 });
          child.on('close', () => resolve());
          child.on('error', () => resolve());
        }),
    ),
  );

  // Windows 上 Chromium 的锁文件叫 lockfile（不是 SingletonLock），
  // 进程被杀后它仍然留在磁盘上，不删的话下次启动照样失败。
  await sleep(1500);
  try {
    const fs = await import('node:fs/promises');
    for (const name of ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      await fs.rm(path.join(PROFILE_DIR, name), { force: true, recursive: true });
    }
  } catch (err) {
    logger.debug({ err }, '清理锁文件失败（可忽略）');
  }

  // 再给 Chrome 一点时间收尾
  await sleep(1500);
  return pids.length;
}

/**
 * 容错导航。
 *
 * 小红书的风控拦截页是以非 2xx 状态码返回的，Playwright 的 goto 会直接抛错，
 * 但页面内容其实已经渲染出来了。所以这里吞掉导航错误，只在真的拿不到页面时失败。
 */
async function safeGoto(page: Page, url: string, timeout = 45_000): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const benign = /ERR_HTTP_RESPONSE_CODE_FAILURE|net::ERR_ABORTED|Timeout/i.test(msg);
    if (!benign) throw err;
    logger.debug({ url, msg }, '导航返回异常状态，但页面已渲染，继续');
  }
}

/**
 * 读页面正文，带重试。
 * 小红书在未登录/风控时会自我跳转，执行上下文会被销毁导致 evaluate 抛错，
 * 这里统一兜住并重试几次。
 */
async function readBody(page: Page, attempts = 4): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await page.locator('body').innerText({ timeout: 6000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Execution context was destroyed|Target closed|Timeout/i.test(msg)) {
        await sleep(1200);
        continue;
      }
      return '';
    }
  }
  return '';
}

/**
 * 单例浏览器会话。
 *
 * 用 launchPersistentContext 而不是每次开新浏览器：登录态（web_session）
 * 落在 userDataDir 里，进程重启后还在，这是整个服务能长期无人值守的前提。
 */
class BrowserSession {
  private ctx: BrowserContext | null = null;
  private transportPage: Page | null = null;
  private launching: Promise<BrowserContext> | null = null;

  get context(): BrowserContext | null {
    return this.ctx;
  }

  isRunning(): boolean {
    return this.ctx !== null;
  }

  async ensureLaunched(): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      const ctx = await this.launch();

      // 把 webdriver 标记摘掉，这是最基础的一层反检测
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      ctx.on('close', () => {
        this.ctx = null;
        this.transportPage = null;
        this.launching = null;
        logger.info('浏览器会话已关闭');
      });

      this.ctx = ctx;
      return ctx;
    })();

    return this.launching;
  }

  /** 带僵尸锁自愈的启动。 */
  private async launch(): Promise<BrowserContext> {
    const opts = {
      headless: HEADLESS,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-default-browser-check',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    };

    try {
      logger.info({ profileDir: PROFILE_DIR, headless: HEADLESS }, '启动浏览器会话');
      return await chromium.launchPersistentContext(PROFILE_DIR, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // profile 被占用的报错形态有好几种：
      //   1. "existing browser session"        —— Playwright 直接拒绝
      //   2. "Target page, context or browser has been closed" —— Chrome 起不来立刻退出
      //   3. ProcessSingleton / profile in use
      // 注意 Chrome 的 stderr 是 GBK 编码传过来的，中文提示会变成乱码，
      // 所以只能靠英文/结构特征判断，不能匹配「已有浏览器会话打开」。
      const locked =
        /existing browser session|ProcessSingleton|profile.*in use|opening in existing/i.test(msg) ||
        (msg.includes('launchPersistentContext') &&
          msg.includes('Target page, context or browser has been closed'));

      if (!locked) throw err;

      logger.warn('profile 被上次残留的浏览器占用，尝试清理后重试');
      const killed = await killStaleProfileBrowsers();
      if (killed === 0) {
        logEvent(
          'cookie',
          '无法启动浏览器：profile 被占用，但没找到残留进程。请关闭 xhsflow 打开的浏览器窗口后重试。',
          { severity: 'error' },
        );
        throw new Error(
          '浏览器 profile 被占用。请关闭之前由 xhsflow 打开的浏览器窗口，或删除 data/chrome-profile 下的 SingletonLock 后重试。',
        );
      }

      logEvent('cookie', `已清理 ${killed} 个残留浏览器进程`, { severity: 'warn' });
      return chromium.launchPersistentContext(PROFILE_DIR, opts);
    }
  }

  /**
   * 专用传输页：长期停在 xiaohongshu.com 上，用于探测签名器。
   * API 请求本身走 context.request（见 rawFetch），不走页面 fetch。
   */
  async transportPage_(): Promise<Page> {
    const ctx = await this.ensureLaunched();
    if (this.transportPage && !this.transportPage.isClosed()) return this.transportPage;

    const page = await ctx.newPage();
    await safeGoto(page, `${XHS_ORIGIN}/explore`);
    this.transportPage = page;
    return page;
  }

  /** 临时开一个页面做自动化操作（发布、主页滚动降级等），用完即关。 */
  async withPage<T>(fn: (page: Page) => Promise<T>, url?: string): Promise<T> {
    const ctx = await this.ensureLaunched();
    const page = await ctx.newPage();
    try {
      if (url) await safeGoto(page, url);
      return await fn(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async cookies(): Promise<Record<string, string>> {
    const ctx = await this.ensureLaunched();
    const list = await ctx.cookies([XHS_ORIGIN, CREATOR_ORIGIN]);
    const out: Record<string, string> = {};
    for (const c of list) out[c.name] = c.value;
    return out;
  }

  snapshot(): Promise<CookieSnapshot> {
    return this.cookies().then((cookies) => {
      const missing = REQUIRED_COOKIES.filter((k) => !cookies[k]);
      return {
        cookies,
        missing,
        hasSession: Boolean(cookies.web_session),
        webSession: cookies.web_session ?? null,
      };
    });
  }

  /**
   * 扫码登录：打开登录弹窗 → 截取二维码为 PNG → 轮询直到 web_session 落袋。
   * 整个流程可以无头跑，二维码以图片形式返回给前端显示，不需要用户碰浏览器。
   */
  async startQrLogin(timeoutMs = 180_000): Promise<{ qr: Buffer; promise: Promise<boolean> }> {
    const ctx = await this.ensureLaunched();
    const page = await ctx.newPage();

    await safeGoto(page, `${XHS_ORIGIN}/explore`);
    // 小红书首屏会自我跳转/懒加载，且登录弹窗是**自动弹出**的
    await sleep(4000);

    // 风控拦截页：只有一句提示，什么都点不了
    const bodyText = await readBody(page);
    if (/IP存在风险|安全限制|切换可靠网络环境/.test(bodyText)) {
      await page.close();
      throw new Error(
        '小红书对本机 IP 启动了风控（页面显示「安全限制 / IP存在风险」），扫码登录无法进行。' +
          '请换个网络环境，或改用「手动导入 Cookie」登录 —— API 在被限 IP 下仍然可用。',
      );
    }

    // ⚠️ 顺序很关键：登录弹窗是自动弹出的，不需要（也不应该）先去点「登录」按钮 ——
    // 弹窗里就有「登录」按钮，点它会提交空表单把弹窗搞坏。
    // 所以先找二维码，找不到再考虑点触发器。
    const qrSelectors = [
      '.login-container .qrcode-img',
      '.qrcode-img',
      '[class*="login"] img[class*="qrcode"]',
      '.qrcode canvas',
      '[class*="qr"] img',
    ];

    const findQr = async () => {
      for (const sel of qrSelectors) {
        try {
          const loc = page.locator(sel).first();
          if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
            return loc;
          }
        } catch {
          /* 试下一个 */
        }
      }
      return null;
    };

    let qrEl = await findQr();

    // 弹窗可能还在动画/异步加载，轮询一会儿
    for (let i = 0; i < 8 && !qrEl; i++) {
      await sleep(1500);
      qrEl = await findQr();
    }

    // 还是没有 —— 这次才尝试点开登录入口（例如上次运行把弹窗关掉了）
    if (!qrEl) {
      for (const sel of ['button:has-text("登录")', '.login-btn', '.side-bar .login-btn']) {
        try {
          const loc = page.locator(sel).first();
          if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
            await loc.click({ timeout: 2500 });
            break;
          }
        } catch {
          /* 试下一个 */
        }
      }
      for (let i = 0; i < 6 && !qrEl; i++) {
        await sleep(1500);
        qrEl = await findQr();
      }
    }

    if (!qrEl) {
      // 没找到二维码时不要把页面关掉 —— 服务默认是有头模式，浏览器窗口就在用户面前，
      // 直接让他在那个窗口里手动登录即可，登录态同样会落进 profile。
      logEvent(
        'cookie',
        '未自动抓取到登录二维码，已把浏览器留在小红书首页，请在该窗口手动登录',
        { severity: 'warn' },
      );
      throw new Error(
        '未找到登录二维码（可能是本机 IP 被风控，或小红书改版）。' +
          '浏览器窗口已经打开在小红书首页 —— 请直接在该窗口里点登录并扫码，' +
          '登录态会自动保存。也可以在「手动导入 Cookie」里贴 cookie。',
      );
    }

    const qr = await qrEl.screenshot({ type: 'png' });
    logger.info('已捕获登录二维码，等待扫码');

    const promise = (async (): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const cookies = await this.cookies();
        if (cookies.web_session) {
          logger.info('扫码登录成功，已拿到 web_session');
          logEvent('cookie', '扫码登录成功');
          await page.close();
          return true;
        }
        await sleep(2000);
      }
      await page.close();
      logEvent('cookie', '扫码登录超时', { severity: 'warn' });
      return false;
    })();

    return { qr, promise };
  }

  /**
   * 手动导入 Cookie 登录。
   *
   * 为什么必须有这条路：小红书会对 IP 做风控，被判定时网页直接返回
   * 「安全限制 / IP存在风险」（300012），连登录二维码都不渲染。
   * 但此时 **API 依然可用** —— 实测被限的 IP 仍能拿到正常业务信封。
   * 所以只要用户在自己正常的浏览器里登录好，把 cookie 串贴进来，
   * 整条流水线照常工作，完全绕开网页渲染环节。
   */
  async importCookies(cookieString: string): Promise<{ ok: boolean; imported: number; detail: string }> {
    const ctx = await this.ensureLaunched();

    const cookies = cookieString
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq <= 0) return null;
        return {
          name: pair.slice(0, eq).trim(),
          value: pair.slice(eq + 1).trim(),
        };
      })
      .filter((c): c is { name: string; value: string } => c !== null && c.value !== '');

    if (cookies.length === 0) {
      return { ok: false, imported: 0, detail: '没解析出任何 cookie，请检查是否完整复制' };
    }

    const toSet = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: '.xiaohongshu.com',
      path: '/',
    }));

    try {
      await ctx.addCookies(toSet);
    } catch (err) {
      return {
        ok: false,
        imported: 0,
        detail: `写入 cookie 失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const snap = await this.snapshot();
    logEvent('cookie', `手动导入 ${cookies.length} 个 cookie`, {
      severity: snap.hasSession ? 'info' : 'warn',
      detail: { missing: snap.missing },
    });

    return {
      ok: snap.hasSession,
      imported: cookies.length,
      detail: snap.hasSession
        ? `导入成功（${cookies.length} 个），会话可用`
        : `已写入 ${cookies.length} 个 cookie，但仍缺：${snap.missing.join('、')}`,
    };
  }

  /**
   * 检测小红书的 IP 风控拦截页。
   * 被拦截时页面只有一句「安全限制 / IP存在风险」，不会有任何内容或登录入口。
   */
  async checkIpBlocked(): Promise<{ blocked: boolean; message: string }> {
    try {
      const page = await this.transportPage_();
      const text = await readBody(page);
      if (/IP存在风险|安全限制|切换可靠网络环境|网络环境存在风险/.test(text)) {
        return {
          blocked: true,
          message:
            '小红书已对本机 IP 启动风控（页面显示「安全限制 / IP存在风险」）。' +
            '此时网页无法渲染、扫码登录不可用，但 API 仍可访问 —— 请用下方「手动导入 Cookie」完成登录。',
        };
      }
      return { blocked: false, message: '' };
    } catch {
      return { blocked: false, message: '' };
    }
  }

  /**
   * 会话健康检查。
   *
   * 刻意打一次**真实的、已签名的**只读端点，而不是只看 cookie 在不在 ——
   * cookie 存在但服务端已失效的情况很常见。
   *
   * 返回码语义（实测）：
   *   code === 0        → 已登录
   *   code === -101     → 签名通过，但没登录（需要扫码）
   *   404 / 非 JSON     → 签名或传输层出问题了
   */
  async healthCheck(): Promise<{
    ok: boolean;
    signed: boolean;
    loggedIn: boolean;
    detail: string;
  }> {
    const path = '/api/sns/web/v2/user/me';
    try {
      const page = await this.transportPage_();
      const sig = await sign(page, path, '');
      if (!sig) {
        return {
          ok: false,
          signed: false,
          loggedIn: false,
          detail: '未能生成签名 —— 将降级到 SSR 页面解析',
        };
      }

      const res = await this.rawFetch(
        `${XHS_API_ORIGIN}${path}`,
        { headers: { Accept: 'application/json, text/plain, */*', ...sig } },
        'healthcheck',
      );

      if (res.error) {
        return { ok: false, signed: false, loggedIn: false, detail: `请求失败：${res.error}` };
      }

      let envelope: { code?: number; success?: boolean; msg?: string; data?: unknown };
      try {
        envelope = JSON.parse(res.body);
      } catch {
        return {
          ok: false,
          signed: false,
          loggedIn: false,
          detail: `HTTP ${res.status} 且非 JSON —— 签名很可能失效了`,
        };
      }

      if (envelope.code === -101) {
        return { ok: false, signed: true, loggedIn: false, detail: '签名正常，但尚未登录，请扫码' };
      }
      if (envelope.success === true || envelope.code === 0) {
        return { ok: true, signed: true, loggedIn: true, detail: '会话有效' };
      }
      return {
        ok: false,
        signed: true,
        loggedIn: false,
        detail: `端点返回 code=${envelope.code} msg=${envelope.msg ?? ''}`,
      };
    } catch (err) {
      return {
        ok: false,
        signed: false,
        loggedIn: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 发一次 API 请求。
   *
   * 用 `context.request`（APIRequestContext）而不是页面里的 fetch，有两个关键理由：
   *  1. 它走浏览器自己的网络栈 —— TLS 指纹仍然是真 Chrome，Node 侧做不到这点；
   *  2. 它不受 CORS 约束 —— 我们从 www 页面打 edith 子域，自定义头 X-s/X-t 会触发
   *     预检，页面内 fetch 直接 "Failed to fetch"。
   * 同时 cookie 与浏览器上下文共享，登录态自动带上。
   */
  async rawFetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
    label = 'raw',
  ): Promise<{ status: number; body: string; error?: string }> {
    const ctx = await this.ensureLaunched();
    try {
      const res = await ctx.request.fetch(url, {
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        data: init.body,
        timeout: 30_000,
        failOnStatusCode: false,
      });
      return { status: res.status(), body: await res.text() };
    } catch (err) {
      return {
        status: 0,
        body: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async close(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = null;
    this.transportPage = null;
    this.launching = null;
    await ctx?.close().catch(() => undefined);
  }
}

export const browser = new BrowserSession();