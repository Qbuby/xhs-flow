import OpenAI from 'openai';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { recordRunLog } from '../db/index.js';
import { extractJson } from '../util/text.js';

/**
 * 文本模型客户端。
 *
 * 同时支持两套协议，因为不同厂商给的端点不一样：
 *   - openai    : POST {baseURL}/chat/completions
 *   - anthropic : POST {baseURL}/v1/messages
 *
 * Anthropic 那条用裸 fetch 实现，不引 SDK —— 报文结构简单，
 * 而且官方 SDK 会带来一堆我们用不上的依赖。
 * 注意 Anthropic 没有 response_format=json_object，
 * 所以 JSON 只能靠 prompt 约束 + 事后修复（见 extractJson）。
 */

let openaiClient: OpenAI | null = null;
let openaiKey = '';

function getOpenAI(): OpenAI {
  const sig = `${config.llm.baseURL}|${config.llm.apiKey}`;
  if (openaiClient && openaiKey === sig) return openaiClient;
  openaiClient = new OpenAI({
    baseURL: config.llm.baseURL,
    apiKey: config.llm.apiKey,
    maxRetries: 2,
  });
  openaiKey = sig;
  return openaiClient;
}

export interface ChatOptions {
  system?: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

/* ------------------------------------------------------------------ */
/* Anthropic Messages                                                  */
/* ------------------------------------------------------------------ */

async function chatAnthropic(opts: ChatOptions): Promise<string> {
  const base = config.llm.baseURL.replace(/\/+$/, '');
  const url = base.endsWith('/v1/messages') ? base : `${base}/v1/messages`;

  const body = {
    model: config.llm.model,
    max_tokens: opts.maxTokens ?? 4096,
    // Anthropic 的 system 是顶层字段，不放进 messages
    ...(opts.system ? { system: opts.system } : {}),
    messages: [{ role: 'user', content: opts.user }],
    temperature: opts.temperature ?? 0.8,
    stream: false,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.llm.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Anthropic 端点 HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  let json: { content?: Array<{ type: string; text?: string }> };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new Error(`Anthropic 响应不是 JSON：${text.slice(0, 200)}`);
  }

  // content 是内容块数组，可能混入 thinking 之类的非文本块
  const out = (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');

  if (!out.trim()) throw new Error('Anthropic 返回了空内容');
  return out;
}

/* ------------------------------------------------------------------ */
/* OpenAI Chat Completions                                             */
/* ------------------------------------------------------------------ */

async function chatOpenAI(opts: ChatOptions): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.user });

  const res = await getOpenAI().chat.completions.create({
    model: config.llm.model,
    messages,
    temperature: opts.temperature ?? 0.8,
    max_completion_tokens: opts.maxTokens ?? 4096,
    ...(opts.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  });

  return res.choices[0]?.message?.content ?? '';
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export async function chat(opts: ChatOptions): Promise<string> {
  if (!config.llm.apiKey) {
    throw new Error('未配置模型 key（.env 里的 XHSFLOW_LLM_API_KEY）');
  }
  return config.llm.api === 'anthropic' ? chatAnthropic(opts) : chatOpenAI(opts);
}

/**
 * 要 JSON 的调用。
 * Anthropic 没有 json_object 模式，所以统一在 prompt 里追加约束，
 * 再用 extractJson 兜住代码块围栏和前后废话。
 */
export async function chatJson<T>(opts: ChatOptions): Promise<T> {
  const wantsJson = opts.jsonMode !== false;
  const system = wantsJson
    ? `${opts.system ? opts.system + '\n\n' : ''}【输出格式】只输出一个 JSON 对象，不要任何解释、前言或代码块围栏。`
    : opts.system;

  const raw = await chat({ ...opts, system, jsonMode: config.llm.api === 'openai' && wantsJson });

  try {
    return extractJson<T>(raw);
  } catch (err) {
    logger.error({ err, raw: raw.slice(0, 500) }, '解析模型 JSON 失败');
    recordRunLog('error', 'llm', '解析模型 JSON 失败', { raw: raw.slice(0, 1000) });
    throw err;
  }
}

/** 探活，设置页用。 */
export async function llmHealth(): Promise<{ ok: boolean; detail: string }> {
  if (!config.llm.apiKey) return { ok: false, detail: '未配置 key' };
  try {
    const out = await chat({ user: '回复两个字：正常', maxTokens: 32, temperature: 0 });
    return { ok: true, detail: `${config.llm.model} 响应：${out.trim().slice(0, 40)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function llmInfo() {
  return {
    api: config.llm.api,
    profile: config.llm.profile,
    baseURL: config.llm.baseURL,
    model: config.llm.model,
    hasKey: Boolean(config.llm.apiKey),
  };
}
