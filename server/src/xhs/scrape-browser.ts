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

/**
 * 被小红书限流（300013 访问频繁）。
 * 单独一个错误类型，是为了让上层能把它判成「不可重试」——
 * 等几分钟重试只会继续撞墙、继续加重标记。
 */
export class RATE_LIMITED extends Error {
  readonly rateLimited = true;
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

/** 轮询等待条件成立；超时返回 false。 */
async function waitFor(
  cond: () => boolean | Promise<boolean>,
  opts: { timeout: number; interval?: number },
): Promise<boolean> {
  const step = opts.interval ?? 200;
  const deadline = Date.now() + opts.timeout;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

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
    await dismissLoginModal(page);
    await page.waitForTimeout(2500);

    // 这里等的是**页面自己把下一页数据拉回来**，不是干等。
    // 原来每次滚动都 throttle(6s)，40 轮下来光列表就要 5 分钟。
    let stagnant = 0;
    const MAX_ROUNDS = 80;
    for (let round = 0; round < MAX_ROUNDS && byId.size < max; round++) {
      const before = byId.size;
      await page.mouse.wheel(0, 3200);

      // 等新数据出现：要么数量涨了，要么确认到底了
      const grew = await waitFor(
        async () => byId.size > before,
        { timeout: 8000, interval: 200 },
      );
      await dismissLoginModal(page);

      // 滚动到一半被限流了就别硬撑，立刻报错
      if (byId.size === before && round > 2) {
        const probe = await page.locator('body').innerText().catch(() => '');
        if (/访问频繁|请稍后再试|300013/.test(probe)) {
          throw new RATE_LIMITED(
            `小红书在翻页时判定访问过于频繁（300013），已停止。已采集 ${byId.size} 条。`,
          );
        }
      }

      if (byId.size === before) {
        if (++stagnant >= 3) break;
      } else {
        stagnant = 0;
      }

      onProgress?.(byId.size);
      // 滚动节奏本身就有随机性，不必再叠加固定延迟。
      // 真要给风控让路，靠并发度而不是每步 sleep。
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
      if (/访问频繁|请稍后再试|300013/.test(text)) {
        throw new RATE_LIMITED(
          '小红书判定为访问过于频繁（300013）。刚抓过的话等一段时间再试，' +
            '建议把「最多篇数」调小、分批抓取。',
        );
      }
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
 * 笔记读取器：**复用同一个标签页**。
 *
 * 原来每篇笔记都 newPage → goto → 固定睡 3.5s → close，
 * 一篇 8~10 秒，150 篇就是二十多分钟，全花在开关标签页和干等上。
 * 现在标签页常驻，且改成「等数据真的出现」而不是「睡够 3.5 秒」。
 */
export interface NoteReader {
  read(noteId: string, xsecToken: string | null): Promise<DomNote | null>;
  close(): Promise<void>;
}

export async function createNoteReader(): Promise<NoteReader> {
  const ctx = await browser.ensureLaunched();
  const page = await ctx.newPage();

  return {
    async read(noteId: string, xsecToken: string | null): Promise<DomNote | null> {
      const qs = xsecToken
        ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_user`
        : '';
      await page.goto(`${XHS_ORIGIN}/explore/${noteId}${qs}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await dismissLoginModal(page);

      // 等正文真的渲染出来，而不是固定睡几秒赌它够了。
      // 有 xsec_token 时通常 1 秒内就有 __INITIAL_STATE__。
      await waitFor(() => hasNoteData(page), { timeout: 12_000, interval: 150 });

      const data = (await page.evaluate(EXTRACT_NOTE)) as
        | ExtractNoteOk
        | ExtractNoteMissing;

      if (!data.ok) {
        if (data.throttled) {
          throw new RATE_LIMITED(
            '小红书判定为访问过于频繁（300013），已停止抓取。等一段时间再试，' +
              '或者把「最多篇数」调小、分批抓取。',
          );
        }
        return null;
      }

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
    },

    async close() {
      await page.close().catch(() => undefined);
    },
  };
}

/**
 * 页面上是否已经有可读的笔记数据了。
 *
 * 注意：图片是**懒加载**的，如果只等正文就立刻取图，
 * naturalWidth 还是 0，会一张都收不到（实测 198 篇全 0 图）。
 * 所以这里同时等「至少有一张大图完成解码」。
 */
function hasNoteData(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const s = (window as unknown as { __INITIAL_STATE__?: Record<string, any> }).__INITIAL_STATE__;
    const dm = (s?.note as Record<string, any>)?.noteDetailMap;
    if (Array.isArray(dm) && dm.some((x) => x?.note?.desc || x?.note?.title)) return true;
    if ((document.querySelector('#detail-desc')?.textContent ?? '').trim().length > 5) return true;
    if (/当前笔记暂时无法浏览|内容不存在/.test(document.body.innerText ?? '')) return true;
    // 有已解码的大图 = 内容确实渲染出来了
    return Array.from(document.querySelectorAll('img')).some((i) => i.naturalWidth >= 600);
  });
}

type ExtractNoteMissing = { ok: false; gone: boolean; throttled: boolean };

type ExtractNoteOk = {
  ok: true;
  title: string;
  desc: string;
  tags: string[];
  images: string[];
  time: number | null;
  liked: number;
  collected: number;
  comment: number;
};

/**
 * 取正文。首选页面自己的 __INITIAL_STATE__ —— 结构化且完整。
 * 从 <img> 标签里猜不靠谱：DOM 里混着轮播缩略图和「相关推荐」封面，
 * 按尺寸过滤也还是会多收，实测一篇笔记能数出 30 多张图。
 */
const EXTRACT_NOTE = (): ExtractNoteOk | ExtractNoteMissing => {
  const state = (window as unknown as { __INITIAL_STATE__?: Record<string, any> }).__INITIAL_STATE__;

  // ⚠️ noteDetailMap 是**以 note_id 为键的对象**，不是数组。
  // 之前写成 Array.isArray() 判断，导致整条结构化分支永远进不去，
  // 所有笔记都掉进 DOM 兜底 —— 于是图片、点赞、收藏全是 0，日期还成了 2001 年。
  const dm = state?.note?.noteDetailMap;
  const note = Array.isArray(dm)
    ? dm.find((x) => x?.note)?.note
    : dm && typeof dm === 'object'
      ? (Object.values(dm)[0] as any)?.note ?? (Object.values(dm)[0] as any)
      : undefined;

  if (note && (note.title || note.desc || note.imageList || note.image_list)) {
    return {
      ok: true,
      title: note.title ?? '',
      desc: note.desc ?? '',
      tags: (note.tagList ?? note.tag_list ?? [])
        .map((t: any) => t?.title ?? t?.name ?? '')
        .filter(Boolean),
      images: (note.imageList ?? note.image_list ?? [])
        .map((i: any) => i?.urlDefault ?? i?.url_default ?? i?.url ?? '')
        .filter(Boolean),
      time: Number(note.time) || null,
      liked: Number(note.interactInfo?.likedCount ?? note.interact_info?.liked_count) || 0,
      collected: Number(note.interactInfo?.collectedCount ?? note.interact_info?.collected_count) || 0,
      comment: Number(note.interactInfo?.commentCount ?? note.interact_info?.comment_count) || 0,
    };
  }

  const txt = (sel: string) =>
    (document.querySelector(sel) as HTMLElement | null)?.textContent?.trim() ?? '';
  const whole = document.body.innerText ?? '';

  // 限流页（300013）必须识别出来，否则会一路读出上百篇空笔记
  if (/访问频繁|请稍后再试|300013/.test(whole)) {
    return { ok: false, gone: false, throttled: true };
  }
  if (/当前笔记暂时无法浏览|内容不存在|笔记不见了/.test(whole)) {
    return { ok: false, gone: true, throttled: false };
  }

  // DOM 兜底。图片认准 .note-slider-img（轮播容器），比按 naturalWidth 猜可靠得多
  const sliderImgs = Array.from(document.querySelectorAll('.note-slider-img'))
    .map((i) => (i as HTMLElement).querySelector('img')?.getAttribute('src') ?? '')
    .filter(Boolean);
  const imgs = sliderImgs.length
    ? sliderImgs
    : Array.from(document.querySelectorAll('img'))
        .filter((i) => i.naturalWidth >= 900 && i.naturalHeight >= 900)
        .map((i) => i.getAttribute('src') ?? '')
        .filter(Boolean);

  // 页面上的日期形如 "09-23 浙江"，没有年份 —— 硬 parse 会变成 2001 年
  const dateText = txt('.bottom-container .date') || txt('.date');
  const dm2 = /(\d{1,2})[-/月](\d{1,2})/.exec(dateText);
  let ts: number | null = null;
  if (dm2) {
    const mo = Number(dm2[1]);
    const day = Number(dm2[2]);
    const now = new Date();
    ts = new Date(now.getFullYear(), mo - 1, day).getTime();
  }

  const numOf = (sel: string): number => {
    const el = document.querySelector(sel);
    const n = Number((el?.textContent ?? '').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  return {
    ok: true,
    title: txt('#detail-title') || txt('.note-content .title'),
    desc: txt('#detail-desc') || txt('.note-content .desc'),
    tags: Array.from(document.querySelectorAll('#detail-desc a'))
      .map((a) => (a.textContent ?? '').replace(/^#/, '').trim())
      .filter(Boolean),
    images: [...new Set(imgs)],
    time: ts,
    liked: numOf('.like-wrapper .count'),
    collected: numOf('.collect-wrapper .count'),
    comment: numOf('.chat-wrapper .count'),
  };
};

/** 兼容旧调用：开一个临时读取器读一篇。 */
export async function readNotePage(
  noteId: string,
  xsecToken: string | null,
): Promise<DomNote | null> {
  const reader = await createNoteReader();
  try {
    return await reader.read(noteId, xsecToken);
  } finally {
    await reader.close();
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
