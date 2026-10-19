import type { ResolvedSpec } from './design/index.js';

/**
 * 卡片文案的共享文本管线。
 *
 * 【为什么单独一个文件】之前 `highlightHtml` / `esc` 是 cards.ts 的私有函数，
 * layouts.ts 拿不到，于是所有版式都在直接 `String(b.title)` 插值 ——
 * 模型给的 `[[强调]]` 标记被当成字面量画进了封面标题（「[[栏目]]」）。
 * cards.ts 又 import layouts.ts（layoutBody），反向导出会成环，所以
 * 这几个纯函数搬到这里，两边都能用。
 */

/** HTML 转义 + 换行转 <br>。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '<br/>');
}

/**
 * 把模型给的强调标记 `[[词]]` 渲染成 accent 样式的 span。
 *
 * ⚠️ `accent_style: 'none'` 旧实现是坏的 —— 会掉进 else 分支变成高亮。
 * 这里显式处理：`none` 就只去掉标记、不加任何样式。
 */
export function highlightHtml(text: string, spec: ResolvedSpec): string {
  // 先按 [[ ]] 切开，只对非标记段做转义，避免转义把方括号搞乱
  const parts: string[] = [];
  let last = 0;
  const re = /\[\[(.+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    parts.push(escapeHtml(text.slice(last, m.index)));
    const inner = escapeHtml(m[1] ?? '');
    parts.push(inner ? `<span class="hl">${inner}</span>` : '');
    last = m.index + m[0].length;
  }
  parts.push(escapeHtml(text.slice(last)));
  // 没有标记时也别留下空 span
  const out = parts.join('');
  return out || (spec.accentStyle === 'none' ? escapeHtml(text) : out);
}
