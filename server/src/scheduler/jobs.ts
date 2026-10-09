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
import { sleep } from '../util/throttle.js';

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
    const existing = get<{ id: number }>('SELECT id FROM jobs WHERE dedupe_key = ?', opts.dedupeKey);
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
      downloadImages: p.downloadImages ?? true,
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

      // 发布间隔是硬性防风控，不能省
      if (queue.length > 1) await sleep(config.publish.intervalSec * 1000);
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
      "UPDATE jobs SET status='done', finished_at=datetime('now'), last_error=NULL WHERE id=?",
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
        `UPDATE jobs SET status='failed', last_error=?, finished_at=datetime('now') WHERE id=?`,
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
        `UPDATE jobs SET status='failed', last_error='进程异常退出，任务未完成', finished_at=datetime('now') WHERE id=?`,
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

  // 定时发布：只有开了自动发布才真正入队
  scheduleCron('publish', config.schedule.publish, () => {
    if (!config.publish.auto) {
      logger.info('自动发布未开启，跳过');
      return;
    }
    enqueue('publish', {}, { dedupeKey: 'publish:tick' });
  });

  // 会话健康检查：web_session 服务端会悄悄过期，早点发现好过发布失败才发现
  scheduleCron('healthcheck', '*/17 * * * *', () => {
    enqueue('healthcheck', {}, { dedupeKey: 'healthcheck:tick' });
  });

  void tick();
}

export function stopScheduler(): void {
  stopped = true;
  for (const stop of timers) stop();
  timers.length = 0;
}

export function schedulerInfo() {
  return {
    running: !stopped,
    generate: config.schedule.generate,
    publish: config.schedule.publish,
    autoPublish: config.publish.auto,
    pending: get<{ c: number }>(`SELECT COUNT(*) AS c FROM jobs WHERE status='pending'`)?.c ?? 0,
    running_jobs: get<{ c: number }>(`SELECT COUNT(*) AS c FROM jobs WHERE status='running'`)?.c ?? 0,
    failed: get<{ c: number }>(`SELECT COUNT(*) AS c FROM jobs WHERE status='failed'`)?.c ?? 0,
  };
}

/** 立即触发一次 tick，供 API 调用。 */
export async function runNow(): Promise<void> {
  await tick();
}