import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * 免费图库。
 *
 * 抽象成 provider 是因为各家的「注册摩擦」差别很大 ——
 * 用户明确反馈 Unsplash 要建应用、拿到的还是带追踪参数的链接。
 * 这里按「打开就能用」的程度排序，前两个完全不需要注册：
 *
 *  1. Wikimedia Commons  零配置，关键词搜索，直链下载。
 *                        代价是内容偏纪实/百科向，不一定有「品牌感」。
 *  2. Pexels            只需注册拿一个 key（不是「建应用」，无审核、即时生效），
 *                        **不强制署名**，URL 干净。生活方式类素材最合适。
 *  3. Unsplash          保留兼容，但要建应用且强制署名。
 *  4. Pixabay           同样只需一个 key。
 *
 * 一个都没配也能跑：photo_text 版式会自动退回纯文字排版卡。
 */

export interface StockImage {
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  author: string;
  sourceProvider: string;
  sourceUrl: string;
  license: string;
}

export interface StockProvider {
  name: string;
  /** 是否免注册（用于在设置页给出提示） */
  keyless: boolean;
  configured(): boolean;
  search(query: string, count?: number): Promise<StockImage[]>;
}

/* ------------------------------------------------------------------ */
/* Wikimedia Commons —— 完全免 key                                      */
/* ------------------------------------------------------------------ */

const WIKI_API = 'https://commons.wikimedia.org/w/api.php';
const WIKI_UA = 'xhsflow/0.1 (local content tool)';

class WikimediaProvider implements StockProvider {
  name = 'wikimedia';
  keyless = true;
  configured = () => true;

  async search(query: string, count = 3): Promise<StockImage[]> {
    const q = new URLSearchParams({
      action: 'query',
      generator: 'search',
      // file: 只搜文件命名空间；加 filetype:bitmap 过滤掉 svg/pdf
      gsrsearch: `filetype:bitmap ${query}`,
      gsrnamespace: '6',
      gsrlimit: String(Math.max(count * 3, 8)),
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
      iiurlwidth: '1080',
      format: 'json',
      origin: '*',
    });

    const res = await fetch(`${WIKI_API}?${q}`, {
      headers: { 'User-Agent': WIKI_UA },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Wikimedia HTTP ${res.status}`);

    const json = (await res.json()) as {
      query?: { pages?: Record<string, { title?: string; imageinfo?: any[] }> };
    };
    const pages = Object.values(json.query?.pages ?? {});

    // 小红书卡片是 3:4（宽高比 0.75）。硬过滤竖图常常一张都不剩，
    // 所以改成「按接近 0.75 的程度排序」取前 N —— 竖图优先，横图兜底，
    // 但至少保证比例裁切时损失可控。
    const TARGET_RATIO = 0.75;
    const scored = pages
      .map((p) => {
        const ii = p.imageinfo?.[0];
        if (!ii?.mime?.startsWith('image/')) return null;
        const w = ii.thumbwidth ?? ii.width;
        const h = ii.thumbheight ?? ii.height;
        if (!w || !h) return null;
        return { p, ii, w, h, penalty: Math.abs(w / h - TARGET_RATIO) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.penalty - b.penalty)
      .slice(0, count);

    return scored.map(({ p, ii, w, h }) => ({
      url: ii.thumburl ?? ii.url,
      thumbUrl: ii.thumburl ?? ii.url,
      width: w,
      height: h,
      author: String(ii.extmetadata?.Artist?.value ?? '')
        .replace(/<[^>]*>/g, '')
        .slice(0, 40),
      sourceProvider: 'wikimedia',
      sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title ?? '')}`,
      license: String(ii.extmetadata?.LicenseShortName?.value ?? 'CC'),
    }));
  }
}

/* ------------------------------------------------------------------ */
/* Pexels —— 注册即用，不强制署名                                       */
/* ------------------------------------------------------------------ */

class PexelsProvider implements StockProvider {
  name = 'pexels';
  keyless = false;
  configured = () => Boolean(config.stock.pexelsKey);

  async search(query: string, count = 3): Promise<StockImage[]> {
    const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=portrait`;
    const res = await fetch(url, {
      headers: { Authorization: config.stock.pexelsKey },
      signal: AbortSignal.timeout(20_000),
    });
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
      thumbUrl: p.src.tiny,
      width: p.width,
      height: p.height,
      author: p.photographer,
      sourceProvider: 'pexels',
      sourceUrl: p.url,
      license: 'Pexels License',
    }));
  }
}

/* ------------------------------------------------------------------ */
/* Unsplash —— 保留兼容（需建应用 + 强制署名）                            */
/* ------------------------------------------------------------------ */

class UnsplashProvider implements StockProvider {
  name = 'unsplash';
  keyless = false;
  configured = () => Boolean(config.stock.unsplashKey);

  async search(query: string, count = 3): Promise<StockImage[]> {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${count}&orientation=portrait`;
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${config.stock.unsplashKey}` },
      signal: AbortSignal.timeout(20_000),
    });
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
      license: 'Unsplash',
    }));
  }
}

/* ------------------------------------------------------------------ */
/* Pixabay —— 只需一个 key                                              */
/* ------------------------------------------------------------------ */

class PixabayProvider implements StockProvider {
  name = 'pixabay';
  keyless = false;
  configured = () => Boolean(config.stock.pixabayKey);

  async search(query: string, count = 3): Promise<StockImage[]> {
    const url = `https://pixabay.com/api/?key=${config.stock.pixabayKey}&q=${encodeURIComponent(query)}&per_page=${count}&image_type=photo&orientation=vertical`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Pixabay HTTP ${res.status}`);
    const body = (await res.json()) as {
      hits?: Array<{
        largeImageURL: string;
        previewURL: string;
        imageWidth: number;
        imageHeight: number;
        user: string;
        pageURL: string;
      }>;
    };
    return (body.hits ?? []).map((h) => ({
      url: h.largeImageURL,
      thumbUrl: h.previewURL,
      width: h.imageWidth,
      height: h.imageHeight,
      author: h.user,
      sourceProvider: 'pixabay',
      sourceUrl: h.pageURL,
      license: 'Pixabay Content License',
    }));
  }
}

/* ------------------------------------------------------------------ */
/* 调度                                                                */
/* ------------------------------------------------------------------ */

// 顺序即优先级：免 key 的排前面，配了 key 的品质更好时排后面
const providers: StockProvider[] = [
  new WikimediaProvider(),
  new PexelsProvider(),
  new PixabayProvider(),
  new UnsplashProvider(),
];

export function allProviders(): StockProvider[] {
  return providers;
}

export function activeProviders(): StockProvider[] {
  return providers.filter((p) => p.configured());
}

/**
 * 依次尝试各 provider，第一个有结果的都用。
 * 注意 wikimedia 永远 configured（免 key），所以它总是第一个试 ——
 * 配了 pexels/unsplash 的话，命中素材质量更好，但优先走免 key 的兜底。
 * 想优先用高品质图库，把 PIXABAY/UNSPLASH 那种配好的调前面即可。
 */
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
 * 图库对中文支持很差，这里过一遍常见映射，命中不了就原样送出去。
 */
const ZH_EN_HINTS: Record<string, string> = {
  咖啡: 'coffee latte cafe',
  茶: 'tea',
  美妆: 'makeup cosmetics beauty',
  护肤: 'skincare cosmetic bottle',
  穿搭: 'fashion outfit clothing',
  健身: 'fitness workout gym',
  美食: 'food dish restaurant',
  旅行: 'travel landscape',
  宠物: 'cat dog pet',
  职场: 'office desk workspace',
  数码: 'laptop technology desk',
  家居: 'interior home living room furniture',
  书: 'books reading library',
  商业: 'business office meeting',
  品牌: 'brand design minimal packaging',
  摄影: 'photography camera',
  植物: 'plant green leaves',
  音乐: 'music headphones',
  运动: 'sports running',
  厨房: 'kitchen cooking',
  收纳: 'storage shelf organize',
  空间: 'interior room design',
  营销: 'marketing business',
};

export function toSearchHint(keyword: string): string {
  // 只取**一个**最贴切的映射。多个映射拼在一起会变成
  // "coffee latte cafe interior room design" 这种六概念长句，
  // 图库的 AND 语义下必然零结果（实测确实如此）。
  // 宁可少给关键词，也要保证能搜到东西。
  const hits = Object.entries(ZH_EN_HINTS)
    .filter(([zh]) => keyword.includes(zh))
    .sort((a, b) => b[0].length - a[0].length);
  const primary = hits[0]?.[1];
  if (!primary) return keyword;

  // 已经含英文/数字为主的查询（模型有时直接给英文）就原样用
  const latin = keyword.replace(/[^ -]/g, '').trim();
  return latin.length >= 6 ? latin : primary;
}
