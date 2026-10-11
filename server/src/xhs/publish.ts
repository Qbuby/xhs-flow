import path from 'node:path';
import fs from 'node:fs/promises';
import type { Page } from 'playwright';
import { browser, CREATOR_ORIGIN, XHS_ORIGIN } from './browser.js';
import { logger } from '../logger.js';
import { logEvent, run, all } from '../db/index.js';
import { serialize } from '../util/throttle.js';
import {
  PAUSE,
  enforceBrowse,
  humanClick,
  humanPause,
  humanType,
  maybeDistracted,
  noteBrowseStart,
} from '../util/human.js';

/**
 * 创作中心发布（UI 自动化）。
 *
 * 为什么不走发布 API：创作端签名同样逆向且变动频繁，没有降级路径，
 * 一旦失效整条链路就断了。网页 UI 自动化虽然慢、选择器会变，
 * 但它模拟的就是真人操作，稳得多。
 *
 * ── 抓包 + DOM 探针实测出来的页面事实（2026-10）────────────────────
 *
 * 1. `?target=image` 直接落在图文表单；默认落在视频表单，且视频表单一开
 *    始那个 file input 只 accept 视频格式，必须先切过去。
 *
 * 2. 发布表单是一个 SPA，图片解析完（约 20s）之后才**挂载**提交区。
 *    也就是说「发布按钮出现」本身就是「图片就绪」的信号。
 *
 * 3. ⚠️ 最坑的一点：「发布」按钮藏在自定义元素 `<xhs-publish-btn>` 的
 *    **closed shadow root** 里。因此：
 *      - `button:has-text("发布")` / `text=发布` / 遍历 innerText 全都找不到它
 *      - 宿主的 innerHTML 和 shadowRoot 都是空 / null
 *      - 「发布」只是宿主上的一个**属性** `submit-text="发布"`
 *    解法是在导航前注入 initScript，把 `attachShadow` 的 mode 强制改成
 *    open。小红书用 closed 只是不想让人用选择器选到，不依赖 closed 语义。
 *    改开之后 `xhs-publish-btn >> button` 就能拿到两个按钮：
 *      .ce-btn.white  → 暂存离开
 *      .ce-btn.bg-red → 发布
 *
 * 4. 正文编辑器是 tiptap：`.tiptap.ProseMirror`（不是 .ql-editor）。
 *
 * 5. 话题必须从下拉里**精确选中**。在编辑器里打 `#关键词` 会弹建议框，
 *    但直接按 Enter / 空格选中的是下拉里的**第一项**，不是你要的那个词
 *    （实测打「#拼豆」回车插进去的是「#拼豆图纸」）。正确做法是：
 *      - 逐字输入 `#关键词`（fill 不触发联想）
 *      - 轮询等 `.tippy-box .items .item` **真正填进来**：容器出现比条目渲染早
 *        约 600ms，只等容器会数到 0 个条目
 *      - 取 `.name` 文本恰好等于 `#关键词` 的那一项，点它
 *    点中之后编辑器里会插入真正的
 *    `<a class="tiptap-topic" data-topic='{"id":…,"name":…}'>`。
 *    下拉里没有精确词条时**退格删掉刚打的词**（不要按 Escape——Escape 不会
 *    取消联想，紧接着的空格会把高亮的第一条提交，等于静默插错话题）。
 *
 * 6. 点完「发布」**没有成功文案**，也没有跳转到成功页，只有 URL 变成
 *    `?source=&published=true`。所以要判定成败必须回过头去笔记管理页
 *    （真实路径 `/new/note-manager`，不是 `/publish/manage`，后者是 404）
 *    核对标题是否真的出现在已发布列表里。
 *
 * 因此**所有选择器集中在这里**，改版时只改这一处。
 */

/** 把 closed shadow root 掀开，否则拿不到发布按钮。 */
const OPEN_SHADOW_ROOTS = () => {
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init: ShadowInit) {
    return orig.call(this, { ...init, mode: 'open' });
  };
};

interface ShadowInit {
  mode: 'open' | 'closed';
}

const SEL = {
  /** 图片上传控件。视频表单也有 file input，靠 accept 区分。 */
  fileInput: 'input[type="file"][accept*=".jpg"]',
  /** 首次进入会弹「图片可以编辑啦」引导层，会挡住后续点击。 */
  guideDismiss: '.feature-guide__btn',
  title: 'input[placeholder="填写标题会有更多赞哦"]',
  editor: '.tiptap.ProseMirror',
  /** 提交区宿主。它出现 == 图片已解析完成。 */
  publishHost: 'xhs-publish-btn',
  publishBtn: 'xhs-publish-btn >> button.ce-btn.bg-red',
  draftBtn: 'xhs-publish-btn >> button.ce-btn.white',
  /** 话题下拉（tippy 浮层）。 */
  topicPanel: '.tippy-box .items',
  topicItem: '.tippy-box .items .item',
} as const;

const TIMEOUTS = {
  goto: 60_000,
  guide: 4_000,
  /** 图片上传 + 服务端解析，实测 15~30s，给足余量。 */
  uploadReady: 120_000,
  editor: 15_000,
  /** 下拉里条目的渲染比容器晚约 600ms，这里给足，轮询等条目。 */
  topicItems: 8_000,
  afterPublish: 12_000,
} as const;

/**
 * 洗掉卡片渲染器用的强调标记，发布出去的是干净文案。
 * 正文里的 `[[词]]` 是给 HTML 卡片做高亮用的，进小红书正文必须去掉方括号。
 */
export function plainText(s: string): string {
  return s.replace(/\[\[([^\]]*)\]\]/g, '$1');
}

export interface PublishInput {
  draftId: number;
  title: string;
  body: string;
  tags: string[];
  imagePaths: string[];
  /** 真跑一遍但**不点发布**，用于链路自检。 */
  dryRun?: boolean;
  /** 定时任务发起时为 true，会严格执行安静时段（手动操作不拦安静时段）。 */
  auto?: boolean;
  /**
   * 已经由调用方开过一次「创作中心会话」。
   *
   * 额度是按**会话**算的，不是按篇算的 —— 真人打开创作中心发两三条笔记是
   * 一次访问，不该让第二条被 20 分钟最小间隔挡住。调用方开完会话后
   * 传 true，表示「闸门我已经过了、次数也记过了」。
   */
  inSession?: boolean;
}

export interface PublishResult {
  ok: boolean;
  noteUrl?: string;
  error?: string;
  screenshot?: string;
  /** 逐步骤记录，便于定位失败点。 */
  steps?: string[];
}

const SHOT_DIR = path.resolve(process.cwd(), 'data', 'publish-shots');

export async function publishNote(input: PublishInput): Promise<PublishResult> {
  // 闸门默认在**这个函数里面**，而不是调用方。
  //
  // 理由：这里是唯一真正打开创作中心的地方。界面手点、诊断脚本的 live 模式
  // 都直接调它 —— 闸门放在调用方就总会有一条路径漏掉，而漏掉的那条路上
  // 「额度」就不算数了。
  //
  // 定时任务是个例外：它一次要发整条队列，按篇过闸会让第二条被最小间隔挡住。
  // 所以它自己先开一次会话（见 scheduler/jobs.ts），然后带 inSession 进来。
  if (!input.inSession) {
    const gate = enforceBrowse('publish', { auto: input.auto });
    if (!gate.ok) return { ok: false, error: `防风控拦截：${gate.reason}` };
    noteBrowseStart('publish');
  }

  if (input.imagePaths.length === 0) {
    return { ok: false, error: '没有渲染好的卡片图片，无法发布' };
  }
  for (const p of input.imagePaths) {
    try {
      await fs.access(p);
    } catch {
      return { ok: false, error: `图片文件不存在：${p}` };
    }
  }

  await fs.mkdir(SHOT_DIR, { recursive: true });

  return serialize(async () => {
    const steps: string[] = [];
    const note = (s: string) => {
      steps.push(s);
      logger.info({ draftId: input.draftId }, s);
    };

    const ctx = await browser.ensureLaunched();
    const page = await ctx.newPage();
    // 必须在导航前注入：attachShadow 的补丁要赶在自定义元素升级之前生效。
    await page.addInitScript(OPEN_SHADOW_ROOTS);

    const shot = (name: string) =>
      page
        .screenshot({ path: path.join(SHOT_DIR, `${input.draftId}-${name}.png`) })
        .then(() => path.join(SHOT_DIR, `${input.draftId}-${name}.png`))
        .catch(() => undefined);

    try {
      /* ---------- 1. 打开图文发布页 ---------- */
      note('打开创作中心图文发布页');
      await page
        .goto(`${CREATOR_ORIGIN}/publish/publish?target=image`, {
          waitUntil: 'domcontentloaded',
          timeout: TIMEOUTS.goto,
        })
        .catch(() => undefined);
      // 打开就立刻上传图片，是自动化的典型形状 —— 真人会先看一眼前端长什么样。
      // 这里按对数正态停一下（中位数约 4 秒，长尾可到十几秒）。
      await humanPause(PAUSE.readShort);

      if (page.url().includes('login') || page.url().includes('customer/login')) {
        await shot('login-required');
        return { ok: false, error: '创作中心要求重新登录（登录态过期或触发风控）', steps };
      }

      // 首屏引导浮层
      await page.locator(SEL.guideDismiss).first().click({ timeout: TIMEOUTS.guide }).catch(() => undefined);

      /* ---------- 2. 上传图片 ---------- */
      const fileInput = page.locator(SEL.fileInput).first();
      if ((await fileInput.count()) === 0) {
        await shot('no-file-input');
        return { ok: false, error: '没找到图文上传控件 —— 创作中心可能已改版（?target=image 失效）', steps };
      }
      note(`注入 ${input.imagePaths.length} 张卡片图`);
      await fileInput.setInputFiles(input.imagePaths);

      // 提交区只在图片解析完成后才挂载，用它当就绪信号。
      const publishHost = page.locator(SEL.publishHost).first();
      await publishHost.waitFor({ state: 'attached', timeout: TIMEOUTS.uploadReady }).catch(() => undefined);
      if ((await publishHost.count()) === 0) {
        await shot('upload-timeout');
        return { ok: false, error: `图片上传/解析超时（${TIMEOUTS.uploadReady / 1000}s）`, steps };
      }

      const publishBtn = page.locator(SEL.publishBtn).first();
      await publishBtn.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
      if ((await publishBtn.count()) === 0) {
        await shot('no-publish-button');
        return {
          ok: false,
          error: '提交区已出现但拿不到「发布」按钮 —— shadow root 补丁可能失效',
          steps,
        };
      }
      note('图片解析完成，提交区已就绪');

      /* ---------- 3. 标题 ---------- */
      const titleEl = page.locator(SEL.title).first();
      if ((await titleEl.count()) > 0) {
        // 逐字输入而不是 fill()：fill 是一次性写入 DOM，没有任何按键事件，
        // 输入框上的 keydown/keypress/input 序列完全不产生 —— 这是个很廉价的机器特征。
        const title = plainText(input.title).slice(0, 20);
        await humanType(page, titleEl, title);
        await humanPause(PAUSE.decide);
        note('已填标题');
      } else {
        logEvent('publish', '未找到标题输入框，跳过', { severity: 'warn' });
      }

      /* ---------- 4. 正文 ---------- */
      const editor = page.locator(SEL.editor).first();
      await editor.waitFor({ state: 'visible', timeout: TIMEOUTS.editor }).catch(() => undefined);
      if ((await editor.count()) === 0) {
        await shot('no-editor');
        return { ok: false, error: '没找到正文编辑器（.tiptap.ProseMirror）—— 可能已改版', steps };
      }

      const body = plainText(input.body).trim();
      await editor.click();
      // 探针 26 实测：tiptap 对 fill() 里的 `\n\n` 处理是正确的，
      // 每段会生成独立的 <p>，中间空行成一个空 <p>。
      // 所以「正文挤成一整块」不是编辑器的问题，是生成端没分段 ——
      // 分段在 pipeline.ts 的 normalizeBody() 里兜底。
      //
      // ⚠️ 但 fill() 是一次性写入，没有按键事件。正文是这里最长的一段输入，
      // 「0.2 秒粘贴 600 字」在风控侧非常显眼。改成逐段输入：每段按真人
      // 打字速度敲进去，段间停一下（像是想下一段怎么写）。
      for (const [i, para] of body.split(/\n\s*\n/).filter(Boolean).entries()) {
        if (i > 0) await editor.press('Enter');
        await humanType(page, editor, para);
        if (i > 0) await editor.press('Enter');
        await humanPause(PAUSE.decide);
        if (i % 3 === 2) await maybeDistracted();
      }
      note(`已填正文 ${body.length} 字，${body.split(/\n\s*\n/).filter(Boolean).length} 段`);

      /* ---------- 5. 话题标签 ---------- */
      const added: string[] = [];
      if (input.tags.length > 0) {
        // 另起一段放话题，跟正文分开更接近真人排版
        await editor.press('End');
        await editor.press('Enter');
        await page.waitForTimeout(400);

        for (const raw of input.tags.slice(0, 10)) {
          const tag = raw.replace(/^#/, '').trim();
          if (!tag) continue;
          const want = `#${tag}`;

          try {
            // 逐字输入，让编辑器逐字符触发联想；fill 不会触发下拉。
            // delay 用拟人的按键间隔（中位数约 165ms），不是固定 50ms。
            for (const ch of want) {
              await editor.pressSequentially(ch, { delay: 0 });
              await humanPause(PAUSE.keystroke);
            }

            // ⚠️ 容器出现 ≠ 条目已渲染，实测差约 600ms。只等容器会数到 0 个条目。
            let itemCount = 0;
            let waited = 0;
            while (waited < TIMEOUTS.topicItems) {
              itemCount = await page.locator(SEL.topicItem).count().catch(() => 0);
              if (itemCount > 0) break;
              await page.waitForTimeout(300);
              waited += 300;
            }

            // 只在 .name 上做精确匹配 —— 条目文本里还夹着「活动话题·X亿浏览」，不能用整条匹配。
            const exact = page.locator(SEL.topicItem).filter({
              has: page.locator('.name', { hasText: new RegExp(`^${escapeRe(want)}$`) }),
            });

            if (itemCount > 0 && (await exact.count()) > 0) {
              await exact.first().click({ timeout: 4000 });
              added.push(want);
              await page.waitForTimeout(600);
              // 点中后下拉会自动收；万一没收，按 Escape 收掉（此时没有待提交的联想，安全）
              if (await page.locator(SEL.topicPanel).first().isVisible().catch(() => false)) {
                await page.keyboard.press('Escape');
              }
              await page.waitForTimeout(300);
            } else {
              // 没有精确词条：把刚打的词退格删干净。
              // 这里**不能按 Escape** —— Escape 不取消联想，紧接着的空格会把高亮的第一条
              // 提交出去，结果是静默插了一个错话题（实测 #拼豆 → #拼豆图纸）。
              for (let i = 0; i < want.length; i++) await page.keyboard.press('Backspace');
              await page.keyboard.press('Escape').catch(() => undefined);
              await page.waitForTimeout(300);
            }
          } catch {
            // 出错也尽量回到干净状态：退格 + 关下拉
            for (let i = 0; i < want.length; i++) await page.keyboard.press('Backspace').catch(() => undefined);
            await page.keyboard.press('Escape').catch(() => undefined);
          }

          // 话题之间用空格隔开
          await editor.press('Space');
          await page.waitForTimeout(400);
        }
        note(`话题：命中 ${added.length}/${input.tags.length}${added.length ? `（${added.join(' ')}）` : ''}`);
      }

      const editorText = await editor.innerText().catch(() => '');
      const editorHtml = await editor.evaluate((el) => el.innerHTML).catch(() => '');
      const topicCount = (editorHtml.match(/tiptap-topic/g) ?? []).length;
      note(`正文终稿 ${editorText.length} 字，真话题 ${topicCount} 个`);

      await shot('filled');

      /* ---------- 6. 发布 ---------- */
      if (input.dryRun) {
        note('dryRun：到发布为止，未点击');
        return { ok: false, error: 'dryRun', screenshot: await shot('dryrun'), steps };
      }

      const submitAttr = await publishHost.getAttribute('submit-disabled').catch(() => null);
      if (submitAttr === 'true') {
        await shot('submit-disabled');
        return { ok: false, error: '发布按钮处于 disabled（内容不完整或图片仍在处理）', steps };
      }

      // 点发布之前那一下迟疑：真人会回头扫一眼标题和图和话题有没有错，
      // 而不是填完立刻按下去。这里连带把鼠标挪到按钮上（humanClick 内部做）。
      note('检查一遍后点击「发布」');
      await humanPause(PAUSE.readShort);
      await humanClick(page, publishBtn).catch(async () => {
        // 拟人点击失败（元素被遮挡等）时退回普通点击，功能不能丢
        await publishBtn.click();
      });
      await humanPause(PAUSE.shift);
      await shot('after-click');

      const url = page.url();
      const pageText = await page.locator('body').innerText({ timeout: 8000 }).catch(() => '');
      const urlSaysPublished = url.includes('published=true');
      const textSaysPublished = /发布成功|已发布|提交成功|发布完成/.test(pageText);

      // ⚠️ 实测：点完发布小红书只把 URL 改成 `?source=&published=true`，
      // **不会**弹「发布成功」文案，也不会跳到 /publish/success。
      // 所以必须额外去笔记管理页核对标题真的在「已发布」列表里，
      // 否则会把一次成功的发布会误判成失败。
      let noteManagerUrl: string | undefined;
      let landed = textSaysPublished;
      if (!landed && urlSaysPublished) {
        noteManagerUrl = await verifyPublished(page, input.title);
        landed = noteManagerUrl !== undefined;
      }

      if (landed) {
        logEvent('publish', `草稿 ${input.draftId} 发布成功`, { detail: { url, noteManagerUrl } });
        return {
          ok: true,
          noteUrl: noteManagerUrl ?? url,
          screenshot: path.join(SHOT_DIR, `${input.draftId}-after-click.png`),
          steps,
        };
      }

      // 没识别到成功文案时，把页面文字带回来，便于判断到底卡在哪
      const hint = pageText.replace(/\s+/g, ' ').slice(0, 200);
      await shot('unconfirmed');
      return { ok: false, error: `发布后未确认成功（当前页 ${url}；页面文字「${hint}」）`, steps };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await shot('error');
      logger.error({ err, draftId: input.draftId }, '发布失败');
      return { ok: false, error: message, steps };
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 二次确认发布结果，并顺手取回真实笔记 ID。
 *
 * 创作中心点完发布只有 `published=true` 这一个信号，不足以判定成功，
 * 所以到笔记管理页（`/new/note-manager`）核对标题是否真的出现在「已发布」列表里。
 *
 * 注意：
 *   - 列表入口是 `/new/note-manager`，`/publish/manage` 是 404 白页
 *   - 每张卡片带 `data-impression`，里面藏着 24 位十六进制笔记 ID，
 *     拿它可以拼出公开链接 `https://www.xiaohongshu.com/explore/<id>`
 *   - 卡片上还可能有「仅自己可见」标签（这是账号本身的可见性设置，不是发布失败）
 */
async function verifyPublished(page: Page, title: string): Promise<string | undefined> {
  const want = plainText(title).slice(0, 20);

  try {
    await page
      .goto(`${CREATOR_ORIGIN}/new/note-manager`, { waitUntil: 'domcontentloaded', timeout: 40_000 })
      .catch(() => undefined);
    await page.waitForTimeout(8000);

    // 切到「已发布」页签，避免把草稿箱里的同名笔记当成发布成功
    await page.locator('text=已发布').first().click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(4000);

    // 标题可能被截断，取前 8 个字做匹配，减少长度差异导致的误判
    const probe = want.slice(0, 8);
    const noteId = await page.evaluate((p) => {
      for (const el of Array.from(document.querySelectorAll('[data-impression]'))) {
        const card = el.closest('.note-card') ?? el.parentElement ?? el;
        if (!(card.textContent ?? '').includes(p)) continue;
        const m = /[0-9a-f]{24}/.exec(el.getAttribute('data-impression') ?? '');
        if (m) return m[0];
      }
      return null;
    }, probe);

    if (!noteId) {
      // 列表里确实有标题但没有 ID，至少说明发布成功了；退回列表页地址
      const hit = await page.locator(`text=${probe}`).first().count().catch(() => 0);
      return hit > 0 ? `${CREATOR_ORIGIN}/new/note-manager` : undefined;
    }

    return `${XHS_ORIGIN}/explore/${noteId}`;
  } catch (err) {
    logger.warn({ err }, '核对发布结果失败');
    return undefined;
  }
}

/** 发布队列里所有已通过的草稿。 */
export function approvedDrafts(): Array<{ id: number }> {
  return all<{ id: number }>(`SELECT id FROM drafts WHERE status = 'approved' ORDER BY updated_at ASC`);
}

export function markPublishing(draftId: number): void {
  run(
    "UPDATE drafts SET status='publishing', attempts=attempts+1, updated_at=datetime('now') WHERE id=?",
    draftId,
  );
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
