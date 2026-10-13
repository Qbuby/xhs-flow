/**
 * 中文检索词 → 英文图库检索词。
 *
 * 为什么必须映射而不是直接透传：Pexels / Pixabay / Unsplash 都是**英文索引**
 * 的图库，把「秋天的第一杯奶茶」原样发给它们必然零结果。
 * 旧实现只有 23 个词条，表外查询直接 return keyword（即原样中文透传），
 * 等于 photo_text 版式在大多数选题上都会取不到图、静默退化成纯文字卡。
 *
 * 设计上有三条约束：
 *
 * 1. **每个映射只给一个概念**。拼成 "coffee latte cafe interior room design"
 *    这种六概念长句，在图库的 AND 语义下同样零结果（实测确实如此）。
 * 2. **表外查询不返回中文**。命中不了就走 generic 兜底词，宁可图不完全贴题，
 *    也不要必然空手而归 —— 空的 photo_text 卡比「图不太贴题」糟得多。
 * 3. **中文直接给 Wikimedia 是可以的**（MediaWiki 搜索支持中文），
 *    但它内容偏纪实，所以只作为最后一级降级，不在这里处理。
 */

/**
 * 领域词表。分两组：
 *  - 生活/场景类：给「厨房收纳」这类垂类语料用
 *  - 商业/设计类：给「品牌营销」这类语料用（本项目的第二个语料源就是这一类）
 */
const ZH_EN_HINTS: Record<string, string> = {
  /* ---- 生活 / 场景 ---- */
  咖啡: 'coffee cafe',
  奶茶: 'milk tea drink',
  茶: 'tea cup',
  早餐: 'breakfast table',
  美食: 'food dish',
  烘焙: 'baking bread',
  烹饪: 'cooking pan',
  厨房: 'kitchen counter',
  收纳: 'storage shelf',
  家居: 'home interior',
  家具: 'furniture living room',
  装修: 'home renovation',
  出租屋: 'small apartment',
  卧室: 'bedroom bed',
  客厅: 'living room sofa',
  阳台: 'balcony plants',
  植物: 'green plant leaves',
  花: 'flowers vase',
  宠物: 'cat dog pet',
  亲子: 'parent child family',
  穿搭: 'fashion outfit',
  衣橱: 'wardrobe clothes',
  美妆: 'makeup cosmetics',
  护肤: 'skincare bottle',
  香氛: 'perfume bottle',
  健身: 'fitness gym',
  瑜伽: 'yoga mat',
  运动: 'sports running',
  旅行: 'travel landscape',
  露营: 'camping tent',
  摄影: 'photography camera',
  音乐: 'music headphones',
  书: 'books reading',
  文具: 'stationery desk',
  数码: 'laptop technology',
  手机: 'smartphone device',
  电脑: 'computer desk',
  汽车: 'car interior',
  自行车: 'bicycle',
  手工: 'handmade craft',
  拼豆: 'colorful beads craft',

  /* ---- 商业 / 设计 ---- */
  品牌: 'brand identity design',
  营销: 'marketing strategy',
  广告: 'advertising billboard',
  创业: 'startup team',
  商业: 'business meeting',
  职场: 'office workspace',
  办公: 'office desk',
  会议: 'meeting room',
  设计: 'graphic design studio',
  包装: 'product packaging',
  电商: 'ecommerce product',
  零售: 'retail store',
  门店: 'storefront shop',
  直播间: 'live streaming setup',
  社群: 'community event',
  课程: 'online course',
  数据: 'data chart analytics',
  财务: 'finance documents',
  建筑: 'architecture building',
  空间: 'minimal interior',
  艺术: 'art gallery',
  展览: 'exhibition space',
  手作: 'craft workshop',
  服饰: 'clothing rack',
};

/**
 * 命中不了时的兜底词。
 *
 * 挑的是「放在任何品牌/生活类卡片上都不违和」的素材：干净桌面、纸张质感、
 * 极简空间。这类图在我们现在这套奶油底排版里几乎不会与文字打架。
 */
const GENERIC_FALLBACKS = [
  'minimal desk workspace',
  'texture paper background',
  'minimal interior neutral',
] as const;

export function isCjkHeavy(s: string): boolean {
  if (!s) return false;
  const cjk = s.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  return cjk / [...s].length > 0.3;
}

/**
 * 主入口：把模型给的中文/中英混合检索词转成一个**英文**图库查询串。
 *
 * 永远不会返回中文 —— 这是本函数的契约，也是修掉「中文透传导致必然零结果」的关键。
 */
export function toSearchHint(keyword: string): string {
  const raw = keyword.trim();
  if (!raw) return GENERIC_FALLBACKS[0];

  // 已经是英文的（模型有时直接给英文，或用户手填）就原样用。
  // ⚠️ 注意判定要用「非 ASCII 字符是否存在」，而不是旧实现那种
  // `replace(/[^\x00-\x7f]/g,'').length >= 6` —— 后者比较的是**剥掉非 ASCII 后
  // 的残渣长度**，只要查询里混了标点就会误判成英文原样透传。
  if (!isCjkHeavy(raw)) {
    const latin = raw.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
    if (latin.length >= 3) return latin;
  }

  // 取**最长**命中的词条：中文里「厨房收纳」比「厨房」更具体，长键优先更准。
  const hits = Object.entries(ZH_EN_HINTS)
    .filter(([zh]) => raw.includes(zh))
    .sort((a, b) => b[0].length - a[0].length);
  if (hits[0]) return hits[0][1];

  // 表外：绝不透传中文，走通用兜底。
  return GENERIC_FALLBACKS[hashPick(raw, GENERIC_FALLBACKS.length)] ?? GENERIC_FALLBACKS[0];
}

/** 稳定取模 —— 同一个查询词每次落到同一张兜底上，避免每次渲染换图。 */
function hashPick(s: string, mod: number): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % mod;
}

export const HINT_TABLE_SIZE = Object.keys(ZH_EN_HINTS).length;
