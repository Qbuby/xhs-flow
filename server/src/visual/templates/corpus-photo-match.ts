import { all } from '../../db/index.js';
import { titleSimilarity } from '../../util/text-sim.js';

/**
 * 配图选择 —— 从语料配图池里挑一张**与本卡内容相关**的图。
 *
 * 【为什么不再用免费图库】
 *
 * 原实现是让模型写一个中文检索词，去 Pexels / Pixabay / Unsplash / Wikimedia
 * 找图。那条路走出来的图有两个硬伤：
 *
 *   1. **与内容无关**：中文检索词经 `media/hints.ts` 的中英映射后落到
 *      极泛的英文词上（"品牌手册 白底 桌面" → "white desk notebook"），
 *      图库只能返回通用桌面照，跟论点毫无关系。
 *   2. **与账号风格不符**：这个账号的视觉语言是排版卡片，不是生活方式摄影。
 *      语料 736 页里内页 546 页只有 12 页有大面积实拍/案例图，其余是文字卡片。
 *      往里塞一张图库照，等于凭空给账号加了一种它没有的风格。
 *
 * 正确做法：**图来自语料本身**。原账号用的就是自己客户的案例图
 * （喜茶、劲牌、三九胃泰……），那才是这个账号该有的配图。
 * 语料配图池（visual/templates/corpus-photos.ts）已经把那些照片抠出来了，
 * 这里只负责「给这一卡挑哪一张」。
 *
 * 【怎么算「相关」】
 *
 * 池里的每张照片都知道自己来自**哪一篇语料**，而每篇语料都有标题与标签。
 * 所以相关度 = 这张照片的来源笔记与本卡内容的主题重合度。
 * 纯靠标题/标签的字符重合打分，不用模型 —— 选题与配图都需要确定性，
 * 可复现比聪明更重要。
 */

/** 语料配图（带来源笔记信息）。 */
export interface CorpusPhoto {
  id: number;
  noteId: number;
  pageIndex: number;
  file: string;
  tiles: number;
  /** 来源笔记标题 */
  noteTitle: string;
  /** 来源笔记标签 */
  noteTags: string[];
}

/** 读整个来源的配图池（按面积降序 —— 大图优先，它是更完整的案例图）。 */
export function corpusPhotoPool(sourceId: number): CorpusPhoto[] {
  const rows = all<{
    id: number;
    note_id: number;
    page_index: number;
    file: string;
    tiles: number;
    title: string;
    tags: string;
  }>(
    `SELECT cp.id, cp.note_id, cp.page_index, cp.file, cp.tiles,
            n.title AS title, n.tags AS tags
       FROM corpus_photos cp JOIN notes n ON n.id = cp.note_id
      WHERE cp.source_id = ?
      ORDER BY cp.tiles DESC`,
    sourceId,
  );
  return rows.map((r) => {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(r.tags || '[]');
      if (Array.isArray(parsed)) tags = parsed.map((t) => String(t));
    } catch {
      /* 坏 JSON 不该让配图池读不出来 */
    }
    return {
      id: r.id,
      noteId: r.note_id,
      pageIndex: r.page_index,
      file: r.file,
      tiles: r.tiles,
      noteTitle: r.title ?? '',
      noteTags: tags,
    };
  });
}

/** 去掉标点与空白，只留实词字符。 */
function normalize(s: string): string {
  return s.replace(/[\s，。？！、：；""''（）()《》【】·\-—…,.!?:;'"[\]{}]/g, '');
}

/**
 * 照片与文本的相关度。
 *
 * 来源笔记的标题与标签 vs 卡片文案。标题权重更高（标题就是命题）。
 * 标签按「取最相关的那一个」算，不取平均 —— 一个标签命中就是强信号，
 * 平均会被一堆无关标签稀释。
 */
function relevance(photo: CorpusPhoto, text: string): number {
  const titleScore = titleSimilarity(text, photo.noteTitle);
  const tagScore = photo.noteTags.length
    ? Math.max(...photo.noteTags.map((t) => titleSimilarity(text, t)))
    : 0;
  return titleScore * 0.7 + tagScore * 0.3;
}

/**
 * 为一张卡片挑配图。
 *
 * @param sourceId  来源
 * @param text      卡片内容（标题 + 要点），用来算相关度
 * @param exclude   已用过的照片 id，避免一篇里重复
 * @returns 照片文件路径；没有可用图返回 null
 */
export function pickCorpusPhoto(
  sourceId: number,
  text: string,
  exclude: number[] = [],
): string | null {
  const pool = corpusPhotoPool(sourceId).filter((p) => !exclude.includes(p.id));
  if (pool.length === 0) return null;

  let best: CorpusPhoto | null = null;
  let bestScore = 0;
  for (const p of pool) {
    const score = relevance(p, text);
    // 同分时面积大的优先（pool 已按 tiles 降序，遍历即自然实现）
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  // 没有明显相关（<0.12）就不硬塞 —— 与其配一张无关的图，
  // 不如让这一格走纯文字版式。语料里本来就有大量纯文字卡。
  if (!best || bestScore < 0.12) return null;
  return best.file;
}

/** 池里照片的来源笔记 id（去重后）—— 用于「这一稿参考了哪些语料图」。 */
export function photoSourceNotes(sourceId: number): number[] {
  return all<{ note_id: number }>(
    'SELECT DISTINCT note_id FROM corpus_photos WHERE source_id = ?',
    sourceId,
  ).map((r) => r.note_id);
}
