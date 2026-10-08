import path from 'node:path';
import fs from 'node:fs/promises';
import { browser, CREATOR_ORIGIN } from './browser.js';
import { logger } from '../logger.js';
import { logEvent, run, all } from '../db/index.js';
import { serialize } from '../util/throttle.js';

/**
 * 创作中心发布（UI 自动化）。
 *
 * 为什么不走发布 API：创作端签名同样逆向且变动频繁，没有降级路径，
 * 一旦失效整条链路就断了。网页 UI 自动化虽然慢、选择器会变，
 * 但它模拟的就是真人操作，稳得多。
 *
 * 因此**所有选择器集中在这里**，改版时只改这一处。
 */

const PUBLISH_URL = `${CREATOR_ORIGIN}/publish/publish`;

const SELECTORS = {
  // 上传入口：小红书是拖拽区，但底下通常藏着 input[type=file]
  fileInput: [
    'input[type="file"]',
    '.upload-input input',
    '[class*="upload"] input[type="file"]',
  ],
  // 图片上传完成后的标题/正文输入框
  titleInput: [
    'input[placeholder*="标题"]',
    '.title-input input',
    'input.d-text[placeholder*="标题"]',
    '[class*="title"] input',
  ],
  contentInput: [
    'div[contenteditable="true"]',
    '.ql-editor',
    '[class*="content"] [contenteditable="true"]',
    '.editor[contenteditable="true"]',
  ],
  tagInput: ['input[placeholder*="话题"]', 'input[placeholder*="标签"]', '[class*="tag"] input'],
  publishBtn: [
    'button:has-text("发布")',
    '.publishBtn',
    '[class*="submit"] button',
    'button.submit',
  ],
  // 切换到「图文笔记」标签
  imageNoteTab: ['text=上传图文', 'text=图文笔记', '.creator-tab:has-text("图文")'],
} as const;

async function firstMatch(page: any, selectors: readonly string[], timeout = 8000): Promise<any | null> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        await loc.waitFor({ state: 'visible', timeout: timeout / selectors.length });
        return loc;
      }
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

export interface PublishInput {
  draftId: number;
  title: string;
  body: string;
  tags: string[];
  imagePaths: string[];
}

export interface PublishResult {
  ok: boolean;
  noteUrl?: string;
  error?: string;
  screenshot?: string;
}

const SHOT_DIR = path.resolve(process.cwd(), 'data', 'publish-shots');

export async function publishNote(input: PublishInput): Promise<PublishResult> {
  if (input.imagePaths.length === 0) {
    return { ok: false, error: '没有渲染好的卡片图片，无法发布' };
  }

  // 确认文件都在
  for (const p of input.imagePaths) {
    try {
      await fs.access(p);
    } catch {
      return { ok: false, error: `图片文件不存在：${p}` };
    }
  }

  await fs.mkdir(SHOT_DIR, { recursive: true });

  return serialize(async () => {
    const ctx = await browser.ensureLaunched();
    const page = await ctx.newPage();
    const shot = (name: string) =>
      page.screenshot({ path: path.join(SHOT_DIR, `${input.draftId}-${name}.png`), fullPage: false }).catch(() => undefined);

    try {
      logger.info({ draftId: input.draftId }, '打开创作中心');
      await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(3000);

      // 已被风控/未登录时会跳登录页
      if (page.url().includes('login')) {
        await shot('login-required');
        return { ok: false, error: '创作中心要求重新登录（可能是登录态过期或触发风控）' };
      }

      // 切到图文笔记
      const tab = await firstMatch(page, SELECTORS.imageNoteTab, 4000);
      if (tab) {
        await tab.click().catch(() => undefined);
        await page.waitForTimeout(800);
      }

      /* --- 1. 上传图片 --- */
      const fileInput = await firstMatch(page, SELECTORS.fileInput, 6000);
      if (!fileInput) {
        await shot('no-file-input');
        return { ok: false, error: '未找到文件上传控件 —— 创作中心页面结构可能已改版' };
      }
      await fileInput.setInputFiles(input.imagePaths);
      logger.info({ draftId: input.draftId, n: input.imagePaths.length }, '图片已注入上传控件');

      // 等上传完成：缩略图数量达到预期
      await page.waitForTimeout(2500);
      let waited = 0;
      while (waited < 90_000) {
        const thumbs = await page.locator('[class*="thumb"], [class*="preview"], img[class*="upload"]').count();
        if (thumbs >= input.imagePaths.length * 0.6) break;
        await page.waitForTimeout(2000);
        waited += 2000;
      }
      await shot('uploaded');

      /* --- 2. 填标题 --- */
      const titleInput = await firstMatch(page, SELECTORS.titleInput, 8000);
      if (titleInput) {
        await titleInput.fill(input.title);
      } else {
        logEvent('publish', '未找到标题输入框，已跳过标题', { severity: 'warn' });
      }

      /* --- 3. 填正文 --- */
      const contentInput = await firstMatch(page, SELECTORS.contentInput, 8000);
      if (contentInput) {
        await contentInput.click();
        await contentInput.fill(input.body);
      } else {
        logEvent('publish', '未找到正文输入框', { severity: 'warn' });
      }

      await page.waitForTimeout(800);

      /* --- 4. 话题标签 --- */
      for (const tag of input.tags.slice(0, 10)) {
        try {
          const tagInput = await firstMatch(page, SELECTORS.tagInput, 2500);
          if (!tagInput) break;
          await tagInput.fill(`#${tag}`);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(500);
        } catch {
          break;
        }
      }

      await shot('filled');

      /* --- 5. 发布 --- */
      const btn = await firstMatch(page, SELECTORS.publishBtn, 6000);
      if (!btn) {
        await shot('no-publish-button');
        return { ok: false, error: '未找到发布按钮 —— 创作中心页面结构可能已改版' };
      }
      await btn.click();

      // 发布成功会跳到发布结果页或出现成功提示
      await page.waitForTimeout(5000);
      await shot('after-click');

      const bodyText = await page.locator('body').innerText().catch(() => '');
      const url = page.url();

      const success =
        /发布成功|已发布|提交成功/.test(bodyText) ||
        /publish\/success|note\/detail/.test(url) ||
        (!bodyText.includes('请输入标题') && url !== PUBLISH_URL);

      if (success) {
        logEvent('publish', `草稿 ${input.draftId} 发布成功`, { detail: { url } });
        return { ok: true, noteUrl: url };
      }

      return { ok: false, error: `发布后未确认成功（当前页：${url}）` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await shot('error');
      logger.error({ err, draftId: input.draftId }, '发布失败');
      return { ok: false, error: message };
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

/** 发布队列里所有已通过的草稿。 */
export function approvedDrafts(): Array<{ id: number }> {
  return all<{ id: number }>(`SELECT id FROM drafts WHERE status = 'approved' ORDER BY updated_at ASC`);
}

export function markPublishing(draftId: number): void {
  run("UPDATE drafts SET status='publishing', attempts=attempts+1, updated_at=datetime('now') WHERE id=?", draftId);
}

export function markPublishResult(draftId: number, ok: boolean, url?: string, error?: string): void {
  if (ok) {
    run(
      `UPDATE drafts SET status='published', published_url=?, published_at=datetime('now'),
        publish_error=NULL, updated_at=datetime('now') WHERE id=?`,
      url ?? null,
      draftId,
    );
  } else {
    run(
      `UPDATE drafts SET status='approved', publish_error=?, updated_at=datetime('now') WHERE id=?`,
      error ?? '未知错误',
      draftId,
    );
  }
}