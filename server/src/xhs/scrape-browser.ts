import type { BrowserContext, Page } from 'playwright';
import { browser, XHS_ORIGIN } from './browser.js';
import { logger } from '../logger.js';
import { logEvent } from '../db/index.js';
import { throttle } from '../util/throttle.js';
import type { ScrapedNote } from './scrape.js';

/**
 * 「让页面自己抓，我们只读」模式。
 *
 * 为什么需要这一条路：实测同一个端点、同一份登录态、同一个浏览器 ——
 *   页面自己发的 user_posted  →  success=true  code=0  notes=30
 *   我们用同样签名发的请求     →  code=300011 当前账号存在异常
 * 也就是说小红书对**发请求的一方**做了区分，页面的请求过、我们的不过。
 * 与其继续跟签名算法较劲，不如让页面像真人一样去请求，我们只从
 * 渲染结果和它自己的响应里读数据。
 *
 * 附带好处：
 *  - 不依赖我们对 x-s 的理解是否正确，页面升级了我们也不用动
 *  - 拿得到 xsec_token（列表响应里就带着），没有它笔记页会显示
 *    「当前笔记暂时无法浏览」
 *  - 全程是正常浏览行为，比裸调 API 更不容易触发风控
 */

export interface HarvestedNote {
  noteId: string;
  xsecToken: string | null;
  title: string;
  liked: number;
  cover: string | null;
}

export interface HarvestedProfile {
  nickname: string | null;
  avatar: string | null;
  redId: string | null;
}

interface ListNote {
  note_id?: string;
  noteId?: string;
  id?: string;
  xsec_token?: string;
  xsecToken?: string;
  display_title?: string;
  title?: string;
  interact_info?: { liked_count?: string | number };
  interactInfo?: { likedCount?: string | number };
  cover?: { url_default?: string; url?: string };
  type?: string;
}

const API_PREFIX = '/api/sns/web';

/** harvestNoteList 顺带采到的作者资料 */
let lastProfile: HarvestedProfile = { nickname: null, avatar: null, redId: null };
export function harvestedProfile(): HarvestedProfile {
  return lastProfile;
}

/* ------------------------------------------------------------------ */
/* 第一步：列作品（监听页面自己的响应）                                  */
/* ------------------------------------------------------------------ */

/**
 * 打开作者主页，滚动加载，等页面自己去拉作品列表，
 * 我们在响应里把 note_id + xsec_token 收走。
 */
export async function harvestNoteList(
  userId: string,
  max: number,
  onProgress?: (n: number) => void,
): Promise<HarvestedNote[]> {
  const ctx: BrowserContext = await browser.ensureLaunched();
  const page = await ctx.newPage();

  const byId = new Map<string, HarvestedNote>();
  const profile: HarvestedProfile = { nickname: null, avatar: null, redId: null };

  page.on('response', async (res) => {
    const url = res.url();

    // 作者资料：直接采页面自己请求到的，省得我们再单独调一次
    if (/\/api\/sns\/web\/v1\/user\b/.test(url) || /\/api\/sns\/web\/v2\/user\//.test(url)) {
      try {
        const j = (await res.json()) as {
          data?: {
            basic_info?: { nickname?: string; images?: string; imageb?: string; redId?: string };
            nickname?: string;
          };
        };
        const b = j.data?.basic_info;
        if (b?.nickname && !profile.nickname) {
          profile.nickname = b.nickname;
          profile.avatar = b.images ?? b.imageb ?? null;
          profile.redId = b.redId ?? null;
        }
      } catch {
        /* 忽略 */
      }
      return;
    }

    if (!url.includes(API_PREFIX) || !/user_posted|\/user\/posted/.test(url)) return;
    let json: { data?: { notes?: ListNote[]; noteCards?: ListNote[]; cursor?: string } };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      return;
    }
    const items = json.data?.notes ?? json.data?.noteCards ?? [];
    for (const it of items) {
      const id = it.note_id ?? it.noteId ?? it.id;
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        noteId: id,
        xsecToken: it.xsec_token ?? it.xsecToken ?? null,
        title: it.display_title ?? it.title ?? '',
        liked: Number(it.interact_info?.liked_count ?? it.interactInfo?.likedCount ?? 0),
        cover: it.cover?.url_default ?? it.cover?.url ?? null,
      });
    }
    onProgress?.(byId.size);
  });

  try {
    await page.goto(`${XHS_ORIGIN}/user/profile/${userId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    // 弹登录框会挡住内容，关掉
    await dismissLoginModal(page);
    await page.waitForTimeout(4000);

    let stagnant = 0;
    for (let round = 0; round < 40 && byId.size < max; round++) {
      const before = byId.size;
      await page.mouse.wheel(0, 2600);
      await page.waitForTimeout(1500 + Math.random() * 900);
      await dismissLoginModal(page);

      if (byId.size === before) {
        if (++stagnant >= 4) break;
      } else {
        stagnant = 0;
        // 每翻一页稍作停留，别把节奏搞得像机器人
        await throttle();
      }
    }

    // 作者资料兜底：从主页的 __INITIAL_STATE__ 里取
    // （作者接口那条路会被签名拒掉，但页面自己拿得到）
    try {
      const st = (await page.evaluate(() => {
        const s0 = (window as unknown as { __INITIAL_STATE__?: Record<string, any> })
          .__INITIAL_STATE__;
        const u = s0?.user as Record<string, any> | undefined;
        const basic = (u?.basicInfo ?? u?.basic_info ?? {}) as Record<string, any>;
        // state 里没有就退回页面上可见的作者名 —— DOM 这条路反而更稳
        const domName =
          (document.querySelector('[class*="nickname"], .user-name, [class*="name"]') as
            | HTMLElement
            | null)?.textContent?.trim() || '';
        return {
          nickname: basic.nickname ?? u?.nickname ?? (domName || null),
          avatar: basic.images ?? basic.imageb ?? u?.image ?? null,
          redId: basic.redId ?? u?.redId ?? null,
        };
      })) as HarvestedProfile | null;
      if (st) {
        if (st.nickname && !profile.nickname) profile.nickname = st.nickname;
        if (st.avatar && !profile.avatar) profile.avatar = st.avatar;
        if (st.redId && !profile.redId) profile.redId = st.redId;
      }
    } catch {
      /* 拿不到就算了 */
    }

    if (byId.size === 0) {
      const text = await page.locator('body').innerText().catch(() => '');
      if (/IP存在风险|安全限制|Whitelabel/.test(text)) {
        throw new Error('主页被风控拦截（IP 风险 / 安全限制），请更换网络环境');
      }
      throw new Error('主页上没有加载出任何作品，可能是页面改版或该作者不可见');
    }

    logger.info({ userId, count: byId.size }, '已从页面响应中采集到作品列表');
    lastProfile = profile;
    return [...byId.values()].slice(0, max);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function dismissLoginModal(page: Page): Promise<void> {
  // 登录弹窗会遮挡并吞掉滚动事件
  for (const sel of ['.login-container [class*="close"]', '.reds-modal-close', '[aria-label="close"]']) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0 && (await el.isVisible().catch(() => false))) {
        await el.click({ timeout: 1200 }).catch(() => undefined);
        await page.waitForTimeout(600);
      }
    } catch {
      /* 忽略 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 第二步：读单篇（渲染页面取内容）                                      */
/* ------------------------------------------------------------------ */

interface DomNote {
  title: string;
  desc: string;
  tags: string[];
  images: string[];
  publishedAt: number | null;
  liked: number;
  collected: number;
  comment: number;
}

/**
 * 打开笔记页并读取渲染后的内容。
 * 必须带 xsec_token，否则小红书会显示「当前笔记暂时无法浏览」。
 */
export async function readNotePage(noteId: string, xsecToken: string | null): Promise<DomNote | null> {
  const ctx = await browser.ensureLaunched();
  const page = await ctx.newPage();

  const qs = xsecToken
    ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_user`
    : '';
  const url = `${XHS_ORIGIN}/explore/${noteId}${qs}`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await dismissLoginModal(page);
    await page.waitForTimeout(3500);

    const data = (await page.evaluate(() => {
      // 首选页面自己的 __INITIAL_STATE__ —— 结构化且完整。
      // 从 <img> 标签里猜不靠谱：DOM 里混着轮播缩略图和「相关推荐」封面，
      // 按尺寸过滤也还是会多收，实测一篇笔记能数出 30 多张图。
      const state = (window as unknown as { __INITIAL_STATE__?: Record<string, any> })
        .__INITIAL_STATE__;
      const dm = (state?.note as Record<string, any>)?.noteDetailMap;
      const note = Array.isArray(dm) ? dm.find((x) => x?.note)?.note : undefined;

      if (note) {
        return {
          ok: true as const,
          title: note.title ?? '',
          desc: note.desc ?? '',
          tags: (note.tagList ?? []).map((t: any) => t?.title ?? t?.name ?? '').filter(Boolean),
          images: (note.imageList ?? [])
            .map((i: any) => i?.urlDefault ?? i?.url_default ?? i?.url ?? '')
            .filter(Boolean),
          time: Number(note.time) || null,
          liked: Number(note.interactInfo?.likedCount) || 0,
          collected: Number(note.interactInfo?.collectedCount) || 0,
          comment: Number(note.interactInfo?.commentCount) || 0,
        };
      }

      // 退路：SSR 没给数据就用渲染后的 DOM
      const txt = (sel: string) =>
        (document.querySelector(sel) as HTMLElement | null)?.textContent?.trim() ?? '';
      const whole = document.body.innerText ?? '';
      if (/当前笔记暂时无法浏览|内容不存在|笔记不见了/.test(whole)) {
        return { ok: false as const, gone: true };
      }
      return {
        ok: true as const,
        title: txt('#detail-title') || txt('.note-content .title'),
        desc: txt('#detail-desc') || txt('.note-content .desc'),
        tags: Array.from(document.querySelectorAll('#detail-desc a'))
          .map((a) => (a.textContent ?? '').replace(/^#/, '').trim())
          .filter(Boolean),
        images: Array.from(document.querySelectorAll('img'))
          .filter((i) => i.naturalWidth >= 900 && i.naturalHeight >= 900)
          .map((i) => i.getAttribute('src') ?? '')
          .filter(Boolean),
        time: null,
        liked: 0,
        collected: 0,
        comment: 0,
      };
    })) as
      | {
          ok: true;
          title: string;
          desc: string;
          tags: string[];
          images: string[];
          time: number | null;
          liked: number;
          collected: number;
          comment: number;
        }
      | { ok: false; gone: boolean };

    if (!data.ok) return null;

    return {
      title: data.title || '',
      desc: data.desc || '',
      tags: [...new Set(data.tags ?? [])],
      images: [...new Set(data.images ?? [])],
      publishedAt: data.time ?? null,
      liked: data.liked ?? 0,
      collected: data.collected ?? 0,
      comment: data.comment ?? 0,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** DOM 读到的数据转成统一的笔记结构 */
export function toScrapedNote(
  base: { noteId: string; xsecToken: string | null },
  dom: DomNote,
): ScrapedNote {
  return {
    noteId: base.noteId,
    xsecToken: base.xsecToken,
    url: base.xsecToken
      ? `${XHS_ORIGIN}/explore/${base.noteId}?xsec_token=${encodeURIComponent(base.xsecToken)}&xsec_source=pc_user`
      : `${XHS_ORIGIN}/explore/${base.noteId}`,
    type: 'normal',
    title: dom.title,
    desc: dom.desc,
    tags: dom.tags,
    ipLocation: null,
    publishedAt: dom.publishedAt,
    likedCount: dom.liked,
    collectedCount: dom.collected,
    commentCount: dom.comment,
    shareCount: 0,
    images: dom.images,
    raw: { via: 'browser-dom' },
  };
}

export { logEvent };
