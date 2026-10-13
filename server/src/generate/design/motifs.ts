import type { Motif } from './contract.js';
import type { Palette } from './contract.js';

/**
 * 装饰件库。
 *
 * 【旧实现只有两个 div】
 * `decoration()` 整个函数只产出：一个 120px 的 CSS 三角形，或三个「·」字符。
 * 再叠加 `decoration` 默认 `'none'` 且 emoji 被禁用，实际可用的装饰就是
 * 「没有」和「三个点」。这直接导致版面「元素少、创造力不够」。
 *
 * 【这里给什么】
 * 一批**可组合**的 SVG/CSS 装饰件，全部是代码画的（不引图标库、不落静态资源）。
 * 设计上守两条：
 *  1. 每个装饰件都必须是**功能性**的（分隔、编号、标记、提供节奏），
 *     不是纯装饰。纯装饰堆多了就是廉价。
 *  2. 全部只吃主题色板里的颜色，所以换主题自动协调，不会出现撞色。
 *
 * 用法：`motifLayer(resolved, { pageNo, eyebrow })` 出一层绝对定位的装饰，
 * 与内容层分离 —— 这样内容换版式不用管装饰，装饰换主题不用管内容。
 */

export interface MotifContext {
  palette: Palette;
  /** 页码文本，如 "01" */
  pageNo?: string;
  /** 竖排标签 / 走马灯条的文本 */
  tag?: string;
  /** 深色主题 */
  dark: boolean;
  /** 字体：走马灯与页码用等宽更好看 */
  fontMono: string;
  fontBody: string;
}

/** 单条短横线。可作为标题上方/下方的节奏点。 */
function rule(p: Palette): string {
  return `<div style="width:96px;height:6px;border-radius:3px;background:${p.accent}"></div>`;
}

/** 渐隐分隔线。比短横线更轻，适合次级分隔。 */
function ruleFade(p: Palette): string {
  return `<div style="width:100%;height:1px;background:linear-gradient(90deg, ${p.accent} 0%, ${p.accent}44 34%, transparent 100%)"></div>`;
}

/** 编号徽章：实心圆角方块 + 数字。可当列表序号或页序。 */
function badge(p: Palette, text: string): string {
  return `<div style="display:inline-flex;align-items:center;justify-content:center;
    min-width:56px;height:56px;padding:0 14px;border-radius:14px;
    background:${p.accent};color:${p.bg};
    font-size:24px;font-weight:800;letter-spacing:0.02em;font-variant-numeric:tabular-nums">${text}</div>`;
}

/** 角标：右上角一个直角块（不是三角，三角太 2008）。 */
function corner(p: Palette): string {
  return `<div style="position:absolute;top:0;right:0;width:180px;height:14px;background:${p.accent}"></div>`;
}

/** 括号：内容左右的一对竖线，给内容加"被引用"的框感。 */
function bracket(p: Palette): string {
  return `<div style="position:absolute;left:0;top:0;bottom:0;width:8px;background:${p.accent}"></div>`;
}

/** 印章：圆形描边 + 文字，档案风的签字感。 */
function seal(p: Palette, text: string): string {
  return `<div style="position:absolute;right:88px;bottom:132px;
    width:148px;height:148px;border-radius:50%;
    border:3px solid ${p.accent};color:${p.accent};
    display:flex;align-items:center;justify-content:center;text-align:center;
    font-size:22px;font-weight:800;line-height:1.15;letter-spacing:0.06em;
    transform:rotate(-11deg);opacity:0.78;padding:0 12px">${text}</div>`;
}

/** 走马灯条：一条深色底 + 等宽小字，横向贯穿。 */
function ticker(p: Palette, text: string, fontMono: string): string {
  return `<div style="position:absolute;left:0;right:0;bottom:0;height:72px;
    background:${p.deep};color:${p.inkSoft};
    display:flex;align-items:center;padding:0 40px;
    font-family:${fontMono};font-size:20px;letter-spacing:0.14em;text-transform:uppercase;
    white-space:nowrap;overflow:hidden">${text}</div>`;
}

/** 竖排标签。中文竖排是国风/杂志感的高辨识度元素（`writing-mode` 原生支持）。 */
function verticalTag(p: Palette, text: string, fontBody: string): string {
  return `<div style="position:absolute;right:0;top:0;bottom:0;width:74px;
    background:${p.deep};display:flex;align-items:center;justify-content:center">
    <div style="writing-mode:vertical-rl;color:${p.tint};
      font-family:${fontBody};font-size:26px;letter-spacing:0.34em;font-weight:700">${text}</div>
  </div>`;
}

/** 页码：右下角等宽数字 + 一条短下划线。 */
function pageNum(p: Palette, text: string, fontMono: string): string {
  return `<div style="position:absolute;right:88px;bottom:88px;text-align:right">
    <div style="font-family:${fontMono};font-size:34px;font-weight:600;
      color:${p.accent};font-variant-numeric:tabular-nums;line-height:1">${text}</div>
    <div style="width:44px;height:2px;background:${p.accent}66;margin:10px 0 0 auto"></div>
  </div>`;
}

/** 点阵：右下角一行小点，最小的装饰。 */
function dots(p: Palette): string {
  return `<div style="position:absolute;right:92px;bottom:100px;display:flex;gap:12px">
    ${[0, 1, 2]
      .map(
        (i) =>
          `<div style="width:10px;height:10px;border-radius:50%;background:${p.accent};opacity:${(0.85 - i * 0.26).toFixed(2)}"></div>`,
      )
      .join('')}
  </div>`;
}

/* ------------------------------------------------------------------ */
/* 组合                                                                */
/* ------------------------------------------------------------------ */

/**
 * 出一层装饰。
 *
 * 注意**装饰不参与布局**（全是绝对定位），所以永远不会把内容挤变形 ——
 * 这也是把它跟内容层分开的原因。内容层自己管排版，装饰层只在边缘活动。
 *
 * `zone` 决定装饰往哪摆：
 *  - 'corners' —— 常规卡：角标/页码/印章/点阵
 *  - 'frame'   —— 需要框感的卡（引用、金句）：括号
 *  - 'strip'   —— 需要横向带的卡（实证/图桥）：走马灯条/竖排标签
 */
export function motifLayer(
  motifs: Motif[],
  ctx: MotifContext,
  zone: 'corners' | 'frame' | 'strip' = 'corners',
): string {
  const p = ctx.palette;
  const parts: string[] = [];
  const pageNo = ctx.pageNo ?? '';
  const tag = ctx.tag ?? '';

  for (const m of motifs) {
    switch (m) {
      case 'corner':
        parts.push(corner(p));
        break;
      case 'bracket':
        if (zone === 'frame') parts.push(bracket(p));
        break;
      case 'seal':
        if (tag) parts.push(seal(p, tag));
        break;
      case 'ticker':
        if (zone === 'strip') parts.push(ticker(p, tag || pageNo, ctx.fontMono));
        break;
      case 'vertical-tag':
        if (zone === 'strip' && tag) parts.push(verticalTag(p, tag, ctx.fontBody));
        break;
      case 'page-num':
        if (pageNo) parts.push(pageNum(p, pageNo, ctx.fontMono));
        break;
      case 'dots':
        parts.push(dots(p));
        break;
      // rule / rule-fade / badge 是**行内**装饰，由版式在内容流里调用（见 inlineMotif）
      default:
        break;
    }
  }

  if (parts.length === 0) return '';
  // class 留给自检脚本（check-layout.ts）识别「这是装饰层」
  return `<div class="motif-layer" style="position:absolute;inset:0;z-index:3;pointer-events:none">${parts.join('')}</div>`;
}

/**
 * 行内装饰：需要参与内容流的那些（短横线 / 渐隐线 / 徽章）。
 *
 * 版式把它们插在标题上方、条目之间，用来制造节奏 —— 这是旧实现完全没有的
 * 一件事：旧版的 list/steps 就是一堆 flex 行，没有任何视觉分隔与呼吸。
 */
export function inlineMotif(
  m: Motif,
  ctx: MotifContext,
  text = '',
  marginBottom = 28,
): string {
  const p = ctx.palette;
  switch (m) {
    case 'rule':
      return `<div style="margin-bottom:${marginBottom}px">${rule(p)}</div>`;
    case 'rule-fade':
      return `<div style="margin-bottom:${marginBottom}px">${ruleFade(p)}</div>`;
    case 'badge':
      return `<div style="margin-bottom:${marginBottom}px">${badge(p, text)}</div>`;
    default:
      return '';
  }
}

/** 目录页用的编号徽章组，避免版式自己拼。 */
export function badgeText(index: number): string {
  return String(index + 1).padStart(2, '0');
}
