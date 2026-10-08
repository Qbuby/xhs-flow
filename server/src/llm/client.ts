import OpenAI from 'openai';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { recordRunLog } from '../db/index.js';
import { extractJson } from '../util/text.js';

let client: OpenAI | null = null;
let clientKey = '';

function getClient(): OpenAI {
  const sig = `${config.llm.baseURL}|${config.llm.apiKey}`;
  if (client && clientKey === sig) return client;
  client = new OpenAI({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey, maxRetries: 2 });
  clientKey = sig;
  return client;
}

export interface ChatOptions {
  system?: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** 强制 JSON 输出。不是所有供应商都支持，所以只作为增强而非依赖。 */
  jsonMode?: boolean;
}

export async function chat(opts: ChatOptions): Promise<string> {
  if (!config.llm.apiKey) {
    throw new Error('未配置模型 key（.env 里的 XHSFLOW_LLM_API_KEY）');
  }

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.user });

  const res = await getClient().chat.completions.create({
    model: config.llm.model,
    messages,
    temperature: opts.temperature ?? 0.8,
    max_completion_tokens: opts.maxTokens ?? 4096,
    ...(opts.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  });

  return res.choices[0]?.message?.content ?? '';
}

export async function chatJson<T>(opts: ChatOptions): Promise<T> {
  const raw = await chat({ ...opts, jsonMode: true });
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
    const out = await chat({ user: '回复两个字：正常', maxTokens: 16, temperature: 0 });
    return { ok: true, detail: `${config.llm.model} 响应：${out.trim().slice(0, 40)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function llmInfo() {
  return {
    profile: config.llm.profile,
    baseURL: config.llm.baseURL,
    model: config.llm.model,
    hasKey: Boolean(config.llm.apiKey),
  };
}