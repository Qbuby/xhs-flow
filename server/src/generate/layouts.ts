import type { ResolvedSpec } from './design/index.js';
import { badgeText, inlineMotif, type MotifContext } from './design/index.js';
import { escapeHtml, highlightHtml } from './card-text.js';
import { stripEmoji } from '../util/text.js';

/**
 * 文案 → 高亮 HTML。
 *
 * 之前 layouts.ts 到处 `String(b.title)` 直接插值，模型按约定写的
 * `[[强调]]` 标记成了字面量「[[栏目]]」画在封面上。现在统一走
 * highlightHtml：`[[ ]]` 被替换成 `.hl` span，由 cards.ts 的
 * accentCss 按契约的 accent_style 决定怎么画。
 */
function rich(v: unknown, spec: ResolvedSpec): string {
  return highlightHtml(stripEmoji(String(v ?? '')), spec);
}

/** 不带强调标记的文案：清 emoji + 转义（元信息/页眉页脚类短字用）。 */
function esc(v: unknown): string {
  return escapeHtml(stripEmoji(String(v ?? '')));
}

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
            <div class="t-body" style="flex:1">${rich(t, spec)}</div></div>`;
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
    font-size:20px;font-weight:800;font-variant-numeric:tabular-nums">${escapeHtml(text)}</span>`;
}

/**
 * 分栏包装：账号模板蒸馏出 2-3 栏时，把条目内容排进 CSS 多栏。
 *
 * 之前 `columns` 字段除定义外零消费 —— 蒸馏端说了分栏，渲染端永远是单栏。
 * 这里让它真正进布局：>1 栏走 `column-count`（内容自动回流，不会溢出），
 * 1 栏维持原状，行为完全由蒸馏证据驱动。只包条目区，标题保持通栏。
 */
function twoColumnWrap(spec: ResolvedSpec, inner: string): string {
  const cols = spec.accountTemplate.columns;
  if (cols <= 1) return inner;
  const gap = Math.max(28, spec.density.gap);
  return `<div style="column-count:${cols};column-gap:${gap}px;column-rule:1px solid var(--hairline)">${inner}</div>`;
}

/**
 * 内页左上角的大号编号（01/02/03…）—— 已上收到 cards.ts 画。
 *
 * 原因：编号要按**画布绝对坐标**（原图实测 x=69,y=161,字号88）摆放，
 * 而 layoutBody 的输出被包在 .card 的 padding box 里，绝对定位会叠加
 * chrome 注入的 padding —— 两层各算一半，谁也对不齐（实测踩坑：
 * 编号落在 y=301 而非 161）。cards.ts 知道注入的 padding 全值，
 * 编号由它渲染（accountPageNumber），这里只保留语义。
 */

/** 编号已上收到 cards.ts（accountPageNumber）：画布绝对坐标只有它知道。 */
function innerPageNo(_spec: ResolvedSpec, _pageNo: string): string {
  return '';
}

/* ------------------------------------------------------------------ */
/* cover —— 非对称封面                                                  */
/* ------------------------------------------------------------------ */

/**
 * 封面 —— 对照原账号 339/0.jpg 实测骨架（wow-ip-trend-v1）：
 *
 *   [页眉条 128px：logo | 两行文字（右对齐）]
 *   [大标题黑字（上部，y≈253 起，两行）]
 *   [蓝底白字强调块（y≈420..600，高约180px，宽度≈内容 56%）]
 *   [副题行（黑粗）]
 *   [2×2 比较矩阵（浅灰底块）] —— items 4 条时
 *   [底部三组固定服务文案（归属模板族，不进动态内容）]
 *
 * 旧骨架「上半留白、下半压字」与原账号完全相反 —— 原账号标题在**上部**，
 * 下部是结构化的比较内容。模型给 title 里带 \n 时，第二个"逻辑段"渲染成
 * 蓝底白字块（这是原账号封面的标志件）。
 */
function cover(input: LayoutInput): string {
  const { blocks: b, spec, motifCtx } = input;
  const items = (b.items as string[]) ?? [];
  const useVertical = spec.motifs.includes('vertical-tag');
  const title = String(b.title ?? '');

  // 标题拆两段：\n 前是黑字主标，\n 后（如有）进蓝底白字块。
  // [[强调]] 只在主标里生效；蓝块整块就是强调，不再嵌套高亮。
  const segs = title.split('\n').map((s) => s.trim()).filter(Boolean);
  const mainTitle = segs[0] ?? '';
  const blockTitle = segs[1] ?? '';

  // 主标字号：原账号黑字标题字面高约 46px/行（bbox 253..299），约 88px/行含行距
  const lines = Math.max(1, mainTitle.length === 0 ? 1 : Math.ceil(mainTitle.length / 13));
  const titleSize = lines >= 3 ? Math.round(spec.type.display * 0.62) : lines === 2 ? Math.round(spec.type.display * 0.82) : spec.type.display;

  // 蓝底白字块：原账号 bbox 71..679 × 420..600 → 宽约 609px、高 180px、
  // 左对齐、文字约 110px。宽度按文字长度撑（max 62%），内边距上下均匀。
  // [[ ]] 标记同样走 rich()：蓝块整块已是强调，模型若再标 [[ ]] 也不该
  // 露出字面括号（smoke 曾抓到 [[新趋势]] 直接印在块里）。
  const blockFont = Math.round(spec.type.display * 0.92);
  const blockHtml = blockTitle
    ? `<div style="display:inline-block;align-self:flex-start;
        background:var(--accent);color:var(--on-accent);
        padding:${Math.round(blockFont * 0.32)}px ${Math.round(blockFont * 0.5)}px;
        margin:26px 0 34px">
        <span style="font-size:${blockFont}px;font-weight:800;line-height:1.15;
          letter-spacing:0;display:block">${rich(blockTitle, spec)}</span>
      </div>`
    : '';

  // items 有 4 条时走 2×2 比较矩阵（原账号封面下部的灰底块）；
  // 2-3 条维持原来的短句列表。
  const matrix = items.length >= 4
    ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px 20px;margin-bottom:var(--gap)">
        ${items.slice(0, 4).map((t) => `
          <div style="background:var(--panel);min-height:172px;
            display:flex;align-items:center;justify-content:center;padding:24px">
            <span class="t-body" style="font-size:${Math.round(spec.type.body * 1.35)}px;font-weight:700;color:var(--ink);text-align:center">${rich(t, spec)}</span>
          </div>`).join('')}
      </div>`
    : '';

  return `
    <div style="display:flex;flex-direction:column;height:100%;${useVertical ? 'padding-right:74px' : ''}">
      <div style="display:flex;align-items:center;gap:16px">
        ${inlineMotif('rule', motifCtx, '', 0)}
        ${b.eyebrow ? `<div class="t-meta latin">${rich(b.eyebrow, spec)}</div>` : ''}
      </div>

      <h1 class="t-title balance" style="font-size:${Math.round(titleSize)}px;
          font-family:var(--font-title);margin-top:44px">${rich(mainTitle, spec)}</h1>

      ${blockHtml}

      ${b.hint ? `<div class="t-title" style="font-size:${Math.round(spec.type.body * 1.5)}px;
        font-weight:800;margin-bottom:30px">${rich(b.hint, spec)}</div>` : ''}

      ${items.length ? (matrix || `<div style="margin-bottom:var(--gap)">${bullets(items.slice(0, spec.density.maxItems), spec, motifCtx)}</div>`) : ''}

      <div style="flex:1"></div>
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
  const family = spec.accountTemplate.family ?? 'generic-enum-v1';

  const quoteBody = `
      <div aria-hidden="true" data-bleed="1" style="position:absolute;top:-140px;left:-40px;
        font-family:var(--font-title);font-size:${Math.round(spec.type.display * 3.4)}px;
        line-height:1;color:var(--accent);opacity:.13;pointer-events:none">&#8220;</div>

      <div class="t-title balance" style="font-family:var(--font-title);position:relative;
        font-size:${Math.round(spec.type.title * 1.28)}px;margin-bottom:calc(var(--gap) * 1.1)">
        ${rich(b.text, spec)}
      </div>

      ${b.note ? `<div class="t-body cjk" style="max-width:78%;opacity:.86">${rich(b.note, spec)}</div>` : ''}

      ${b.attribution ? `
        <div style="margin-top:calc(var(--gap) * 1.4);display:flex;align-items:center;gap:18px">
          ${inlineMotif('rule', motifCtx, '', 0)}
          <span class="t-meta latin" style="color:var(--accent);font-weight:700">${rich(b.attribution, spec)}</span>
        </div>` : ''}`;

  // 无账号模板的通用模式：保留原来的居中出血引号骨架
  if (family === 'generic-enum-v1') {
    return `
    <div style="position:relative;height:100%;display:flex;flex-direction:column;
                justify-content:center;${framed ? 'padding-left:56px' : ''}">
      ${quoteBody}
    </div>`;
  }

  // 复刻模式：编号在 chrome 层，标题 y266 起，金句作正文区内容
  return `
    <div style="position:relative;display:flex;flex-direction:column;height:100%;">
      ${b.title ? `<h2 class="t-title" style="font-family:var(--font-title);
        font-size:${Math.round(spec.type.title * 0.74)}px;margin:calc(266px - var(--pad-top, 0px)) calc(69px - var(--pad-x, 0px)) 0;line-height:1.3">${rich(b.title, spec)}</h2>` : ''}
      <div style="margin:calc(475px - var(--pad-top, 0px)) calc(69px - var(--pad-x, 0px)) 0;${framed ? 'border-left:6px solid var(--accent);padding-left:38px;' : ''}">
        ${quoteBody}
      </div>
    </div>`;
}

/**
 * 内页正文骨架 —— **按模板族**排。
 *
 * 各族顶部元素与正文起排的实测值（全部 1080×1440 画布坐标）：
 *   wow-ip-trend-v1  （339/1）编号 y161 与标题同行；标题 x≈250 起
 *   wow-brand-case-v1（340/1）细字编号 y131 + 横线；标题 y266；正文 y475
 *   wow-title-top-v1 （342/1）**无页码**，标题直接置顶 y≈153；正文 y≈380
 *   wow-blue-tag-v1  （357/2）蓝底反白标签 y99..166；标题 y≈220；正文 y≈400
 *
 * 版式不同是事实不是 bug；用同一套骨架渲染必然有一族错位。
 * 所有 y 都是画布坐标，内容层原点已下移 --pad-top/--pad-x，用 calc 抵扣。
 */
function innerBody(
  input: LayoutInput,
  content: string,
): string {
  const { spec, motifCtx } = input;
  const b = input.blocks;
  const family = spec.accountTemplate.family ?? 'generic-enum-v1';
  const itemsRaw = (b.items as Array<{ text?: string; note?: string }>) ?? [];
  const hasItems = itemsRaw.length > 0;

  /** titleTop / bodyTop：按族给画布坐标。 */
  const FAMILY_TOP: Record<string, { title: number; body: number }> = {
    'wow-brand-case-v1': { title: 266, body: 475 },
    'wow-title-top-v1': { title: 153, body: 380 },
    'wow-blue-tag-v1': { title: 220, body: 400 },
  };
  const top = FAMILY_TOP[family];

  // 有实测顶部起排的族：标题按画布坐标落位，正文另起
  if (top) {
    const titleFont = Math.round(spec.type.title * 0.74);
    return `
      <div style="display:flex;flex-direction:column;height:100%">
        ${b.eyebrow ? `<div class="t-meta latin" style="margin:calc(99px - var(--pad-top, 0px)) calc(69px - var(--pad-x, 0px)) 0;letter-spacing:0.22em">${rich(b.eyebrow, spec)}</div>` : ''}
        ${b.title ? `<h2 class="t-title" style="font-family:var(--font-title);
          font-size:${titleFont}px;margin:calc(${top.title}px - var(--pad-top, 0px)) calc(69px - var(--pad-x, 0px)) 0;line-height:1.3">${rich(b.title, spec)}</h2>` : ''}
        ${hasItems ? `<div style="margin:calc(${top.body}px - var(--pad-top, 0px)) calc(69px - var(--pad-x, 0px)) 0">${content}</div>` : ''}
      </div>`;
  }

  // ip-trend 族（以及未标注族的旧数据）：编号与标题同行
  return `
    <div style="display:flex;flex-direction:column;height:100%">
      ${b.title ? `<h2 class="t-title" style="font-family:var(--font-title);
        font-size:${Math.round(spec.type.title * 0.72)}px;
        margin:52px 0 0 200px;
        white-space:nowrap">${rich(b.title, spec)}</h2>` : ''}
      <div style="display:flex;align-items:center;gap:16px;margin:26px 0 20px 69px">
        ${inlineMotif('rule', motifCtx, '', 0)}
        ${b.eyebrow ? `<div class="t-meta latin">${rich(b.eyebrow, spec)}</div>` : ''}
      </div>
      ${hasItems ? `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-start;margin:40px 69px 0">${content}</div>` : ''}
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
  const family = spec.accountTemplate.family ?? 'generic-enum-v1';

  // 条目本体：两族共用，差异只在骨架（innerBody）
  const itemsHtml = twoColumnWrap(spec, `
      ${items
        .map(
          (it, i) => `
        <div style="display:flex;gap:22px;align-items:flex-start;
          padding:${Math.round(spec.density.gap * 0.62)}px 0;
          ${i > 0 ? 'border-top:1px solid var(--hairline);' : ''}">
          <span style="flex:0 0 auto">${badgeMark(spec, badgeText(i))}</span>
          <div style="flex:1;min-width:0">
            <div class="t-body" style="font-size:${spec.type.body + 2}px;font-weight:700">${rich(it.text, spec)}</div>
            ${it.note ? `<div class="t-body cjk" style="font-size:${spec.type.caption}px;opacity:.72;margin-top:8px">${rich(it.note, spec)}</div>` : ''}
          </div>
        </div>`,
        )
        .join('')}
    `);

  // brand-case 族的列表是「小序号 + 词条」分隔行（340/2：01 字体 / 02 色彩 …）
  if (family === 'wow-brand-case-v1') {
    return innerBody(input, `<div style="display:flex;flex-direction:column">
      ${items
        .map(
          (it, i) => `
        <div style="display:flex;align-items:baseline;gap:34px;
          padding:34px 0;border-bottom:1px solid var(--hairline)">
          <span style="font-size:26px;font-weight:700;letter-spacing:0.1em;color:var(--accent);
            font-variant-numeric:tabular-nums;flex:0 0 46px">${badgeText(i)}</span>
          <span class="t-title" style="font-family:var(--font-title);
            font-size:${Math.round(spec.type.title * 0.5)}px">${rich(it.text, spec)}</span>
          ${it.note ? `<span class="t-body" style="margin-left:auto;font-size:${spec.type.caption}px;
            color:var(--ink-soft);opacity:.7">${rich(it.note, spec)}</span>` : ''}
        </div>`,
        )
        .join('')}
    </div>`);
  }

  return innerBody(input, itemsHtml);
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
  const { blocks: b, spec } = input;
  const raw = (b.items as Array<{ text?: string; note?: string }>) ?? [];
  const items = raw.slice(0, spec.density.maxItems);
  const dot = Math.round(spec.type.body * 1.05);

  const timeline = `<div style="position:relative;padding-left:${dot + 26}px">
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
              <div class="t-body" style="font-size:${spec.type.body + 2}px;font-weight:700;line-height:1.42">${rich(it.text, spec)}</div>
              ${it.note ? `<div class="t-body cjk" style="font-size:${spec.type.caption}px;opacity:.72;margin-top:8px">${rich(it.note, spec)}</div>` : ''}
            </div>`,
            )
            .join('')}
        </div>
      </div>`;

  return innerBody(input, timeline);
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
        color:${hot ? 'var(--accent)' : 'var(--ink-soft)'}">${escapeHtml(c.title ?? '')}</div>
      ${(c.items ?? [])
        .slice(0, spec.density.maxItems)
        .map((t) => `<div class="t-body cjk" style="font-size:${spec.type.caption + 1}px;
          line-height:1.62;margin-bottom:12px">${rich(t, spec)}</div>`)
        .join('')}
    </div>`;

  const family = spec.accountTemplate.family ?? 'generic-enum-v1';

  if (family === 'generic-enum-v1') {
    return `
    <div style="display:flex;flex-direction:column;height:100%">
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
        ${inlineMotif('rule', input.motifCtx, '', 0)}
        ${b.eyebrow ? `<div class="t-meta latin">${rich(b.eyebrow, spec)}</div>` : ''}
      </div>

      ${b.title ? `<h2 class="t-title balance" style="font-family:var(--font-title);
        font-size:${Math.round(spec.type.title * 0.78)}px;margin-bottom:calc(var(--gap) * 1.2)">${rich(b.title, spec)}</h2>` : ''}

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
          <div class="t-body" style="font-size:${spec.type.body - 1}px;font-weight:700;line-height:1.5">${rich(b.conclusion, spec)}</div>
        </div>` : ''}
    </div>`;
  }

  // 复刻模式（340 实测）：标题 y266 起，双栏对比块从 y≈475 起，
  // 中间用「→」箭头（原图是细箭头，不是 VS 圆徽章），左列浅底右列强调色底。
  return `
    <div style="display:flex;flex-direction:column;height:100%">
      ${b.title ? `<h2 class="t-title" style="font-family:var(--font-title);
        font-size:${Math.round(spec.type.title * 0.74)}px;margin:calc(266px - var(--pad-top, 0px)) calc(69px - var(--pad-x, 0px)) 0;line-height:1.3">${rich(b.title, spec)}</h2>` : ''}

      <div style="margin:calc(475px - var(--pad-top, 0px)) calc(69px - var(--pad-x, 0px)) 0;display:flex;align-items:stretch;gap:0;position:relative">
        <div style="flex:1;min-width:0;background:var(--panel);
          padding:${Math.round(spec.density.gap * 0.8)}px;border-radius:18px">
          <div class="t-meta latin" style="font-weight:700;margin-bottom:16px;color:var(--ink-soft)">
            ${escapeHtml(left.title ?? '')}</div>
          ${(left.items ?? []).slice(0, 4).map((t) => `
            <div class="t-body cjk" style="font-size:${spec.type.body}px;line-height:1.6;
              margin-bottom:10px">${rich(t, spec)}</div>`).join('')}
        </div>
        <div style="flex:0 0 76px;display:flex;align-items:center;justify-content:center;
          font-size:40px;font-weight:800;color:var(--accent)">&#8594;</div>
        <div style="flex:1;min-width:0;background:var(--accent);color:var(--on-accent);
          padding:${Math.round(spec.density.gap * 0.8)}px;border-radius:18px">
          <div class="t-meta latin" style="font-weight:700;margin-bottom:16px;opacity:.85">
            ${escapeHtml(right.title ?? '')}</div>
          ${(right.items ?? []).slice(0, 4).map((t) => `
            <div class="t-body cjk" style="font-size:${spec.type.body}px;line-height:1.6;
              margin-bottom:10px">${rich(t, spec)}</div>`).join('')}
        </div>
      </div>

      ${b.conclusion ? `
        <div style="margin:44px 0 0;padding:30px 34px;
          border-left:6px solid var(--accent);background:var(--panel)">
          <div class="t-body" style="font-size:${spec.type.body + 4}px;font-weight:700;line-height:1.5">${rich(b.conclusion, spec)}</div>
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
  const family = spec.accountTemplate.family ?? 'generic-enum-v1';

  if (!photoDataUri) {
    // 没图的退化形态：复刻模式下按族骨架排（有编号、有标题行），
    // 不能退回通用「居中大字」——那正是原账号没有的构图。
    if (family !== 'generic-enum-v1') {
      return innerBody(
        input,
        `<div style="padding:36px 0">
          <div class="t-title" style="font-family:var(--font-title);
            font-size:${Math.round(spec.type.title * 0.6)}px">${rich(b.title ?? '', spec)}</div>
          ${b.subtitle ? `<div class="t-body cjk" style="margin-top:26px;opacity:.86">${rich(b.subtitle, spec)}</div>` : ''}
        </div>`,
      );
    }
    return `
      <div style="display:flex;flex-direction:column;height:100%;justify-content:center">
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px">
          ${inlineMotif('rule', input.motifCtx, '', 0)}
          <div class="t-meta latin">${rich(b.eyebrow ?? '', spec)}</div>
        </div>
        <h2 class="t-title balance" style="font-family:var(--font-title);
          font-size:${Math.round(spec.type.title * 1.05)}px">${rich(b.title ?? '', spec)}</h2>
        ${b.subtitle ? `<div class="t-body cjk" style="margin-top:var(--gap);opacity:.86">${rich(b.subtitle, spec)}</div>` : ''}
      </div>`;
  }

  // 复刻模式有图：原账号的图卡是**上方配图 + 下方文字**（340/1 右下图区），
  // 不是满铺压字。底部页脚条由 chrome 层负责，这里只排图文区。
  if (family !== 'generic-enum-v1') {
    return `
    <div style="position:relative;display:flex;flex-direction:column;height:100%">
      ${b.title ? `<h2 class="t-title" style="font-family:var(--font-title);
        font-size:${Math.round(spec.type.title * 0.7)}px;margin:calc(266px - var(--pad-top, 0px)) calc(69px - var(--pad-x, 0px)) 0;line-height:1.3">${rich(b.title, spec)}</h2>` : ''}
      <div style="margin:calc(430px - var(--pad-top, 0px)) calc(69px - var(--pad-x, 0px)) 0;border-radius:18px;overflow:hidden;
        background-image:url('${photoDataUri}');background-size:cover;background-position:center;
        aspect-ratio:4/3"></div>
      ${b.subtitle ? `<div class="t-body cjk" style="margin:30px 0 0;opacity:.86">${rich(b.subtitle, spec)}</div>` : ''}
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
          text-shadow:0 3px 22px rgba(0,0,0,.55)">${rich(b.title ?? '', spec)}</h2>
        ${b.subtitle ? `<div class="t-body cjk" style="margin-top:22px;color:rgba(255,255,255,.9);
          text-shadow:0 2px 14px rgba(0,0,0,.6)">${rich(b.subtitle, spec)}</div>` : ''}
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
  const family = spec.accountTemplate.family ?? 'generic-enum-v1';

  // 复刻模式：收尾页与内页同骨架（左上编号 + 标题 y266 + 行动块），
  // 不是通用模式的居中胶囊。原账号的收尾页同样是左对齐版式。
  if (family !== 'generic-enum-v1') {
    return `
    <div style="display:flex;flex-direction:column;height:100%">
      ${b.title ? `<h2 class="t-title" style="font-family:var(--font-title);
        font-size:${Math.round(spec.type.title * 0.74)}px;margin:calc(266px - var(--pad-top, 0px)) calc(69px - var(--pad-x, 0px)) 0;line-height:1.3">${rich(b.title, spec)}</h2>` : ''}
      ${b.action ? `
        <div style="margin:calc(475px - var(--pad-top, 0px)) calc(69px - var(--pad-x, 0px)) 0;display:inline-flex;align-self:flex-start;align-items:center;gap:18px;
          padding:32px 46px;border-radius:999px;
          background:var(--accent);color:var(--on-accent)">
          <span class="t-body" style="font-size:${spec.type.body + 6}px;font-weight:800">${rich(b.action, spec)}</span>
          <span style="font-size:34px;line-height:1">&#8594;</span>
        </div>` : ''}
      <div style="flex:1"></div>
    </div>`;
  }

  return `
    <div style="display:flex;flex-direction:column;height:100%;justify-content:center;align-items:center;text-align:center">
      ${inlineMotif('rule', motifCtx, '', Math.round(spec.density.gap * 1.4))}

      <h2 class="t-title balance" style="font-family:var(--font-title);
        font-size:${Math.round(spec.type.title * 1.02)}px;text-align:center">${rich(b.title ?? '', spec)}</h2>

      ${b.action ? `
        <div style="margin-top:calc(var(--gap) * 1.2);display:inline-flex;align-items:center;gap:14px;
          padding:24px 44px;border-radius:999px;
          background:var(--accent-soft);color:var(--accent);
          box-shadow:inset 0 0 0 2px var(--accent)">
          <span class="t-body" style="font-size:${spec.type.body + 2}px;font-weight:800">${rich(b.action, spec)}</span>
        </div>` : ''}

      <div style="flex:1"></div>
      <div class="t-meta latin" style="opacity:.5">${esc(b.brand ?? '')}${pageNo ? ` · ${escapeHtml(pageNo)}` : ''}</div>
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
      return `<div class="t-title">${rich(input.blocks.title ?? '', input.spec)}</div>`;
  }
}

/** 装饰往哪摆 —— 由版式决定（引用卡要框感，图卡要横向带）。 */
export function motifZone(layout: string): 'corners' | 'frame' | 'strip' {
  if (layout === 'photo_text') return 'strip';
  if (layout === 'quote') return 'frame';
  return 'corners';
}
