import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * 免费图库。
 *
 * 抽象成 provider 是因为两家都可以没有 —— 没有 key 时渲染器会自动退回纯文字卡，
 * 不会因此报错。
 */

export interface StockImage {
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  author: string;
  sourceProvider: string;
  sourceUrl: string;
}

export interface StockProvider {
  name: string;
  configured(): boolean;
  search(query: string, count?: number): Promise<StockImage[]>;
}

class UnsplashProvider implements StockProvider {
  name = 'unsplash';
  configured = () => Boolean(config.stock.unsplashKey);

  async search(query: string, count = 3): Promise<StockImage[]> {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${count}&orientation=portrait`;
    const res = await fetch(url, { headers: { Authorization: `Client-ID ${config.stock.unsplashKey}` } });
    if (!res.ok) throw new Error(`Unsplash HTTP ${res.status}`);
    const body = (await res.json()) as {
      results?: Array<{
        urls: { regular: string };
        width: number;
        height: number;
        user: { name: string };
        links: { html: string };
      }>;
    };
    return (body.results ?? []).map((r) => ({
      url: `${r.urls.regular}&w=1080&h=1440&fit=crop`,
      thumbUrl: `${r.urls.regular}&w=200&h=200&fit=crop`,
      width: r.width,
      height: r.height,
      author: r.user.name,
      sourceProvider: 'unsplash',
      sourceUrl: r.links.html,
    }));
  }
}

class PexelsProvider implements StockProvider {
  name = 'pexels';
  configured = () => Boolean(config.stock.pexelsKey);

  async search(query: string, count = 3): Promise<StockImage[]> {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=portrait`;
    const res = await fetch(url, { headers: { Authorization: config.stock.pexelsKey } });
    if (!res.ok) throw new Error(`Pexels HTTP ${res.status}`);
    const body = (await res.json()) as {
      photos?: Array<{
        src: { large: string; tiny: string };
        width: number;
        height: number;
        photographer: string;
        url: string;
      }>;
    };
    return (body.photos ?? []).map((p) => ({
      url: `${p.src.large}?auto=compress&cs=tinysrgb&w=1080&h=1440&fit=crop`,
      thumbUrl: `${p.src.tiny}`,
      width: p.width,
      height: p.height,
      author: p.photographer,
      sourceProvider: 'pexels',
      sourceUrl: p.url,
    }));
  }
}

const providers: StockProvider[] = [new UnsplashProvider(), new PexelsProvider()];

export function activeProviders(): StockProvider[] {
  return providers.filter((p) => p.configured());
}

/** 依次尝试各 provider，第一个成功的就用。 */
export async function searchStock(query: string, count = 2): Promise<StockImage[]> {
  for (const p of activeProviders()) {
    try {
      const out = await p.search(query, count);
      if (out.length > 0) {
        logger.debug({ provider: p.name, query, n: out.length }, '图库命中');
        return out;
      }
    } catch (err) {
      logger.warn({ provider: p.name, err }, '图库查询失败，尝试下一个');
    }
  }
  return [];
}

/**
 * 给中文关键词找一个英文检索词。
 * 图库对中文支持很差，这里过一遍常见映射，命中不了就原样送出去（总比没有强）。
 */
const ZH_EN_HINTS: Record<string, string> = {
  咖啡: 'coffee shop latte',
  茶: 'tea',
  美妆: 'makeup cosmetics beauty',
  护肤: 'skincare cosmetic bottle',
  穿搭: 'fashion outfit',
  健身: 'fitness workout gym',
  美食: 'food dish restaurant',
  旅行: 'travel landscape',
  宠物: 'cat dog pet',
  职场: 'office desk workspace',
  数码: 'laptop technology desk',
  家居: 'interior home living room',
  书: 'books reading library',
  商业: 'business office meeting',
  品牌: 'brand design minimal',
  摄影: 'photography camera',
  植物: 'plant green leaves',
  音乐: 'music headphones',
  运动: 'sports running',
};

export function toSearchHint(keyword: string): string {
  for (const [zh, en] of Object.entries(ZH_EN_HINTS)) {
    if (keyword.includes(zh)) return en;
  }
  return keyword;
}