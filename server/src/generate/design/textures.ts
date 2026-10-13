import type { Texture } from './contract.js';

/**
 * 纹理层。
 *
 * 【为什么这一层是「廉价」与「有质感」的分界】
 *
 * 一张纯色/线性渐变的 1080×1440 卡片，在手机上是**一大块塑料**：
 * 渐变色带（banding）肉眼可见、没有材质、没有尺度感。而真实印刷品
 * 无论纸张、胶片还是铜版纸，表面都有微弱的不均匀 —— 那就是「质感」。
 *
 * 一层 `feTurbulence` 噪点 + `mix-blend-mode: overlay` 就能伪造出来，
 * 成本是一个 div，收益是整张卡片从"PPT 背景"变成"印刷品"。
 * 这类配方是通用 CSS 技术（kane50613/takumi 的视觉特效文档里有同款做法，
 * Apache-2.0；这里是自己写的实现，只采纳手法）。
 *
 * 【实现注意】
 * - 全部用 **data-URI 内联 SVG**，不落文件、不引资源目录
 * - `#` 交给 `encodeURIComponent` 编码成 `%23`，浏览器解码后仍是合法的
 *   fragment 引用 —— 所以源码里直接写 `#000`，**不要**手工预编码
 * - 噪点瓦片 220~260px 就够，铺满 1080×1440 时肉眼看不出重复
 */

/** 把内联 SVG 编码成 CSS 可用的 data-URI。 */
function svgUri(svg: string): string {
  const compact = svg.replace(/\s+/g, ' ').trim();
  return `url("data:image/svg+xml,${encodeURIComponent(compact).replace(/'/g, '%27')}")`;
}

/* ------------------------------------------------------------------ */
/* 噪点：纸张 / 胶片                                                   */
/* ------------------------------------------------------------------ */

/**
 * 分形噪声瓦片。
 *
 * `baseFrequency` 越大颗粒越细。纸感用 0.9（细密），胶片用 0.55（更粗）。
 * `numOctaves: 4` 让噪声有层次，只有 1 层会像电视雪花。
 */
function grainTile(baseFrequency: number, size = 220): string {
  return svgUri(`<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'>
    <filter id='g'>
      <feTurbulence type='fractalNoise' baseFrequency='${baseFrequency}' numOctaves='4' stitchTiles='stitch'/>
      <feColorMatrix type='saturate' values='0'/>
    </filter>
    <rect width='${size}' height='${size}' filter='url(#g)'/>
  </svg>`);
}

/* ------------------------------------------------------------------ */
/* 半调网点                                                            */
/* ------------------------------------------------------------------ */

/** 规则网点。径向渐变平铺，配 mix-blend-mode 就能做出印刷网点感。 */
function halftoneTile(spacing = 7, dot = 1.1): string {
  return svgUri(`<svg xmlns='http://www.w3.org/2000/svg' width='${spacing}' height='${spacing}'>
    <circle cx='${spacing / 2}' cy='${spacing / 2}' r='${dot}' fill='#000'/>
  </svg>`);
}

/* ------------------------------------------------------------------ */
/* 发丝网格                                                            */
/* ------------------------------------------------------------------ */

/** 40px 发丝网格。配合 mask 向角落淡出（见 textureLayer 的 mask）。 */
function hairlineGrid(size = 44, weight = 1): string {
  return svgUri(`<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'>
    <path d='M ${size} 0 L 0 0 0 ${size}' fill='none' stroke='#000' stroke-width='${weight}'/>
  </svg>`);
}

/* ------------------------------------------------------------------ */
/* 柔焦光晕                                                            */
/* ------------------------------------------------------------------ */

/**
 * 柔焦色团。**不用图片、不用 SVG blur** —— 直接在 DOM 里放几个
 * 错位的大 radial-gradient 圆 + `filter: blur()`。
 *
 * 这是成本最低的「脱离纯色背景」手段：暖白底 + 3 个错位模糊色团，
 * 立刻就有了空气感与纵深。色值取自当前主题的色板，所以每套主题
 * 的光晕颜色不同。
 */
export function hazeBlobs(accent: string, tint: string): string {
  return `
    <div style="position:absolute;inset:0;overflow:hidden">
      <div style="position:absolute;width:760px;height:760px;border-radius:50%;
                  top:-180px;right:-200px;background:radial-gradient(circle, ${accent}44 0%, transparent 68%);
                  filter:blur(60px)"></div>
      <div style="position:absolute;width:560px;height:560px;border-radius:50%;
                  bottom:-140px;left:-160px;background:radial-gradient(circle, ${tint}cc 0%, transparent 70%);
                  filter:blur(70px)"></div>
      <div style="position:absolute;width:420px;height:420px;border-radius:50%;
                  top:46%;left:38%;background:radial-gradient(circle, ${accent}22 0%, transparent 72%);
                  filter:blur(80px)"></div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* 组装纹理层                                                          */
/* ------------------------------------------------------------------ */

export interface TextureLayerOptions {
  texture: Texture;
  /** 卡片底色，用于决定噪点的混合模式（浅底用 multiply 会脏，用 overlay） */
  bg: string;
  accent: string;
  tint: string;
  /** 主题是否为深色底 */
  dark: boolean;
  /** 内容层的 z-index 基准（纹理必须在内容下面） */
  zIndex?: number;
}

/**
 * 出一个绝对定位、铺满卡片、`pointer-events:none` 的纹理层。
 *
 * 混合模式的选择有讲究：
 *  - 浅色底 + 噪点 → `overlay`：在中间调上叠加，暗处更暗亮处更亮，伪出纸张的凹凸
 *  - 深色底 + 噪点 → `screen` 低透明度：深底用 overlay 会几乎看不见
 *  - 网格/网点 → 统一用 `overlay` 并压到很低的透明度，只当「底纹」
 */
export function textureLayer(o: TextureLayerOptions): string {
  const z = o.zIndex ?? 1;

  switch (o.texture) {
    case 'none':
      return '';

    case 'paper-grain':
      return `<div style="position:absolute;inset:0;z-index:${z};pointer-events:none;
        background-image:${grainTile(0.9)};
        background-size:220px 220px;
        opacity:${o.dark ? 0.06 : 0.075};
        mix-blend-mode:${o.dark ? 'screen' : 'overlay'}"></div>`;

    case 'film-grain':
      return `<div style="position:absolute;inset:0;z-index:${z};pointer-events:none;
        background-image:${grainTile(0.55, 260)};
        background-size:260px 260px;
        opacity:${o.dark ? 0.1 : 0.11};
        mix-blend-mode:${o.dark ? 'screen' : 'overlay'}"></div>`;

    case 'halftone':
      return `<div style="position:absolute;inset:0;z-index:${z};pointer-events:none;
        background-image:${halftoneTile(7, 1.1)};
        background-size:7px 7px;
        opacity:${o.dark ? 0.07 : 0.055};
        mix-blend-mode:overlay"></div>`;

    case 'hairline-grid':
      // 网格向角落淡出：满铺的网格线会显得像草稿纸，淡出后才像设计元素
      return `<div style="position:absolute;inset:0;z-index:${z};pointer-events:none;
        background-image:${hairlineGrid()};
        background-size:44px 44px;
        opacity:${o.dark ? 0.14 : 0.1};
        mix-blend-mode:overlay;
        -webkit-mask-image:radial-gradient(ellipse 90% 70% at 22% 12%, #000 0%, transparent 76%);
        mask-image:radial-gradient(ellipse 90% 70% at 22% 12%, #000 0%, transparent 76%)"></div>`;

    case 'haze-blob':
      return `<div style="position:absolute;inset:0;z-index:${z};pointer-events:none">
        ${hazeBlobs(o.accent, o.tint)}
      </div>`;

    default:
      return '';
  }
}

/**
 * 背景 CSS。
 *
 * 相比旧实现（一条 160° 三段线性渐变）多做了两件事：
 *  1. 叠一层同色系的径向高光，避免大面积纯色显得平
 *  2. 深色主题不再硬套线性渐变，改用从中心偏上的径向 —— 深色底上线性渐变
 *     的方向感很脏，径向更像打光
 */
export function backgroundCss(o: {
  bg: string;
  palette: { tint: string; accent: string };
  dark: boolean;
}): string {
  if (o.dark) {
    return [
      `radial-gradient(ellipse 130% 90% at 50% 8%, ${o.palette.tint} 0%, transparent 62%)`,
      `linear-gradient(180deg, ${o.bg} 0%, ${o.bg} 100%)`,
    ].join(', ');
  }
  return [
    `radial-gradient(ellipse 120% 80% at 12% 0%, ${o.palette.tint} 0%, transparent 58%)`,
    `linear-gradient(168deg, ${o.bg} 0%, ${o.palette.tint} 100%)`,
  ].join(', ');
}

/** 给底图用的压暗蒙版：底部更暗，保证白字可读；顶部留一点亮，不闷。 */
export function photoScrim(dark = 0.78): string {
  return `linear-gradient(180deg, rgba(0,0,0,0.18) 0%, rgba(0,0,0,${(dark * 0.45).toFixed(2)}) 42%, rgba(0,0,0,${dark}) 100%)`;
}
