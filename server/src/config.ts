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
export type LlmApi = 'openai' | 'anthropic';

export interface AppConfig {
  port: number;
  host: string;
  openBrowser: boolean;
  llm: {
    profile: LlmProfileName;
    api: LlmApi;
    baseURL: string;
    apiKey: string;
    model: string;
  };
  stock: {
    unsplashKey: string;
    pexelsKey: string;
    pixabayKey: string;
  };
  scrape: {
    concurrency: number;
    avgDelayMs: number;
    delaySigma: number;
  };
  schedule: {
    /**
     * 默认值刻意避开整点和等间隔。
     * 「每两小时整点」在风控看来就是一条等距的时间线；
     * 真人一天去创作中心两三次，而且不会恰好都在整点。
     */
    generate: string;
    publish: string;
  };
  publish: {
    auto: boolean;
    intervalSec: number;
  };
  /**
   * 防风控。2026-10-10 账号因「浏览行为异常或不规律」被限制曝光，
   * 之后所有自动化浏览都要过这里这几道闸。
   */
  risk: {
    /** 安静时段 "23:30-07:30"，跨零点支持。自动任务在此期间不动小红书。 */
    quietHours: string;
    /** 用本机真实安装的 Chrome 而不是 Playwright 自带的 Chromium。 */
    useRealChrome: boolean;
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
    api: (str(process.env.XHSFLOW_LLM_API, 'openai').toLowerCase() === 'anthropic'
      ? 'anthropic'
      : 'openai') as LlmApi,
    baseURL: str(process.env.XHSFLOW_LLM_BASE_URL, preset.baseURL),
    apiKey: str(process.env.XHSFLOW_LLM_API_KEY),
    model: str(process.env.XHSFLOW_LLM_MODEL, preset.model),
  },

  stock: {
    unsplashKey: str(process.env.UNSPLASH_ACCESS_KEY),
    pexelsKey: str(process.env.PEXELS_API_KEY),
    pixabayKey: str(process.env.PIXABAY_API_KEY),
  },

  scrape: {
    concurrency: num(process.env.XHSFLOW_SCRAPE_CONCURRENCY, 1),
    avgDelayMs: num(process.env.XHSFLOW_SCRAPE_AVG_DELAY_MS, 6000),
    delaySigma: num(process.env.XHSFLOW_SCRAPE_DELAY_SIGMA, 0.6),
  },

  schedule: {
    // 09:30 → 10:20：早上的第一件事应该是看数据，不是发稿
    generate: str(process.env.XHSFLOW_SCHEDULE_GENERATE, '20 10 * * *'),
    // 每两小时整点 → 一天三次、时刻错开
    publish: str(process.env.XHSFLOW_SCHEDULE_PUBLISH, '25 10,16,21 * * *'),
  },

  publish: {
    auto: bool(process.env.XHSFLOW_PUBLISH_AUTO, false),
    intervalSec: num(process.env.XHSFLOW_PUBLISH_INTERVAL_SEC, 45),
  },

  risk: {
    quietHours: str(process.env.XHSFLOW_QUIET_HOURS, '23:30-07:30'),
    useRealChrome: bool(process.env.XHSFLOW_USE_REAL_CHROME, true),
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
  // wikimedia 免 key，永远可用，所以这里不再提示缺 key
  return missing;
}