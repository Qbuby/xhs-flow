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

/** 非常朴素的 emoji 识别，覆盖小红书文案里的高频区间。 */
export function countEmoji(s: string): number {
  return (
    s.match(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu,
    )?.length ?? 0
  );
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