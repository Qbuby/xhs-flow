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

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string; thinking?: string }>;
  stop_reason?: string;
}

async function callAnthropic(opts: ChatOptions, maxTokens: number): Promise<AnthropicResponse> {
  const base = config.llm.baseURL.replace(/\/+$/, '');
  const url = base.endsWith('/v1/messages') ? base : `${base}/v1/messages`;

  const body = {
    model: config.llm.model,
    max_tokens: maxTokens,
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
  if (!res.ok) throw new Error(`Anthropic 端点 HTTP ${res.status}: ${text.slice(0, 300)}`);

  try {
    return JSON.parse(text) as AnthropicResponse;
  } catch {
    throw new Error(`Anthropic 响应不是 JSON：${text.slice(0, 200)}`);
  }
}

function joinText(json: AnthropicResponse): string {
  return (json.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
    .trim();
}

async function chatAnthropic(opts: ChatOptions): Promise<string> {
  // 默认给足。这个模型思考很重（实测单篇蒸馏要 6k+ token），
  // 预算不够会先被截断、再触发 4 倍重试，一次调用就变成两次的耗时。
  let budget = opts.maxTokens ?? 16_384;
  let json = await callAnthropic(opts, budget);

  let out = joinText(json);

  // MiniMax-M3 / Claude 这类**推理模型**会先吐 thinking 块，
  // 如果 max_tokens 给小了，额度全被思考吃掉，一个 text 块都不剩
  // （表现为 stop_reason=max_tokens 且返回空内容）。这时加倍预算重来一次。
  if (!out && json.stop_reason === 'max_tokens') {
    logger.warn({ budget }, '模型思考耗尽了 token 预算，加大额度重试');
    budget = Math.min(budget * 4, 32_000);
    json = await callAnthropic(opts, budget);
    out = joinText(json);
  }

  if (!out) {
    const kinds = (json.content ?? []).map((b) => b.type).join(',') || '(空)';
    throw new Error(
      `模型没有返回正文（内容块类型：${kinds}，stop_reason=${json.stop_reason ?? '?'}）。` +
        `若 stop_reason=max_tokens，说明 max_tokens 全被 thinking 消耗了，需要调大。`,
    );
  }
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

/** 把厂商返回的原始报文翻成人话，别把整段 JSON 甩到界面上。 */
function friendlyError(raw: string): string {
  if (/401|无效的令牌|invalid.*(token|key)|Unauthorized/i.test(raw)) {
    return '模型鉴权失败（HTTP 401：密钥无效或没权限）。请核对 API Key 与 baseURL 是否匹配。';
  }
  if (/404|not found|model.*not/i.test(raw)) {
    return '模型名或端点不存在（HTTP 404）。请检查 baseURL 与 model 拼写。';
  }
  if (/429|rate limit|quota/i.test(raw)) {
    return '触发限流或额度用尽（HTTP 429）。稍后再试。';
  }
  if (/timeout|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(raw)) {
    return '无法连接模型服务（网络或地址问题）。请检查 baseURL 是否可访问。';
  }
  return raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
}

/** 探活，设置页用。 */
export async function llmHealth(): Promise<{ ok: boolean; detail: string }> {
  if (!config.llm.apiKey) return { ok: false, detail: '未配置 key' };
  try {
    const out = await chat({ user: '回复两个字：正常', maxTokens: 2048, temperature: 0 });
    return { ok: true, detail: `${config.llm.model} 响应：${out.trim().slice(0, 40)}` };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: friendlyError(raw) };
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
