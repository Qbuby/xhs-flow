import { all } from '../db/index.js';

/**
 * 语料检索。
 *
 * 用 FTS5 的 trigram 分词器 —— 必须是 trigram：默认的 unicode61 不切分 CJK，
 * 会把一整段中文当成一个 token，检索基本等于失效。
 * trigram 按 3 字窗口索引，中文子串匹配就能正常工作。
 *
 * 有意不引入 embedding 模型：我们的检索目标是"找同风格/同题材的样稿"，
 * 这是关键词匹配问题，不是稠密语义问题。几百条量级下，
 * trigram + 标签重合度打分比拉 300MB 的 ONNX 运行时又快又准。
 */

export interface RetrievedNote {
  notePk: number;
  title: string;
  desc: string;
  tags: string[];
  likedCount: number;
  analysis: unknown;
  score: number;
  matchedBy: string;
}

/** FTS5 查询串要转义，双引号包裹是最省事的做法。 */
function ftsQuery(raw: string): string {
  const cleaned = raw.replace(/["'^*()]/g, ' ').trim();
  if (!cleaned) return '';
  return `"${cleaned}"`;
}

/**
 * 按关键词检索语料。
 * @param query    选题关键词或短语
 * @param sourceId 限定某个作者的语料
 * @param limit    返回条数
 */
export function retrieveNotes(query: string, sourceId: number, limit = 5): RetrievedNote[] {
  const q = ftsQuery(query);
  if (!q) return [];

  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = all(
      `SELECT m.note_pk AS note_pk, bm25(notes_fts) AS rank
       FROM notes_fts
       JOIN notes_fts_map m ON m.rowid = notes_fts.rowid
       JOIN notes n ON n.id = m.note_pk
       WHERE notes_fts MATCH ? AND n.source_id = ?
       ORDER BY rank
       LIMIT ?`,
      q,
      sourceId,
      limit * 4,
    );
  } catch {
    // trigram 索引对少于 3 字的查询会报错，这里静默降级
    return [];
  }

  if (rows.length === 0) return [];

  const pks = rows.map((r) => Number(r.note_pk));
  const details = all<{
    id: number;
    title: string;
    desc: string;
    tags: string;
    liked_count: number;
    analysis: string | null;
    rank: number | null;
  }>(
    `SELECT n.id, n.title, n.desc, n.tags, n.liked_count, ns.analysis,
            (SELECT rank FROM (SELECT 1) WHERE 0) AS rank
     FROM notes n
     LEFT JOIN note_styles ns ON ns.note_id = n.id
     WHERE n.id IN (${pks.map(() => '?').join(',')})`,
    ...pks,
  );

  const rankMap = new Map(rows.map((r) => [Number(r.note_pk), Number(r.rank)]));
  const queryChars = new Set(query.replace(/\s/g, '').split(''));

  const scored = details.map((d) => {
    // bm25 越小越相关；翻成正向分数
    const bm25 = rankMap.get(d.id) ?? 0;
    let score = 1 / (1 + Math.max(0, bm25));

    // 标签重合加成
    const tags: string[] = JSON.parse(d.tags || '[]');
    const overlap = tags.filter((t) => queryChars.has(t[0] ?? '')).length;
    score += overlap * 0.15;

    // 互动量轻微加权 —— 高互动样稿更值得模仿
    score += Math.min(0.3, Math.log10(d.liked_count + 1) * 0.12);

    let analysis: unknown = undefined;
    try {
      analysis = d.analysis ? JSON.parse(d.analysis) : undefined;
    } catch {
      /* 标注坏了就当没有 */
    }

    return {
      notePk: d.id,
      title: d.title,
      desc: d.desc,
      tags,
      likedCount: d.liked_count,
      analysis,
      score: Number(score.toFixed(4)),
      matchedBy: `bm25=${bm25.toFixed(3)}`,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * 兜底检索：FTS 没命中时按互动量取头部样稿。
 * 生成环节至少需要 few-shot 参考，不能因为关键词没交集就空手而归。
 */
export function topNotes(sourceId: number, limit = 5): RetrievedNote[] {
  const rows = all<{
    id: number;
    title: string;
    desc: string;
    tags: string;
    liked_count: number;
    analysis: string | null;
  }>(
    `SELECT n.id, n.title, n.desc, n.tags, n.liked_count, ns.analysis
     FROM notes n LEFT JOIN note_styles ns ON ns.note_id = n.id
     WHERE n.source_id = ? AND ns.analysis IS NOT NULL
     ORDER BY n.liked_count DESC, n.collected_count DESC
     LIMIT ?`,
    sourceId,
    limit,
  );

  return rows.map((d, i) => {
    let analysis: unknown;
    try {
      analysis = d.analysis ? JSON.parse(d.analysis) : undefined;
    } catch {
      analysis = undefined;
    }
    return {
      notePk: d.id,
      title: d.title,
      desc: d.desc,
      tags: JSON.parse(d.tags || '[]'),
      likedCount: d.liked_count,
      analysis,
      score: 1 - i * 0.01,
      matchedBy: 'top-engagement',
    };
  });
}

/** 检索失败时自动降级，保证一定有参考样稿。 */
export function retrieveWithFallback(query: string, sourceId: number, limit = 5): RetrievedNote[] {
  const primary = retrieveNotes(query, sourceId, limit);
  if (primary.length >= 2) return primary;

  const seen = new Set(primary.map((n) => n.notePk));
  const extra = topNotes(sourceId, limit).filter((n) => !seen.has(n.notePk));
  return [...primary, ...extra].slice(0, limit);
}

/** 画像里的选题地图，用于自动找选题。 */
export function topicMap(sourceId: number): Array<{ topic: string; count: number }> {
  const rows = all<{ tags: string }>('SELECT tags FROM notes WHERE source_id = ?', sourceId);
  const counter = new Map<string, number>();
  for (const r of rows) {
    let tags: string[] = [];
    try {
      tags = JSON.parse(r.tags || '[]');
    } catch {
      continue;
    }
    for (const t of tags) counter.set(t, (counter.get(t) ?? 0) + 1);
  }
  return [...counter.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);
}