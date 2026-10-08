import Fastify from 'fastify';
import cors from '@fastify/cors';
import fstatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import {
  config,
  WEB_DIST,
  describeMissingConfig,
  MEDIA_DIR,
  PROFILE_DIR,
  llmIsConfigured,
} from '../config.js';
import { logger } from '../logger.js';
import {
  all,
  get,
  run,
  logEvent,
  recentEvents,
  recentRunLogs,
  setSetting,
  getSetting,
} from '../db/index.js';
import { browser } from '../xhs/browser.js';
import { scrapeAuthor, listSources } from '../xhs/scrape.js';
import { signerState, resetSigner } from '../xhs/signing.js';
import { getStyleProfile } from '../corpus/profile.js';
import { composeDraft, ideateTopics, renderDraftCards } from '../generate/pipeline.js';
import { DEFAULT_SPEC, renderCard } from '../generate/cards.js';
import { enqueue, schedulerInfo, runNow } from '../scheduler/jobs.js';
import { approvedDrafts } from '../xhs/publish.js';
import { llmHealth, llmInfo } from '../llm/client.js';
import { activeProviders } from '../media/stock.js';

export async function buildServer() {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  await app.register(cors, { origin: true });

  /* ---------------- 系统状态 ---------------- */

  app.get('/api/health', async () => {
    // 绝不因为一次健康查询就把浏览器拉起来 —— 前端每 8 秒轮询一次这里。
    // 浏览器没开时回落到「上次已知状态」，这样界面既不会被弹窗打扰，
    // 也不会因为进程重启就把已登录状态误报成未登录。
    const snap = await browser.snapshot({ onlyIfRunning: true }).catch(() => null);
    const cached = getSetting('session_hint');
    const lastKnown = cached ? (JSON.parse(cached) as { hasSession: boolean; at: string }) : null;

    return {
      ok: true,
      llm: llmInfo(),
      llmConfigured: llmIsConfigured(),
      llmMissing: describeMissingConfig(),
      stockProviders: activeProviders().map((p) => ({
        name: p.name,
        keyless: p.keyless,
      })),
      browser: {
        running: browser.isRunning(),
        hasSession: snap?.hasSession ?? lastKnown?.hasSession ?? false,
        // 未启动且没有缓存 → 说明这台机器还没验证过登录
        unknown: Boolean(snap?.skipped && !lastKnown),
        missingCookies: snap?.skipped ? [] : (snap?.missing ?? []),
        lastCheckedAt: lastKnown?.at ?? null,
      },
      signer: signerState(),
      scheduler: schedulerInfo(),
    };
  });

  app.get('/api/settings', async () => ({
    brand: getSetting('brand') ?? '',
    schedule: {
      generate: getSetting('schedule_generate') ?? config.schedule.generate,
      publish: getSetting('schedule_publish') ?? config.schedule.publish,
      autoPublish: (getSetting('auto_publish') ?? String(config.publish.auto)) === 'true',
    },
  }));

  app.post('/api/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string | boolean>;
    if (typeof body.brand === 'string') setSetting('brand', body.brand);
    if (typeof body.scheduleGenerate === 'string') setSetting('schedule_generate', body.scheduleGenerate);
    if (typeof body.schedulePublish === 'string') setSetting('schedule_publish', body.schedulePublish);
    if (typeof body.autoPublish === 'boolean') setSetting('auto_publish', String(body.autoPublish));
    return { ok: true };
  });

  app.get('/api/events', async () => recentEvents(80));
  app.get('/api/logs', async () => recentRunLogs(200));
  app.get('/api/jobs', async () =>
    all(`SELECT * FROM jobs ORDER BY id DESC LIMIT 100`),
  );

  /* ---------------- 登录 ---------------- */

  app.get('/api/login/status', async () => {
    const snap = await browser.snapshot({ onlyIfRunning: true }).catch(() => null);
    return {
      ...snap,
      signer: signerState(),
      browserRunning: browser.isRunning(),
      // 只有用户主动点登录/抓取时才会真正启动浏览器
      ipBlocked: snap?.skipped ? null : await browser.checkIpBlocked(),
    };
  });

  /** 风控时的备用登录路径：手动贴 cookie 串 */
  app.post('/api/login/cookies', async (req, reply) => {
    const { cookies } = (req.body ?? {}) as { cookies?: string };
    if (!cookies || !cookies.trim()) {
      reply.code(400);
      return { error: '缺少 cookies' };
    }
    const result = await browser.importCookies(cookies);
    return result;
  });

  app.post('/api/login/qr', async (_req, reply) => {
    // 已经有登录态就别去找二维码了 —— 已登录时小红书根本不弹登录框，
    // 硬找只会得到一句莫名其妙的「页面可能已改版」。
    const snap = await browser.snapshot({ onlyIfRunning: true }).catch(() => null);
    if (snap?.hasSession) {
      return { alreadyLoggedIn: true, detail: '当前已经是登录状态，无需再扫码' };
    }

    try {
      const { qr, promise } = await browser.startQrLogin();
      // 立刻返回二维码；登录在后台继续等
      void promise;
      return reply
        .header('Content-Type', 'image/png')
        .header('Cache-Control', 'no-store')
        .send(qr);
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** 清除登录态（换账号用）—— 连同整个浏览器 profile 一起清，cookie 无从残留。 */
  app.post('/api/login/reset', async () => {
    await browser.close().catch(() => undefined);
    try {
      await fsPromises.rm(PROFILE_DIR, { recursive: true, force: true });
      await fsPromises.mkdir(PROFILE_DIR, { recursive: true });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    resetSigner();
    return { ok: true, detail: '已清除本地登录态，下次登录会重新走扫码' };
  });

  app.post('/api/browser/launch', async () => {
    await browser.ensureLaunched();
    return { ok: true };
  });

  app.post('/api/browser/close', async () => {
    await browser.close();
    return { ok: true };
  });

  app.post('/api/health/check', async () => {
    const cookie = await browser.healthCheck();
    const llm = await llmHealth();
    return { cookie, llm };
  });

  /* ---------------- 语料源 ---------------- */

  app.get('/api/sources', async () => listSources());

  app.post('/api/sources', async (req, reply) => {
    const { profileUrl, maxNotes, downloadImages } = (req.body ?? {}) as {
      profileUrl?: string;
      maxNotes?: number;
      downloadImages?: boolean;
    };
    if (!profileUrl) {
      reply.code(400);
      return { error: '缺少 profileUrl' };
    }
    // 立即入队，HTTP 请求不等整个抓取过程
    const jobId = enqueue('scrape', {
      profileUrl,
      maxNotes: maxNotes ?? 200,
      downloadImages: downloadImages ?? true,
    });
    return { ok: true, jobId };
  });

  app.get('/api/sources/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const source = get('SELECT * FROM sources WHERE id = ?', id);
    const stats = get<{ total: number; with_style: number; styled: number; avg_liked: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ns.note_id IS NOT NULL THEN 1 ELSE 0 END) AS styled
       FROM notes n LEFT JOIN note_styles ns ON ns.note_id = n.id
       WHERE n.source_id = ?`,
      id,
    );
    const notes = all(
      `SELECT n.id, n.note_id, n.title, n.image_count, n.liked_count, n.collected_count,
              n.published_at, n.type, ns.analysis IS NOT NULL AS styled
       FROM notes n LEFT JOIN note_styles ns ON ns.note_id = n.id
       WHERE n.source_id = ? ORDER BY n.published_at DESC LIMIT 200`,
      id,
    );
    const profile = getStyleProfile(id);
    return { source, stats, notes, styleProfile: profile?.profile ?? null, cardSpec: profile?.profile.card_template_spec ?? DEFAULT_SPEC };
  });

  app.post('/api/sources/:id/delete', async (req) => {
    const id = Number((req.params as { id: string }).id);
    run('DELETE FROM sources WHERE id = ?', id);
    return { ok: true };
  });

  app.get('/api/sources/:id/notes/:pk', async (req) => {
    const pk = Number((req.params as { pk: string }).pk);
    const note = get('SELECT * FROM notes WHERE id = ?', pk);
    const images = all('SELECT * FROM note_images WHERE note_id = ? ORDER BY idx', pk);
    const style = get<{ analysis: string }>('SELECT analysis FROM note_styles WHERE note_id = ?', pk);
    return {
      note,
      images,
      style: style ? JSON.parse(style.analysis) : null,
    };
  });

  /* ---------------- 语料操作 ---------------- */

  app.post('/api/sources/:id/distill', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);

    // 预检：模型不通就别入队了。排一个注定失败的任务，用户点下去
    // 只看到「已入队」然后界面永远不动 —— 比直接报错更让人困惑。
    const probe = await llmHealth();
    if (!probe.ok) {
      logEvent('error', `蒸馏未启动：模型不可用 —— ${probe.detail}`, { severity: 'error' });
      reply.code(400);
      return {
        error: `无法开始蒸馏：${probe.detail}`,
        hint: '请到「设置」页检查模型配置。密钥必须搭配对应的 baseURL —— 智谱的团队套餐和按量付费不是同一个地址。',
      };
    }

    return { jobId: enqueue('distill', { sourceId: id }) };
  });

  app.post('/api/sources/:id/ideate', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const count = Number((req.query as { count?: string }).count ?? 6);
    return { jobId: enqueue('ideate', { sourceId: id, count }) };
  });

  app.get('/api/sources/:id/topics', async (req) => {
    const id = Number((req.params as { id: string }).id);
    return all('SELECT * FROM topics WHERE source_id = ? ORDER BY id DESC', id);
  });

  app.post('/api/sources/:id/topics', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const { title, angle, brief } = (req.body ?? {}) as Record<string, string>;
    if (!title) return { error: '缺少 title' };
    const r = run(
      `INSERT INTO topics(source_id, title, angle, brief, origin) VALUES (?,?,?,?, 'manual')`,
      id,
      title,
      angle ?? '',
      brief ?? '',
    );
    return { ok: true, id: Number(r.lastInsertRowid) };
  });

  app.post('/api/topics/:id/remove', async (req) => {
    const id = Number((req.params as { id: string }).id);
    run('DELETE FROM topics WHERE id = ?', id);
    return { ok: true };
  });

  /* ---------------- 草稿与审核 ---------------- */

  app.get('/api/drafts', async (req) => {
    const q = req.query as { status?: string; sourceId?: string };
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status) {
      where.push('d.status = ?');
      params.push(q.status);
    }
    if (q.sourceId) {
      where.push('d.source_id = ?');
      params.push(Number(q.sourceId));
    }
    return all(
      `SELECT d.*, s.nickname FROM drafts d LEFT JOIN sources s ON s.id = d.source_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY d.id DESC LIMIT 200`,
      ...params,
    );
  });

  app.get('/api/drafts/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const draft = get('SELECT * FROM drafts WHERE id = ?', id);
    if (!draft) return { error: '草稿不存在' };
    const cards = all('SELECT * FROM draft_cards WHERE draft_id = ? ORDER BY idx', id);
    return { draft, cards };
  });

  app.post('/api/drafts/:id/status', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const { status, note } = (req.body ?? {}) as { status?: string; note?: string };
    const allowed = ['draft', 'pending', 'approved', 'rejected', 'published'];
    if (!status || !allowed.includes(status)) return { error: '非法状态' };
    run(
      `UPDATE drafts SET status=?, review_note=?, updated_at=datetime('now') WHERE id=?`,
      status,
      note ?? null,
      id,
    );
    return { ok: true };
  });

  app.post('/api/drafts/:id/edit', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const { title, body, tags, rerender } = (req.body ?? {}) as {
      title?: string;
      body?: string;
      tags?: string[];
      rerender?: boolean;
    };
    if (title !== undefined) run('UPDATE drafts SET title=? WHERE id=?', title.slice(0, 40), id);
    if (body !== undefined) run('UPDATE drafts SET body=? WHERE id=?', body, id);
    if (tags !== undefined) run('UPDATE drafts SET tags=? WHERE id=?', JSON.stringify(tags), id);
    if (rerender) {
      const row = get<{ source_id: number | null }>('SELECT source_id FROM drafts WHERE id = ?', id);
      return { jobId: enqueue('render', { draftId: id }) , sourceId: row?.source_id ?? null };
    }
    return { ok: true };
  });

  app.post('/api/drafts/:id/rerender', async (req) => {
    const id = Number((req.params as { id: string }).id);
    return { jobId: enqueue('render', { draftId: id }) };
  });

  app.get('/api/drafts/pending/count', async () =>
    get<{ c: number }>(`SELECT COUNT(*) AS c FROM drafts WHERE status='pending'`)?.c ?? 0,
  );

  app.post('/api/drafts/bulk-approve', async (req) => {
    const { ids } = (req.body ?? {}) as { ids?: number[] };
    if (!ids?.length) return { error: '缺少 ids' };
    for (const id of ids) {
      run("UPDATE drafts SET status='approved', updated_at=datetime('now') WHERE id=?", id);
    }
    return { ok: true, n: ids.length };
  });

  /* ---------------- 生成 ---------------- */

  app.post('/api/compose', async (req, reply) => {
    const { sourceId, topic, angle, brief, brand, cardCount } = (req.body ?? {}) as {
      sourceId?: number;
      topic?: string;
      angle?: string;
      brief?: string;
      brand?: string;
      cardCount?: number;
    };
    if (!sourceId || !topic) {
      reply.code(400);
      return { error: '缺少 sourceId 或 topic' };
    }
    if (!llmIsConfigured()) {
      reply.code(400);
      return { error: '未配置模型 key' };
    }
    try {
      return await composeDraft({
        sourceId: Number(sourceId),
        topic,
        angle,
        brief,
        brand: brand ?? getSetting('brand') ?? '',
        cardCount: cardCount ?? 7,
      });
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post('/api/ideate', async (req, reply) => {
    const { sourceId, count } = (req.body ?? {}) as { sourceId?: number; count?: number };
    if (!sourceId) {
      reply.code(400);
      return { error: '缺少 sourceId' };
    }
    try {
      return { topics: await ideateTopics(Number(sourceId), count ?? 6) };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  /* ---------------- 发布 ---------------- */

  app.get('/api/publish/queue', async () => approvedDrafts());

  app.post('/api/publish/run', async () => ({ jobId: enqueue('publish', {}) }));
  app.post('/api/publish/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const r = run("UPDATE drafts SET status='approved' WHERE id=? AND status <> 'published'", id);
    return { ok: r.changes > 0, jobId: enqueue('publish', {}) };
  });

  /* ---------------- 调度 ---------------- */

  app.post('/api/scheduler/run', async () => {
    await runNow();
    return schedulerInfo();
  });

  app.get('/api/scheduler', async () => schedulerInfo());

  /* ---------------- 媒体静态 ---------------- */

  // 图片从 media 目录直接出，带缓存
  if (fs.existsSync(MEDIA_DIR)) {
    await app.register(fstatic, {
      root: MEDIA_DIR,
      prefix: '/media/',
      decorateReply: false,
      cacheControl: true,
      maxAge: '7d',
    });
  }

  /* ---------------- 前端 ---------------- */

  if (fs.existsSync(WEB_DIST)) {
    await app.register(fstatic, { root: WEB_DIST, prefix: '/' });

    // SPA 回退
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/media/')) {
        reply.code(404);
        return { error: 'Not found' };
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html')
        .send(
          `<h1>xhsflow</h1><p>前端尚未构建。请运行 <code>npm run build</code>，或开发模式下访问 Vite 端口。</p>`,
        ),
    );
  }

  return app;
}

/** 把绝对路径转成前端可用的 /media/... URL */
export function toMediaUrl(localPath: string | null | undefined): string | null {
  if (!localPath) return null;
  const rel = path.relative(MEDIA_DIR, localPath).split(path.sep).join('/');
  return `/media/${rel}`;
}

export { fsPromises };