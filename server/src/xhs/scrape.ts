import { browser, XHS_ORIGIN } from './browser.js';
import {
  ENDPOINTS,
  noteUrl,
  parseProfileUrl,
  signedFetch,
  tryEndpoints,
  fetchHtml,
  takeEndpointFailures,
} from './api.js';
import {
  harvestNoteList,
  harvestedProfile,
  createNoteReader,
  toScrapedNote,
} from './scrape-browser.js';
import { logger } from '../logger.js';
import { logEvent, run, all, get, transaction } from '../db/index.js';
import { parseInitialState, extractTags } from '../util/text.js';
import { throttle } from '../util/throttle.js';
import { downloadImage } from '../media/download.js';
import sharp from 'sharp';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface ScrapedNote {
  noteId: string;
  xsecToken: string | null;
  url: string;
  type: string;
  title: string;
  desc: string;
  tags: string[];
  ipLocation: string | null;
  publishedAt: number | null;
  likedCount: number;
  collectedCount: number;
  commentCount: number;
  shareCount: number;
  images: string[];
  raw: unknown;
}

export interface ScrapeProgress {
  phase: string;
  done: number;
  total: number;
  noteId?: string;
}

export type ProgressFn = (p: ScrapeProgress) => void;

/* ------------------------------------------------------------------ */
/* 归一化：把各路数据的字段映射成统一形状                                */
/* ------------------------------------------------------------------ */

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 笔记详情在不同来源里有两种形态：
 *  - camelCase（XHS API 原样）：imageList / tagList / interactInfo.likeCount
 *  - snake_case（部分 SSR）：image_list / tags
 * 这里两种都吃。
 */
function normalizeNote(raw: Record<string, unknown>): ScrapedNote | null {
  const noteId =
    str(raw.noteId) ||
    str(raw.note_id) ||
    str(raw.id) ||
    str((raw.noteCard as Record<string, unknown> | undefined)?.noteId);
  if (!noteId) return null;

  const camel = raw as Record<string, any>;
  const imageList: unknown[] = camel.imageList ?? camel.image_list ?? [];
  const tagList: unknown[] = camel.tagList ?? camel.tags ?? [];
  const interact = (camel.interactInfo ?? camel.interact_info ?? {}) as Record<string, any>;

  const images = imageList
    .map((it) => {
      if (typeof it === 'string') return it;
      const o = it as Record<string, any>;
      // urlDefault 是大图，优先用
      return str(o.urlDefault) || str(o.url_default) || str(o.url) || str(o.urlPre) || str(o.url_pre);
    })
    .filter(Boolean);

  const desc = str(camel.desc) || str(camel.description);
  const tags = [
    ...new Set([
      ...tagList.map((t) => str((t as Record<string, any>)?.title ?? (t as Record<string, any>)?.name ?? t)),
      ...extractTags(desc),
      ...extractTags(str(camel.title)),
    ]),
  ].filter(Boolean);

  return {
    noteId,
    xsecToken: str(camel.xsecToken) || str(camel.xsec_token) || null,
    url: noteUrl(noteId, camel.xsecToken),
    type: str(camel.type) === 'video' ? 'video' : 'normal',
    title: str(camel.title),
    desc,
    tags,
    ipLocation: str(camel.ipLocation) || str(camel.ip_location) || null,
    publishedAt: num(camel.time) || num(camel.publishTime) || null,
    likedCount: num(interact.likeCount ?? interact.liked_count),
    collectedCount: num(interact.collectedCount ?? interact.collected_count),
    commentCount: num(interact.commentCount ?? interact.comment_count),
    shareCount: num(interact.shareCount ?? interact.share_count),
    images,
    raw,
  };
}

/* ------------------------------------------------------------------ */
/* 详情：三级降级                                                       */
/* ------------------------------------------------------------------ */

/** 详情失败的累积原因，供上层给出可操作的诊断。 */
const detailFailures: string[] = [];
function takeDetailFailures(): string[] {
  const out = [...new Set(detailFailures)];
  detailFailures.length = 0;
  return out;
}

async function fetchNoteDetail(noteId: string, xsecToken: string | null): Promise<ScrapedNote | null> {
  // 1) /feed（POST，带 xsec_source）
  const feed = await signedFetch<Record<string, any>>(ENDPOINTS.feed, {
    method: 'POST',
    body: {
      source_note_id: noteId,
      image_formats: 'jpg,webp,avif',
      extra: { need_body_topic: 1 },
      xsec_token: xsecToken ?? '',
    },
  }).catch((err) => {
    detailFailures.push(`feed 调用异常：${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  if (feed?.ok && feed.data) {
    const n = normalizeNote(feed.data);
    if (n) return { ...n, xsecToken: n.xsecToken ?? xsecToken };
  }
  if (feed && !feed.ok) detailFailures.push(`feed ${feed.error}`);

  // 2) /note/<id>
  const detail = await signedFetch<Record<string, any>>(`${ENDPOINTS.noteDetail}/${noteId}`, {
    params: { xsec_token: xsecToken ?? '', xsec_source: 'pc_search' },
  }).catch((err) => {
    detailFailures.push(`note 调用异常：${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  if (detail?.ok && detail.data) {
    const n = normalizeNote(detail.data);
    if (n) return { ...n, xsecToken: n.xsecToken ?? xsecToken };
  }
  if (detail && !detail.ok) detailFailures.push(`note ${detail.error}`);

  // 3) SSR 页面 __INITIAL_STATE__
  try {
    const html = await fetchHtml(noteUrl(noteId, xsecToken));
    if (html) {
      const state = parseInitialState(html);
      const n = (state?.note as Record<string, any>)?.noteDetailMap;
      const first = Array.isArray(n) ? n.find((x) => x?.note)?.note : undefined;
      const normalized = first ? normalizeNote(first) : null;
      if (normalized) return { ...normalized, xsecToken: normalized.xsecToken ?? xsecToken };
      detailFailures.push('SSR 页面里没有笔记数据（多半被风控替换成错误页了）');
    } else {
      detailFailures.push('SSR 页面取不到（HTTP 非 200）');
    }
  } catch (err) {
    detailFailures.push(`SSR 异常：${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 主页全量：多级降级                                                   */
/* ------------------------------------------------------------------ */

interface ListedNote {
  noteId: string;
  xsecToken: string | null;
}

async function listNotesViaApi(
  userId: string,
  firstToken: string | null,
  max: number,
  onProgress: ProgressFn,
): Promise<ListedNote[] | null> {
  const out: ListedNote[] = [];
  let cursor = '';
  let token = firstToken;

  for (let page = 0; page < 40 && out.length < max; page++) {
    const hit = await tryEndpoints<Record<string, any>>(
      [ENDPOINTS.userPostedA, ENDPOINTS.userPostedB],
      {
        params: {
          num: '30',
          cursor,
          user_id: userId,
          image_formats: 'jpg,webp,avif',
          ...(token ? { xsec_token: token } : {}),
        },
      },
    );

    if (!hit) {
      logEvent('fallback', `分页第 ${page + 1} 页失败：两套端点均不可用`, { severity: 'warn' });
      return out.length > 0 ? out : null;
    }

    const data = hit.result.data as Record<string, any>;
    const items: any[] = data.notes ?? data.noteCards ?? data.items ?? [];

    for (const it of items) {
      const id = str(it?.noteCard?.noteId) || str(it?.noteId) || str(it?.id);
      if (!id) continue;
      out.push({ noteId: id, xsecToken: it?.xsecToken ?? it?.xsec_token ?? token ?? null });
      // 列表接口给的 token 才是笔记详情能用的那个，抓下来
      if (it?.xsecToken) token = it.xsecToken;
    }

    onProgress({ phase: 'list', done: out.length, total: max });

    const hasMore = Boolean(data.hasMore ?? data.has_more);
    cursor = str(data.cursor) || str(data.next_cursor);
    if (!hasMore || !cursor) break;
    await throttle();
  }

  return out;
}

async function listNotesViaSsr(userId: string): Promise<ListedNote[] | null> {
  const html = await fetchHtml(`${XHS_ORIGIN}/user/profile/${userId}`);
  if (!html) return null;
  const state = parseInitialState(html);
  if (!state) return null;

  const user = state.user as Record<string, any> | undefined;
  const notes = (user?.notes as any[]) ?? [];
  const out: ListedNote[] = [];
  for (const n of notes) {
    const card = n?.noteCard ?? n;
    const id = str(card?.noteId) || str(card?.id);
    if (id) out.push({ noteId: id, xsecToken: card?.xsecToken ?? null });
  }
  return out.length > 0 ? out : null;
}

async function listNotesViaDomScroll(userId: string, max: number): Promise<ListedNote[] | null> {
  // 最后的兜底：真的滚动页面，从渲染出来的卡片里读
  return browser.withPage(async (page) => {
    await page.goto(`${XHS_ORIGIN}/user/profile/${userId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForTimeout(3000);

    const seen = new Map<string, string | null>();
    let stagnant = 0;

    for (let round = 0; round < 30 && seen.size < max; round++) {
      const batch = (await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="/explore/"]')).map((a) => {
          const href = (a as HTMLAnchorElement).getAttribute('href') ?? '';
          const m = /\/explore\/([0-9a-f]{16,32})/.exec(href);
          if (!m?.[1]) return null;
          const u = new URL(href, location.origin);
          return { noteId: m[1], xsecToken: u.searchParams.get('xsec_token') };
        }),
      )) as Array<{ noteId: string; xsecToken: string | null } | null>;

      let added = 0;
      for (const b of batch) {
        if (b && !seen.has(b.noteId)) {
          seen.set(b.noteId, b.xsecToken);
          added++;
        }
      }

      if (added === 0) {
        if (++stagnant >= 3) break;
      } else {
        stagnant = 0;
      }

      await page.mouse.wheel(0, 2400);
      await page.waitForTimeout(1200 + Math.random() * 800);
      await throttle();
    }

    if (seen.size === 0) return null;
    return [...seen.entries()].map(([noteId, xsecToken]) => ({ noteId, xsecToken }));
  });
}

/* ------------------------------------------------------------------ */
/* 入库                                                                */
/* ------------------------------------------------------------------ */

function upsertSource(profileUrl: string, patch: Partial<Record<string, unknown>>): number {
  const existing = get<{ id: number }>('SELECT id FROM sources WHERE profile_url = ?', profileUrl);
  if (existing) {
    const keys = Object.keys(patch);
    if (keys.length) {
      run(
        `UPDATE sources SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        ...keys.map((k) => patch[k]),
        existing.id,
      );
    }
    return existing.id;
  }
  const r = run('INSERT INTO sources(profile_url) VALUES (?)', profileUrl);
  return Number(r.lastInsertRowid);
}

async function storeNoteImages(notePk: number, images: string[]): Promise<void> {
  const { MEDIA_DIR } = await import('../config.js');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');

  const outDir = path.join(MEDIA_DIR, 'corpus', String(notePk));
  await fs.mkdir(outDir, { recursive: true });

  // 并行下载：每篇 3 张图串行是 3 个来回，并行后基本一波拉完
  await Promise.all(images.map((url, idx) => downloadOne(notePk, idx, url)));

  async function downloadOne(pk: number, idx: number, url: string): Promise<void> {
    const inserted = run(
      `INSERT INTO note_images(note_id, idx, remote_url, is_cover) VALUES (?, ?, ?, ?)
       ON CONFLICT(note_id, idx) DO NOTHING`,
      pk,
      idx,
      url,
      idx === 0 ? 1 : 0,
    );
    if (inserted.changes === 0) return; // 已经下过了

    try {
      const raw = await downloadImage(url);
      const buf = await sharp(raw)
        .resize(1080, 1440, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer();

      const file = path.join(outDir, `${idx}.jpg`);
      await fs.writeFile(file, buf);

      const info = await sharp(buf).metadata();
      const stats = await sharp(buf).stats();
      const bright = stats.channels.map((c) => c.mean).reduce((a, b) => a + b, 0) / 255 / 3;

      run(
        `UPDATE note_images SET local_path = ?, width = ?, height = ?, bytes = ?, sha256 = ?,
           palette = ?, brightness = ? WHERE note_id = ? AND idx = ?`,
        file,
        info.width ?? 1080,
        info.height ?? 1440,
        buf.length,
        createHash('sha256').update(buf).digest('hex'),
        JSON.stringify(await extractPalette(buf)),
        bright,
        pk,
        idx,
      );
    } catch (err) {
      logger.debug({ err, url }, '笔记图片下载失败，跳过');
    }
  }
}


/** 用 sharp 取主色板 —— 不依赖 LLM 看图，快且零 token。 */
async function extractPalette(buf: Buffer): Promise<Array<{ hex: string; weight: number }>> {
  try {
    const { data } = await sharp(buf)
      .resize(64, 64, { fit: 'cover' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const buckets = new Map<number, number>();
    for (let i = 0; i < data.length; i += 3) {
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      // 粗量化到 5bit，抵抗压缩噪声
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const total = [...buckets.values()].reduce((a, b) => a + b, 0) || 1;
    return [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, weight]) => ({
        hex: '#' + key.toString(16).padStart(6, '0').toUpperCase(),
        weight: Number((weight / total).toFixed(3)),
      }));
  } catch {
    return [];
  }
}

function indexNoteFts(notePk: number, title: string, desc: string, tags: string[]): void {
  transaction(() => {
    run('DELETE FROM notes_fts WHERE rowid = ?', notePk);
    run('DELETE FROM notes_fts_map WHERE rowid = ?', notePk);
    run(
      'INSERT INTO notes_fts(rowid, title, desc, tags) VALUES (?, ?, ?, ?)',
      notePk,
      title,
      desc,
      tags.join(' '),
    );
    run('INSERT INTO notes_fts_map(rowid, note_pk) VALUES (?, ?)', notePk, notePk);
  });
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

export interface ScrapeOptions {
  profileUrl: string;
  maxNotes?: number;
  downloadImages?: boolean;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
}

export interface ScrapeResult {
  sourceId: number;
  listed: number;
  stored: number;
  skipped: number;
  via: string[];
}

export async function scrapeAuthor(opts: ScrapeOptions): Promise<ScrapeResult> {
  const { profileUrl, maxNotes = 200, downloadImages = true, onProgress = () => {}, signal } = opts;

  const sourceId = upsertSource(profileUrl, { status: 'scraping' });
  const { userId: urlUserId, xsecToken } = parseProfileUrl(profileUrl);
  if (!urlUserId) {
    run("UPDATE sources SET status='error', last_error=? WHERE id=?", '链接里解析不出 user_id', sourceId);
    throw new Error('链接里解析不出 user_id，请确认是完整的主页链接（含 /user/profile/<id>）');
  }

  const usedVia: string[] = [];
  onProgress({ phase: 'profile', done: 0, total: maxNotes });

  /* --- 1. 拿作者基本信息，顺便确认 user_id --- */
  let userId = urlUserId;
  const profile = await signedFetch<Record<string, any>>(ENDPOINTS.userProfile, {
    params: { user_id: urlUserId, ...(xsecToken ? { xsec_token: xsecToken } : {}) },
  }).catch(() => null);

  if (profile?.ok && profile.data) {
    const d = profile.data as Record<string, any>;
    const basic = (d.basic_info ?? d) as Record<string, any>;
    run(
      `UPDATE sources SET user_id = ?, nickname = ?, avatar_url = ?, red_id = ?, followers = ?, updated_at = datetime('now') WHERE id = ?`,
      str(basic.redId) || userId,
      str(basic.nickname),
      str(basic.imageb) || str(basic.images),
      str(basic.redId),
      num(basic.fans),
      sourceId,
    );
    userId = str(basic.redId) || urlUserId;
    usedVia.push('signed-api:user');
  } else {
    run("UPDATE sources SET user_id = ?, updated_at = datetime('now') WHERE id = ?", userId, sourceId);
    logEvent('fallback', '作者信息接口不可用（签名被拒），改用页面采集', { severity: 'info' });
  }

  /* --- 2. 列出全部笔记 ---
   *
   * 优先走「让页面自己请求、我们只读响应」：实测同一个端点、同一份登录态、
   * 同一个浏览器，页面自己发 success=true notes=30，我们自己发就是 300011。
   * 小红书明显在区分「谁发的请求」，那就别跟签名较劲，让页面像真人一样去拉。
   */
  let listed: ListedNote[] | null = null;
  const attempts: string[] = [];

  try {
    const harvested = await harvestNoteList(userId, maxNotes, (n) =>
      onProgress({ phase: 'list', done: n, total: maxNotes }),
    );
    listed = harvested.map((h) => ({ noteId: h.noteId, xsecToken: h.xsecToken }));
    usedVia.push('browser:harvest');

    // 作者资料也从页面响应里顺带采一份 —— 直接调 API 那条路会被签名拒掉
    const hp = harvestedProfile();
    if (hp.nickname || hp.redId) {
      run(
        `UPDATE sources SET nickname = COALESCE(?, nickname), avatar_url = COALESCE(?, avatar_url),
           red_id = COALESCE(?, red_id), user_id = COALESCE(?, user_id), updated_at = datetime('now')
         WHERE id = ?`,
        hp.nickname,
        hp.avatar,
        hp.redId,
        hp.redId,
        sourceId,
      );
    }
  } catch (err) {
    attempts.push(`页面采集失败：${err instanceof Error ? err.message : String(err)}`);
    logEvent('fallback', '页面采集不可用，降级到直接调 API', { severity: 'warn' });
  }

  if (!listed || listed.length === 0) {
    const viaApi = await listNotesViaApi(userId, xsecToken, maxNotes, onProgress).catch((err) => {
      attempts.push(`签名 API 抛错：${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (viaApi && viaApi.length > 0) {
      listed = viaApi;
      usedVia.push('signed-api:user_posted');
    } else {
      attempts.push(...takeEndpointFailures());
      logEvent('fallback', '笔记列表 API 不可用，降级到 SSR 页面解析', { severity: 'warn' });

      const viaSsr = await listNotesViaSsr(userId).catch((err) => {
        attempts.push(`SSR 抛错：${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      if (viaSsr && viaSsr.length > 0) {
        listed = viaSsr;
        usedVia.push('ssr:initial-state');
      } else {
        attempts.push('SSR 页面里没找到作品列表（可能被风控替换成错误页）');
        logEvent('fallback', 'SSR 也没拿到作品列表，降级到滚动页面', { severity: 'warn' });

        const viaDom = await listNotesViaDomScroll(userId, maxNotes).catch((err) => {
          attempts.push(`滚动抛错：${err instanceof Error ? err.message : String(err)}`);
          return null;
        });
        if (viaDom && viaDom.length > 0) {
          listed = viaDom;
          usedVia.push('dom:scroll');
        } else {
          attempts.push('页面滚动后仍未渲染出作品卡片');
        }
      }
    }
  }

  if (!listed || listed.length === 0) {
    // 把真实原因顶到最前面 —— 风控一眼可见，而不是只丢一句「降级失败」
    const reason = attempts.length ? attempts.join("；") : "未知原因";
    logEvent('error', `抓取失败：${reason}`, {
      severity: 'error',
      detail: { sourceId, attempts },
    });
    run(
      "UPDATE sources SET status='error', last_error=?, updated_at=datetime('now') WHERE id=?",
      `抓取失败 —— ${reason}`,
      sourceId,
    );
    throw new Error(`抓不到作品列表。实际原因：${reason}`);
  }

  const target = listed.slice(0, maxNotes);
  logger.info({ sourceId, listed: target.length }, '开始逐篇抓取');

  /* --- 3. 逐篇抓详情 + 下载图片 --- */
  let stored = 0;
  let skipped = 0;
  let consecutiveDetailFailures = 0;

  // 标签页常驻复用，不再一篇一个
  const reader = await createNoteReader();

  for (const [i, item] of target.entries()) {
    if (signal?.aborted) break;

    const already = get<{ id: number }>(
      'SELECT id FROM notes WHERE source_id = ? AND note_id = ?',
      sourceId,
      item.noteId,
    );
    if (already) {
      skipped++;
      onProgress({ phase: 'detail', done: i + 1, total: target.length, noteId: item.noteId });
      continue;
    }

    onProgress({ phase: 'detail', done: i + 1, total: target.length, noteId: item.noteId });

    // 优先用浏览器读页面（和列表同一个思路：页面能过的，我们就能过）
    let note = await reader
      .read(item.noteId, item.xsecToken)
      .then((dom) => (dom ? toScrapedNote({ noteId: item.noteId, xsecToken: item.xsecToken }, dom) : null))
      .catch(() => null);

    // 读不到再退回签名 API
    if (!note) {
      note = await fetchNoteDetail(item.noteId, item.xsecToken).catch(() => null);
    }

    // 连续多篇拿不到内容，说明不是偶发问题，而是账号/风控层面的整体封锁。
    // 此时继续往下跑毫无意义 —— 每篇要走 3 条降级、每次都要过节流，
    // 30 篇能白耗十分钟。撞够阈值就立刻停，并把真实原因报上去。
    if (!note) {
      skipped++;
      consecutiveDetailFailures++;
      if (consecutiveDetailFailures >= 4) {
        const reasons = takeDetailFailures();
        const reason = reasons.length
          ? reasons.slice(0, 4).join('；')
          : '所有降级路径都没拿到内容';
        const msg =
          `连续 ${consecutiveDetailFailures} 篇笔记全部取不到内容，已中止抓取。` +
          `典型原因：账号被风控（300011）或签名失效。实际返回：${reason}`;
        logEvent('error', msg, { severity: 'error', detail: { sourceId, reasons } });
        run(
          "UPDATE sources SET status='error', last_error=?, updated_at=datetime('now') WHERE id=?",
          msg,
          sourceId,
        );
        throw new Error(msg);
      }
      continue;
    }

    consecutiveDetailFailures = 0;

    // 只要图文，视频笔记对这个项目没有意义
    if (note.type === 'video' && note.images.length === 0) {
      skipped++;
      continue;
    }

    const ins = run(
      `INSERT INTO notes(source_id, note_id, xsec_token, url, type, title, desc, tags, ip_location,
         published_at, liked_count, collected_count, comment_count, share_count, image_count, raw)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(source_id, note_id) DO NOTHING`,
      sourceId,
      note.noteId,
      note.xsecToken ?? item.xsecToken,
      note.url,
      note.type,
      note.title,
      note.desc,
      JSON.stringify(note.tags),
      note.ipLocation,
      note.publishedAt,
      note.likedCount,
      note.collectedCount,
      note.commentCount,
      note.shareCount,
      note.images.length,
      JSON.stringify(note.raw).slice(0, 400_000),
    );

    if (ins.changes === 0) {
      skipped++;
      continue;
    }

    const notePk = Number(ins.lastInsertRowid);
    indexNoteFts(notePk, note.title, note.desc, note.tags);

    if (downloadImages && note.images.length > 0) {
      await storeNoteImages(notePk, note.images).catch((err) =>
        logger.debug({ err }, '图片入库失败'),
      );
    }

    stored++;
    onProgress({ phase: 'detail', done: i + 1, total: target.length, noteId: note.noteId });
  }

  await reader.close().catch(() => undefined);

  const count = get<{ c: number }>('SELECT COUNT(*) AS c FROM notes WHERE source_id = ?', sourceId);
  run(
    `UPDATE sources SET status='active', last_error=NULL, note_count=?, last_scraped_at=datetime('now'), updated_at=datetime('now') WHERE id=?`,
    count?.c ?? 0,
    sourceId,
  );

  logger.info({ sourceId, stored, skipped, via: usedVia }, '抓取完成');
  return { sourceId, listed: target.length, stored, skipped, via: usedVia };
}

/** 列出所有语料源。 */
export function listSources(): unknown[] {
  return all(`
    SELECT s.*,
           (SELECT COUNT(*) FROM note_styles WHERE note_id IN (SELECT id FROM notes WHERE source_id = s.id)) AS styled
    FROM sources s ORDER BY s.id DESC
  `);
}