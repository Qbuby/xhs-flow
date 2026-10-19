import sharp from 'sharp';
import fs from 'node:fs/promises';

/**
 * 发给视觉模型前的图片预算。
 *
 * 【768px 为什么不够】账号模板的证据全在小字上：页眉条高约 90/1440 ≈ 全图 6%，
 * 页脚条更矮。缩到 768px 后页眉文字只剩十几个像素高，蒸馏时模型基本认不出，
 * 于是「页眉仅 1 次提及、页脚 0 次」。这里把边长提到 1024 —— 页眉文字能到
 * 20px 上下，可读；同时压缩质量收到 68，保证 payload 不失控。
 */
export const MAX_IMAGES = 4;
export const MAX_EDGE = 1024;
export const MAX_BYTES = 900_000;

export interface VisionImage {
  mediaType: 'image/jpeg';
  /** 不含 data URL 前缀的 base64。 */
  data: string;
}

/**
 * 把本地图片压缩成适合视觉模型的 JPEG 负载。
 *
 * 同一份 `{ mediaType, data }` 同时喂两种协议（见 llm/client.ts）：
 *   - openai    → `data:${mediaType};base64,${data}` 塞进 image_url
 *   - anthropic → `{ type:'image', source:{ type:'base64', media_type, data } }`
 * 调用方（analyze.ts）不需要关心当前配置走哪条路。
 */
export async function prepareVisionImage(localPath: string): Promise<VisionImage | null> {
  try {
    const input = await fs.readFile(localPath);
    const data = await sharp(input)
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 68, mozjpeg: true })
      .toBuffer();
    if (data.length > MAX_BYTES) return null;
    return { mediaType: 'image/jpeg', data: data.toString('base64') };
  } catch {
    return null;
  }
}

/**
 * 为蒸馏准备图片。与旧版不同的是失败不再完全静默：
 * 静默返 null 是上次「105/118 篇 visual=未体现」排查时最费时间的一环 ——
 * 无法区分「模型没看到」和「图根本没发上去」。这里统计送出/失败数量，
 * 让调用方（analyzeNote）至少能在日志里看到图片是否真的在 payload 里。
 */
export async function prepareVisionImages(
  paths: string[],
): Promise<{ images: VisionImage[]; failed: number }> {
  const images: VisionImage[] = [];
  let failed = 0;
  for (const path of paths.slice(0, MAX_IMAGES)) {
    const image = await prepareVisionImage(path);
    if (image) images.push(image);
    else failed++;
  }
  return { images, failed };
}
