/**
 * 诊断登录弹窗：把 explore 页上所有疑似「登录」的元素 dump 出来。
 * 目的：找到稳定的登录入口选择器，避免每次小红书改版都要重写。
 *
 *   node server/dist/diagnostics/inspect-login.js
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { PROFILE_DIR, MEDIA_DIR } from '../config.js';

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
  await page.goto(`${XHS}/explore`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(6000);

  const before = await page.evaluate(() => {
    const out: Array<{ tag: string; cls: string; text: string; id: string }> = [];
    for (const el of Array.from(document.querySelectorAll('button, a, div, span'))) {
      const text = (el.textContent ?? '').trim();
      if (!text || text.length > 12) continue;
      if (!/登录|扫码|手机号|验证码/.test(text)) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute('class') ?? '').slice(0, 70),
        text,
        id: el.id ?? '',
      });
      if (out.length > 25) break;
    }
    return out;
  });

  console.log('=== 未点击前的登录相关元素 ===');
  console.table(before);

  await page.screenshot({ path: path.join(MEDIA_DIR, '_sample', 'login-1-before.png') });

  // 逐个试点击，看有没有能打开二维码弹窗的
  const candidates = [
    'button:has-text("登录")',
    '.login-btn',
    '[class*="login"] button',
    'div.login-container',
    '[class*="side-bar"] [class*="login"]',
    '.user-info',
  ];

  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    try {
      if ((await loc.count()) === 0) {
        console.log(`  ✗ ${sel} —— 不存在`);
        continue;
      }
      await loc.click({ timeout: 3000 });
      await page.waitForTimeout(2500);

      const found = await page.evaluate(() => {
        const sels = [
          '.qrcode-img',
          'img[class*="qrcode"]',
          '[class*="qr-code"] img',
          'canvas[class*="qrcode"]',
          '[class*="login"] img',
        ];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el) return s;
        }
        return null;
      });

      console.log(`  ${found ? '✓' : '·'} ${sel} —— 二维码: ${found ?? '未出现'}`);
      if (found) {
        await page.screenshot({ path: path.join(MEDIA_DIR, '_sample', 'login-2-qr.png') });
        console.log('\n>>> 可用的选择器:', sel, '+', found);
        break;
      }
    } catch (e) {
      console.log(`  ✗ ${sel} —— ${String(e).slice(0, 60)}`);
    }
  }

  await page.screenshot({ path: path.join(MEDIA_DIR, '_sample', 'login-3-after.png') });
  await ctx.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});