import sharp from 'sharp';

/**
 * 主色板提取 —— 用 sharp 离线算，不依赖 LLM 看图，快且零 token。
 *
 * ⚠️ 这里曾经有个把整条配色链路都污染了的 bug，值得记下来：
 *
 * 旧实现把 5bit 的 r/g/b 分别塞进 key 的 bits 15-10 / 9-5 / 4-0，然后
 * `key.toString(16).padStart(6,'0')` 当普通十六进制打印。问题是十六进制里
 * 每个通道占 4 bit，而打包时占 5 bit —— 位宽对不上，解出来的颜色是错的：
 *
 *   白色 (255,255,255) → key 0x7FFF → "#007FFF"   ← 一个蓝色，不是白色
 *   灰色 (128,128,128) → key 0x4210 → "#004210"   ← 近乎纯黑
 *
 * 也就是说 `note_images.palette` 里存的 hex 几乎全是错的，而聚合画像的
 * PROFILE_SYSTEM 又要求「色值必须能追溯到样稿证据」—— 源头上就是断的。
 *
 * 正解：量化只是为了**分桶去噪**，取色时要把量化值还原回 8bit 再拼 hex
 * （把低 3 位补回去），不能拿打包键当颜色用。
 */

/** 每个通道量化到 5bit 的桶数。 */
const BUCKET_BITS = 5;
/** 每通道 5bit → 8bit 的还原除数由移位完成：(v >> 3) << 3。 */
const QUANT_SHIFT = 8 - BUCKET_BITS; // 3

export interface PaletteEntry {
  hex: string;
  weight: number;
}

/** 从一段 RGB 原始像素里统计主色板。抽出来是为了能单测。 */
export function paletteFromRgb(data: Buffer | Uint8Array, top = 5): PaletteEntry[] {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();

  for (let i = 0; i + 2 < data.length; i += 3) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;

    // 量化到 5bit 只用于**分桶**，抵抗压缩噪声
    const qr = r >> QUANT_SHIFT;
    const qg = g >> QUANT_SHIFT;
    const qb = b >> QUANT_SHIFT;
    const key = (qr << (BUCKET_BITS * 2)) | (qg << BUCKET_BITS) | qb;

    const cur = buckets.get(key);
    if (cur) {
      cur.count++;
      // 累加真实像素值，最后取均值 —— 比直接用桶中心色更准
      cur.r += r;
      cur.g += g;
      cur.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }

  const total = [...buckets.values()].reduce((a, b) => a + b.count, 0) || 1;
  return [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, top)
    .map((bucket) => ({
      hex: rgbToHex(
        Math.round(bucket.r / bucket.count),
        Math.round(bucket.g / bucket.count),
        Math.round(bucket.b / bucket.count),
      ),
      weight: Number((bucket.count / total).toFixed(3)),
    }));
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** 取一张图片的主色板。失败返回空数组（调用方不要因为配色失败就中断抓取）。 */
export async function extractPalette(buf: Buffer, top = 5): Promise<PaletteEntry[]> {
  try {
    const { data } = await sharp(buf)
      .resize(64, 64, { fit: 'cover' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return paletteFromRgb(data, top);
  } catch {
    return [];
  }
}

/** 平均亮度 0..1。用于判断「深色底配亮字」还是反之。 */
export async function averageBrightness(buf: Buffer): Promise<number> {
  const stats = await sharp(buf).stats();
  return stats.channels.map((c) => c.mean).reduce((a, b) => a + b, 0) / 255 / 3;
}
