/**
 * 标题/文本的近似度。
 *
 * 【为什么需要】
 *
 * 「每篇都很雷同」不只表现在版式上，也表现在**选题**上。
 * 实测成稿里出现过：
 *   - 「主理人IP和品牌IP先做哪个」/「主理人IP和品牌IP，先做哪个？」
 *     —— 完全相同，只是标点不同
 *   - 「为什么出圈的新品牌，都不太像品牌」/「为什么出圈的品牌，都不太像品牌了」
 *     —— 二元组相似度 0.73
 *
 * 精确判重（Set.has）拦不住这些，所以需要近似度。
 */

/** 近似阈值。实测语料内部最高 0.26、成稿之间可达 1.00，取中间。 */
export const TITLE_NEAR_DUP_THRESHOLD = 0.62;

/** 去掉标点与空白，只留实词字符。 */
export function normalizeText(s: string): string {
  return s.replace(
    /[\s，。？！、：；""''（）()《》【】·\-—…,.!?:;'"[\]{}]/g,
    '',
  );
}

/** 二元字组集合（中文按 2 字切，不需要分词器）。 */
export function bigrams(s: string): Set<string> {
  const t = normalizeText(s);
  const out = new Set<string>();
  if (t.length === 0) return out;
  if (t.length === 1) {
    out.add(t);
    return out;
  }
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** Jaccard 相似度（0..1）。 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 两段文本的近似度。 */
export function titleSimilarity(a: string, b: string): number {
  return jaccard(bigrams(a), bigrams(b));
}
