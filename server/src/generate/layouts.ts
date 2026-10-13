import type { ResolvedSpec } from './design/index.js';
import { badgeText, inlineMotif, type MotifContext } from './design/index.js';

/**
 * 版式骨架。
 *
 * 【为什么每个版式要自持骨架】
 *
 * 旧实现所有版式共用一个骨架：
 *
 *     body > .card > [ decoration, .content(flex column, justify-center), .footer ]
 *
 * `.content` 是唯一内容容器，7 种版式只是往里塞不同片段。后果是**没有任何
 * 版式能偏离「垂直居中一列文字」** —— 这就是「每张卡都长一个样、元素少」
 * 的结构性根源。再好的配色和字号也救不回来。
 *
 * 现在每个版式自己决定骨架：可以底部对齐、可以分栏、可以出血、可以有
 * 绝对定位的自由元素层。它们只共享两件事：
 *   1. 一组 CSS 变量（`--ink` / `--accent` / `--gap` …），换主题自动协调
 *   2. 一批语义化的类（`.t-title` / `.t-body` / `.t-meta` / `.panel` …）
 *
 * 【中文排版】
 * 规则参照 heti（MIT，https://github.com/sivan/heti）的中西文分治做法：
 *  - 汉字 **不加** 字距（加 letter-spacing 会让汉字之间出现难看的缝隙）
 *  - 只有纯拉丁（eyebrow / 元信息 / 页码）才加 tracking
 *  - 中文禁用斜体（斜体会让汉字变形），强调用字重/颜色/底色
 *  - 中文段落 `text-align: justify`，西文左对齐
 *  - 标题 `text-wrap: balance`，避免「一行三四个字」的碎片断行
 * 这些在 cards.ts 的 baseCss 里用 `.cjk` / `.latin` 两个类落地。
 */

export interface LayoutInput {
  /** 版式相关的文案块 */
  blocks: Record<string, unknown>;
  spec: ResolvedSpec;
  /** 底图 data-URI（photo_text 用） */
  photoDataUri?: string;
  /** PDF 风格的页码，如 "03" */
  pageNo: string;
  /** 主题给的行内装饰上下文 */
  motifCtx: MotifContext;
}

/** 只读的短横线分隔列表。 */
function bullets(items: string[], spec: ResolvedSpec, ctx: MotifContext): string {
  if (items.length === 0) return '';
  const showRule = spec.motifs.includes('rule-fade');
  const useBadge = spec.motifs.includes('badge');
  return `
    <div style="display:flex;flex-direction:column;gap:${Math.round(spec.density.gap * 0.5)}px">
      ${items
        .map((t, i) => {
          const lead = useBadge
            ? `<span style="flex:0 0 auto">${badgeMark(spec, badgeText(i))}</span>`
            : `<span style="flex:0 0 auto;width:26px;height:2px;margin-top:${Math.round(spec.type.body * 0.7)}px;background:var(--accent);opacity:.7"></span>`;
          return `<div style="display:flex;gap:18px;align-items:flex-start">${lead}
            <div class="t-body" style="flex:1">${t}</div></div>`;
        })
        .join('')}
    </div>
    ${showRule ? '' : ''}`;
}

/** 行内小徽章（数字方块）。放在内容流里，不是绝对定位。 */
function badgeMark(spec: ResolvedSpec, text: string): string {
  return `<span style="display:inline-flex;align-items:center;justify-content:center;
    min-width:46px;height:46px;padding:0 12px;border-radius:12px;
    background:var(--accent);color:var(--on-accent);
    font-size:20px;font-weight:800;font-variant-numeric:tabular-nums">${text}</span>`;
}

/* ------------------------------------------------------------------ */
/* cover —— 非对称封面                                                  */
/* ------------------------------------------------------------------ */

/**
 * 旧封面是 eyebrow + 标题 + items + hint 全部居中堆叠，没有构图。
 *
 * 新骨架走杂志封面逻辑：**上半留白，下半压字**，左对齐，右侧一条竖排
 * 色带作为视觉锚点。三块信息分工明确：顶部 eyebrow（栏目）、
 * 中部标题（钩子）、底部 items（承诺）。留白在中间，让标题有呼吸。
 */
function cover(input: LayoutInput): string {
  const { blocks: b, spec, pageNo, motifCtx } = input;
  const items = (b.items as string[]) ?? [];
  const useVertical = spec.motifs.includes('vertical-tag');
  const title = String(b.title ?? '');

  // 标题字号按行数降档：一行可以很大，三行必须收
  const lines = Math.min(3, title.split('\n').filter(Boolean).length || 1);
  const titleSize = lines >= 3 ? spec.type.display * 0.62 : lines === 2 ? spec.type.display * 0.82 : spec.type.display;

  return `
    <div style="display:flex;flex-direction:column;height:100%;${useVertical ? 'padding-right:74px' : ''}">
      <div style="display:flex;align-items:center;gap:16px">
        ${inlineMotif('rule', motifCtx, '', 0)}
        ${b.eyebrow ? `<div class="t-meta latin">${String(b.eyebrow)}</div>` : ''}
      </div>

      <div style="flex:1"></div>

      <h1 class="t-title balance" style="font-size:${Math.round(titleSize)}px;
          font-family:var(--font-title);margin-bottom:var(--gap)">${title}</h1>

      ${items.length ? `<div style="margin-bottom:var(--gap)">${bullets(items.slice(0, spec.density.maxItems), spec, motifCtx)}</div>` : ''}

      ${b.hint ? `<div class="rule-fade" style="margin-bottom:20px"></div>
        <div class="t-meta" style="color:var(--accent);font-weight:700">${String(b.hint)}</div>` : ''}
    </div>`;
}

/* ------------------------------------------------------------------ */
/* quote —— 金句                                                        */
/* ------------------------------------------------------------------ */

/**
 * 旧实现唯一的「装饰」是一个 `"` 字符（还是英文直引号），字号 title+34。
 *
 * 新骨架把引号做成**出血元素**：超大、半透明、压在左上角外侧，
 * 只露一半 —— 这是杂志金句页的标准做法。正文居中，署名右下，
 * 整块用括号装饰框住（如果主题允许）。
 */
function quote(input: LayoutInput): string {
  const { blocks: b, spec, motifCtx } = input;
  const framed = spec.motifs.includes('bracket');

  return `
    <div style="position:relative;height:100%;display:flex;flex-direction:column;
                justify-content:center;${framed ? 'padding-left:56px' : ''}">
      <div aria-hidden="true" data-bleed="1" style="position:absolute;top:-140px;left:-40px;
        font-family:var(--font-title);font-size:${Math.round(spec.type.display * 3.4)}px;
        line-height:1;color:var(--accent);opacity:.13;pointer-events:none">&#8220;</div>

      <div class="t-title balance" style="font-family:var(--font-title);position:relative;
        font-size:${Math.round(spec.type.title * 1.28)}px;margin-bottom:calc(var(--gap) * 1.1)">
        ${String(b.text ?? '')}
      </div>

      ${b.note ? `<div class="t-body cjk" style="max-width:78%;opacity:.86">${String(b.note)}</div>` : ''}

      ${b.attribution ? `
        <div style="margin-top:calc(var(--gap) * 1.4);display:flex;align-items:center;gap:18px">
          ${inlineMotif('rule', motifCtx, '', 0)}
          <span class="t-meta latin" style="color:var(--accent);font-weight:700">${String(b.attribution)}</span>
        </div>` : ''}
    </div>`;
}

/* ------------------------------------------------------------------ */
/* list —— 清单                                                         */
/* ------------------------------------------------------------------ */

/**
 * 旧实现是「序号大数字 + 粗体要点 + 小字注释」的 flex 行堆叠，没有分隔。
 * 新骨架：编号徽章 + 条目之间插发丝分隔线，让密度高的卡片有节奏。
 * 标题在顶部左对齐（不再居中），扫读路径更清楚。
 */
function list(input: LayoutInput): string {
  const { blocks: b, spec, motifCtx } = input;
  const raw = (b.items as Array<{ text?: string; note?: string }>) ?? [];
  const items = raw.slice(0, spec.density.maxItems);

  return `
    <div style="display:flex;flex-direction:column;height:100%">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
        ${inlineMotif('rule', motifCtx, '', 0)}
        ${b.eyebrow ? `<div class="t-meta latin">${String(b.eyebrow)}</div>` : ''}
      </div>

      ${b.title ? `<h2 class="t-title balance" style="font-family:var(--font-title);
        font-size:${Math.round(spec.type.title * 0.86)}px;margin-bottom:calc(var(--gap) * 1.2)">${String(b.title)}</h2>` : ''}

      <div style="flex:1;display:flex;flex-direction:column;justify-content:center">
        ${items
          .map(
            (it, i) => `
          <div style="display:flex;gap:22px;align-items:flex-start;
            padding:${Math.round(spec.density.gap * 0.62)}px 0;
            ${i > 0 ? 'border-top:1px solid var(--hairline);' : ''}">
            <span style="flex:0 0 auto">${badgeMark(spec, badgeText(i))}</span>
            <div style="flex:1;min-width:0">
              <div class="t-body" style="font-size:${spec.type.body + 2}px;font-weight:700">${String(it.text ?? '')}</div>
              ${it.note ? `<div class="t-body cjk" style="font-size:${spec.type.caption}px;opacity:.72;margin-top:8px">${String(it.note)}</div>` : ''}
            </div>
          </div>`,
          )
          .join('')}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* steps —— 时间轴                                                      */
/* ------------------------------------------------------------------ */

/**
 * 旧实现是一条 3px 竖线 + 实心圆点，靠硬编码 `left:-52px` 对齐。
 * 新骨架：渐隐竖线（顶部实、底部虚，暗示"流程在继续"）+ 带序号底色的圆点，
 * 步骤之间留白更大。这条线是**唯一**的图形元素，做精比堆元素有效。
 */
function steps(input: LayoutInput): string {
  const { blocks: b, spec, motifCtx } = input;
  const raw = (b.items as Array<{ text?: string; note?: string }>) ?? [];
  const items = raw.slice(0, spec.density.maxItems);
  const dot = Math.round(spec.type.body * 1.05);

  return `
    <div style="display:flex;flex-direction:column;height:100%">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
        ${inlineMotif('rule', motifCtx, '', 0)}
        ${b.eyebrow ? `<div class="t-meta latin">${String(b.eyebrow)}</div>` : ''}
      </div>

      ${b.title ? `<h2 class="t-title balance" style="font-family:var(--font-title);
        font-size:${Math.round(spec.type.title * 0.8)}px;margin-bottom:calc(var(--gap) * 1.3)">${String(b.title)}</h2>` : ''}

      <div style="flex:1;position:relative;padding-left:${dot + 26}px">
        <div style="position:absolute;left:${Math.round(dot / 2)}px;top:${dot / 2}px;bottom:${dot / 2}px;width:2px;
          background:linear-gradient(180deg, var(--accent) 0%, var(--accent) 58%, transparent 100%)"></div>
        <div style="display:flex;flex-direction:column;gap:${Math.round(spec.density.gap * 1.05)}px">
          ${items
            .map(
              (it, i) => `
            <div style="position:relative">
              <div style="position:absolute;left:-${dot + 26}px;top:0;
                width:${dot}px;height:${dot}px;border-radius:50%;
                background:var(--accent);color:var(--on-accent);
                display:flex;align-items:center;justify-content:center;
                font-size:${Math.round(dot * 0.52)}px;font-weight:800;
                font-variant-numeric:tabular-nums">${i + 1}</div>
              <div class="t-body" style="font-size:${spec.type.body + 2}px;font-weight:700;line-height:1.42">${String(it.text ?? '')}</div>
              ${it.note ? `<div class="t-body cjk" style="font-size:${spec.type.caption}px;opacity:.72;margin-top:8px">${String(it.note)}</div>` : ''}
            </div>`,
            )
            .join('')}
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* compare —— 对比                                                      */
/* ------------------------------------------------------------------ */

/**
 * 旧实现是两个 1fr 等宽列 + 右列高亮，**没有 vs 标识、没有分割**，
 * 连 ❌/✓ 都是文案里带的（而且会被 stripEmoji 删掉）。
 *
 * 新骨架：两列之间插一条竖直虚线 + 中间一个 VS 徽章，把「对立」这件事
 * 用版面说出来。结论单独做成一条深色底的通栏，视觉上收尾。
 */
function compare(input: LayoutInput): string {
  const { blocks: b, spec } = input;
  const left = (b.left as { title?: string; items?: string[] }) ?? {};
  const right = (b.right as { title?: string; items?: string[] }) ?? {};

  const col = (
    c: { title?: string; items?: string[] },
    hot: boolean,
  ) => `
    <div style="flex:1;min-width:0;padding:${Math.round(spec.density.gap * 0.8)}px ${Math.round(spec.density.gap * 0.7)}px;
      border-radius:20px;
      background:${hot ? 'var(--accent-soft)' : 'var(--panel)'};
      ${hot ? 'box-shadow:inset 0 0 0 2px var(--accent);' : 'box-shadow:inset 0 0 0 1px var(--hairline);'}">
      <div class="t-meta latin" style="font-weight:800;margin-bottom:14px;
        color:${hot ? 'var(--accent)' : 'var(--ink-soft)'}">${String(c.title ?? '')}</div>
      ${(c.items ?? [])
        .slice(0, spec.density.maxItems)
        .map((t) => `<div class="t-body cjk" style="font-size:${spec.type.caption + 1}px;
          line-height:1.62;margin-bottom:12px">${t}</div>`)
        .join('')}
    </div>`;

  return `
    <div style="display:flex;flex-direction:column;height:100%">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
        ${inlineMotif('rule', input.motifCtx, '', 0)}
        ${b.eyebrow ? `<div class="t-meta latin">${String(b.eyebrow)}</div>` : ''}
      </div>

      ${b.title ? `<h2 class="t-title balance" style="font-family:var(--font-title);
        font-size:${Math.round(spec.type.title * 0.78)}px;margin-bottom:calc(var(--gap) * 1.2)">${String(b.title)}</h2>` : ''}

      <div style="flex:1;display:flex;align-items:center">
        <div style="display:flex;gap:0;align-items:stretch;width:100%;position:relative">
          ${col(left, false)}
          <div style="flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:0;position:relative">
            <div style="position:absolute;width:1px;top:8%;bottom:8%;
              background:repeating-linear-gradient(180deg, var(--hairline) 0 8px, transparent 8px 16px)"></div>
            <div style="position:absolute;width:64px;height:64px;border-radius:50%;
              background:var(--deep);color:var(--ink);
              display:flex;align-items:center;justify-content:center;
              font-size:20px;font-weight:800;letter-spacing:.04em;
              box-shadow:0 0 0 8px var(--bg)">VS</div>
          </div>
          ${col(right, true)}
        </div>
      </div>

      ${b.conclusion ? `
        <div style="margin-top:calc(var(--gap) * 1.15);padding:${Math.round(spec.density.gap * 0.72)}px ${Math.round(spec.density.gap * 0.8)}px;
          background:var(--deep);color:var(--ink);border-radius:18px">
          <div class="t-body" style="font-size:${spec.type.body - 1}px;font-weight:700;line-height:1.5">${String(b.conclusion)}</div>
        </div>` : ''}
    </div>`;
}

/* ------------------------------------------------------------------ */
/* photo_text —— 满铺影像                                               */
/* ------------------------------------------------------------------ */

/**
 * 旧实现只有一种构图：全屏底图 + 底部压字（文字直接贴在图上）。
 * 新骨架把字幕做成**独立色块**（不再靠渐变蒙版硬压），
 * 并给底图加统一的 scrim 保证对比度。没有底图时退化成暗底大字，
 * 而不是旧实现那种「大字 + 大片空白」的废图。
 */
function photoText(input: LayoutInput): string {
  const { blocks: b, spec, photoDataUri } = input;

  if (!photoDataUri) {
    // 没图的退化形态：暗底 + 大字 + 说明，仍然成立
    return `
      <div style="display:flex;flex-direction:column;height:100%;justify-content:center">
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px">
          ${inlineMotif('rule', input.motifCtx, '', 0)}
          <div class="t-meta latin">${String(b.eyebrow ?? '')}</div>
        </div>
        <h2 class="t-title balance" style="font-family:var(--font-title);
          font-size:${Math.round(spec.type.title * 1.05)}px">${String(b.title ?? '')}</h2>
        ${b.subtitle ? `<div class="t-body cjk" style="margin-top:var(--gap);opacity:.86">${String(b.subtitle)}</div>` : ''}
      </div>`;
  }

  // 有图：底部字幕块（用色块而不是纯文字压图）
  return `
    <div style="position:absolute;inset:0;z-index:0;
      background-image:url('${photoDataUri}');background-size:cover;background-position:center"></div>
    <div style="position:absolute;inset:0;z-index:1;background:var(--scrim)"></div>
    <div style="position:relative;z-index:2;display:flex;flex-direction:column;
      justify-content:flex-end;height:100%">
      <div style="max-width:88%">
        <h2 class="t-title balance" style="font-family:var(--font-title);
          font-size:${Math.round(spec.type.title * 1.1)}px;color:#fff;
          text-shadow:0 3px 22px rgba(0,0,0,.55)">${String(b.title ?? '')}</h2>
        ${b.subtitle ? `<div class="t-body cjk" style="margin-top:22px;color:rgba(255,255,255,.9);
          text-shadow:0 2px 14px rgba(0,0,0,.6)">${String(b.subtitle)}</div>` : ''}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* cta —— 收尾                                                          */
/* ------------------------------------------------------------------ */

/**
 * 旧实现是居中 + 一条 72×6 短线 + 一个胶囊按钮，没有任何导流出口。
 * 新骨架：上方短横线 + 居中大字 + 行动语块，底部一行等宽元信息
 * （品牌 / 页码），把"这一组图到站了"这件事说清楚。
 */
function cta(input: LayoutInput): string {
  const { blocks: b, spec, pageNo, motifCtx } = input;
  return `
    <div style="display:flex;flex-direction:column;height:100%;justify-content:center;align-items:center;text-align:center">
      ${inlineMotif('rule', motifCtx, '', Math.round(spec.density.gap * 1.4))}

      <h2 class="t-title balance" style="font-family:var(--font-title);
        font-size:${Math.round(spec.type.title * 1.02)}px;text-align:center">${String(b.title ?? '')}</h2>

      ${b.action ? `
        <div style="margin-top:calc(var(--gap) * 1.2);display:inline-flex;align-items:center;gap:14px;
          padding:24px 44px;border-radius:999px;
          background:var(--accent-soft);color:var(--accent);
          box-shadow:inset 0 0 0 2px var(--accent)">
          <span class="t-body" style="font-size:${spec.type.body + 2}px;font-weight:800">${String(b.action)}</span>
        </div>` : ''}

      <div style="flex:1"></div>
      <div class="t-meta latin" style="opacity:.5">${String(b.brand ?? '')}${pageNo ? ` · ${pageNo}` : ''}</div>
    </div>`;
}

/* ------------------------------------------------------------------ */

export function layoutBody(layout: string, input: LayoutInput): string {
  switch (layout) {
    case 'cover':
      return cover(input);
    case 'quote':
      return quote(input);
    case 'list':
      return list(input);
    case 'steps':
      return steps(input);
    case 'compare':
      return compare(input);
    case 'photo_text':
      return photoText(input);
    case 'cta':
      return cta(input);
    default:
      return `<div class="t-title">${String(input.blocks.title ?? '')}</div>`;
  }
}

/** 装饰往哪摆 —— 由版式决定（引用卡要框感，图卡要横向带）。 */
export function motifZone(layout: string): 'corners' | 'frame' | 'strip' {
  if (layout === 'photo_text') return 'strip';
  if (layout === 'quote') return 'frame';
  return 'corners';
}
