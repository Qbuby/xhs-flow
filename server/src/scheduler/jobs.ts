import { Cron } from 'croner';
import { run, get, all, logEvent, recordRunLog, getSetting } from '../db/index.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { scrapeAuthor } from '../xhs/scrape.js';
import { browser } from '../xhs/browser.js';
import { analyzeSource } from '../corpus/analyze.js';
import { buildStyleProfile } from '../corpus/profile.js';
import { composeNextDraft, ideateTopics, renderDraftCards } from '../generate/pipeline.js';
import { approvedDrafts, markPublishing, markPublishResult, publishNote } from '../xhs/publish.js';
import { logNormalDelay, sleep } from '../util/throttle.js';
import { enforceBrowse, browseGate, noteBrowseStart, quietHoursNow } from '../util/human.js';

/**
 * 任务调度。
 *
 * 刻意不引 BullMQ：那是为 Redis 持久队列设计的，单机常驻进程用不上，
 * 代价却是一个额外服务。DB-backed jobs 表 + ticker 就够了 ——
 * 状态存在 SQLite 里，重启不丢，还顺带获得完整历史可查。
 */

export type JobType =
  | 'scrape'
  | 'distill'
  | 'ideate'
  | 'compose'
  | 'render'
  | 'publish'
  | 'healthcheck';

export interface JobPayload {
  sourceId?: number;
  profileUrl?: string;
  maxNotes?: number;
  maxNew?: number;
  downloadImages?: boolean;
  count?: number;
  draftId?: number;
  brand?: string;
}

/* ------------------------------------------------------------------ */
/* 入队                                                                */
/* ------------------------------------------------------------------ */

export function enqueue(type: JobType, payload: JobPayload = {}, opts: { runAt?: string; dedupeKey?: string; maxAttempts?: number } = {}): number | null {
  if (opts.dedupeKey) {
    // 只对「还在排队/执行中」的任务去重。
    // 之前不看状态，导致手动续抓这种要反复触发的任务被一次历史记录永久挡死 ——
    // 点了没反应，还以为抓过了。
    const existing = get<{ id: number }>(
      "SELECT id FROM jobs WHERE dedupe_key = ? AND status IN ('pending','running')",
      opts.dedupeKey,
    );
    if (existing) return existing.id;
  }
  const r = run(
    `INSERT INTO jobs(type, payload, run_at, dedupe_key, max_attempts) VALUES (?,?,?,?,?)`,
    type,
    JSON.stringify(payload),
    opts.runAt ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
    opts.dedupeKey ?? null,
    opts.maxAttempts ?? 3,
  );
  return Number(r.lastInsertRowid);
}

/* ------------------------------------------------------------------ */
/* 任务处理器                                                          */
/* ------------------------------------------------------------------ */

type Handler = (payload: JobPayload, jobId: number) => Promise<unknown>;

const handlers: Record<JobType, Handler> = {
  async scrape(p) {
    if (!p.profileUrl) throw new Error('scrape 任务缺少 profileUrl');
    const res = await scrapeAuthor({
      profileUrl: p.profileUrl,
      maxNotes: p.maxNotes ?? 200,
      maxNew: p.maxNew,
      downloadImages: p.downloadImages ?? true,
      // 定时续抓是自动行为 —— 要过每日额度、最小间隔和安静时段。
      // 凌晨四点爬起来把作者主页从头翻一遍，正是风控最想抓的形状。
      auto: true,
    });
    // 抓完自动排队蒸馏，省得手动点
    enqueue('distill', { sourceId: res.sourceId }, { dedupeKey: `distill:${res.sourceId}:pending` });
    return res;
  },

  async distill(p) {
    if (!p.sourceId) throw new Error('distill 任务缺少 sourceId');
    const analysis = await analyzeSource(p.sourceId, 60);

    // 作者画像是一次 200 秒量级的大调用，但结果几乎不变。
    // 只要没有新增笔记、且已有画像，就别重算。
    const existing = get<{ sample_count: number }>(
      'SELECT sample_count FROM style_profiles WHERE source_id = ?',
      p.sourceId,
    );
    const styled = get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM notes n JOIN note_styles ns ON ns.note_id = n.id WHERE n.source_id = ?',
      p.sourceId,
    );

    let profileBuilt = false;
    if (!existing || (styled?.c ?? 0) > existing.sample_count + 2) {
      const profile = await buildStyleProfile(p.sourceId);
      profileBuilt = Boolean(profile);
    } else {
      logger.info({ sourceId: p.sourceId, sample: styled?.c }, '已有风格画像且无新增笔记，跳过重算');
    }
    return { ...analysis, profileBuilt, profileSkipped: !profileBuilt };
  },

  async ideate(p) {
    if (!p.sourceId) throw new Error('ideate 任务缺少 sourceId');
    const topics = await ideateTopics(p.sourceId, p.count ?? 6);
    return { created: topics.length };
  },

  async compose(p) {
    if (!p.sourceId) throw new Error('compose 任务缺少 sourceId');
    const brand = p.brand ?? (await import('../db/index.js')).getSetting('brand') ?? '';
    const res = await composeNextDraft(p.sourceId, brand);
    return res ?? { skipped: '没有待创作选题' };
  },

  async render(p) {
    if (!p.draftId) throw new Error('render 任务缺少 draftId');
    const row = get<{ source_id: number | null }>('SELECT source_id FROM drafts WHERE id = ?', p.draftId);
    const n = await renderDraftCards(p.draftId, row?.source_id ?? null);
    return { rendered: n };
  },

  async publish() {
    const queue = approvedDrafts();
    if (queue.length === 0) return { published: 0 };

    // 自动发布要过额度与安静时段。一次自动发布就是一次完整的创作中心会话，
    // 一天里反复进出创作中心是最容易被判定为「非真人运营」的行为之一。
    //
    // 闸门按**会话**过：这里过一次（并记一次额度），循环里每篇带 inSession
    // 进去 —— 否则第二条会被「发布最小间隔 20 分钟」挡住，而真人打开创作中心
    // 发两条笔记就是一次访问。
    const gate = enforceBrowse('publish', { auto: true });
    if (!gate.ok) {
      logEvent('risk', `自动发布已推迟：${gate.reason}`, { severity: 'warn' });
      return { published: [], deferred: gate.reason };
    }
    noteBrowseStart('publish');

    const published: number[] = [];
    const failed: Array<{ id: number; error: string }> = [];

    for (const { id } of queue) {
      markPublishing(id);
      const draft = get<{
        id: number;
        title: string;
        body: string;
        tags: string;
        source_id: number | null;
      }>('SELECT id, title, body, tags, source_id FROM drafts WHERE id = ?', id);

      if (!draft) continue;

      const cards = all<{ image_path: string | null }>(
        'SELECT image_path FROM draft_cards WHERE draft_id = ? AND image_path IS NOT NULL ORDER BY idx',
        id,
      );
      const imagePaths = cards.map((c) => c.image_path as string);

      const result = await publishNote({
        draftId: id,
        title: draft.title,
        body: draft.body,
        tags: JSON.parse(draft.tags || '[]'),
        imagePaths,
        // 闸门与计数已经在循环外按会话做过一次
        inSession: true,
      });

      markPublishResult(id, result.ok, result.noteUrl, result.error);

      if (result.ok) {
        published.push(id);
        logger.info({ draftId: id }, '发布成功');
        // 成功后清理本地图片，省磁盘
        await cleanupDraftMedia(id);
      } else {
        failed.push({ id, error: result.error ?? '未知' });
        logEvent('publish', `草稿 ${id} 发布失败：${result.error}`, { severity: 'error' });
      }

      // 发布间隔是硬性防风控，不能省；而且不能是固定值 ——
      // 固定 45 秒连发在风控眼里仍然是机器。这里改成对数正态抖动。
      if (queue.length > 1) {
        await sleep(logNormalDelay(config.publish.intervalSec * 1000, 0.45));
      }
    }

    return { published, failed };
  },

  async healthcheck() {
    // 只在浏览器已经开着的时候探一下，不要把这个后台任务变成
    // 「每 17 分钟弹一次小红书窗口」的东西。
    const cookie = await browser.healthCheck({ onlyIfRunning: true });
    if (cookie.skipped) return cookie;
    logEvent('cookie', cookie.ok ? '会话正常' : `会话异常：${cookie.detail}`, {
      severity: cookie.ok ? 'info' : 'warn',
    });
    return cookie;
  },
};

async function cleanupDraftMedia(draftId: number): Promise<void> {
  try {
    const { MEDIA_DIR } = await import('../config.js');
    const fs = await import('node:fs/promises');
    await fs.rm(`${MEDIA_DIR}/drafts/${draftId}`, { recursive: true, force: true });
  } catch {
    /* 清理失败无所谓 */
  }
}

/* ------------------------------------------------------------------ */
/* 执行循环                                                            */
/* ------------------------------------------------------------------ */

let ticking = false;
let stopped = false;

async function claimNext(): Promise<{ id: number; type: JobType; payload: JobPayload } | null> {
  const row = get<{ id: number; type: JobType; payload: string }>(
    `SELECT id, type, payload FROM jobs
     WHERE status = 'pending' AND run_at <= datetime('now')
     ORDER BY run_at ASC, id ASC LIMIT 1`,
  );
  if (!row) return null;

  const claimed = run(
    `UPDATE jobs SET status='running', started_at=datetime('now'), attempts=attempts+1
     WHERE id = ? AND status = 'pending'`,
    row.id,
  );
  if (claimed.changes === 0) return null; // 被别人抢了

  let payload: JobPayload = {};
  try {
    payload = JSON.parse(row.payload) as JobPayload;
  } catch {
    /* payload 坏了就当空 */
  }
  return { id: row.id, type: row.type, payload };
}

/**
 * 这些失败重试也没用 —— 短时间内不会自己好，重试只会反复撞风控，
 * 徒增被封号的概率。命中就直接判死，把额度留给真正可重试的错误。
 */
const NON_RETRYABLE =
  /300011|300012|300013|当前账号存在异常|IP存在风险|访问频繁|无登录信息|未登录|账号被风控|签名失效|签名不可用/;

function isNonRetryable(message: string): boolean {
  return NON_RETRYABLE.test(message);
}

async function execute(job: { id: number; type: JobType; payload: JobPayload }): Promise<void> {
  const handler = handlers[job.type];
  if (!handler) {
    run("UPDATE jobs SET status='failed', last_error=?, finished_at=datetime('now') WHERE id=?", `未知任务类型 ${job.type}`, job.id);
    return;
  }

  const started = Date.now();
  try {
    const result = await handler(job.payload, job.id);
    const ms = Date.now() - started;
    run(
      "UPDATE jobs SET status='done', finished_at=datetime('now'), last_error=NULL, dedupe_key=NULL WHERE id=?",
      job.id,
    );
    recordRunLog('info', job.type, `任务完成（${ms}ms）`, result);
    logger.info({ jobId: job.id, type: job.type, ms }, '任务完成');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const jobRow = get<{ attempts: number; max_attempts: number }>(
      'SELECT attempts, max_attempts FROM jobs WHERE id = ?',
      job.id,
    );
    const exhausted = (jobRow?.attempts ?? 0) >= (jobRow?.max_attempts ?? 3);
    const hopeless = isNonRetryable(message);

    if (exhausted || hopeless) {
      run(
        `UPDATE jobs SET status='failed', last_error=?, finished_at=datetime('now'), dedupe_key=NULL WHERE id=?`,
        message,
        job.id,
      );
      logEvent(
        'error',
        hopeless
          ? `任务 ${job.type} 判定为不可重试：${message.slice(0, 200)}`
          : `任务 ${job.type} 彻底失败：${message.slice(0, 200)}`,
        { severity: 'error', detail: { jobId: job.id } },
      );
    } else {
      // 指数退避重试
      const backoffMin = Math.min(60, 2 ** (jobRow?.attempts ?? 1) * 5);
      run(
        `UPDATE jobs SET status='pending', last_error=?, run_at=datetime('now', ?) WHERE id=?`,
        message,
        `+${backoffMin} minutes`,
        job.id,
      );
    }

    recordRunLog('error', job.type, message.slice(0, 500));
    logger.error({ jobId: job.id, type: job.type, err }, '任务失败');
  }
}

/**
 * 进程被强杀 / 断电时，会留下一批卡在 running 的僵尸任务 ——
 * 它们永远不会再被 claim，也永远不会结束。启动时统一回收。
 */
function reclaimOrphanJobs(): number {
  // 历史遗留：早期版本完成后不清 dedupe_key，会把后续同 key 任务永久挡住
  run(
    "UPDATE jobs SET dedupe_key = NULL WHERE status IN ('done','failed','canceled') AND dedupe_key IS NOT NULL",
  );

  const orphans = all<{ id: number }>(`SELECT id FROM jobs WHERE status = 'running'`);
  if (orphans.length === 0) return 0;
  for (const o of orphans) {
    const row = get<{ attempts: number; max_attempts: number }>(
      'SELECT attempts, max_attempts FROM jobs WHERE id = ?',
      o.id,
    );
    const exhausted = (row?.attempts ?? 0) >= (row?.max_attempts ?? 3);
    if (exhausted) {
      run(
        `UPDATE jobs SET status='failed', last_error='进程异常退出，任务未完成', finished_at=datetime('now'), dedupe_key=NULL WHERE id=?`,
        o.id,
      );
    } else {
      run(
        `UPDATE jobs SET status='pending', last_error='进程异常退出，任务被回收重排队', run_at=datetime('now') WHERE id=?`,
        o.id,
      );
    }
  }
  logger.warn({ count: orphans.length }, '回收了上次异常退出遗留的僵尸任务');
  return orphans.length;
}

async function tick(): Promise<void> {
  if (ticking || stopped) return;
  ticking = true;
  try {
    // 串行执行：并发抓取没有好处，只会撞风控
    for (;;) {
      const job = await claimNext();
      if (!job) break;
      await execute(job);
      if (stopped) break;
    }
  } finally {
    ticking = false;
  }
}

/* ------------------------------------------------------------------ */
/* 定时触发                                                            */
/* ------------------------------------------------------------------ */

const timers: Array<() => void> = [];

function scheduleCron(name: string, pattern: string, fn: () => void): void {
  if (!pattern) return;
  try {
    const cron = new Cron(pattern, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, () => {
      logger.info({ name }, '定时任务触发');
      try {
        fn();
      } catch (err) {
        logger.error({ err, name }, '定时任务入队失败');
      }
    });
    timers.push(() => cron.stop());
    logger.info({ name, pattern }, '已注册定时任务');
  } catch (err) {
    logger.error({ err, name, pattern }, '定时表达式无效');
  }
}

/** 所有已启用的语料源 id */
function activeSourceIds(): number[] {
  return all<{ id: number }>(`SELECT id FROM sources WHERE status = 'active' ORDER BY id`).map((r) => r.id);
}

/**
 * 自动发布是否开启。
 *
 * 以设置表为准：界面上那个开关写的就是 `auto_publish`，
 * 而 `config.publish.auto` 只来自 .env 的默认值。两处都看的话
 * 会出现「界面上关了但定时任务照发」这种最不该有的不一致。
 */
export function autoPublishEnabled(): boolean {
  const raw = getSetting('auto_publish');
  return raw === undefined || raw === '' ? config.publish.auto : raw === 'true';
}

/* ------------------------------------------------------------------ */
/* 会话健康检查的「非定周期」排程                                        */
/* ------------------------------------------------------------------ */

/** 40~90 分钟之间的随机间隔（对数正态，长尾偏长）。 */
function healthcheckDelayMs(): number {
  return Math.max(46 * 60_000, logNormalDelay(52 * 60_000, 0.35));
}

let healthcheckTimer: NodeJS.Timeout | null = null;

/**
 * 自己排自己：跑完再掷一次骰子决定下一次什么时候跑。
 *
 * 换成 cron 表达式的固定周期（哪怕是「每 17 分钟」那种写法）都会留下等距痕迹，
 * 而等距正是「第三方工具模拟浏览」最直接的证据。随机间隔 + 安静时段跳过，
 * 才和真人「想起来看一眼」的节奏对得上。
 *
 * 被闸门挡下时用 debug 记一笔就好 —— 这是设计内的正常推迟，
 * 不是异常，不该在事件日志里刷屏。
 */
function scheduleHealthcheck(): void {
  if (stopped) return;
  // 安静时段直接往后推半小时，别在凌晨反复探
  const delay = quietHoursNow() ? 30 * 60_000 : healthcheckDelayMs();

  healthcheckTimer = setTimeout(() => {
    if (stopped) return;
    const gate = browseGate('healthcheck', { auto: true });
    if (gate.ok) {
      enqueue('healthcheck', {}, { dedupeKey: 'healthcheck:tick' });
    } else {
      logger.debug({ reason: gate.reason }, '会话探活本轮跳过');
    }
    scheduleHealthcheck();
  }, delay);
  healthcheckTimer.unref?.();

  logger.info(
    { nextInMin: Math.round(delay / 60_000), quiet: quietHoursNow() },
    '已排下一次会话健康检查（随机间隔）',
  );
}

export function startScheduler(): void {
  stopped = false;
  reclaimOrphanJobs();
  setInterval(() => void tick(), 15_000).unref?.();

  // 定时创作：按设置来，不再写死在 .env
  scheduleCron(
    'generate',
    (getSetting('schedule_generate') ?? config.schedule.generate) || '',
    () => {
      const autoCompose = (getSetting('auto_compose') ?? 'false') === 'true';
      if (!autoCompose) {
        logger.info('定时创作未开启，跳过');
        return;
      }

      const perSource = Number(getSetting('compose_per_run') ?? '1');
      const autoIdeate = (getSetting('auto_ideate') ?? 'true') === 'true';
      const ideateCount = Number(getSetting('ideate_per_run') ?? '6');

      for (const sourceId of activeSourceIds()) {
        // 选题池空了就没东西可写 —— 先自动补一批选题，
        // 否则这个定时任务每天都在空转
        const open = get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM topics WHERE source_id = ? AND status = 'open'`,
          sourceId,
        );
        if ((open?.c ?? 0) < perSource && autoIdeate) {
          enqueue('ideate', { sourceId, count: ideateCount });
        }
        for (let i = 0; i < perSource; i++) {
          enqueue('compose', { sourceId }, { dedupeKey: `compose:${sourceId}:${i}` });
        }
      }
    },
  );

  // 自动续抓：到点给开了开关的语料源补新作品。
  // 默认时间从 04:00 挪到 10:40 —— 凌晨四点爬起来翻别人主页，
  // 在「活跃时段」这一维上就直接对不上真人了。而且 04:00 落在安静时段里，
  // 任务会被闸门拦下，看起来像「点了没反应」。10:40 也不是整点，避开 cron 的整齐感。
  scheduleCron(
    'rescrape',
    getSetting('schedule_rescrape') || '40 10 * * *',
    () => {
      const batch = Number(getSetting('rescrape_batch') ?? '30');
      const rows = all<{ id: number; profile_url: string; note_count: number }>(
        `SELECT id, profile_url, note_count FROM sources
         WHERE auto_scrape = 1 AND status = 'active'`,
      );
      if (rows.length === 0) {
        logger.info('没有开启自动续抓的语料源');
        return;
      }
      for (const r of rows) {
        enqueue(
          'scrape',
          { profileUrl: r.profile_url, maxNotes: 1000, maxNew: batch, downloadImages: true },
          { dedupeKey: `scrape:${r.id}` },
        );
      }
      logger.info({ count: rows.length, batch }, '已排入自动续抓');
    },
  );

  // 定时发布：只有开了自动发布才真正入队。
  //
  // 两处都改用设置表里的值：原来这里读的是 config（.env），而界面上开关写的是
  // settings.auto_publish —— 也就是说「在界面上打开自动发布」根本不生效。
  scheduleCron('publish', getSetting('schedule_publish') ?? config.schedule.publish, () => {
    if (!autoPublishEnabled()) {
      logger.info('自动发布未开启，跳过');
      return;
    }
    enqueue('publish', {}, { dedupeKey: 'publish:tick' });
  });

  // 会话健康检查：web_session 服务端会悄悄过期，早点发现好过发布失败才发现。
  //
  // ⚠️ 原来是严格「每 17 分钟一次」。数据库里的间隔直方图是 17/17/17/9/17/17…，
  // 这种不差分毫的周期性本身就是机器特征。改成「每次跑完再随机排下一次」，
  // 间隔在 25~75 分钟之间浮动，并且安静时段不打扰。
  scheduleHealthcheck();

  void tick();
}

export function stopScheduler(): void {
  stopped = true;
  if (healthcheckTimer) {
    clearTimeout(healthcheckTimer);
    healthcheckTimer = null;
  }
  for (const stop of timers) stop();
  timers.length = 0;
}

export function schedulerInfo() {
  return {
    running: !stopped,
    generate: getSetting('schedule_generate') ?? config.schedule.generate,
    publish: getSetting('schedule_publish') ?? config.schedule.publish,
    autoPublish: autoPublishEnabled(),
    pending: get<{ c: number }>(`SELECT COUNT(*) AS c FROM jobs WHERE status='pending'`)?.c ?? 0,
    running_jobs: get<{ c: number }>(`SELECT COUNT(*) AS c FROM jobs WHERE status='running'`)?.c ?? 0,
    failed: get<{ c: number }>(`SELECT COUNT(*) AS c FROM jobs WHERE status='failed'`)?.c ?? 0,
  };
}

/** 立即触发一次 tick，供 API 调用。 */
export async function runNow(): Promise<void> {
  await tick();
}