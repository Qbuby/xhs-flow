import { all } from '../../db/index.js';
import { EXTRACTOR_VERSION } from '../../visual/evidence/extract.js';
import { titleSimilarity } from '../../util/text-sim.js';
import { detectGenre, type Genre } from './genre.js';
import type { TemplateFamilyId } from './contract.js';

/**
 * 稿件计划（deck plan）—— **从语料派生**，不是写死的模板。
 *
 * 【为什么必须这样做】
 *
 * 旧实现把卡片结构写死在提示词的 JSON 模板里：
 *
 *     {cover} {quote} {list} {steps} {compare} {photo_text} {cta}
 *
 * 结果是每一篇都长成同一个样子：7 张、同一顺序、同一个版式序列。
 * 连续 12 篇草稿的 layout 序列实测下来全都是
 * `cover>quote>list>steps>compare>photo_text>cta`（最多只换了两张的先后）。
 *
 * 但语料本身根本不是这样。实测 118 篇语料：
 *   - 每篇的**页数**都不同（4..10 页，均值 5.6），不是固定 7 张；
 *   - 每篇的**正文骨架**都不同（118 个不同的 `误区→定义→公式→诊断→行动`
 *     式骨架，289 个不同的节拍词）；
 *   - 每篇的**内页版式族**也不同：brand-case 42 篇、title-top 40 篇、
 *     label-dark 15 篇、blue-tag 6 篇、纯 ip-trend 15 篇。
 *   - 每篇的**内页编号前缀**也不同：SHIFT / TRANSLATE / STEP / LAYER /
 *     CASE / PART / METHOD —— 都是本篇主题的英文关键词。
 *
 * 所以「像这个博主」这件事，应该由**语料里那一篇的结构**来决定，
 * 而不是由我们写死的模板来决定。这份计划就是把那篇语料的
 * 「页数 + 骨架 + 内页族 + 编号前缀」取出来，作为新稿的施工图。
 *
 * 【计划包含什么】
 *
 *   cardCount    卡片总数（= 样稿的图数，4..10）
 *   beats        正文骨架拆成的节拍（每拍对应一张内页的一个论点）
 *   roles        每张卡片的版式（由节拍推导）
 *   families     每张卡片的模板族（封面恒 ip-trend，内页取样稿主族）
 *   prefix       内页编号前缀（英文关键词，由模型按本篇主题给）
 *   hasPhoto     这一稿要不要配图（样稿有案例图才有）
 */

/** 我们能渲染的版式（与 cards.ts 的 LAYOUTS 对齐，photo_text 除外）。 */
export type PlanLayout = 'cover' | 'quote' | 'list' | 'steps' | 'compare' | 'photo_text' | 'cta';

export interface DeckPlan {
  /** 参照的语料笔记 id */
  exemplarNoteId: number;
  /** 参照语料的标题 */
  exemplarTitle: string;
  /** 卡片总数 */
  cardCount: number;
  /** 正文骨架（节拍序列） */
  beats: string[];
  /** 骨架原句 */
  skeleton: string;
  /** 每张卡片的模板族（长度 = cardCount） */
  families: TemplateFamilyId[];
  /** 内页编号前缀（栏目英文关键词，如 SHIFT / STEP / TRANSLATE） */
  numberingPrefix: string;
  /** 每张卡片的版式（长度 = cardCount） */
  roles: PlanLayout[];
  /** 每张卡片对应的节拍（长度 = cardCount） */
  slotBeats: string[];
  /** 是否包含配图卡 */
  hasPhoto: boolean;
}

/* ------------------------------------------------------------------ */
/* 节拍 → 版式映射                                                      */
/* ------------------------------------------------------------------ */

/**
 * 节拍词 → 版式。
 *
 * 词表来自语料实际出现过的骨架词（见文件头说明）。
 * 匹配顺序有意义：先判收尾类，再判流程类、对比类 —— 因为
 * 「误区」既像清单也像对比，先判谁归谁。
 */
const BEAT_RULES: Array<{ layout: PlanLayout; words: string[] }> = [
  {
    layout: 'cta',
    words: [
      '行动', '行动建议', '行动号召', '行动引导', '行动落点', '行动邀请',
      '建议', '收束', '收藏', '收藏引导', '互动', '交流', '邀请', '邀约', '号召',
      '引导', '总结', '总结趋势', '归纳逻辑', '归纳', '启发', '启示', '品牌启示',
      '行业启发', '反思', '咨询', '结论', '核心结论', '价值结论', '价值总结',
      '价值收束', '未来收束', '机会收束', '关键词收束', '金句收束', '观点收束',
      '经营结论', '品牌结论', '方向结论',
    ],
  },
  {
    layout: 'steps',
    words: [
      '方法', '方法链', '方法结论', '方法启示', '路径', '步骤', '流程', '流程拆解',
      '流程总览', '系统链路', '常规链路', '闭环模型', '三步法', '五步框架', '五步流程',
      '5步流程', '四模块', '五模块', '三层模型', '三项框架', '四阶段链路', '六类模块',
      '六类清单', '五项清单', '五项排查', '十点清单', '九步方案', '七维度', '三公式',
      'AI六步', '步骤拆解', '方法拆解', '模块', '策略', '排期', '节点',
      '四问释义', '五问释义', '三问框架', '三问自检', '三问', '四问',
    ],
  },
  {
    layout: 'compare',
    words: ['对比', '区别', '前后对比', '定义对比', '差异', '两者作用', '价值对比'],
  },
  {
    layout: 'quote',
    words: [
      '定义', '概念', '本质', '公式', '原则', '含义', '核心目标', '核心转折',
      '认知转折', '认知反转', '价值', '价值答案', '答案', '判断方法', '判断',
      '识别标准', '品牌应用', '主体性定义', '否定定义', '否定Logo单一认知',
      '否定单一卖点', '否定运气', '否定标准答案', '认知结果', '金句',
      '提问', '设问', '反问', '发问', '提出问题', '品牌疑问', '场景提问',
      '旧物反问', '反常识开场', '反常识起手', '反常识判断', '反常识定义',
      '反常识纠偏', '反常识', '用户理由',
    ],
  },
  {
    layout: 'list',
    words: [
      '误区', '痛点', '常见做法', '常见误区', '旧做法', '旧认知', '旧偏好', '旧说法',
      '旧卖点', '平台误区', '认知误区', '同质化现象', '群体惯例', '错误后果',
      '归因', '原因', '原因解释', '现象', '问题', '风险', '症状筛选', '痛点诊断',
      '问题诊断', '诊断', '消费变化', '行业变化', '变化', '背景', '品牌判断',
      '需求', '需求拆解', '企业痛点', '清单', '要素', '维度', '识别感受',
      '服务边界', '体系价值', '体系', '场景', '前置条件', '定位条件', '定位辨析',
      '误判', '切口', '品牌反作', '身份需求', '模式分工', '三层分工', '品牌馆',
      '五感拆解', '体验整合', '品类例证', '例证', '案例举证', '案例拆解',
      '公式案例', '案例设问', '案例', '观夏案例', '列出案例', '拆解要素', '拆解逻辑',
      '解释原因', '给出路径', '价值拆解', '要点', '标准',
    ],
  },
];

/** 兜底版式（节拍词没命中时）。 */
const FALLBACK_LAYOUT: PlanLayout = 'list';

/**
 * 补位节拍（节拍数不够铺满卡片时用）。
 *
 * 全部取自语料出现过的骨架词，且互不重复 —— 补出来的页也各讲一件事，
 * 不是凑数。选哪几个由 topic 的哈希决定，所以不同选题补出来的不一样。
 */
const FILLER_BEATS = [
  '误区', '痛点', '定义', '方法', '对比', '案例', '归因', '清单', '公式',
  '风险', '价值', '判断标准', '三问', '自测', '清单', '要素',
];

/** 一个节拍词对应哪个版式。 */
export function layoutForBeat(beat: string): PlanLayout {
  const b = beat.trim();
  if (!b) return FALLBACK_LAYOUT;
  for (const rule of BEAT_RULES) {
    for (const w of rule.words) {
      if (b === w) return rule.layout;
      // 「品牌问答」「痛点诊断」这类带修饰的词，按包含匹配再判一次，
      // 但要保证「行动」不会被「行动号召」抢先（所以先精确、再包含）。
      if (b.includes(w) && b.length - w.length <= 3) return rule.layout;
    }
  }
  return FALLBACK_LAYOUT;
}

/** 骨架串 → 节拍数组。语料里同时有 → 和 -> 两种写法。 */
export function splitSkeleton(skeleton: string): string[] {
  return skeleton
    .split(/→|->|＞|>/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* 从语料取结构                                                        */
/* ------------------------------------------------------------------ */

interface CorpusNoteRow {
  id: number;
  title: string;
  image_count: number;
  liked_count: number;
  analysis: string | null;
}

/** 语料笔记（含蒸馏出的骨架）。 */
function corpusNotes(sourceId: number): CorpusNoteRow[] {
  return all<CorpusNoteRow>(
    `SELECT n.id, n.title, n.image_count, n.liked_count, ns.analysis
       FROM notes n JOIN note_styles ns ON ns.note_id = n.id
      WHERE n.source_id = ?`,
    sourceId,
  );
}

/**
 * 某篇语料的内页模板族（逐页）。
 *
 * 语料实测：118 篇的**封面**全部是 ip-trend 形态（蓝底白字强调块），
 * 内页才是各族的战场（brand-case 174 页 / title-top 163 / ip-trend 89 /
 * label-dark 59 / blue-tag 46）。
 *
 * 返回的是**逐页序列**（page_index 1..n-1），不是单一族：
 * 语料里一篇之内内页族也会切换（如 386 = title-top×7 + brand-case + title-top），
 * 所以新稿照抄这个序列才是真的复刻。认不出的页（unknown）用该篇的主族补。
 */
export function innerFamiliesOf(
  sourceId: number,
  noteId: number,
  innerCount: number,
): TemplateFamilyId[] {
  const rows = all<{ page_index: number; family: string }>(
    `SELECT page_index, family
       FROM page_evidence
      WHERE source_id = ? AND note_id = ? AND extractor_version = ? AND family != 'unknown'
        AND page_index > 0
      ORDER BY page_index`,
    sourceId,
    noteId,
    EXTRACTOR_VERSION,
  );
  const byIndex = new Map(rows.map((r) => [r.page_index, r.family as TemplateFamilyId]));
  const dominant = dominantInnerFamily(rows.map((r) => r.family));

  const out: TemplateFamilyId[] = [];
  for (let i = 1; i <= innerCount; i++) {
    out.push(byIndex.get(i) ?? dominant);
  }
  return out;
}

/** 一组族里出现最多的那个。 */
function dominantInnerFamily(families: string[]): TemplateFamilyId {
  const count = new Map<string, number>();
  for (const f of families) count.set(f, (count.get(f) ?? 0) + 1);
  let best = '';
  let bestN = 0;
  for (const [f, n] of count) {
    if (n > bestN) {
      bestN = n;
      best = f;
    }
  }
  return (best as TemplateFamilyId) || 'wow-ip-trend-v1';
}

/**
 * 某篇语料的内页主族（页数最多的那个）。
 *
 * 取内页里**出现最多**的那个族作为该篇的内页族；语料里 345/346 那种
 * 「同一套 5 页循环两遍」的笔记因此会得到干净的单族。
 */
export function innerFamilyOf(sourceId: number, noteId: number): TemplateFamilyId {
  const rows = all<{ family: string; c: number }>(
    `SELECT family, COUNT(*) AS c
       FROM page_evidence
      WHERE source_id = ? AND note_id = ? AND extractor_version = ? AND family != 'unknown'
        AND page_index > 0
      GROUP BY family`,
    sourceId,
    noteId,
    EXTRACTOR_VERSION,
  );
  const top = rows.sort((a, b) => b.c - a.c)[0];
  return (top?.family as TemplateFamilyId) ?? 'wow-ip-trend-v1';
}

/**
 * 某篇语料的编号前缀（栏目英文关键词）。
 *
 * 语料实测各篇的编号前缀不同：SHIFT / TRANSLATE / STEP / LAYER / CASE /
 * PART / METHOD —— 都是**本篇主题的英文词**。所以新稿的前缀应当来自
 * 本篇选题，而不是全账号共用一个。
 *
 * 只有蒸馏时把前缀写进 `visual.numbering` 的那几篇能直接读到；
 * 其余篇目前缀未入库，留空由调用方按选题另定。
 */
export function numberingPrefixOf(noteId: number): string {
  const row = all<{ analysis: string | null }>(
    'SELECT analysis FROM note_styles WHERE note_id = ?',
    noteId,
  )[0];
  if (!row?.analysis) return '';
  try {
    const parsed = JSON.parse(row.analysis) as { visual?: { numbering?: string } };
    const m = /[A-Za-z]{3,}/.exec(String(parsed.visual?.numbering ?? ''));
    return m ? m[0].toUpperCase() : '';
  } catch {
    return '';
  }
}

/** 某篇语料有没有可用的案例图（配图池里有它的照片）。 */
function noteHasCorpusPhoto(sourceId: number, noteId: number): boolean {
  const row = all<{ c: number }>(
    'SELECT COUNT(*) AS c FROM corpus_photos WHERE source_id = ? AND note_id = ?',
    sourceId,
    noteId,
  )[0];
  return (row?.c ?? 0) > 0;
}

/* ------------------------------------------------------------------ */
/* 计划构造                                                            */
/* ------------------------------------------------------------------ */

/** 近期用过的计划（用于避免连续两篇同构）。 */
interface RecentPlan {
  cardCount: number;
  roles: string;
  beats: string;
}

/** 读最近若干篇的计划摘要。 */
function recentPlanSignatures(sourceId: number, limit = 12): RecentPlan[] {
  const rows = all<{ card_count: number | null; roles: string | null; beats: string | null }>(
    `SELECT
        (SELECT COUNT(*) FROM draft_cards dc WHERE dc.draft_id = d.id) AS card_count,
        (SELECT GROUP_CONCAT(dc.layout) FROM draft_cards dc WHERE dc.draft_id = d.id) AS roles,
        json_extract(d.plan, '$.beats') AS beats
       FROM drafts d
      WHERE d.source_id = ?
      ORDER BY d.id DESC LIMIT ?`,
    sourceId,
    limit,
  );
  return rows.map((r) => ({
    cardCount: r.card_count ?? 0,
    roles: r.roles ?? '',
    beats: r.beats ?? '',
  }));
}

/** 两串版式序列是否一样。 */
function sameRoles(a: string, b: string): boolean {
  return a.replace(/[^a-z_]/g, '') === b.replace(/[^a-z_]/g, '');
}

/** 稳定字符串哈希（用于按选题挑补位节拍）。 */
function hashOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 取 n 个互不重复的补位节拍（按 hash 决定起点，保证同一选题结果稳定）。 */
function fillerBeats(topic: string, n: number, exclude: string[]): string[] {
  const out: string[] = [];
  const start = hashOf(topic) % FILLER_BEATS.length;
  for (let i = 0; out.length < n && i < FILLER_BEATS.length; i++) {
    const cand = FILLER_BEATS[(start + i) % FILLER_BEATS.length]!;
    if (exclude.includes(cand) || out.includes(cand)) continue;
    out.push(cand);
  }
  return out;
}

/**
 * 由骨架推导卡片版式序列。
 *
 * 【页数口径】
 * 语料里第 0 页就是封面，第 1..n-1 页是内页，所以
 * `image_count = n` 意味着 **1 张封面 + (n-1) 张内页**。
 * 收尾页不是额外加的一张，而是内页里的某一页（它的节拍往往是「行动建议/收藏」）。
 * 之前写成 n-2 会凭空少一张、并且丢掉一个节拍。
 */
export function rolesFromPlan(
  cardCount: number,
  beats: string[],
  topic: string,
  hasPhoto: boolean,
): { roles: PlanLayout[]; slotBeats: string[] } {
  const n = Math.max(3, Math.min(10, cardCount));
  const innerCount = n - 1; // 封面之外全是内页（含收尾）

  const slotBeats: string[] = [''];
  const roles: PlanLayout[] = ['cover'];

  // 内页节拍：先用骨架的，不够用补位节拍补齐
  const inner: string[] = [];
  for (let i = 0; i < innerCount; i++) {
    if (i < beats.length) {
      inner.push(beats[i]!);
    } else {
      const fillers = fillerBeats(topic, innerCount, inner);
      inner.push(fillers[i - beats.length] ?? beats[beats.length - 1] ?? '痛点');
    }
  }

  for (let i = 0; i < innerCount; i++) {
    const beat = inner[i]!;
    let layout = layoutForBeat(beat);
    // 案例类节拍 + 样稿有案例图 → 用配图卡；否则仍是清单
    if (layout === 'list' && hasPhoto && /案例|例证|举证/.test(beat)) {
      layout = 'photo_text';
    }

    const prev = roles[roles.length - 1];
    const prev2 = roles[roles.length - 2];

    // 最后一页若不是收尾类，收成 cta —— 语料里内页写到最后都在引导互动。
    // 但**不能与前一页重复**：骨架结尾就是「收藏/行动」时，
    // 再加一张收尾页会得到 `cta > cta`（实测出现过）。
    if (i === innerCount - 1 && layout === 'list' && !hasPhoto && prev !== 'cta') {
      layout = 'cta';
    }

    // 同版式连续三张不好看：换成语料里另一个常见版式
    if (layout === prev && prev === prev2 && layout !== 'photo_text') {
      layout = layout === 'list' ? 'steps' : layout === 'cta' ? 'quote' : 'list';
    }
    // 收尾版式不连排（两张 cta 是明确的版面缺陷）
    if (layout === 'cta' && prev === 'cta') {
      layout = 'list';
    }

    roles.push(layout);
    slotBeats.push(beat);
  }

  return { roles, slotBeats };
}


/**
 * 给某篇选题造一份施工计划。
 *
 * @param sourceId   来源
 * @param topic      本篇选题（用于挑样稿与补位节拍）
 * @param preferIds  优先采用的样稿 id 列表（通常是检索命中的那些）
 * @param genre      本篇体裁。给了就优先挑同体裁的样稿当骨架来源。
 */
export function buildDeckPlan(
  sourceId: number,
  topic: string,
  preferIds: number[] = [],
  genre?: Genre,
): DeckPlan | null {
  const notes = corpusNotes(sourceId);
  if (notes.length === 0) return null;

  const byId = new Map(notes.map((n) => [n.id, n]));
  const recent = recentPlanSignatures(sourceId);

  /**
   * 候选排序：**本体裁优先 + 选题相关度**，不是按互动量。
   *
   * 之前是「检索命中的优先，否则按互动量降序」，于是同一来源天天都挑中
   * 同一篇爆款当样稿 —— 骨架、页数、内页族全跟着那篇走，这就是
   * 「每篇都很雷同」的根因之一。实测连造 12 份计划时 12 份完全相同。
   *
   * 再往上一层：即使骨架变了，如果样稿总是"现象归因"类，
   * 写出来的还是同一个文体。所以**同体裁的样稿优先**，
   * 让"教程"的稿子照着语料里的教程写、让"概念辨析"照着辨析写。
   */
  const prefer = new Set(preferIds);
  const scored = notes
    .filter((n) => n.analysis)
    .map((n) => {
      let titleScore = titleSimilarity(topic, n.title);
      // 检索命中是强信号（FTS 已经判过相关），给一个显著加成但不独占
      if (prefer.has(n.id)) titleScore = Math.max(titleScore, 0.5);
      // 同体裁是**更强**的信号：直接决定正文组织方式
      const sameGenre = genre ? detectGenre(n.title) === genre : false;
      return {
        note: n,
        score: titleScore + (sameGenre ? 0.45 : 0),
        sameGenre,
      };
    })
    .sort((a, b) => b.score - a.score || b.note.liked_count - a.note.liked_count);

  // 候选池：相关度最高的 K 篇。K 取大一点，保证有足够空间避开近期用过的结构。
  const pool = scored.slice(0, Math.max(8, preferIds.length + 4));
  // 相关度全为 0（选题与所有标题都无字面重合）时，池子退化成按互动量的头部
  const ordered = pool.length > 0 ? pool : scored;

  interface BuiltPlan {
    plan: DeckPlan;
    clash: boolean;
  }
  const built: BuiltPlan[] = [];

  for (const { note } of ordered) {
    let skeleton = '';
    try {
      const parsed = JSON.parse(note.analysis!) as { structure?: { pattern?: string } };
      skeleton = String(parsed.structure?.pattern ?? '').trim();
    } catch {
      continue;
    }
    const beats = splitSkeleton(skeleton);
    if (beats.length < 2) continue;

    const cardCount = Math.max(3, Math.min(10, note.image_count || 6));
    const hasPhoto = noteHasCorpusPhoto(sourceId, note.id);
    const { roles, slotBeats } = rolesFromPlan(cardCount, beats, topic, hasPhoto);
    const roleSig = roles.join('>');

    const clash = recent.some(
      (r) =>
        sameRoles(r.roles, roleSig) ||
        (r.cardCount === cardCount && r.beats === JSON.stringify(beats)),
    );

    /**
     * 逐页模板族：封面恒 ip-trend，其余非封面页照抄样稿的**逐页族序列**。
     *
     * 用 innerFamiliesOf（逐页）而不是 innerFamilyOf（单族）——
     * 语料里同一篇之内的内页族会切换（386 = title-top×7 + brand-case + title-top），
     * 照抄序列才是真的复刻那个结构。
     */
    const innerSeq = innerFamiliesOf(sourceId, note.id, Math.max(1, roles.length - 1));
    const families: TemplateFamilyId[] = roles.map((_, i) =>
      i === 0 ? 'wow-ip-trend-v1' : (innerSeq[i - 1] ?? 'wow-ip-trend-v1'),
    );

    // 内页有细字编号族才需要前缀；样稿有就沿用
    const numberingPrefix = families.some((f) => f === 'wow-brand-case-v1')
      ? numberingPrefixOf(note.id)
      : '';

    built.push({
      clash,
      plan: {
        exemplarNoteId: note.id,
        exemplarTitle: note.title,
        cardCount: roles.length,
        beats,
        skeleton,
        families,
        numberingPrefix,
        roles,
        slotBeats,
        hasPhoto,
      },
    });
  }

  if (built.length === 0) return null;
  // 优先未与近期撞车的；全撞了（语料结构被写遍了）就拿相关度最高那篇
  return (built.find((b) => !b.clash) ?? built[0]!).plan;
}

/** 计划的紧凑摘要（落库到 drafts.plan，便于复现与去重）。 */
export function planSummary(plan: DeckPlan): Record<string, unknown> {
  return {
    exemplarNoteId: plan.exemplarNoteId,
    cardCount: plan.cardCount,
    beats: plan.beats,
    roles: plan.roles,
    families: plan.families,
    numberingPrefix: plan.numberingPrefix,
    hasPhoto: plan.hasPhoto,
    skeleton: plan.skeleton,
  };
}

/** 从落库的计划摘要里读编号前缀（渲染时用）。 */
export function prefixFromPlan(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { numberingPrefix?: unknown };
    return typeof parsed.numberingPrefix === 'string' ? parsed.numberingPrefix : '';
  } catch {
    return '';
  }
}
