import Fastify from 'fastify';
import { Cron } from 'croner';
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
  PROFILE_DIR
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
import { renderCard, toResolved } from '../generate/cards.js';
import { enqueue, schedulerInfo, runNow } from '../scheduler/jobs.js';
import { approvedDrafts } from '../xhs/publish.js';
import { exportCorpusZip, importCorpusZip } from '../corpus/transfer.js';
import { createZip, type ZipEntryInput } from '../util/zip.js';
import { CREATOR_ORIGIN } from '../xhs/browser.js';
import { plainText } from '../xhs/publish.js';
import { llmHealth, llmInfo } from '../llm/client.js';
import {
  getLlmConfig,
  llmIsConfigured,
  describeLlmMissing,
  maskKey,
} from '../llm/runtime.js';
import { activeProviders } from '../media/stock.js';
import { browseBudget, enforceBrowse, inCooldown, noteBrowseStart, quietHoursNow } from '../util/human.js';

/** 把 cron 表达式翻译成「下一次会是什么时候」，创作台要显示。 */
function nextRunTimes(): { generate: string | null; rescrape: string | null } {
  const gen = getSetting('schedule_generate') ?? config.schedule.generate;
  const re = getSetting('schedule_rescrape') ?? '40 10 * * *';
  const calc = (p: string): string | null => {
    if (!p?.trim()) return null;
    try {
      const c = new Cron(p, { paused: true });
      const next = c.nextRun();
      c.stop();
      return next ? next.toISOString() : null;
    } catch {
      return null;
    }
  };
  return { generate: calc(gen), rescrape: calc(re) };
}

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
      llmMissing: describeLlmMissing(),
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
      // 防风控余量。账号已被处置过一次（2026-10-10 曝光受限一周），
      // 「今天还能不能动」必须直接在界面上可见，而不是藏在日志里。
      risk: {
        quietHours: config.risk.quietHours,
        inQuietHours: quietHoursNow(),
        useRealChrome: config.risk.useRealChrome,
        cooldown: inCooldown(),
        budget: browseBudget(),
      },
    };
  });

  app.get('/api/settings', async () => {
    const llm = getLlmConfig();
    return {
    brand: getSetting('brand') ?? '',
    llm: {
      api: llm.api,
      baseURL: llm.baseURL,
      model: llm.model,
      hasKey: Boolean(llm.apiKey),
      keyMasked: maskKey(llm.apiKey),
      fromEnv: !getSetting('llm_api_key'),
    },
    schedule: {
      generate: getSetting('schedule_generate') ?? config.schedule.generate,
      // 创作台的新配置
      autoCompose: (getSetting('auto_compose') ?? 'false') === 'true',
      autoIdeate: (getSetting('auto_ideate') ?? 'true') === 'true',
      composePerRun: Number(getSetting('compose_per_run') ?? '1'),
      ideatePerRun: Number(getSetting('ideate_per_run') ?? '6'),
      rescrape: getSetting('schedule_rescrape') ?? '40 10 * * *',
      rescrapeBatch: Number(getSetting('rescrape_batch') ?? '30'),
      // 冷静期（本地时间字符串，空 = 未启用）
      pauseUntil: getSetting('pause_until') ?? '',
    },
    nextRun: nextRunTimes(),
    };
  });

  app.post('/api/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string | number | boolean>;
    const setStr = (k: string, v: string | number | boolean | undefined) => {
      if (v !== undefined) setSetting(k, String(v));
    };
    setStr('brand', body.brand);
    setStr('schedule_generate', body.scheduleGenerate);
    setStr('auto_compose', body.autoCompose);
    setStr('auto_ideate', body.autoIdeate);
    setStr('compose_per_run', body.composePerRun);
    setStr('ideate_per_run', body.ideatePerRun);
    setStr('schedule_rescrape', body.rescrape);
    setStr('rescrape_batch', body.rescrapeBatch);
    // 冷静期。空字符串是有效值（= 清除冷静期），所以不能用 setStr 的
    // 「undefined 才跳过」语义 —— 用户清空输入框就是要解除它。
    if (typeof body.pauseUntil === 'string') {
      const v = body.pauseUntil.trim();
      if (!v) {
        setSetting('pause_until', '');
      } else {
        const t = new Date(v.replace(' ', 'T'));
        if (Number.isNaN(t.getTime())) {
          reply.code(400);
          return { error: `冷静期时间格式无法解析：${v}（应为 2026-10-17 16:00 这种形式）` };
        }
        setSetting('pause_until', v);
      }
    }
    // 模型配置。key 只在非空时更新 —— 界面上留空表示「保持现状」，
    // 不然掩码显示的占位符一保存就把真 key 冲掉了。
    setStr('llm_api', typeof body.llmApi === 'string' && ['openai','anthropic'].includes(body.llmApi) ? body.llmApi : undefined);
    setStr('llm_base_url', typeof body.llmBaseUrl === 'string' ? body.llmBaseUrl.trim() : undefined);
    setStr('llm_model', typeof body.llmModel === 'string' ? body.llmModel.trim() : undefined);
    if (typeof body.llmApiKey === 'string' && body.llmApiKey.trim()) {
      setSetting('llm_api_key', body.llmApiKey.trim());
    }

    // cron 表达式校验：无效的表达式不该等到下次触发才暴露
    for (const [key, label] of [
      ['scheduleGenerate', '定时创作'],
      ['scheduleRescrape', '自动续抓'],
    ] as const) {
      const v = body[key];
      if (typeof v === 'string' && v.trim()) {
        try {
          new Cron(v);
        } catch {
          reply.code(400);
          return { error: `${label}的时间表达式无效：${v}` };
        }
      }
    }
    return { ok: true, nextRun: nextRunTimes() };
  });

  /** 创作台：跨语料源的选题总览 */
  app.get('/api/studio/topics', async () => {
    const sources = all<{ id: number; nickname: string | null; note_count: number }>(
      `SELECT id, nickname, note_count FROM sources WHERE status='active' ORDER BY id`,
    );
    const topics = all(
      `SELECT t.*, s.nickname FROM topics t
       LEFT JOIN sources s ON s.id = t.source_id
       ORDER BY t.status='open' DESC, t.id DESC LIMIT 200`,
    );
    const counts = all<{ source_id: number; open: number; used: number }>(
      `SELECT source_id,
              SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN status='used' THEN 1 ELSE 0 END) AS used
       FROM topics GROUP BY source_id`,
    );
    return { sources, topics, counts };
  });

  app.get('/api/events', async () => recentEvents(80));
  app.get('/api/logs', async () => recentRunLogs(200));
  app.get('/api/jobs', async () =>
    all(`SELECT * FROM jobs ORDER BY id DESC LIMIT 100`),
  );

  /* ---------------- 登录 ---------------- */

  app.get('/api/login/status', async () => {
    const snap = await browser.snapshot({ onlyIfRunning: true }).catch(() => null);
    // checkIpBlocked 会打开/复用一个 xiaohongshu.com 页面，本质上是一次浏览。
    // 冷静期里连这个也不做 —— 「看一下有没有被墙」和「去试试恢复没有」是一回事。
    const mayProbeIp = !snap?.skipped && !inCooldown().active;
    return {
      ...snap,
      signer: signerState(),
      browserRunning: browser.isRunning(),
      ipBlocked: mayProbeIp ? await browser.checkIpBlocked() : null,
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
    // 冷静期里连扫码也不该做 —— 打开小红书首页本身就是一次浏览行为。
    const gate = enforceBrowse('login', { auto: false });
    if (!gate.ok) {
      reply.code(429);
      return { error: gate.reason ?? '防风控拦截' };
    }

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

  app.post('/api/health/check', async (_req, reply) => {
    // 这会打一次真实签名的 /user/me —— 是货真价实的一次小红书 API 调用。
    // 冷静期里不该发生，用户点「检测」时得明确告诉他为什么不做。
    const gate = enforceBrowse('healthcheck', { auto: false });
    if (!gate.ok) {
      reply.code(429);
      return { error: gate.reason ?? '防风控拦截' };
    }
    noteBrowseStart('healthcheck');
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
    // 画像里存的可能是新契约，也可能是库里遗留的旧 18 字段 ——
    // toResolved 两种都吃，顺带把旧的迁移过来。
    const resolved = toResolved(profile?.profile.card_template_spec);
    return {
      source,
      stats,
      notes,
      styleProfile: profile?.profile ?? null,
      // 前端不再自己读 hex。这里回填的是**归一后的契约**（旧画像读出来
      // 就是迁移后的新契约），并把解析出来的真实色值一起给出去。
      cardSpec: resolved.contract,
      design: {
        theme: resolved.theme,
        paletteName: resolved.palette.name,
        texture: resolved.texture,
        motifs: resolved.motifs,
        accentStyle: resolved.accentStyle,
        typeScale: resolved.contract.type_scale,
        density: resolved.contract.density,
        bg: resolved.palette.bg,
        ink: resolved.palette.ink,
        accent: resolved.palette.accent,
      },
    };
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

  /**
   * 续抓：只补没有的，已入库的自动跳过。
   * `maxNotes` 传 null 表示「一次抓到作者全部作品」；
   * 数字则表示「本次最多新增这么多篇」，避免一次拉太多触发风控。
   */
  app.post('/api/sources/:id/scrape', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { maxNotes?: number | null; downloadImages?: boolean };
    const src = get<{ profile_url: string; note_count: number }>(
      'SELECT profile_url, note_count FROM sources WHERE id = ?',
      id,
    );
    if (!src) return { error: '语料源不存在' };

    // 闸门不过就当面说清楚，绝不静默失败 —— 否则用户以为是 bug，再点几次，
    // 而「反复重试」正是风控最想看到的形状。
    const gate = enforceBrowse('scrape', { auto: false });
    if (!gate.ok) {
      reply.code(429);
      return {
        error: gate.reason ?? '防风控拦截',
        hint: gate.waitMin
          ? `还要等约 ${gate.waitMin} 分钟。`
          : '这是防风控的硬约束，不是故障。',
      };
    }

    // maxNotes = 本次要**新增**多少篇（不是总共处理多少条）。
    // 列表阶段单独给足覆盖量，否则会把作者几百篇旧作翻个遍才凑够数。
    const maxNew = body.maxNotes === null || body.maxNotes === undefined ? 2000 : Number(body.maxNotes);
    const avail = get<{ c: number }>(
      'SELECT available_count AS c FROM sources WHERE id = ?',
      id,
    );
    const listed = Math.max(avail?.c ?? 0, src.note_count + 1) + 200;

    return {
      ok: true,
      jobId: enqueue(
        'scrape',
        { profileUrl: src.profile_url, maxNotes: listed, maxNew, downloadImages: body.downloadImages ?? true },
        { dedupeKey: `scrape:${id}` },
      ),
      budget: gate,
    };
  });

  /** 单个语料源的自动续抓开关 */
  app.post('/api/sources/:id/auto', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    run(
      "UPDATE sources SET auto_scrape = ?, updated_at = datetime('now') WHERE id = ?",
      enabled ? 1 : 0,
      id,
    );
    return { ok: true, enabled: Boolean(enabled) };
  });

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

  /* ---------------- 发布准备台 ---------------- */

  /**
   * 2026-10-12 起，**取消一切自动化发布**。
   *
   * 背景：账号在 2026-10-10 因「AI 模拟浏览」被限制曝光一周，官方点名的正是
   * 「用第三方工具模拟真人操作」。发布这条链路是全部功能里最重的机器行为：
   * 打开创作中心、传图、逐字填表、点发布、再回管理页核对 —— 全程没有一个
   * 真人在回路里。拟人节奏只能降低概率，压不住这个量级的暴露面。
   *
   * 所以改成「发布准备台」：我们把素材按小红书能直接吃的形态备齐
   * （文案纯文本一键复制 / 图片按顺序打包 / 创作中心一键打开），
   * 最后粘贴、传图、点发布由人在真身浏览器里完成。
   *
   * publishNote() 及 xhs/publish.ts 整体保留但不再被调用 —— 它是唯一
   * 经过实发验证的代码（笔记 6aca12cd000000001801a737），将来若调整策略
   * 还得靠它。verify-publish.js --live 也留着，但默认 dry run。
   */
  app.get('/api/publish/queue', async () => approvedDrafts());

  /**
   * 取一篇草稿的发布素材（准备台用）。
   *
   * 图片按 idx 顺序给出，且**复制前先按发布顺序重命名** ——
   * 小红书的图片上传框按文件名排序，直接给 card-<时间戳>-<随机>.jpg
   * 的顺序是乱的，人会传错图。所以打包时就落成 01.jpg / 02.jpg …
   */
  app.get('/api/publish/prep/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const draft = get<{ id: number; title: string; body: string; tags: string; rendered: number }>(
      'SELECT id, title, body, tags, rendered FROM drafts WHERE id = ?',
      id,
    );
    if (!draft) return { error: '草稿不存在' };

    const cards = all<{ idx: number; layout: string; image_path: string | null }>(
      'SELECT idx, layout, image_path FROM draft_cards WHERE draft_id = ? ORDER BY idx',
      id,
    );
    const images = cards
      .filter((c) => c.image_path)
      .map((c) => ({ idx: c.idx, layout: c.layout, image_path: c.image_path as string }));

    let tags: string[] = [];
    try {
      const arr = JSON.parse(draft.tags || '[]') as unknown;
      if (Array.isArray(arr)) tags = arr.map(String);
    } catch {
      /* 保持空 */
    }

    return {
      draft: {
        id: draft.id,
        title: draft.title,
        // 正文在**准备台这一侧**再洗一遍。
        //
        // 为什么不在生成端一劳永逸：pipeline.normalizeBody() 已经会剥掉尾部的
        // 话题标签，但历史草稿（2026-10-12 之前生成的）里有正文中间夹着
        // `#品牌营销[话题]#` 的形态 —— 那句紧贴着 CTA，正则没匹配上。
        // 发布台的正文是要用户直接粘贴出去的，带这种残留就是明显的机器痕迹，
        // 所以在这里兜底：不依赖语料/生成端何时修过。
        body: plainText(stripTopicTags(draft.body)),
        tags,
        rendered: Boolean(draft.rendered),
        imageCount: images.length,
      },
      images,
      creatorUrl: `${CREATOR_ORIGIN}/publish/publish?target=image`,
    };
  });

  /**
   * 把正文里的小红书话题标签洗成纯文本。
   *
   * 两种形态：
   *   1. `#话题[话题]#` —— 抓语料时从小红书 DOM 原样带下来的（页面把话题渲染成
   *      `<a class="tiptap-topic">#词<span class="content-hide">[话题]#</span></a>`）
   *   2. 独立成行的 `#话题 #话题`（作者的标签堆）
   *
   * 处理原则：**只删标签本身，不动它周围的文字和空行**。
   * 理由是这段文字用户会原样粘贴到小红书，段落结构得保留；
   * 而话题标签小红书自己会加（发布台单独给一份 tags 让用户手动加），
   * 正文里留着反而是脏的。
   */
  function stripTopicTags(body: string): string {
    return body
      // ① 任意位置（含行尾）的 `#词[话题]#`，连同它前面可能的空格
      .replace(/[ \t]*#[^\s#\n]{1,30}\[话题\]#/g, '')
      // ② 独立成行的标签堆（整行只有 #话题 #话题…）
      .replace(/^[ \t]*(#[^\s#\n]{1,30}[ \t]*){2,}$/gm, '')
      // 洗完之后可能留下连续空行，压回一个
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * 把一篇草稿的图片按发布顺序打成 zip。
   *
   * 条目名用 01.jpg / 02.jpg …，解压后按文件名排序就是发布顺序 ——
   * 用户解压后全选上传即可，不用记卡片顺序。
   */
  app.get('/api/publish/images/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const cards = all<{ idx: number; image_path: string | null }>(
      'SELECT idx, image_path FROM draft_cards WHERE draft_id = ? AND image_path IS NOT NULL ORDER BY idx',
      id,
    );
    if (cards.length === 0) {
      reply.code(400);
      return { error: '这篇草稿还没有渲染好的图片' };
    }

    const entries: ZipEntryInput[] = [];
    const missing: string[] = [];
    for (const [i, c] of cards.entries()) {
      try {
        entries.push({
          name: `${String(i + 1).padStart(2, '0')}.jpg`,
          data: await fsPromises.readFile(c.image_path as string),
          store: true,
        });
      } catch {
        missing.push(String(c.image_path));
      }
    }
    if (entries.length === 0) {
      reply.code(400);
      return { error: `图片文件都不在磁盘上了（${missing.slice(0, 2).join(', ')}），需要重新渲染` };
    }

    reply.header('Content-Type', 'application/zip');
    reply.header(
      'Content-Disposition',
      `attachment; filename="xhsflow-draft-${id}-images.zip"`,
    );
    return reply.send(createZip(entries));
  });

  /** 手动登记发布结果：填真实笔记链接，把草稿归档成 published。 */
  app.post('/api/publish/mark/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    const { url } = (req.body ?? {}) as { url?: string };
    const trimmed = (url ?? '').trim();
    if (!trimmed) {
      run("UPDATE drafts SET status='published', published_at=datetime('now'), updated_at=datetime('now') WHERE id=?", id);
      return { ok: true, note: '未填链接，已按已发布归档' };
    }
    // 只收小红书笔记链接；填错域名多半是复制到了别的东西
    if (!/^https?:\/\/(www\.)?xiaohongshu\.com\//.test(trimmed)) {
      return { error: '看起来不是小红书笔记链接（应为 https://www.xiaohongshu.com/explore/… ）' };
    }
    run(
      `UPDATE drafts SET status='published', published_url=?, published_at=datetime('now'),
         publish_error=NULL, updated_at=datetime('now') WHERE id=?`,
      trimmed,
      id,
    );
    return { ok: true };
  });

  /* ---------------- 语料库导入导出 ---------------- */

  // 导入走的是原始 zip 请求体。Fastify 默认只认 json/text，
  // 这里给 zip 挂一个 buffer 解析器（parseAs: 'buffer'）。
  // Windows 下有的浏览器/工具会把 zip 标成 x-zip-compressed，一并接住。
  for (const ctype of ['application/zip', 'application/x-zip-compressed', 'application/octet-stream']) {
    app.addContentTypeParser(ctype, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  }

  app.get('/api/corpus/export', async (req, reply) => {
    const q = req.query as { sourceId?: string };
    const sourceId = q.sourceId && q.sourceId !== 'all' ? Number(q.sourceId) : null;
    if (q.sourceId && q.sourceId !== 'all' && !Number.isFinite(sourceId)) {
      reply.code(400);
      return { error: `sourceId 无效：${q.sourceId}` };
    }

    try {
      const { buf, filename, summary } = await exportCorpusZip(sourceId);
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      reply.header('X-Export-Counts', JSON.stringify(summary.counts));
      return reply.send(buf);
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.post('/api/corpus/import', { bodyLimit: 1024 * 1024 * 1024 }, async (req, reply) => {
    const body = req.body as Buffer | string | undefined;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      reply.code(400);
      return { error: '请求体不是 zip 数据（应为 application/zip 的原始字节）' };
    }

    try {
      const summary = await importCorpusZip(body);
      return { ok: true, summary };
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  app.get('/api/corpus/overview', async () => {
    // 导出按钮上要先展示「会带走多少东西」，这个数字必须便宜地拿到
    const row = get<{ sources: number; notes: number; images: number; styles: number; topics: number }>(`
      SELECT
        (SELECT COUNT(*) FROM sources) AS sources,
        (SELECT COUNT(*) FROM notes) AS notes,
        (SELECT COUNT(*) FROM note_images) AS images,
        (SELECT COUNT(*) FROM note_styles) AS styles,
        (SELECT COUNT(*) FROM topics) AS topics
    `);
    return row ?? { sources: 0, notes: 0, images: 0, styles: 0, topics: 0 };
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