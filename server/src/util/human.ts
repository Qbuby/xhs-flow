import type { Locator, Page } from 'playwright';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getSetting, setSetting, logEvent } from '../db/index.js';
import { sleep } from './throttle.js';

/**
 * 拟人行为层。
 *
 * 【为什么需要这一层】
 * 2026-10-10 收到小红书正式处置：账号流量曝光与商业权益受限，
 * 理由是「账号浏览行为异常或不规律，如使用第三方工具（如 AI）进行模拟浏览，
 * 与真人操作习惯不符」。
 *
 * 把数据库翻出来对时间戳，机器的指纹非常刺眼：
 *   - 笔记入库间隔 **精确到 2.0 秒一条**，连续 5 条如此（第 351~366 条）
 *     真人不可能对每一篇内容都恰好花 2 秒，这是最直接的机器签名
 *   - 主页滚动是 `mouse.wheel(0, 3200)` 一步到位，没有任何中间停顿
 *   - 全程 **零鼠标移动、零停留**：页面在动，指针却钉在原点
 *   - healthcheck 严格 17 分钟一次（直方图 17/17/17/9/17…）
 *
 * 也就是说问题不在「内容是不是 AI 写的」，而在**行为节奏是一台机器**。
 * 所以这一层的任务只有一个：让每一步的时长和轨迹都带上真人的方差。
 *
 * 【设计原则】
 *  1. 一切都用对数正态分布 —— 真人的停顿是长尾的（多数很短，偶尔很长），
 *     均匀分布反而比固定值更容易被规律性检测抓出来。
 *  2. 滚动要「顿挫」：一次滚一点，滚完看一眼，偶尔回看一点。
 *     一步滚 3200px 在真人身上不存在。
 *  3. 动作之间必须有位移 —— 鼠标停着不动而页面在翻，是最廉价的机器特征。
 *  4. 有额度和安静时段。真人不会在凌晨三点连续访问创作中心 8 次。
 */

/**
 * 对数正态抖动。
 *
 * 为什么不复用 `throttle.ts` 的 `logNormalDelay`：那个函数是给**接口请求间隔**
 * 用的，下限被夹在 500ms（原意是「请求别发得太密」）。拿来做拟人动作就会出事 ——
 * 按键间隔的真实中位数是 165ms，夹到 500ms 之后 600 字的正文要敲五分钟，
 * 而且所有短动作都被拍平成同一个 500ms，等于又变回了固定节奏。
 * 所以这里自己实现一份，只在下面留一个物理下限（1 帧，防止退化成 0）。
 */
function jitter(medianMs: number, sigma: number, floorMs = 16): number {
  if (sigma <= 0) return Math.max(floorMs, medianMs);
  const u1 = Math.max(Number.EPSILON, Math.random());
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const ms = medianMs * Math.exp(sigma * z);
  // 上限给到中位数的 6 倍 —— 长尾要有，但不能长到让任务看起来卡死
  return Math.min(Math.max(ms, floorMs), medianMs * 6);
}

export interface PauseProfile {
  /** 中位数停顿时长 */
  medianMs: number;
  /** 对数空间标准差，值越大越不可预测 */
  sigma: number;
}

/** 停顿档位。中位数按「真人在这一步会花多久」定。 */
export const PAUSE = {
  /** 滚动一屏里的一个分段后扫一眼 */
  glide: { medianMs: 900, sigma: 0.55 },
  /** 鼠标挪一下 */
  nudge: { medianMs: 320, sigma: 0.5 },
  /** 看完一篇短笔记 */
  readShort: { medianMs: 4200, sigma: 0.5 },
  /** 打开页面/浮层之后「哦，出来了」的那一下 */
  settle: { medianMs: 1400, sigma: 0.45 },
  /** 点按钮前那一下「想一下」 */
  decide: { medianMs: 850, sigma: 0.6 },
  /** 两篇笔记之间的空档（失神、回消息） */
  shift: { medianMs: 9000, sigma: 0.7 },
  /** 打字时逐字之间的间隔。中文输入法下 150~200ms 是真人手速 */
  keystroke: { medianMs: 165, sigma: 0.4 },
} as const satisfies Record<string, PauseProfile>;

/** 按档位停顿。也可以直接传毫秒数。 */
export async function humanPause(
  p: PauseProfile | number,
  signal?: AbortSignal,
): Promise<void> {
  const ms = typeof p === 'number' ? p : jitter(p.medianMs, p.sigma);
  await sleep(ms, signal);
}

/**
 * 「走神」。真人在翻完五六篇之后总会有一次长时间停顿 ——
 * 去回个消息、接杯水。没有这种长尾，节奏就是等距的。
 *
 * @param chance 触发概率
 */
export async function maybeDistracted(
  signal?: AbortSignal,
  chance = 0.14,
): Promise<boolean> {
  if (Math.random() >= chance) return false;
  const ms = jitter(35_000, 0.75);
  logger.debug({ ms }, '拟人：插入一次走神停顿');
  await sleep(ms, signal);
  return true;
}

/** 视口里随机取一个「看起来自然」的点。 */
function randomPoint(page: Page): { x: number; y: number } {
  const vp = page.viewportSize() ?? { width: 1440, height: 900 };
  return {
    x: Math.round(vp.width * (0.12 + Math.random() * 0.76)),
    y: Math.round(vp.height * (0.12 + Math.random() * 0.72)),
  };
}

/** 把指针挪到一个随机位置。不用 force，鼠标本来就该到处走。 */
export async function humanNudge(page: Page, signal?: AbortSignal): Promise<void> {
  const { x, y } = randomPoint(page);
  await page.mouse
    .move(x, y, { steps: 8 + Math.floor(Math.random() * 20) })
    .catch(() => undefined);
  await humanPause(PAUSE.nudge, signal);
}

/**
 * 分步滚动，模拟滚轮的顿挫感。
 *
 * 原来是一步 `wheel(0, 3200)` —— CDP 层面这等价于「瞬间位移 3200 像素、
 * 无中间帧、无停留」，是自动化最典型的形状。真人滚轮是一格一格来的。
 */
export async function humanScroll(
  page: Page,
  opts: { distance?: number; signal?: AbortSignal; jiggle?: boolean } = {},
): Promise<void> {
  const total = opts.distance ?? 500 + Math.random() * 900;
  let moved = 0;
  while (moved < total) {
    // 每一格的幅度本身也有方差：真人不会每格都是 100px
    const step = 70 + Math.random() * 200;
    await page.mouse.wheel(0, step).catch(() => undefined);
    moved += step;
    await humanPause(PAUSE.glide, opts.signal);
  }

  // 偶尔回看一点，像是刚才那屏漏了东西
  if (opts.jiggle !== false && Math.random() < 0.18) {
    await page.mouse.wheel(0, -(40 + Math.random() * 110)).catch(() => undefined);
    await humanPause(PAUSE.glide, opts.signal);
  }
}

/**
 * 看完一篇内容的停留时长。
 *
 * 按字数算基准（划读中文约 500 字/分钟 —— 比通读快，因为真人看小红书是扫读），
 * 再乘一个对数正态抖动，于是不会出现「每篇都刚好 2 秒」。
 *
 * 上限压到 30 秒：更长的「阅读」在进度条上看着就像卡住了，
 * 需要长尾的地方交给 maybeDistracted 统一插（它才是那个「去接杯水」的动作）。
 */
export function readingDwellMs(chars: number): number {
  const base = 2200 + Math.min(chars, 700) * 42;
  return Math.round(Math.min(jitter(base, 0.45), 30_000));
}

/** 在一篇笔记里「读」一遍：挪一下 → 停 → 往下翻 → 再看会儿评论。 */
export async function humanReadNote(
  page: Page,
  chars: number,
  signal?: AbortSignal,
): Promise<void> {
  await humanNudge(page, signal);
  await sleep(readingDwellMs(chars), signal);
  await humanScroll(page, { distance: 300 + Math.random() * 600, signal, jiggle: false });
  await humanPause(PAUSE.glide, signal);
  // 长文才有翻评论的耐心
  if (chars > 240 && Math.random() < 0.55) {
    await humanScroll(page, { distance: 400 + Math.random() * 900, signal });
  }
}

/** 点到元素上。先滚进视野、挪过去、想一下，再点。 */
export async function humanClick(
  page: Page,
  target: Locator | string,
  signal?: AbortSignal,
): Promise<void> {
  const loc = typeof target === 'string' ? page.locator(target).first() : target;
  await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
  await humanPause(PAUSE.decide, signal);

  const box = await loc.boundingBox().catch(() => null);
  if (box) {
    // 点元素中心附近，但不正中 —— 真人不会像素级对准圆心
    const x = box.x + box.width * (0.35 + Math.random() * 0.3);
    const y = box.y + box.height * (0.35 + Math.random() * 0.3);
    await page.mouse.move(x, y, { steps: 10 + Math.floor(Math.random() * 15) }).catch(() => undefined);
    await humanPause(PAUSE.nudge, signal);
  }
  await loc.click({ timeout: 6000 });
}

/** 逐字输入。fill() 是一次性写入，没有按键间隔，也不触发联想。 */
export async function humanType(
  page: Page,
  locator: Locator,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  await locator.click({ timeout: 6000 }).catch(() => undefined);
  for (const ch of text) {
    await locator.pressSequentially(ch, { delay: 0 }).catch(() => undefined);
    await humanPause(PAUSE.keystroke, signal);
  }
}

/* ------------------------------------------------------------------ */
/* 访问额度与安静时段                                                   */
/* ------------------------------------------------------------------ */

export type BrowseKind = 'scrape' | 'publish' | 'healthcheck' | 'login';

/**
 * 每天最多几次「打开小红书去干点什么」。
 *
 * 这些数字不是拍脑袋：真人运营一个号，一天主动去创作中心两三次、
 * 去看别人主页两三次，是正常上限；再多就不像人了。
 */
const DAILY_QUOTA: Record<BrowseKind, number> = {
  scrape: 3,
  publish: 2,
  healthcheck: 8,
  login: 6,
};

/** 同一类操作两次之间至少隔多久（分钟）。 */
const MIN_GAP_MIN: Record<BrowseKind, number> = {
  scrape: 25,
  publish: 20,
  healthcheck: 45,
  login: 10,
};

function localDay(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function counterKey(kind: BrowseKind, day = localDay()): string {
  return `browse_count:${kind}:${day}`;
}

export function browseUsed(kind: BrowseKind): number {
  return Number(getSetting(counterKey(kind)) ?? '0') || 0;
}

/** 解析 "23:30-07:30" 形式的安静时段，跨零点也支持。 */
function inQuietHours(now = new Date()): boolean {
  const spec = config.risk.quietHours?.trim();
  if (!spec) return false;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(spec);
  if (!m) return false;
  const toMin = (h: string, mi: string) => Number(h) * 60 + Number(mi);
  const start = toMin(m[1]!, m[2]!);
  const end = toMin(m[3]!, m[4]!);
  const cur = now.getHours() * 60 + now.getMinutes();
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

/**
 * 冷静期。
 *
 * 账号被处置之后**必须停手**，理由有两条，都很硬：
 *
 *  1. 处置本身就是一次「观察开始」的信号。翻数据库能看到，2026-10-10 15:09
 *     处置生效，而 15:19 和 15:25 又各抓了一批 —— 在平台的观察窗口里继续
 *     用同样的节奏抓，等于把证据再交一遍。
 *  2. 这段时间的访问不会成功（300011/300013 会被拦），纯粹是在累积记录。
 *
 * 所以这里做一个**连手动操作也拦**的硬闸：一般闸门对手动操作只提醒，
 * 这个不行 —— 它拦的正是「反复去试它恢复没有」这个动作本身。
 *
 * 用法：设置里把 `pause_until` 填成一个日期时间（本地时间），
 * 到期自动失效，不需要记得回来关。
 */
function pauseUntil(): Date | null {
  const raw = getSetting('pause_until')?.trim();
  if (!raw) return null;
  const t = new Date(raw.replace(' ', 'T'));
  return Number.isNaN(t.getTime()) ? null : t;
}

/** 把 ISO 时间按本机时区渲染成 `YYYY-MM-DD HH:mm`。界面上显示 UTC 会误导人。 */
function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function inCooldown(now = new Date()): {
  active: boolean;
  until?: string;
  untilLocal?: string;
  leftHours?: number;
} {
  const until = pauseUntil();
  if (!until || until.getTime() <= now.getTime()) return { active: false };
  return {
    active: true,
    until: until.toISOString(),
    untilLocal: localStamp(until),
    leftHours: Math.ceil((until.getTime() - now.getTime()) / 3_600_000),
  };
}

export interface BrowseGate {
  ok: boolean;
  reason?: string;
  used: number;
  limit: number;
  /** 距离可以再动还差多少分钟 */
  waitMin?: number;
}

/**
 * 判断现在能不能去小红书动一动。
 *
 * 三道闸，从硬到软：
 *  1. **冷静期**（`pause_until`）—— 连手动也拦，见上面的注释。
 *  2. **安静时段** —— 只拦自动任务。手动点一下是用户自己的决定，
 *     不至于因为在晚上十一点点了一次就把功能锁掉。
 *  3. **日额度 / 最小间隔** —— 两类都拦，但表述不同。
 *
 * 手动操作被拦时返回的原因是给人看的（还差几分钟、为什么），
 * 路由层会把它变成 429 + hint，而不是静默失败。
 */
export function browseGate(kind: BrowseKind, opts: { auto?: boolean } = {}): BrowseGate {
  const limit = DAILY_QUOTA[kind];
  const used = browseUsed(kind);

  // 冷静期优先于一切，而且**手动也拦**。
  // 这段时间的访问注定失败，还会落在平台的观察窗口里 ——
  // 「去试试恢复没有」这个动作本身就该被挡住。
  const cooldown = inCooldown();
  if (cooldown.active) {
    return {
      ok: false,
      used,
      limit,
      reason:
        `账号处于处置冷静期（还有约 ${cooldown.leftHours} 小时）。` +
        `此期间访问小红书不会成功，只会继续累积风控记录，所以不自动进行、也建议不要手动去试。`,
    };
  }

  // 探活不是「打开页面」，只是一个已签名接口调用；安静时段也该静默。
  if (opts.auto && kind !== 'healthcheck' && inQuietHours()) {
    return {
      ok: false,
      used,
      limit,
      reason: `现在是安静时段（${config.risk.quietHours}），自动化不去打扰小红书 —— 真人也不会在这个点反复访问创作中心。`,
    };
  }

  if (used >= limit) {
    return {
      ok: false,
      used,
      limit,
      reason: `今天「${kind}」的访问额度已用完（${used}/${limit}）。防风控起见不再继续，明天再试。`,
    };
  }

  const lastAt = getSetting(`browse_last:${kind}`);
  if (lastAt) {
    const gapMin = (Date.now() - new Date(lastAt).getTime()) / 60_000;
    const need = MIN_GAP_MIN[kind];
    if (gapMin < need) {
      return {
        ok: false,
        used,
        limit,
        waitMin: Math.ceil(need - gapMin),
        reason: `距上次${kind}只过了 ${gapMin.toFixed(0)} 分钟，最少要隔 ${need} 分钟（防风控的硬约束）。`,
      };
    }
  }

  return { ok: true, used, limit };
}

/** 记一次访问。真正动手之前调用。 */
export function noteBrowseStart(kind: BrowseKind): void {
  const day = localDay();
  setSetting(counterKey(kind, day), String(browseUsed(kind) + 1));
  setSetting(`browse_last:${kind}`, new Date().toISOString());
  logger.info({ kind, used: browseUsed(kind), limit: DAILY_QUOTA[kind] }, '记录一次小红书访问');
}

/**
 * 拦截闸门：自动任务在门外就停，手动操作只写一条告警。
 */
export function enforceBrowse(kind: BrowseKind, opts: { auto?: boolean } = {}): BrowseGate {
  const gate = browseGate(kind, opts);
  if (!gate.ok) {
    logEvent('risk', `防风控拦截（${kind}）：${gate.reason}`, {
      // 手动操作被拦时用 warn 而不是 info：这是用户当场看到的阻断，
      // 得让它在事件流里显眼，而不是混在「正常推迟」里
      severity: opts.auto ? 'warn' : 'error',
      detail: { kind, used: gate.used, limit: gate.limit, manual: !opts.auto },
    });
  }
  return gate;
}

/**
 * 供界面展示当前风控余量。
 *
 * 每项都用 `browseGate` 的真实结论，但把 used/limit 换成本日计数 ——
 * gate 返回的 used 就是计数，这里显式再取一次只是为了可读性。
 */
export function browseBudget(): Array<BrowseGate & { kind: BrowseKind }> {
  const cooldown = inCooldown();
  return (Object.keys(DAILY_QUOTA) as BrowseKind[]).map((kind) => {
    const gate = browseGate(kind);
    return {
      ...gate,
      kind,
      used: browseUsed(kind),
      limit: DAILY_QUOTA[kind],
      // 冷静期是全局状态，四个格子都要显示，而不是让用户以为是某一项被卡住
      ...(cooldown.active && !gate.reason
        ? { reason: `冷静期至 ${cooldown.untilLocal}` }
        : {}),
    };
  });
}

export function quietHoursNow(): boolean {
  return inQuietHours();
}
