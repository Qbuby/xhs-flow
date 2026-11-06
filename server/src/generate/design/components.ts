import { escapeHtml, highlightHtml } from '../card-text.js';
import { stripEmoji } from '../../util/text.js';
import type { ResolvedSpec } from './index.js';

/**
 * 构件库（component library）—— 一页内页是由**几个构件**堆出来的。
 *
 * 【为什么需要这一层：图雷同的真正原因】
 *
 * 之前的模型是「一版式 = 一页」的整块骨架：list 就是标题 + 一列文字，
 * steps 就是标题 + 一列步骤。所以不管换多少版式，画出来都是
 * 「一个大标题 + 一列字」，扫过去像同一张图。
 *
 * 但语料不是这样。实测语料内页（我逐页读了 20+ 页），一页是由
 * 2~4 个**构件**按不同顺序堆出来的：
 *
 *   348/1  编号标签行「PLAN·01—02」 → 大标题
 *          → 【章节块】01方框 + 蓝标题 + 灰副标题
 *          → 【四宫格按钮】①拉新(选中蓝底) ②活跃 ③转化 ④裂变
 *          → 【箭头映射行】拉新 → 福利/赠品
 *          → 【章节块】02方框(描边) + 黑标题
 *          → 4 行箭头映射
 *          → 灰色收尾行
 *
 *   371/1  标题 + 蓝色副标题
 *          → 【圆圈序号行】①行业 + 灰说明（发丝线分隔）
 *          → 【左侧蓝边引块】这一步解决的是：…
 *
 *   366/1  顶部小标签「01 — THE REAL PROBLEM」+ 两行大标题
 *          → 发丝线
 *          → 【双气泡对照】白底描边气泡 vs 浅蓝气泡
 *          → 发丝线
 *          → 灰色接句 + 【左侧蓝边引块】
 *
 *   344/1  标题 → 【章节块】01蓝方框 + 蓝标题 + 灰副标题
 *          → 【两列清单】带彩色小标题的两列
 *          → 【案例截图】两张并排
 *
 *   341/1  大标题 + 发丝线
 *          → 【❌/✅ 清单】红叉绿勾条目
 *          → 【浅蓝面板 + 深蓝面板】
 *          → 【左侧蓝边引块】
 *
 * 所以「不雷同」的钥匙是：**每页的构件组合与顺序不同**。
 * 这一层提供构件，每个构件是一个独立的 HTML 生成器；
 * 版式层负责按「构件配方」把它们拼起来。
 */

/** 构件标识。 */
export type ComponentKind =
  | 'eyebrow'        // 顶部小标签（栏目 + 序号，如 "PLAN · 01 — 02"）
  | 'headline'       // 大标题（1~2 行）
  | 'subhead'        // 蓝色副标题（紧跟标题）
  | 'sectionBox'     // 章节块：方框编号 + 标题 + 灰色副标题
  | 'numberedRow'    // 序号行：序号 + 粗体词 + 灰色说明（发丝线分隔）
  | 'bulletList'     // 清单行：符号 + 粗体词 + 灰色说明
  | 'tagGrid'        // 标签片网格（描边小方块，可选中态）
  | 'arrowMap'       // 箭头映射行：左词 → 右标签
  | 'dualBubble'     // 双气泡对照：白底描边 vs 浅蓝
  | 'darkPair'       // 深浅对照对（白框 vs 深蓝黑实心）
  | 'panelStack'     // 浅蓝面板 + 深蓝面板叠放
  | 'quotePanel'     // 引块：左侧蓝边 + 粗体/蓝色文字
  | 'screenshot'     // 案例截图区
  | 'hairline'       // 通栏发丝线
  | 'closingLine'    // 灰色收尾行
  | 'listItem';      // 通用条目

/** 构件的输入。 */
export interface ComponentData {
  /** 主文本 */
  text?: string;
  /** 次文本（灰色说明） */
  note?: string;
  /** 标签（编号、方框数字、eyebrow 文案） */
  label?: string;
  /** 标签片组 */
  tags?: string[];
  /** 选中态（tagGrid 用） */
  selected?: string[];
  /** 条目数组 */
  items?: Array<{ text?: string; note?: string; tag?: string }>;
  /** 左列（dualBubble / darkPair） */
  left?: { title?: string; text?: string };
  /** 右列 */
  right?: { title?: string; text?: string };
}

/** 构件渲染上下文。 */
export interface ComponentCtx {
  spec: ResolvedSpec;
  /** 强调色（通常是 var(--accent)） */
  accent: string;
  /** 该页的页码（空则不画编号） */
  pageNo: string;
}

/** 文案 → 高亮 HTML（与 layouts.ts 的 rich 同义，这里独立一份避免循环依赖）。 */
function rich(v: unknown, spec: ResolvedSpec): string {
  return highlightHtml(stripEmoji(String(v ?? '')), spec);
}

function esc(v: unknown): string {
  return escapeHtml(stripEmoji(String(v ?? '')));
}

/** 圆圈序号（①②③ 的描边圆圈版，371/1 实测）。 */
function circledNumber(n: number): string {
  // ①②③④⑤⑥⑦⑧⑨⑩ 直接用 Unicode，与语料一致
  const circled = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
  return circled[n] ?? String(n + 1);
}

/* ------------------------------------------------------------------ */
/* 构件                                                                */
/* ------------------------------------------------------------------ */

/**
 * 顶部小标签。
 *
 * 语料实测有两种：
 *   - 「PLAN · 01 — 02」蓝字，字母间距拉开（348/1）
 *   - 「01 — THE REAL PROBLEM」蓝字（366/1）
 *   - 「STEP ZERO」灰字（361/1）
 * 所以 label 直接给文字，颜色由 tone 决定。
 */
function eyebrow(d: ComponentData, ctx: ComponentCtx): string {
  const tone = d.note === 'gray' ? 'var(--ink-soft)' : 'var(--accent)';
  return `<div class="t-meta latin" style="color:${tone};font-weight:700;
    letter-spacing:0.18em;font-size:26px">${rich(d.text ?? '', ctx.spec)}</div>`;
}

/** 大标题。 */
function headline(d: ComponentData, ctx: ComponentCtx): string {
  const size = Math.round(ctx.spec.type.title * 0.74);
  return `<h2 class="t-title" style="font-family:var(--font-title);
    font-size:${size}px;line-height:1.3;color:var(--ink)">${rich(d.text ?? '', ctx.spec)}</h2>`;
}

/** 蓝色副标题（371/1 的「先诊断，再动手」）。 */
function subhead(d: ComponentData, ctx: ComponentCtx): string {
  return `<div class="t-title" style="font-family:var(--font-title);
    font-size:${Math.round(ctx.spec.type.title * 0.5)}px;font-weight:800;
    line-height:1.35;color:var(--accent)">${rich(d.text ?? '', ctx.spec)}</div>`;
}

/**
 * 章节块：方框编号 + 标题 + 灰色副标题。
 *
 * 语料实测（348/1、344/1、341/2）：
 *   - 方框 104×104（348/1 的 01）或 80×80（344/1）
 *   - 选中态：蓝底白字；未选中：白底描边黑字
 *   - 标题在方框右侧，蓝字加粗；副标题在标题下方，灰色
 *   - 左侧有一条细竖线连到下一个章节（341/2）
 */
function sectionBox(d: ComponentData, ctx: ComponentCtx): string {
  const label = d.label ?? '';
  const active = d.note === 'active';
  const size = 84;
  const box = `<div style="flex:0 0 auto;width:${size}px;height:${size}px;
    display:flex;align-items:center;justify-content:center;
    ${active
      ? 'background:var(--accent);color:var(--on-accent);'
      : 'background:#FFFFFF;color:var(--ink);box-shadow:inset 0 0 0 1px #DCDCDE;'}
    font-size:34px;font-weight:800;font-variant-numeric:tabular-nums">${esc(label)}</div>`;

  const title = `<div class="t-title" style="font-family:var(--font-title);
    font-size:${Math.round(ctx.spec.type.title * 0.52)}px;font-weight:800;
    line-height:1.3;color:var(--accent)">${rich(d.text ?? '', ctx.spec)}</div>`;
  const note = d.note && d.note !== 'active'
    ? `<div class="t-body cjk" style="font-size:${ctx.spec.type.caption + 6}px;
        color:var(--ink-soft);margin-top:12px">${rich(d.note, ctx.spec)}</div>`
    : '';

  return `<div style="display:flex;gap:34px;align-items:flex-start">${box}
    <div style="flex:1;min-width:0;padding-top:6px">${title}${note}</div></div>`;
}

/**
 * 序号行：圆圈序号 + 粗体词 + 灰色说明，行间发丝线。
 *
 * 371/1 实测：① 行业 | 市场处在什么阶段，每行下方一条 1px #E5E5E5 通栏线。
 * 与 bulletList 的区别是符号用圆圈数字而不是 ❌/✅。
 */
function numberedRow(d: ComponentData, ctx: ComponentCtx): string {
  const items = d.items ?? [];
  return `<div style="display:flex;flex-direction:column">
    ${items
      .map(
        (it, i) => `
      <div style="display:flex;align-items:baseline;gap:26px;
        padding:34px 0;${i < items.length - 1 ? 'border-bottom:1px solid var(--hairline);' : ''}">
        <span style="flex:0 0 auto;font-size:34px;line-height:1;color:var(--ink)">${circledNumber(i)}</span>
        <span class="t-title" style="font-family:var(--font-title);
          font-size:${Math.round(ctx.spec.type.title * 0.46)}px;font-weight:800;
          flex:0 1 auto;max-width:46%;white-space:nowrap">${rich(it.text ?? '', ctx.spec)}</span>
        <span class="t-body cjk" style="font-size:${ctx.spec.type.caption + 8}px;
          flex:1 1 0;min-width:0;color:var(--ink-soft);opacity:.82">${rich(it.note ?? '', ctx.spec)}</span>
      </div>`,
      )
      .join('')}
  </div>`;
}

/**
 * 清单行：符号 + 粗体词 + 灰色说明。
 *
 * 339/1 实测用 ❌ 红叉 / ✅ 绿勾表达正反两面；
 * 341/1 实测是白底描边方框里放 ❌。
 * 这里的符号由 tone 决定：'cross' 用 ❌/✅，'dash' 用蓝点。
 */
function bulletList(d: ComponentData, ctx: ComponentCtx): string {
  const items = d.items ?? [];
  const useCross = d.note !== 'dash';
  return `<div style="display:flex;flex-direction:column">
    ${items
      .map(
        (it, i) => `
      <div style="display:flex;gap:24px;align-items:flex-start;
        padding:${Math.round(ctx.spec.density.gap * 0.6)}px 0;
        ${i < items.length - 1 ? 'border-bottom:1px solid var(--hairline);' : ''}">
        <span style="flex:0 0 auto;width:34px;text-align:center;
          ${useCross
            ? `color:${i % 2 === 1 ? '#34CF45' : '#E8352A'};font-size:30px;font-weight:800;line-height:1.1`
            : 'color:var(--accent);font-size:30px;font-weight:800;line-height:1.1'}">
          ${useCross ? (i % 2 === 1 ? '&#10003;' : '&#10007;') : '&#8226;'}</span>
        <div style="flex:1;min-width:0">
          <div class="t-body" style="font-size:${ctx.spec.type.body + 2}px;font-weight:700">${rich(it.text ?? '', ctx.spec)}</div>
          ${it.note ? `<div class="t-body cjk" style="font-size:${ctx.spec.type.caption}px;opacity:.72;margin-top:8px">${rich(it.note, ctx.spec)}</div>` : ''}
        </div>
      </div>`,
      )
      .join('')}
  </div>`;
}

/**
 * 标签片网格。
 *
 * 348/1 实测：①拉新（蓝底白字，选中）/ ②活跃（白底描边）/ ③转化 / ④裂变，
 * 两列排布，每个约 330×80。
 * 344/3 实测：同类标签更多（门头/导视系统/店内标识…），也是描边框。
 */
function tagGrid(d: ComponentData, ctx: ComponentCtx): string {
  const tags = d.tags ?? [];
  const selected = new Set(d.selected ?? []);
  const cols = tags.length > 4 ? 3 : 2;
  return `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);
    gap:20px 24px">
    ${tags
      .map((t) => {
        const on = selected.has(t);
        return `<div style="display:flex;align-items:center;gap:14px;
          padding:22px 26px;min-height:80px;
          ${on
            ? 'background:var(--accent);color:var(--on-accent);'
            : 'background:#FFFFFF;color:var(--ink);box-shadow:inset 0 0 0 1px #DCDCDE;'}
          font-size:${Math.round(ctx.spec.type.body * 0.92)}px;font-weight:700">${esc(t)}</div>`;
      })
      .join('')}
  </div>`;
}

/**
 * 箭头映射行：左词 → 右标签。
 *
 * 348/1 实测：「拉新 → 福利 / 赠品」，左词黑字，右标签蓝色描边框。
 * 361/1 实测：「想快速成交 → 流量型平台」，右边是蓝字描边框。
 */
function arrowMap(d: ComponentData, ctx: ComponentCtx): string {
  const items = d.items ?? [];
  return `<div style="display:flex;flex-direction:column">
    ${items
      .map(
        (it, i) => `
      <div style="display:flex;align-items:center;gap:26px;
        padding:30px 0;${i < items.length - 1 ? 'border-bottom:1px solid var(--hairline);' : ''}">
        <span class="t-title" style="font-family:var(--font-title);
          font-size:${Math.round(ctx.spec.type.title * 0.44)}px;font-weight:700;
          flex:1;min-width:0">${rich(it.text ?? '', ctx.spec)}</span>
        <span style="flex:0 0 auto;color:var(--ink-soft);font-size:30px">&#8594;</span>
        <span style="flex:0 0 auto;padding:12px 26px;
          border:2px solid var(--accent);color:var(--accent);
          font-size:${Math.round(ctx.spec.type.body * 0.88)}px;font-weight:800">${esc(it.tag ?? '')}</span>
      </div>`,
      )
      .join('')}
  </div>`;
}

/**
 * 双气泡对照：白底描边 vs 浅蓝底。
 *
 * 366/1 实测：「品牌说」白底描边圆角气泡 vs 「消费者想」浅蓝底圆角气泡，
 * 两块并排，上面各有一个小标题。
 */
function dualBubble(d: ComponentData, ctx: ComponentCtx): string {
  const bubble = (
    c: { title?: string; text?: string } | undefined,
    hot: boolean,
  ) => `
    <div style="flex:1;min-width:0;padding:34px 36px;border-radius:18px;
      ${hot
        ? 'background:#E4EEFA;color:var(--ink);'
        : 'background:#FFFFFF;color:var(--ink);box-shadow:inset 0 0 0 1px #DCDCDE;'}">
      ${c?.title
        ? `<div class="t-title" style="font-family:var(--font-title);
            font-size:${Math.round(ctx.spec.type.title * 0.42)}px;font-weight:800;
            margin-bottom:20px;color:${hot ? 'var(--accent)' : 'var(--ink-soft)'}">${esc(c.title)}</div>`
        : ''}
      <div class="t-body cjk" style="font-size:${ctx.spec.type.body + 4}px;
        line-height:1.6">${rich(c?.text ?? '', ctx.spec)}</div>
    </div>`;

  return `<div style="display:flex;gap:30px;align-items:stretch">
    ${bubble(d.left, false)}
    ${bubble(d.right, true)}
  </div>`;
}

/**
 * 深浅对照对：白底描边 vs 深蓝黑实心，中间一个箭头。
 *
 * 340/1 与 341/2 实测：左块白底 1px 细线框，右块深蓝黑 #0A172A 实心白字，
 * 中间一个蓝色箭头。
 */
function darkPair(d: ComponentData, ctx: ComponentCtx): string {
  const box = (
    c: { title?: string; text?: string } | undefined,
    hot: boolean,
  ) => `
    <div style="flex:1;min-width:0;padding:${Math.round(ctx.spec.density.gap * 0.8)}px;
      ${hot
        ? 'background:#0A172A;color:#FFFFFF;'
        : 'background:#FFFFFF;color:var(--ink);box-shadow:inset 0 0 0 1px #DCDCDE;'}">
      ${c?.title
        ? `<div class="t-meta latin ${hot ? 'on-accent' : ''}" style="font-weight:800;margin-bottom:14px;
            ${hot ? '' : 'color:var(--ink-soft);'}">${esc(c.title)}</div>`
        : ''}
      <div class="t-body cjk ${hot ? 'on-accent' : ''}" style="font-size:${ctx.spec.type.caption + 4}px;
        line-height:1.62;${hot ? '' : 'color:inherit;'}">${rich(c?.text ?? '', ctx.spec)}</div>
    </div>`;

  return `<div style="display:flex;gap:0;align-items:stretch;width:100%">
    ${box(d.left, false)}
    <div style="flex:0 0 auto;display:flex;align-items:center;justify-content:center;
      width:76px;color:var(--accent);font-size:34px;font-weight:800">&#8594;</div>
    ${box(d.right, true)}
  </div>`;
}

/**
 * 浅蓝面板 + 深蓝面板叠放。
 *
 * 341/1 实测：上半浅蓝 #E4EEFA 面板（"现在更重要的是："），
 * 下半深蓝黑 #0A172A 面板（"看到你 → 记住你 → 信任你 → 选择你"）。
 */
function panelStack(d: ComponentData, ctx: ComponentCtx): string {
  return `<div style="display:flex;flex-direction:column;gap:22px">
    <div style="background:#E4EEFA;padding:${Math.round(ctx.spec.density.gap * 0.8)}px">
      <div class="t-title" style="font-family:var(--font-title);
        font-size:${Math.round(ctx.spec.type.title * 0.46)}px;font-weight:800;
        color:var(--accent)">${rich(d.text ?? '', ctx.spec)}</div>
      ${d.note ? `<div class="t-body cjk" style="font-size:${ctx.spec.type.caption + 4}px;
        color:var(--ink-soft);margin-top:12px">${rich(d.note, ctx.spec)}</div>` : ''}
    </div>
    <div style="background:#0A172A;color:#FFFFFF;padding:${Math.round(ctx.spec.density.gap * 0.8)}px">
      <div class="t-title on-accent" style="font-family:var(--font-title);
        font-size:${Math.round(ctx.spec.type.title * 0.44)}px;font-weight:800;
        line-height:1.5">${rich(d.right?.text ?? '', ctx.spec)}</div>
    </div>
  </div>`;
}

/**
 * 引块：左侧一条蓝边 + 粗体文字（可带蓝色强调句）。
 *
 * 339/1、371/1、366/1 都有这个构件：左 6px 蓝色竖条 + 粗体正文，
 * 关键句用蓝色。366/1 的文字是「文化不是越厚重越高级，」接
 * 蓝色竖条块「而是要让消费者看得懂、感受到、愿意认同」。
 */
function quotePanel(d: ComponentData, ctx: ComponentCtx): string {
  return `<div style="border-left:6px solid var(--accent);
    padding:${Math.round(ctx.spec.density.gap * 0.55)}px 0 ${Math.round(ctx.spec.density.gap * 0.55)}px 34px">
    <div class="t-title" style="font-family:var(--font-title);
      font-size:${Math.round(ctx.spec.type.title * 0.46)}px;font-weight:800;
      line-height:1.55">${rich(d.text ?? '', ctx.spec)}</div>
    ${d.note ? `<div class="t-body cjk" style="font-size:${ctx.spec.type.caption + 6}px;
      margin-top:12px;color:var(--ink-soft)">${rich(d.note, ctx.spec)}</div>` : ''}
  </div>`;
}

/** 案例截图区（整幅图，语料里是客户案例截图）。 */
function screenshot(d: ComponentData, ctx: ComponentCtx): string {
  if (!d.note) return '';
  return `<div style="background-image:url('${d.note}');background-size:cover;
    background-position:center;width:100%;aspect-ratio:16/10;overflow:hidden"></div>`;
}

/** 通栏发丝线。 */
function hairline(): string {
  return `<div style="height:1px;background:var(--hairline);width:100%"></div>`;
}

/** 灰色收尾行。 */
function closingLine(d: ComponentData, ctx: ComponentCtx): string {
  return `<div class="t-body cjk" style="font-size:${ctx.spec.type.caption + 8}px;
    color:var(--ink-soft);opacity:.85">${rich(d.text ?? '', ctx.spec)}</div>`;
}

/* ------------------------------------------------------------------ */
/* 构件注册表                                                          */
/* ------------------------------------------------------------------ */

/** 构件实现表。 */
export const COMPONENTS: Record<ComponentKind, (d: ComponentData, ctx: ComponentCtx) => string> = {
  eyebrow,
  headline,
  subhead,
  sectionBox,
  numberedRow,
  bulletList,
  tagGrid,
  arrowMap,
  dualBubble,
  darkPair,
  panelStack,
  quotePanel,
  screenshot,
  hairline,
  closingLine,
  listItem: bulletList,
};

/** 渲染一个构件。未知类型返回空串（不抛，避免脏数据毁掉整页）。 */
export function renderComponent(
  kind: ComponentKind,
  data: ComponentData,
  ctx: ComponentCtx,
): string {
  const fn = COMPONENTS[kind];
  if (!fn) return '';
  try {
    return fn(data, ctx);
  } catch {
    return '';
  }
}
