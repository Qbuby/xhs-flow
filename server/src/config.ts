import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

loadEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/config.js -> 项目根
export const ROOT_DIR = path.resolve(here, '..', '..');
export const DATA_DIR = path.resolve(ROOT_DIR, 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const PROFILE_DIR = path.join(DATA_DIR, 'chrome-profile');
export const WEB_DIST = path.resolve(ROOT_DIR, 'web', 'dist');

for (const dir of [DATA_DIR, MEDIA_DIR, PROFILE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v);
const str = (v: string | undefined, fallback = ''): string =>
  v === undefined || v === '' ? fallback : v;

/**
 * 智谱团队套餐 key 与按量付费 key 不通用，baseURL 必须与 key 成对绑定，
 * 所以这里刻意做成「预置 profile」而不是两个自由填写的独立字段。
 */
const LLM_PROFILES = {
  'glm-coding': {
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
    model: 'glm-5.3',
  },
  'glm-paygpt': {
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3',
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-6.1-sol',
  },
  custom: { baseURL: '', model: '' },
} as const;

export type LlmProfileName = keyof typeof LLM_PROFILES;

export interface AppConfig {
  port: number;
  host: string;
  openBrowser: boolean;
  llm: {
    profile: LlmProfileName;
    baseURL: string;
    apiKey: string;
    model: string;
  };
  stock: {
    unsplashKey: string;
    pexelsKey: string;
  };
  scrape: {
    concurrency: number;
    avgDelayMs: number;
    delaySigma: number;
  };
  schedule: {
    generate: string;
    publish: string;
  };
  publish: {
    auto: boolean;
    intervalSec: number;
  };
}

const requested = str(process.env.XHSFLOW_LLM_PROFILE, 'glm-coding') as LlmProfileName;
const preset = LLM_PROFILES[requested] ?? LLM_PROFILES['glm-coding'];

export const config: AppConfig = {
  port: num(process.env.XHSFLOW_PORT, 8787),
  host: str(process.env.XHSFLOW_HOST, '127.0.0.1'),
  openBrowser: bool(process.env.XHSFLOW_OPEN_BROWSER, true),

  llm: {
    profile: requested,
    baseURL: str(process.env.XHSFLOW_LLM_BASE_URL, preset.baseURL),
    apiKey: str(process.env.XHSFLOW_LLM_API_KEY),
    model: str(process.env.XHSFLOW_LLM_MODEL, preset.model),
  },

  stock: {
    unsplashKey: str(process.env.UNSPLASH_ACCESS_KEY),
    pexelsKey: str(process.env.PEXELS_API_KEY),
  },

  scrape: {
    concurrency: num(process.env.XHSFLOW_SCRAPE_CONCURRENCY, 1),
    avgDelayMs: num(process.env.XHSFLOW_SCRAPE_AVG_DELAY_MS, 6000),
    delaySigma: num(process.env.XHSFLOW_SCRAPE_DELAY_SIGMA, 0.6),
  },

  schedule: {
    generate: str(process.env.XHSFLOW_SCHEDULE_GENERATE, '30 9 * * *'),
    publish: str(process.env.XHSFLOW_SCHEDULE_PUBLISH, '0 */2 * * *'),
  },

  publish: {
    auto: bool(process.env.XHSFLOW_PUBLISH_AUTO, false),
    intervalSec: num(process.env.XHSFLOW_PUBLISH_INTERVAL_SEC, 45),
  },
};

export function llmIsConfigured(): boolean {
  return Boolean(config.llm.baseURL && config.llm.apiKey && config.llm.model);
}

export function describeMissingConfig(): string[] {
  const missing: string[] = [];
  if (!llmIsConfigured()) {
    missing.push('文本模型未配置（需要 XHSFLOW_LLM_API_KEY，baseURL 与 key 需成对）');
  }
  if (!config.stock.unsplashKey && !config.stock.pexelsKey) {
    missing.push('未配置图库 key —— 配图将只使用纯文字排版卡');
  }
  return missing;
}