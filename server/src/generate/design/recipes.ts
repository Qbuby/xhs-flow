import type { Layout } from '../cards.js';
import type { Genre } from './genre.js';
import type { PageRecipe, RecipeStep } from '../layouts.js';
import type { ComponentData } from './components.js';
import { hashOf } from './plan.js';

/**
 * 页面配方库（page recipes）—— 一页由哪些构件按什么顺序堆成。
 *
 * 【这一层解决什么：图雷同】
 *
 * 之前的渲染模型是「一个版式 = 一页整块骨架」：
 *   list  = 标题 + 一列条目
 *   steps = 标题 + 一列步骤
 * 不管换多少版式，画出来都是「一个大标题 + 一列字」，所以每一页都像同一张图。
 *
 * 语料普查（26 页逐页读 + 像素测量）的结论：
 *
 *   - 构件词汇约 53 种（numberedRows / tagChips / comparePairDark /
 *     sectionNumberBox / calloutLeftBar / lightBluePanel / imageBlock …）
 *   - **26/26 页的构件序列都不重复** —— 多样性来自**组合**，不是来自新构件
 *   - 但页面骨架只有约 10 种反复出现：
 *
 *     L1 Title→Rule→NumberedList(+image)              342/2
 *     L2 Eyebrow→Rule→Title→Sub→Compare→Numbered     340/2
 *     L3 GhostNumeral→Tick→Body→Block→Callout         380/1
 *     L4 Title→Rule→Badge→Heading→Chips(+2nd section) 343/1
 *     L5 Title→Rule→Badge→Heading→Bullets→Images      344/1
 *     L6 Eyebrow→Rule→Title→Compare→Statement        350/1
 *     L7 Banner→Title→Panel→Numbered→Callout          357/3
 *     L8 Eyebrow→Rule→Title→Sub→Panel→Numbered        360/1
 *     L9 Eyebrow→Title→Rule→Rows→Callout              385/1
 *     L10 单例（341/1 / 339/2 / 386/2 / 386/4）        —
 *
 *   共同脊柱：**页头（eyebrow/大号浅蓝编号 + 标题）→ 可选发丝线 →
 *   一个主体构件 → 一条收尾引块/胶囊 → 案例图 → 固定页脚**
 *
 * 所以这一层做两件事：
 *   1. 把普查里的 10 种骨架写成**可复用的配方模板**（不是写死 HTML，
 *      是把构件按序列拼起来）
 *   2. 按版式/体裁/序号挑一个配方，并保证同篇之内不重复
 */

/** 配方标识（对应普查里的 L1..L10）。 */
export type RecipeId = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'L8' | 'L9' | 'L10';

/** 配方模板：给定文案块，生成一页的构件序列。 */
export interface RecipeTemplate {
  id: RecipeId;
  name: string;
  /** 来自普查的哪一页 */
  source: string;
  /** 这个配方适合的版式（用于按版式缩小候选） */
  fits: Layout[];
  /** 是否铺满整页（清单类） */
  fill: boolean;
  /** 生成构件序列 */
  build: (b: Record<string, unknown>, pageNo: string) => RecipeStep[];
}

/** 从 blocks.items 里取前 n 条，统一成 {text,note}。 */
function itemsOf(b: Record<string, unknown>, n = 6): Array<{ text?: string; note?: string; tag?: string }> {
  const raw = Array.isArray(b.items) ? b.items : [];
  return raw.slice(0, n).map((it) => {
    if (typeof it === 'string') return { text: it };
    const o = (it ?? {}) as Record<string, unknown>;
    return {
      text: String(o.text ?? ''),
      note: String(o.note ?? ''),
      ...(o.tag ? { tag: String(o.tag) } : {}),
    };
  });
}

/** 从 blocks 里取标题。 */
function titleOf(b: Record<string, unknown>): string {
  return String(b.title ?? b.text ?? '').trim();
}

/** 从 blocks 里取结论/引导语（收尾引块用）。 */
function takeawayOf(b: Record<string, unknown>): string {
  return String(b.conclusion ?? b.action ?? b.hint ?? b.subtitle ?? '').trim();
}

/** 通用页头：eyebrow + headline（普查里 26/26 页都有标题）。 */
function header(b: Record<string, unknown>, opts: { eyebrow?: string } = {}): RecipeStep[] {
  const eb = opts.eyebrow ?? String(b.eyebrow ?? '').trim();
  const out: RecipeStep[] = [];
  if (eb) out.push({ kind: 'eyebrow', data: { text: eb }, gap: 0 });
  out.push({ kind: 'headline', data: { text: titleOf(b) }, gap: 0 });
  return out;
}

/** 通用收尾引块（普查里 20/26 页都有）。 */
function callout(b: Record<string, unknown>): RecipeStep[] {
  const t = takeawayOf(b);
  return t ? [{ kind: 'quotePanel', data: { text: t }, gap: 44 }] : [];
}

/* ------------------------------------------------------------------ */
/* 10 种配方                                                           */
/* ------------------------------------------------------------------ */

export const RECIPES: Record<RecipeId, RecipeTemplate> = {
  /** L1：Title → Rule → NumberedList (+ image)。语料 342/2。最"薄"的一页。 */
  L1: {
    id: 'L1',
    name: '标题 + 发丝线 + 序号清单',
    source: '342/2',
    fits: ['list', 'steps'],
    fill: true,
    build: (b) => [
      ...header(b),
      { kind: 'hairline', gap: 38 },
      { kind: 'numberedRow', data: { items: itemsOf(b, 5) }, gap: 30 },
      ...callout(b),
    ],
  },

  /** L2：Eyebrow → Rule → Title → Sub → Compare → Numbered。语料 340/2。 */
  L2: {
    id: 'L2',
    name: '栏目 + 对照 + 序号清单',
    source: '340/2',
    fits: ['compare', 'list'],
    fill: false,
    build: (b) => {
      const left = (b.left ?? {}) as { title?: string; items?: string[] };
      const right = (b.right ?? {}) as { title?: string; items?: string[] };
      return [
        ...header(b, { eyebrow: String(b.eyebrow || 'CASE · 01') }),
        { kind: 'hairline', gap: 30 },
        { kind: 'subhead', data: { text: String(b.subtitle ?? '') }, gap: 24 },
        {
          kind: 'darkPair',
          gap: 30,
          data: {
            left: { title: left.title, text: (left.items ?? []).join(' / ') },
            right: { title: right.title, text: (right.items ?? []).join(' / ') },
          },
        },
        { kind: 'numberedRow', data: { items: itemsOf(b, 4) }, gap: 34 },
        ...callout(b),
      ];
    },
  },

  /** L3：GhostNumeral → Tick → Body → Panel → Callout。语料 380/1。
   *  大号浅蓝编号由 chrome 层画（ip-trend 族），所以这里只补面板与引块。 */
  L3: {
    id: 'L3',
    name: '大编号 + 蓝色面板 + 引块',
    source: '380/1',
    fits: ['quote', 'list'],
    fill: false,
    build: (b) => [
      ...header(b),
      { kind: 'hairline', gap: 34 },
      { kind: 'panelStack', data: { text: String(b.subtitle ?? ''), right: { text: itemsOf(b, 2).map((i) => i.text).join(' → ') } }, gap: 30 },
      { kind: 'bulletList', data: { items: itemsOf(b, 4), note: 'dash' }, gap: 30 },
      ...callout(b),
    ],
  },

  /** L4：Title → Rule → Badge → Heading → Chips (+ 第二章节)。语料 343/1。
   *  这是语料里最"满"的页：两个章节，每个都有方框编号 + 标签片。 */
  L4: {
    id: 'L4',
    name: '双章节 + 标签片矩阵',
    source: '343/1',
    fits: ['list', 'steps'],
    fill: false,
    build: (b) => {
      const items = itemsOf(b, 8);
      const half = Math.ceil(items.length / 2);
      return [
        ...header(b, { eyebrow: String(b.eyebrow || 'STEP · 01 — 02') }),
        { kind: 'hairline', gap: 30 },
        { kind: 'sectionBox', data: { label: '01', text: items[0]?.text ?? '', note: 'active' }, gap: 28 },
        { kind: 'tagGrid', data: { tags: items.slice(0, half).map((i) => i.text ?? ''), selected: [items[0]?.text ?? ''] }, gap: 24 },
        { kind: 'sectionBox', data: { label: '02', text: items[half]?.text ?? '' }, gap: 36 },
        { kind: 'tagGrid', data: { tags: items.slice(half).map((i) => i.text ?? '') }, gap: 24 },
        ...callout(b),
      ];
    },
  },

  /** L5：Title → Rule → Badge → Heading → Bullets → Images。语料 344/1。 */
  L5: {
    id: 'L5',
    name: '章节 + 两列清单 + 案例图',
    source: '344/1',
    fits: ['list', 'steps'],
    fill: false,
    build: (b) => {
      const items = itemsOf(b, 6);
      // 章节标题用本页的副标题/引导语，没有才退回第一条 ——
      // 否则「01 提案是决策文件」会和清单第一条逐字重复（实测成图确认）。
      const sectionTitle = String(b.subtitle ?? b.hint ?? '').trim() || items[0]?.text || '';
      return [
        ...header(b),
        { kind: 'hairline', gap: 28 },
        { kind: 'sectionBox', data: { label: '01', text: sectionTitle, note: 'active' }, gap: 26 },
        { kind: 'bulletList', data: { items, note: 'dash' }, gap: 22 },
        { kind: 'screenshot', data: { note: String(b.photoDataUri ?? '') }, gap: 28 },
        ...callout(b),
      ];
    },
  },

  /** L6：Eyebrow → Rule → Title → Compare → Statement。语料 350/1。 */
  L6: {
    id: 'L6',
    name: '栏目 + 双气泡对照 + 结论',
    source: '350/1',
    fits: ['compare', 'quote'],
    fill: false,
    build: (b) => {
      const left = (b.left ?? {}) as { title?: string; items?: string[] };
      const right = (b.right ?? {}) as { title?: string; items?: string[] };
      return [
        ...header(b, { eyebrow: String(b.eyebrow || 'INSIGHT · 01') }),
        { kind: 'hairline', gap: 30 },
        {
          kind: 'dualBubble',
          gap: 32,
          data: {
            left: { title: left.title, text: (left.items ?? []).join('\n') },
            right: { title: right.title, text: (right.items ?? []).join('\n') },
          },
        },
        ...callout(b),
      ];
    },
  },

  /** L7：Banner → Title → Panel → Numbered → Callout。语料 357/3。 */
  L7: {
    id: 'L7',
    name: '蓝色栏目标签 + 序号清单 + 浅蓝引块',
    source: '357/3',
    fits: ['list', 'steps'],
    fill: true,
    build: (b) => [
      ...header(b, { eyebrow: String(b.eyebrow || 'CASE · 01') }),
      { kind: 'numberedRow', data: { items: itemsOf(b, 5) }, gap: 36 },
      ...callout(b),
    ],
  },

  /** L8：Eyebrow → Rule → Title → Sub → Panel → Numbered。语料 360/1。 */
  L8: {
    id: 'L8',
    name: '栏目 + 蓝色面板 + 序号清单',
    source: '360/1',
    fits: ['list', 'steps'],
    fill: false,
    build: (b) => [
      ...header(b, { eyebrow: String(b.eyebrow || 'HOW IT WORKS') }),
      { kind: 'hairline', gap: 30 },
      { kind: 'subhead', data: { text: String(b.subtitle ?? '') }, gap: 24 },
      { kind: 'panelStack', data: { text: String(b.hint ?? ''), right: { text: itemsOf(b, 3).map((i) => i.text).join(' → ') } }, gap: 30 },
      { kind: 'numberedRow', data: { items: itemsOf(b, 4) }, gap: 32 },
      ...callout(b),
    ],
  },

  /** L9：Eyebrow → Title → Rule → Rows → Callout。语料 385/1。 */
  L9: {
    id: 'L9',
    name: '栏目 + 箭头映射 + 引块',
    source: '385/1',
    fits: ['list', 'compare'],
    fill: false,
    build: (b) => [
      ...header(b, { eyebrow: String(b.eyebrow || 'WITHOUT BRAND') }),
      { kind: 'hairline', gap: 28 },
      { kind: 'arrowMap', data: { items: itemsOf(b, 4) }, gap: 30 },
      ...callout(b),
    ],
  },

  /** L10：单例集合（语料里 5 页各自不同）。这里取 341/1 的
   *  「交叉清单 + 蓝色面板 + 三卡对照」作为代表。 */
  L10: {
    id: 'L10',
    name: '交叉清单 + 面板 + 三卡',
    source: '341/1',
    fits: ['list', 'compare'],
    fill: false,
    build: (b) => [
      ...header(b),
      { kind: 'hairline', gap: 30 },
      { kind: 'bulletList', data: { items: itemsOf(b, 3) }, gap: 26 },
      { kind: 'panelStack', data: { text: String(b.hint ?? ''), right: { text: itemsOf(b, 3).map((i) => i.text).join(' → ') } }, gap: 28 },
      { kind: 'tagGrid', data: { tags: itemsOf(b, 3).map((i) => i.text ?? ''), selected: [itemsOf(b, 1)[0]?.text ?? ''] }, gap: 28 },
      ...callout(b),
    ],
  },
};

/* ------------------------------------------------------------------ */
/* 配方挑选                                                            */
/* ------------------------------------------------------------------ */

/**
 * 为某页挑一个配方。
 *
 * 规则（按优先级）：
 *   1. 候选 = 该版式能用的配方
 *   2. 排除本篇已经用过的（保证同篇之内每页不同）
 *   3. 在剩下的里用**稳定哈希**选（选题 + 页序 → 配方），
 *      同一篇每次重渲染结果一致、不同篇不同
 *
 * 为什么不用随机：随机会让同一篇重渲染时版式变掉，
 * 而"预览所见 = 生产所得"是这个项目的硬约束。
 */
export function pickRecipe(
  layout: Layout,
  topic: string,
  pageIndex: number,
  used: RecipeId[] = [],
  genre?: Genre,
): RecipeId | null {
  let candidates = (Object.keys(RECIPES) as RecipeId[]).filter((id) =>
    RECIPES[id].fits.includes(layout),
  );
  if (candidates.length === 0) return null;

  const free = candidates.filter((id) => !used.includes(id));
  if (free.length > 0) candidates = free;

  // 体裁偏好的启发式：教程/清单类优先用序号清单；辨析类优先用对照
  const prefer: Partial<Record<Genre, RecipeId[]>> = {
    tutorial: ['L1', 'L5', 'L7'],
    checklist: ['L1', 'L7', 'L4'],
    concept: ['L6', 'L2', 'L10'],
    why: ['L3', 'L9'],
    roundup: ['L4', 'L8'],
  };
  const liked = genre ? prefer[genre] : undefined;
  if (liked) {
    const hit = candidates.filter((id) => liked.includes(id));
    if (hit.length > 0) candidates = hit;
  }

  const h = hashOf(`${topic}|${pageIndex}`);
  return candidates[h % candidates.length] ?? null;
}

/** 把配方实例化成一页可渲染的 PageRecipe。 */
export function buildPageRecipe(
  id: RecipeId,
  blocks: Record<string, unknown>,
  pageNo: string,
): PageRecipe {
  const tpl = RECIPES[id];
  return {
    steps: tpl.build(blocks, pageNo),
    fill: tpl.fill,
  };
}
