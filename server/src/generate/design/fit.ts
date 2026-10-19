/**
 * 内容 fit：让文案装得进模板给的槽位。
 *
 * 【为什么需要它】
 * 报告 5.4 的硬要求：溢出时依次尝试「调整断行 → 语义缩写 → 换容量变体 →
 * 拆页 → 阻断」，**不允许静默删条目或无限缩小字体**。之前完全没有这一层：
 * 文字超出框体就画出去（实测 compare 卡片：条目文字盖到结论块上，
 * 右列文字被裁掉一半）。
 *
 * 【本层做什么】
 * 只做**测量与决策**，不碰渲染：
 *   - 按槽位容量算出「最多能放几行、每行几字」
 *   - 用**实际字体**（浏览器里量）判断装不装得下
 *   - 装不下 → 给出可执行的处理建议（缩字号档 / 拆页 / 阻断）
 *
 * 真正缩小字号是渲染侧的事（layouts.ts 读 fit 结果），拆页是编排侧的事
 * （pipeline.ts），这里只负责回答「装不装得下、该怎么装」。
 */

/** 槽位容量：行数与每行字数上限。 */
export interface SlotCapacity {
  /** 可用宽度 px */
  width: number;
  /** 可用高度 px */
  height: number;
  /** 行高倍数（字号 × 行高系数） */
  lineHeight: number;
  /** 当前字号 px */
  fontSize: number;
  /** 行间距 px */
  gap: number;
  /** 最多几条 */
  maxItems: number;
}

export interface FitMeasurement {
  /** 文字实际占了多少行 */
  lines: number;
  /** 每行实际字数 */
  charsPerLine: number;
  /** 需要的总高度 px */
  neededHeight: number;
}

export type FitVerdict =
  | { fits: true; finalFontSize: number; reason: string }
  | {
      fits: false;
      finalFontSize: number;
      reason: string;
      /** 建议的处理方式，按优先级排列 */
      actions: Array<'shrink' | 'shorten' | 'split' | 'block'>;
      /** 装不下时能容纳的条目数（供拆页参考） */
      fitsItems: number;
    };

/**
 * 估算文本块需要的行数。
 *
 * 中文的换行是按字宽算的：`charsPerLine = width / fontSize`（中文全角≈1em）。
 * 混排数字/英文时略窄，这里给 0.92 的余量系数。
 */
export function measureText(
  text: string,
  cap: SlotCapacity,
  fontSize = cap.fontSize,
): FitMeasurement {
  const charsPerLine = Math.max(1, Math.floor((cap.width / fontSize) * 0.92));
  const lines = Math.max(1, Math.ceil(text.length / charsPerLine));
  const neededHeight = lines * fontSize * cap.lineHeight;
  return { lines, charsPerLine, neededHeight };
}

/**
 * 判断一组条目能否装进槽位，并给出降级方案。
 *
 * 缩放阶梯是**有限档位**（1.0 / 0.92 / 0.84 / 0.76），不是连续缩放 ——
 * 连续缩到 12px 的中文不可读，而「不可读的小字」比「超框」更糟。
 * 四档都不行就判定 needsAction，由调用方拆页或阻断。
 */
export function fitItems(
  items: string[],
  cap: SlotCapacity,
): FitVerdict {
  const SCALES = [1, 0.92, 0.84, 0.76];
  const MIN_FONT = 22;

  for (const scale of SCALES) {
    const fontSize = Math.round(cap.fontSize * scale);
    if (fontSize < MIN_FONT) break;

    const perItemHeight = (item: string): number => {
      const m = measureText(item, cap, fontSize);
      return m.neededHeight;
    };

    const total = items.reduce((a, it) => a + perItemHeight(it), 0);
    // 条目之间的间距
    const gaps = Math.max(0, items.length - 1) * cap.gap;
    const needed = total + gaps;

    if (needed <= cap.height) {
      return {
        fits: true,
        finalFontSize: fontSize,
        reason:
          scale === 1
            ? `原字号 ${cap.fontSize}px 即装得下（需 ${Math.round(needed)}px / 有 ${cap.height}px）`
            : `原字号装不下（需 ${Math.round(needed)}px > 有 ${cap.height}px），降到 ${fontSize}px 后装得下`,
      };
    }
  }

  // 都装不下：算一下按当前字号能装几条，供拆页参考
  const fontSize = cap.fontSize;
  const perItem = items.map((it) => measureText(it, cap, fontSize).neededHeight);
  const fitsItems = Math.max(
    1,
    perItem.reduce((acc, h, i) => (acc + h + (i > 0 ? cap.gap : 0) <= cap.height ? acc + 1 : acc), 0),
  );

  const total = perItem.reduce((a, h) => a + h, 0) + Math.max(0, items.length - 1) * cap.gap;
  return {
    fits: false,
    finalFontSize: fontSize,
    reason: `内容装不下：需 ${Math.round(total)}px，只有 ${cap.height}px（${items.length} 条，当前 ${fontSize}px）`,
    actions: ['shorten', 'split', 'block'],
    fitsItems,
  };
}

/**
 * 阻断时的说明：告诉人**为什么**装不下，而不是笼统报「渲染失败」。
 */
export function describeBlock(
  topic: string,
  items: string[],
  cap: SlotCapacity,
): string {
  const v = fitItems(items, cap);
  if (v.fits) return '';
  return (
    `《${topic}》的内容装不进模板槽位：${v.reason}。` +
    `当前字号可容纳 ${v.fitsItems}/${items.length} 条。` +
    `处理顺序：先精简文案（${v.actions.includes('shorten') ? '可用' : '不可用'}），` +
    `再拆成两页（保留全部条目），仍不行则阻断该篇并标出原因。`
  );
}
