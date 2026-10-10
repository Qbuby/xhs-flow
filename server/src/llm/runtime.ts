import { getSetting } from '../db/index.js';
import { config } from '../config.js';

/**
 * 模型配置的运行时读取。
 *
 * .env 只是**初始默认值**，真正的配置存 settings 表（界面可改）。
 * 每次调用都现读 —— 改完立即生效，不用重启服务。
 *
 * 为什么不放进 config.ts：config 被 db 依赖（DATA_DIR），再反向依赖 db 会成环。
 */

export interface LlmRuntimeConfig {
  api: 'openai' | 'anthropic';
  baseURL: string;
  apiKey: string;
  model: string;
}

export function getLlmConfig(): LlmRuntimeConfig {
  const api = (getSetting('llm_api') ?? config.llm.api) as 'openai' | 'anthropic';
  return {
    api,
    baseURL: getSetting('llm_base_url') || config.llm.baseURL,
    apiKey: getSetting('llm_api_key') || config.llm.apiKey,
    model: getSetting('llm_model') || config.llm.model,
  };
}

export function llmIsConfigured(): boolean {
  const c = getLlmConfig();
  return Boolean(c.baseURL && c.apiKey && c.model);
}

/** 给界面看的掩码：sk-1HMY…WAzu，能认出是哪把钥匙又不泄露全文。 */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 10) return '•'.repeat(key.length);
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

export function describeLlmMissing(): string[] {
  const c = getLlmConfig();
  const missing: string[] = [];
  if (!c.apiKey) missing.push('文本模型未配置（缺少 API Key）');
  if (!c.baseURL) missing.push('文本模型未配置（缺少 Base URL）');
  if (!c.model) missing.push('文本模型未配置（缺少模型名）');
  return missing;
}
