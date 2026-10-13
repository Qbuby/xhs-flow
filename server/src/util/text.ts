/** 从 LLM 返回里稳妥地抠出 JSON 对象，容忍 ```json 包裹和前后废话。 */
export function extractJson<T = unknown>(raw: string): T {
  const trimmed = raw.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  const direct = tryParse(candidate);
  if (direct !== undefined) return direct as T;

  // 退而求其次：抓第一个配平的 { ... } 或 [ ... ]
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error('LLM 输出中找不到 JSON');

  const open = candidate[start] as '{' | '[';
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i] as string;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const parsed = tryParse(candidate.slice(start, i + 1));
        if (parsed !== undefined) return parsed as T;
        break;
      }
    }
  }

  throw new Error(`LLM 输出不是合法 JSON：${candidate.slice(0, 200)}…`);
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** 统计中文字符占比，用来判断 emoji 率、标题长度这类指标。 */
export function cjkRatio(s: string): number {
  if (!s) return 0;
  const cjk = s.match(/[一-龥]/g)?.length ?? 0;
  return cjk / [...s].length;
}

/**
 * 真正的 emoji 区间。
 *
 * ⚠️ 这里必须**精确**，不能用「看着像符号就删」的宽区间。
 * 旧实现把 `\u{2600}-\u{27BF}`（杂项符号）、`\u{2B00}-\u{2BFF}`、`\u{2190}-\u{21FF}`
 * （箭头）、`\u{2460}-\u{24FF}`（带圈数字 ①-⑳）一起删了，结果是：
 *
 *   - pipeline.ts 的 prompt 明确允许「用 ①②③ 和「」做结构标记」，
 *     但卡片上 ①②③ 会被静默删掉，只留两个空格
 *   - 作者有意放的 ❌ / ✓ / ★ / → / ↓ 全部消失，版面出现莫名空白
 *
 * 现在改成白名单制：只删彩色 emoji 本体及其配套修饰符，
 * 单色几何符号与带圈数字一律保留（它们走文字字体渲染，不会破坏字重与配色）。
 */
const EMOJI_CORE =
  /[\u{1F000}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu;

/** 只有真正成对的符号才当 emoji 删 —— 单色变体（U+FE0E）保留。 */
const EMOJI_TEXT_STYLE = /\uFE0E/gu;

/** 非常朴素的 emoji 计数，与 stripEmoji 的判定保持一致。 */
export function countEmoji(s: string): number {
  return s.match(EMOJI_CORE)?.length ?? 0;
}

/**
 * 去掉 emoji 及其配套字符（变体选择符、零宽连接符、肤色修饰符、数字键帽）。
 *
 * 为什么在渲染层做而不是只写进 prompt：卡片是**矢量排版**，
 * emoji 在 Chromium 里走彩色位图字体，跟卡片配色和字重完全不搭，
 * 一出现就破坏整张版面的统一感；而且不同语料库的 emoji 密度差很多，
 * 只靠 prompt 拦不住。放进这里兜底，任何来源的文案进卡片前都会被清一遍。
 *
 * 反向约束见 EMOJI_CORE 的注释：**不删** ①②③、→、★、✓、❌、●、◆、▲ 这类
 * 单色几何/带圈字符 —— prompt 允许它们，渲染也正常。
 */
export function stripEmoji(s: string): string {
  return s
    .replace(EMOJI_CORE, '')
    // 零宽连接符残留（emoji 序列被拆掉后可能留下孤立的 ZWJ）
    .replace(/\u200D/g, '')
    // 数字键帽的包围框
    .replace(/[\u20E3]/g, '')
    // 变体选择符残留
    .replace(/[\uFE0E\uFE0F]/g, '')
    .replace(EMOJI_TEXT_STYLE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n');
}

/** 从文案里抽 #话题 标签。 */
export function extractTags(s: string): string[] {
  return [...s.matchAll(/#([^#\s，。！？、；：,.!?;:\n]{1,20})/g)].map((m) => (m[1] as string).trim());
}

/**
 * 清洗小红书 SSR 页面里的 window.__INITIAL_STATE__。
 * 那个 blob 是 JS 字面量而非严格 JSON，需要先规整再 JSON.parse
 * （原项目的做法是塞给 YAML 解析器，那更脆）。
 */
export function parseInitialState(html: string): Record<string, unknown> | undefined {
  const marker = 'window.__INITIAL_STATE__=';
  const at = html.indexOf(marker);
  if (at === -1) return undefined;

  const start = at + marker.length;
  const obj = extractBalancedObject(html, start);
  if (!obj) return undefined;

  const cleaned = obj
    .replace(/new Map\(\[\]\)/g, '{}')
    .replace(/\bundefined\b/g, 'null')
    // JSON 不允许的控制字符
    .replace(/[\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // 单引号字符串 -> 双引号（仅在明确是单引号键或值时）
    .replace(/'([^'\\]*)'/g, '"$1"')
    // 裸键补引号: { key: 1 } -> { "key": 1 }
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');

  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractBalancedObject(src: string, start: number): string | undefined {
  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;

  for (let i = start; i < src.length; i++) {
    const ch = src[i] as string;

    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}