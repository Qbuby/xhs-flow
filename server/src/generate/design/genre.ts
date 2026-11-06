import { all } from '../../db/index.js';

/**
 * 体裁（genre）—— 一篇笔记"在干什么"，与"写什么题材"是两个维度。
 *
 * 【为什么需要这一层：雷同的真正来源不是版式，是体裁】
 *
 * 上一轮已经修掉了「每篇版式序列都一样」，实测 12 份计划能产出 12 种。
 * 但成稿读起来仍然雷同 —— 因为版式变了，**文体没变**。
 *
 * 实测 136 篇成稿 vs 118 篇语料（按标题判体裁）：
 *
 *   体裁        语料占比   成稿占比    偏离
 *   教程/SOP      19%       10%      -9pt   ← 语料有，成稿几乎没有
 *   概念辨析       13%        1%     -12pt   ← 几乎消失
 *   趋势断言       11%        4%      -7pt   ← 几乎消失
 *   现象归因       14%       45%     +31pt   ← 严重超配
 *
 * 也就是说：博主写的是「教程 / 辨析 / 趋势 / 复盘」的混合体，
 * 我们把它写成了 45% 都是「为什么 XX 会 YY」的单一体裁。
 *
 * 【根因是蒸馏 + 提示词，两处叠加】
 *
 *  1. **蒸馏把 118 篇压成了一份画像。** 每篇的 `structure.pattern`
 *     （如「误区→四模块→行动建议」「合集案例→归纳→趋势」）在聚合时
 *     被抹平成一句 `opening_patterns` + 一个 `tone` 数组。体裁信息丢失。
 *  2. **提示词主动压制了其它体裁。** `IDEATE_SYSTEM` 里写着
 *     「用提问或判断句，不写陈述式标题」「讲判断和方法，不讲操作步骤」——
 *     这两句直接否掉了教程、清单、趋势三类（语料合计 30%）。
 *
 * 所以这一层做两件事：
 *   - 从语料**逐篇**识别体裁，统计真实分布（不经过画像压缩）
 *   - 按这个分布给每篇新稿分配体裁，并让选题提示词按体裁写标题
 */

/** 体裁标识。 */
export type Genre =
  | 'tutorial'   // 教程 / SOP / 流程
  | 'concept'    // 概念辨析（是什么 / 区别 / 本质）
  | 'trend'      // 趋势断言（正在 / 越来越 / 未来）
  | 'casestudy'  // 单案深拆（某个品牌做对了什么）
  | 'roundup'    // 合集盘点（N 个案例）
  | 'checklist'  // 清单（这几件事 / 这 N 点）
  | 'why'        // 现象归因（为什么 XX 会 YY）
  | 'thesis';    // 观点断言（不解释为什么，直接给判断）

/** 每个体裁的：中文名、标题写法、正文要求。 */
export interface GenreSpec {
  genre: Genre;
  name: string;
  /** 喂给选题模型：这个体裁的标题长什么样 */
  titleGuide: string;
  /** 喂给创作模型：正文该怎么组织 */
  bodyGuide: string;
  /** 语料里的真实例子（会自动从 DB 填） */
  examples: string[];
}

export const GENRE_SPECS: Record<Genre, Omit<GenreSpec, 'examples'>> = {
  tutorial: {
    genre: 'tutorial',
    name: '教程/SOP',
    titleGuide:
      '动作主张 + 交付承诺。例：「品牌手册怎么写，一篇讲清楚」「品牌全案5个固定步骤，顺序真的不能乱」',
    bodyGuide:
      '按步骤讲清"怎么做"，每步给可执行的动作和判断标准。允许出现编号（01/02/03）。' +
      '不要只讲"为什么要做"，要能让人照着做。',
  },
  concept: {
    genre: 'concept',
    name: '概念辨析',
    titleGuide:
      '概念词 + 追问 / 区别。例：「经常说的品牌调性到底是什么？」「品牌和营销，根本不是一回事」',
    bodyGuide:
      '把两个容易混淆的概念摆开，给出边界与判据。结构多为：设问→纠偏→定义→要素→差异。' +
      '重点在"分清楚"，不在"教你做"。',
  },
  trend: {
    genre: 'trend',
    name: '趋势断言',
    titleGuide:
      '时间/变化词 + 断言。例：「全民进入"过日子"时代，品牌还在卷高级感」「江浙沪制造业，正在集体补上"品牌课"」',
    bodyGuide:
      '先给出趋势判断，再用现象与数据支撑，最后说对谁有用、该做什么。' +
      '要敢下判断，不要只说"值得关注"。',
  },
  casestudy: {
    genre: 'casestudy',
    name: '单案深拆',
    titleGuide:
      '具体品牌名 + 反常现象。例：「喜茶为什么越看越"有感觉"」「拙趣风突然火了，喜茶做对了什么」',
    bodyGuide:
      '聚焦一个具体品牌，拆开它做对了什么。必须有可复述的判断，不能只是夸。' +
      '结论要能迁移到别的品牌。',
  },
  roundup: {
    genre: 'roundup',
    name: '合集盘点',
    titleGuide:
      '时间范围/N 个 + 共性承诺。例：「2026上半年出圈的品牌，都在用这套逻辑」「10种常见的营销玩法」',
    bodyGuide:
      '列出多个案例（3 个以上），每个给一句"它做了什么"，最后归纳共性。' +
      '并列案例之间要有可比性。',
  },
  checklist: {
    genre: 'checklist',
    name: '清单',
    titleGuide:
      'N 个 + 场景。例：「小品牌别乱做视觉，先找到自己的方向」「初创品牌被记住的10个声量密码」',
    bodyGuide:
      '给出一份可直接对照的清单，每条一句话说清，附一句判断标准。' +
      '条目之间不重复，覆盖不同维度。',
  },
  why: {
    genre: 'why',
    name: '现象归因',
    titleGuide:
      '为什么 + 具体现象。例：「为什么现在的品牌，都在卖情绪」「为什么小品牌的视觉，都长一个样」',
    bodyGuide:
      '解释一个现象背后的成因，要有反常识的洞察。结构：设问→归因→例证→结论。' +
      '⚠️ 这是最容易被滥用的体裁，不要每篇都用。',
  },
  thesis: {
    genre: 'thesis',
    name: '观点断言',
    titleGuide:
      '直接给判断（不是提问）。例：「产品卖的不是产品，而是情绪价值」「真正厉害的品牌人，都有一套自己的体系」',
    bodyGuide:
      '开门见山给判断，然后论证。允许"不是A而是B"的纠偏句式，但不要全篇只有这一种结构。',
  },
};

/* ------------------------------------------------------------------ */
/* 体裁识别                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从标题识别体裁。
 *
 * 只用标题不读正文：语料的标题本身就足够指向体裁（实测 118 篇均可判），
 * 而读正文会让这一步变慢且不稳定。
 *
 * 【判定顺序】有意义的 —— 一个标题可能同时命中多处
 * （「品牌手册怎么写，一篇讲清楚」既像教程也像清单），
 * 所以先判最强的信号，从具体到泛化。
 */
/**
 * 把标题里"编码成 emoji 的数字"还原成普通数字。
 *
 * 语料标题大量使用 keycap emoji（5️⃣ / 6️⃣ / 3️⃣），它们是
 * `数字 + U+FE0F + U+20E3` 三个码位，`/\d/` 能匹配到数字本身，
 * 但 `5️⃣个` 这种写法在正则里夹了不可见字符，直接写 `\d+\s*[个点]`
 * 会漏掉。所以先把 keycap 还原成纯数字再做判定。
 */
function normalizeTitle(title: string): string {
  return String(title || '')
    .replace(/([0-9])\uFE0F?\u20E3/g, '$1') // 5️⃣ → 5
    .replace(/[\uFE0F\u20E3]/g, '');
}

export function detectGenre(title: string): Genre {
  const t = normalizeTitle(title).trim();

  // 1. 教程 / SOP：动作 + 交付（最强的信号）
  if (
    /SOP|流程|步骤|步法|指南|教程|讲清|讲透|讲明白|怎么|如何|一篇告诉|拆解手册|做法|要做哪些|哪些内容|需要做/.test(
      t,
    )
  ) {
    return 'tutorial';
  }
  // 2. 合集盘点：数量 + 多个对象
  if (/合集|盘点|十大|TOP|榜单|\d+\s*种|几种|一次性|全讲/.test(t)) return 'roundup';
  // 3. 概念辨析：两个概念/术语边界
  if (/是什么|什么是|到底|区别|≠|不是一回事|本质是|分不清|包含|含义|定义/.test(t)) {
    return 'concept';
  }
  // 4. 单案深拆：具体品牌名
  if (
    /喜茶|观夏|三九|劲牌|PANE|浴见|图拉斯|SANLEE|瑞幸|胖东|山姆|名创|LABUBU|Patagonia|Everlane|IKEA|Marimekko|Seesaw|无印|麦当劳|Nike|Chiikawa|Supreme|RIMOWA|茶颜|霸王茶姬|闻献|迪卡侬|解码|拆完/.test(t)
  ) {
    return 'casestudy';
  }
  /**
   * 5. 现象归因 —— **必须排在趋势断言之前**。
   *
   * 「为什么"丑东西"越来越好卖？」同时命中「为什么」（归因）和
   * 「越来越」（趋势）。但它的**提问方式**是归因，不是下判断。
   * 之前趋势判定在前，把一批「为什么…越…越…」全判成了趋势断言，
   * 直接让语料的趋势占比虚高、归因占比虚低。
   */
  if (/^为什么|^为啥|为什么|为啥/.test(t)) return 'why';
  // 6. 趋势断言：变化 / 时间
  if (/正在|时代|越来越|未来|趋势|不再|结束了|换赛道|消失|变了/.test(t)) return 'trend';
  // 7. 清单：数量 + 建议
  if (
    /这\s*\d+\s*[个点样件层步]|\d+\s*[个点样件步层]|省不得|别只|别急|先找|先搞懂|这几|这几件/.test(t)
  ) {
    return 'checklist';
  }
  // 8. 兜底
  return 'thesis';
}

/* ------------------------------------------------------------------ */
/* 语料的真实体裁分布                                                   */
/* ------------------------------------------------------------------ */

/** 语料体裁分布。 */
export interface GenreDistribution {
  total: number;
  counts: Array<{ genre: Genre; name: string; count: number; ratio: number; examples: string[] }>;
}

/**
 * 统计某来源语料的**逐篇**体裁分布。
 *
 * 关键点：不读 `style_profiles`（那是被压缩过的画像），
 * 而是读 `notes` 的**每一篇标题**，逐篇判体裁。
 * 这样得到的分布才是"这个博主实际在写的结构"。
 */
export function corpusGenreDistribution(sourceId: number): GenreDistribution {
  const rows = all<{ id: number; title: string; liked_count: number }>(
    `SELECT id, title, liked_count FROM notes
      WHERE source_id = ? AND title IS NOT NULL AND title != ''
      ORDER BY liked_count DESC`,
    sourceId,
  );

  const buckets = new Map<Genre, string[]>();
  for (const r of rows) {
    const g = detectGenre(r.title);
    const arr = buckets.get(g) ?? [];
    // 每体裁留最多 3 个高赞例子（作为提示词里的真实样本）
    if (arr.length < 3) arr.push(r.title);
    buckets.set(g, arr);
  }

  const total = rows.length;
  const counts = [...buckets.entries()]
    .map(([genre, examples]) => {
      // 重新数一遍（examples 只留了 3 条，不能拿它的长度当 count）
      const count = rows.filter((r) => detectGenre(r.title) === genre).length;
      return {
        genre,
        name: GENRE_SPECS[genre].name,
        count,
        ratio: total > 0 ? count / total : 0,
        examples,
      };
    })
    .sort((a, b) => b.count - a.count);

  return { total, counts };
}

/**
 * 按语料分布挑一个**当前最缺**的体裁。
 *
 * @param sourceId  来源
 * @param recent    最近若干篇成稿的体裁（用于算欠配）
 *
 * 【为什么按"欠配"而不是按概率随机】
 * 按概率抽会在小样本上偏斜（连着抽到 3 个 why 并不罕见），
 * 而"哪个体裁欠得最多就补哪个"是确定性的、可解释的，
 * 也直接对上「雷同」这个诉求 —— 雷同就是某个体裁被超配。
 */
export function pickUnderrepresentedGenre(
  sourceId: number,
  recent: Genre[],
): Genre {
  const dist = corpusGenreDistribution(sourceId);
  if (dist.total === 0) return 'thesis';

  const window = recent.slice(-12);
  if (window.length === 0) {
    // 还没有历史：拿语料里最多的那个体裁
    return dist.counts[0]?.genre ?? 'thesis';
  }

  // 按语料占比算出这 12 篇"本该"各有几篇，再与实际比，取缺口最大的
  let best: { genre: Genre; gap: number } = { genre: 'thesis', gap: -Infinity };
  for (const c of dist.counts) {
    const expected = c.ratio * window.length;
    const actual = window.filter((g) => g === c.genre).length;
    const gap = expected - actual;
    if (gap > best.gap) best = { genre: c.genre, gap };
  }
  return best.genre;
}

/** 全局体裁偏差报告（诊断用：语料 vs 成稿）。 */
export function genreSkew(sourceId: number, draftLimit = 60): Array<{
  genre: Genre;
  name: string;
  corpusRatio: number;
  draftRatio: number;
  delta: number;
}> {
  const dist = corpusGenreDistribution(sourceId);
  const drafts = all<{ title: string }>(
    'SELECT title FROM drafts WHERE source_id = ? ORDER BY id DESC LIMIT ?',
    sourceId,
    draftLimit,
  );
  const total = drafts.length;
  return dist.counts.map((c) => {
    const n = drafts.filter((d) => detectGenre(d.title) === c.genre).length;
    const draftRatio = total > 0 ? n / total : 0;
    return {
      genre: c.genre,
      name: c.name,
      corpusRatio: c.ratio,
      draftRatio,
      delta: draftRatio - c.ratio,
    };
  });
}
