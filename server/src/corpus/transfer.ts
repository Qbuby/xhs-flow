import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { all, get, run, transaction, logEvent } from '../db/index.js';
import { MEDIA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { indexNoteFtsStatements } from '../db/fts.js';
import { createZip, readZip, safeEntryName, type ZipEntryInput } from '../util/zip.js';

/**
 * 语料库导入导出 —— 多设备迁移用。
 *
 * 【导出的是什么】
 * 语料库 = sources + notes + note_images + note_styles + style_profiles + topics
 * 六张表，外加笔记图片文件（data/media/corpus/**）。
 * 刻意**不含** drafts / draft_cards：那是生成产物不是语料，而且它们的
 * ref_note_ids 存的是本机笔记主键，跨设备语义不同，混进来会把
 * 「合并语义」搞复杂。要连草稿一起搬，直接拷 data/ 目录更干净。
 *
 * 【为什么图片要打进包里，且 local_path 不能信】
 * note_images.local_path 存的是**绝对路径**（抓取时图省事），换一台机器
 * 必然失效 —— 所以清单里不带 local_path，只带「包内文件名」；
 * 导入时按本机 MEDIA_DIR 重新落盘、重新写绝对路径。
 * 顺带解决历史遗留：磁盘上同时存在 corpus/<pk>/<idx>.jpg（现行）
 * 和 corpus/<pk>-<idx>.jpg（旧版）两种布局，导出时只认 DB 里的 local_path，
 * 不假设布局 —— 反正导入时统一落成现行的目录式。
 *
 * 【合并语义】
 * 按 profile_url / (source_id, note_id) 认「同一条」：
 * 已存在的一律跳过，只补缺 —— 导出是快照，导入是增量补充，
 * 不覆盖本机较新的数据。所以同一个包导两遍结果一致（幂等）。
 */

const FORMAT = 'xhsflow-corpus';
const VERSION = 1;
const MANIFEST_NAME = 'corpus.json';

type Row = Record<string, unknown>;

interface CorpusManifest {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  counts: Record<string, number>;
  sources: Row[];
  notes: Row[];
  noteImages: Row[];
  noteStyles: Row[];
  styleProfiles: Row[];
  topics: Row[];
}

export interface ExportSummary {
  fileCount: number;
  bytes: number;
  counts: Record<string, number>;
  /** 磁盘上找不到的图片数（DB 有记录但文件丢了） */
  missingFiles: number;
}

export interface ImportSummary {
  sourcesAdded: number;
  sourcesMerged: number;
  notesAdded: number;
  notesSkipped: number;
  imagesAdded: number;
  imagesSkipped: number;
  stylesAdded: number;
  stylesSkipped: number;
  profilesAdded: number;
  profilesSkipped: number;
  topicsAdded: number;
  topicsSkipped: number;
  filesWritten: number;
  /** 缺图片文件（导出方当时就没有） */
  imagesWithoutFile: number;
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param sourceId 只导这个语料源；null = 全部
 */
export async function exportCorpusZip(
  sourceId: number | null,
): Promise<{ buf: Buffer; filename: string; summary: ExportSummary }> {
  const sources = sourceId === null
    ? all<Row>('SELECT * FROM sources ORDER BY id')
    : all<Row>('SELECT * FROM sources WHERE id = ?', sourceId);
  const sourceIds = sources.map((s) => Number(s.id));

  if (sourceIds.length === 0) {
    throw new Error('没有可导出的语料源');
  }

  const ph = sourceIds.map(() => '?').join(',');
  const notes = all<Row>(
    `SELECT * FROM notes WHERE source_id IN (${ph}) ORDER BY id`,
    ...sourceIds,
  );
  const noteIds = notes.map((n) => Number(n.id));

  const noteImages = noteIds.length
    ? all<Row>(`SELECT * FROM note_images WHERE note_id IN (${noteIds.map(() => '?').join(',')}) ORDER BY note_id, idx`, ...noteIds)
    : [];
  const noteStyles = noteIds.length
    ? all<Row>(`SELECT * FROM note_styles WHERE note_id IN (${noteIds.map(() => '?').join(',')})`, ...noteIds)
    : [];
  const styleProfiles = all<Row>(`SELECT * FROM style_profiles WHERE source_id IN (${ph})`, ...sourceIds);
  const topics = all<Row>(`SELECT * FROM topics WHERE source_id IN (${ph}) ORDER BY id`, ...sourceIds);

  /* --- 图片：读进包里，local_path 换成包内文件名 --- */
  const entries: ZipEntryInput[] = [];
  const missingFiles: string[] = [];

  for (const img of noteImages) {
    const localPath = typeof img.local_path === 'string' ? img.local_path : null;
    delete img.local_path; // 绝对路径不出门 —— 换机器必失效
    if (!localPath) continue;

    const entryName = safeEntryName(
      'images',
      Number(img.note_id),
      `${Number(img.idx)}.jpg`,
    );
    try {
      const data = await fs.readFile(localPath);
      entries.push({ name: entryName, data, store: true }); // JPEG 已压缩，再压一遍纯浪费 CPU
      img.file = entryName;
    } catch {
      missingFiles.push(localPath);
    }
  }

  const manifest: CorpusManifest = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      sources: sources.length,
      notes: notes.length,
      noteImages: noteImages.length,
      noteStyles: noteStyles.length,
      styleProfiles: styleProfiles.length,
      topics: topics.length,
      imageFiles: entries.length,
    },
    sources,
    notes,
    noteImages,
    noteStyles,
    styleProfiles,
    topics,
  };

  entries.unshift({
    name: MANIFEST_NAME,
    data: Buffer.from(JSON.stringify(manifest), 'utf8'),
  });

  const buf = createZip(entries);
  const stamp = new Date().toISOString().slice(0, 10);
  const scope = sourceId === null ? 'all' : String(sourceId);
  const filename = `xhsflow-corpus-${scope}-${stamp}.zip`;

  logEvent('corpus', `导出语料库：${manifest.counts.sources} 个来源 / ${manifest.counts.notes} 篇笔记 / ${manifest.counts.imageFiles} 张图片（${(buf.length / 1024 / 1024).toFixed(1)} MB）`, {
    detail: { sourceId, ...manifest.counts, missingFiles: missingFiles.length, bytes: buf.length },
  });

  return {
    buf,
    filename,
    summary: {
      fileCount: entries.length,
      bytes: buf.length,
      counts: manifest.counts,
      missingFiles: missingFiles.length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

export async function importCorpusZip(buf: Buffer): Promise<ImportSummary> {
  let manifest: CorpusManifest;
  let files: Map<string, Buffer>;

  try {
    const entries = readZip(buf);
    files = new Map(entries.map((e) => [normalizeEntryName(e.name), e.data]));
    const raw = files.get(MANIFEST_NAME);
    if (!raw) throw new Error(`包里没有 ${MANIFEST_NAME}`);
    manifest = JSON.parse(raw.toString('utf8')) as CorpusManifest;
  } catch (err) {
    throw new Error(`解不开语料包：${err instanceof Error ? err.message : String(err)}`);
  }

  if (manifest.format !== FORMAT || manifest.version !== VERSION) {
    throw new Error(
      `不支持的语料包格式：${String(manifest.format)} v${String(manifest.version)}（本机支持 ${FORMAT} v${VERSION}）`,
    );
  }

  const s: ImportSummary = {
    sourcesAdded: 0, sourcesMerged: 0,
    notesAdded: 0, notesSkipped: 0,
    imagesAdded: 0, imagesSkipped: 0,
    stylesAdded: 0, stylesSkipped: 0,
    profilesAdded: 0, profilesSkipped: 0,
    topicsAdded: 0, topicsSkipped: 0,
    filesWritten: 0,
    imagesWithoutFile: 0,
  };

  /**
   * 先在一个事务里把行都写掉、把文件落盘，最后一起提交。
   * 文件写在提交之前 —— 万一写文件失败，回滚后顶多留下几个孤儿文件
   * （下次导入会覆盖），绝不会出现「DB 里有行、图却不存在」的半截状态。
   */
  transaction(() => {
    /* --- 1. 来源：按 profile_url 认同一条 --- */
    const sourceMap = new Map<number, number>();
    for (const src of manifest.sources) {
      const profileUrl = str(src.profile_url);
      const existing = get<{ id: number }>('SELECT id FROM sources WHERE profile_url = ?', profileUrl);
      if (existing) {
        sourceMap.set(num(src.id), existing.id);
        s.sourcesMerged++;
        continue;
      }
      const r = run(
        `INSERT INTO sources(profile_url, user_id, xsec_token, nickname, avatar_url, red_id,
           note_count, followers, status, last_error, last_scraped_at, available_count, auto_scrape)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        profileUrl,
        strOrNull(src.user_id),
        strOrNull(src.xsec_token),
        strOrNull(src.nickname),
        strOrNull(src.avatar_url),
        strOrNull(src.red_id),
        numOrZero(src.note_count),
        src.followers == null ? null : num(src.followers),
        str(src.status, 'active'),
        strOrNull(src.last_error),
        strOrNull(src.last_scraped_at),
        src.available_count == null ? null : num(src.available_count),
        numOrZero(src.auto_scrape),
      );
      sourceMap.set(num(src.id), Number(r.lastInsertRowid));
      s.sourcesAdded++;
    }

    /* --- 2. 笔记：按 (source_id, note_id) 认同一条 --- */
    const noteMap = new Map<number, { pk: number; fresh: boolean }>();
    for (const n of manifest.notes) {
      const sid = sourceMap.get(num(n.source_id));
      if (sid === undefined) {
        s.notesSkipped++;
        continue;
      }
      const existing = get<{ id: number }>(
        'SELECT id FROM notes WHERE source_id = ? AND note_id = ?',
        sid,
        str(n.note_id),
      );
      if (existing) {
        noteMap.set(num(n.id), { pk: existing.id, fresh: false });
        s.notesSkipped++;
        continue;
      }

      const r = run(
        `INSERT INTO notes(source_id, note_id, xsec_token, url, type, title, desc, tags, ip_location,
           published_at, liked_count, collected_count, comment_count, share_count, image_count, raw, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        sid,
        str(n.note_id),
        strOrNull(n.xsec_token),
        strOrNull(n.url),
        str(n.type, 'normal'),
        strOrNull(n.title),
        str(n.desc, ''),
        str(n.tags, '[]'),
        strOrNull(n.ip_location),
        n.published_at == null ? null : num(n.published_at),
        numOrZero(n.liked_count),
        numOrZero(n.collected_count),
        numOrZero(n.comment_count),
        numOrZero(n.share_count),
        numOrZero(n.image_count),
        strOrNull(n.raw),
        str(n.created_at, new Date().toISOString().slice(0, 19).replace('T', ' ')),
      );
      const pk = Number(r.lastInsertRowid);
      noteMap.set(num(n.id), { pk, fresh: true });
      s.notesAdded++;
      // 裸语句版：外面已经是导入的大事务，不能再开嵌套事务
      indexNoteFtsStatements(pk, str(n.title), str(n.desc), parseTags(n.tags));
    }

    /* --- 3. 图片：落盘 + 写行，路径全部按本机重算 --- */
    for (const img of manifest.noteImages) {
      const target = noteMap.get(num(img.note_id));
      if (!target || !target.fresh) {
        // 笔记本身是跳过的 → 图片也跳过（本机已有的不动）
        s.imagesSkipped++;
        continue;
      }
      const fileKey = typeof img.file === 'string' ? img.file : null;
      const data = fileKey ? files.get(fileKey) : undefined;

      const dest = path.join(MEDIA_DIR, 'corpus', String(target.pk), `${num(img.idx)}.jpg`);
      if (data) {
        // 事务回调用的是同步 fs —— transaction() 里面没法 await
        fsSync.mkdirSync(path.dirname(dest), { recursive: true });
        fsSync.writeFileSync(dest, data);
        s.filesWritten++;
      } else {
        s.imagesWithoutFile++;
      }

      run(
        `INSERT INTO note_images(note_id, idx, remote_url, local_path, width, height, bytes, sha256, palette, brightness, is_cover)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(note_id, idx) DO NOTHING`,
        target.pk,
        num(img.idx),
        strOrNull(img.remote_url),
        data ? dest : null,
        img.width == null ? null : num(img.width),
        img.height == null ? null : num(img.height),
        img.bytes == null ? null : num(img.bytes),
        strOrNull(img.sha256),
        strOrNull(img.palette),
        img.brightness == null ? null : Number(img.brightness),
        numOrZero(img.is_cover),
      );
      s.imagesAdded++;
    }

    /* --- 4. 单篇蒸馏：note_id 主键，跟着笔记走 --- */
    for (const st of manifest.noteStyles) {
      const target = noteMap.get(num(st.note_id));
      if (!target || !target.fresh) {
        s.stylesSkipped++;
        continue;
      }
      const r = run(
        `INSERT INTO note_styles(note_id, analysis, model, created_at) VALUES (?,?,?,?)
         ON CONFLICT(note_id) DO NOTHING`,
        target.pk,
        str(st.analysis, '{}'),
        strOrNull(st.model),
        str(st.created_at, new Date().toISOString().slice(0, 19).replace('T', ' ')),
      );
      if (r.changes > 0) s.stylesAdded++; else s.stylesSkipped++;
    }

    /* --- 5. 作者画像：source_id 主键；本机已有就保留本机的 --- */
    for (const p of manifest.styleProfiles) {
      const sid = sourceMap.get(num(p.source_id));
      if (sid === undefined) {
        s.profilesSkipped++;
        continue;
      }
      const r = run(
        `INSERT INTO style_profiles(source_id, profile, sample_count, model, created_at, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(source_id) DO NOTHING`,
        sid,
        str(p.profile, '{}'),
        numOrZero(p.sample_count),
        strOrNull(p.model),
        str(p.created_at, new Date().toISOString().slice(0, 19).replace('T', ' ')),
        new Date().toISOString().slice(0, 19).replace('T', ' '),
      );
      if (r.changes > 0) s.profilesAdded++; else s.profilesSkipped++;
    }

    /* --- 6. 选题：同来源同名跳过 --- */
    for (const t of manifest.topics) {
      const sid = sourceMap.get(num(t.source_id));
      if (sid === undefined) {
        s.topicsSkipped++;
        continue;
      }
      const dup = get<{ id: number }>(
        'SELECT id FROM topics WHERE source_id = ? AND title = ?',
        sid,
        str(t.title),
      );
      if (dup) {
        s.topicsSkipped++;
        continue;
      }
      run(
        `INSERT INTO topics(source_id, title, angle, brief, status, origin, used_at, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        sid,
        str(t.title),
        strOrNull(t.angle),
        strOrNull(t.brief),
        str(t.status, 'open'),
        str(t.origin, 'manual'),
        strOrNull(t.used_at),
        str(t.created_at, new Date().toISOString().slice(0, 19).replace('T', ' ')),
      );
      s.topicsAdded++;
    }
  });

  const summaryText =
    `导入语料库：来源 +${s.sourcesAdded}（合并 ${s.sourcesMerged}）· 笔记 +${s.notesAdded}（跳过 ${s.notesSkipped}）· ` +
    `图片 ${s.filesWritten} 张 · 蒸馏 +${s.stylesAdded} · 选题 +${s.topicsAdded}`;
  logger.info({ ...s }, '语料库导入完成');
  logEvent('corpus', summaryText, { detail: s });

  return s;
}

/** Windows 资源管理器压缩出来的包条目名会用 `\`，归一成 `/` 再对表。 */
function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/');
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

function strOrNull(v: unknown): string | null {
  return v == null || v === '' ? null : String(v);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrZero(v: unknown): number {
  return num(v);
}

function parseTags(raw: unknown): string[] {
  try {
    const arr = JSON.parse(str(raw, '[]')) as unknown;
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}
