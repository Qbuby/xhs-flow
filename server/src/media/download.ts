import sharp from 'sharp';
import { logger } from '../logger.js';
import { serialize } from '../util/throttle.js';

/**
 * 带 Referer 的图片下载。
 *
 * 小红书的图片 CDN 会校验 Referer，缺了就是 403 ——
 * 生态里现成的下载器在这里普遍有 bug，我们显式带上。
 */
const REFERER = 'https://www.xiaohongshu.com/';

export async function downloadImage(url: string, timeoutMs = 20_000): Promise<Buffer> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Referer: REFERER,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** 串行下载并统一压到小红书友好的规格（3:4 / JPEG / ~500KB）。 */
export async function fetchAndNormalize(
  url: string,
): Promise<{ buffer: Buffer; width: number; height: number; bytes: number }> {
  return serialize(async () => {
    const raw = await downloadImage(url);
    const pipeline = sharp(raw)
      .rotate() // 尊重 EXIF 方向，否则竖图会躺下
      .resize(1080, 1440, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 88, mozjpeg: true });

    let buffer = await pipeline.toBuffer();

    // 小红书压图狠，超大图没意义；这里做一次体积收敛
    let quality = 88;
    while (buffer.length > 700 * 1024 && quality > 60) {
      quality -= 8;
      buffer = await sharp(raw)
        .rotate()
        .resize(1080, 1440, { fit: 'cover', position: 'centre' })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
    }

    const meta = await sharp(buffer).metadata();
    return {
      buffer,
      width: meta.width ?? 1080,
      height: meta.height ?? 1440,
      bytes: buffer.length,
    };
  });
}

/** 校验这堆字节真的是图片，别把 403 的 HTML 错误页存成 jpg。 */
export async function isProbablyImage(buf: Buffer): Promise<boolean> {
  try {
    const m = await sharp(buf).metadata();
    return Boolean(m.width && m.height);
  } catch {
    return false;
  }
}

export async function loadImageMetadata(localPath: string) {
  try {
    return await sharp(localPath).stats();
  } catch (err) {
    logger.debug({ err, localPath }, '读取图片统计失败');
    return undefined;
  }
}