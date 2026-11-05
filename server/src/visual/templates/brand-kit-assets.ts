import sharp from 'sharp';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../config.js';

/**
 * 品牌素材处理：上传 → 裁边 → 抠底 → 派生明暗双版。
 *
 * 【为什么必须抠底】
 * 用户上传的 logo 通常是「白底 + 图标」，甚至带圆形底板的成品图
 * （Chengwang 那张就是 1254×1254 的白底圆形图标带投影）。
 * 直接贴到页脚条（#333333）上会露出一块白方块 —— 原账号的 logo
 * 是透明底直接压在深色条上的。所以必须抠成透明。
 *
 * 【为什么派生两版而不是用 CSS 反色】
 * 页眉是白底 + 深色 logo，页脚是深底 + 白色 logo。
 * 用 CSS filter 反色会把品牌色（Chengwang 的蓝/黄）一起反掉，
 * 变成错误的颜色。正确做法是按亮度生成两个 alpha 版本：
 *  - 深色版：保留原始颜色，alpha 取「非底色的覆盖度」
 *  - 浅色版：填纯白，alpha 取同一覆盖度
 */

/** 品牌素材存放目录（data/brand-kits/<sourceId>/）。 */
export function brandKitDir(sourceId: number): string {
  return path.join(DATA_DIR, 'brand-kits', String(sourceId));
}

export interface PreparedLogo {
  darkFile: string;
  lightFile: string;
  width: number;
  height: number;
  cutoutThreshold: number;
  /** 抠图后剩余的不透明像素占比，用于判断素材质量 */
  inkRatio: number;
}

/**
 * 从上传图派生一套 logo（深色版 + 浅色版，均透明底）。
 *
 * @param srcBuf   上传的原始图
 * @param sourceId 归属来源
 * @param opts.trim 是否裁掉四周留白（默认 true）
 * @param opts.threshold 底色亮度阈值 0-255（默认自动探测）
 */
export async function prepareBrandLogo(
  srcBuf: Buffer,
  sourceId: number,
  opts: { trim?: boolean; threshold?: number } = {},
): Promise<PreparedLogo> {
  const dir = brandKitDir(sourceId);
  await fs.mkdir(dir, { recursive: true });

  // 1) 归一化到 RGBA，并限制最大边长（避免超大图拖慢渲染）
  let img = sharp(srcBuf).rotate().ensureAlpha();
  const meta = await img.metadata();
  const maxSide = 1200;
  if ((meta.width ?? 0) > maxSide || (meta.height ?? 0) > maxSide) {
    img = img.resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });
  }
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;

  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * W + x) * ch;
    return [data[i]!, data[i + 1]!, data[i + 2]!];
  };
  const lumAt = (x: number, y: number): number => {
    const [r, g, b] = at(x, y);
    return (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
  };

  // 2) 探测底色：取四角与四边中点的众数亮度。
  //    用户上传的图绝大多数是「白底」或「浅灰底」，但也会有深色底。
  const edgeSamples: number[] = [];
  const inset = Math.max(2, Math.round(Math.min(W, H) * 0.01));
  for (let s = 0; s < 20; s++) {
    const t = s / 19;
    edgeSamples.push(lumAt(Math.round(t * (W - 1)), inset));
    edgeSamples.push(lumAt(Math.round(t * (W - 1)), H - 1 - inset));
    edgeSamples.push(lumAt(inset, Math.round(t * (H - 1))));
    edgeSamples.push(lumAt(W - 1 - inset, Math.round(t * (H - 1))));
  }
  edgeSamples.sort((a, b) => a - b);
  const edgeMedian = edgeSamples[Math.floor(edgeSamples.length / 2)]!;
  const bgIsLight = edgeMedian > 0.6;

  // 3) 阈值：底色与内容的分界。
  //    浅底时「比底色暗 X」算内容；深底时「比底色亮 X」算内容。
  //    默认留 8% 的余量吸收抗锯齿与投影。
  const explicit = opts.threshold;
  const cutoutThreshold =
    explicit ??
    Math.round((bgIsLight ? Math.max(0.55, edgeMedian - 0.1) : Math.min(0.45, edgeMedian + 0.1)) * 255);

  // 4) 逐像素求覆盖度（alpha）。
  //    - 浅底：内容越暗，覆盖度越高；彩色像素（饱和度高的）一律算内容，
  //      否则品牌蓝会因为亮度接近 0.5 而被误判为背景。
  //    - 深底：内容越亮越算内容。
  const alpha = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = at(x, y);
      const lum = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
      const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;

      let a: number;
      if (bgIsLight) {
        // 亮度差 → 覆盖度
        const diff = (cutoutThreshold / 255 - lum) / Math.max(0.001, cutoutThreshold / 255);
        a = Math.max(0, Math.min(1, diff * 1.35));
        // 彩色像素直接抬到高覆盖度（品牌色不能丢）
        if (sat > 0.12 && lum < 0.92) a = Math.max(a, Math.min(1, 0.55 + sat * 2));
      } else {
        const diff = (lum - cutoutThreshold / 255) / Math.max(0.001, 1 - cutoutThreshold / 255);
        a = Math.max(0, Math.min(1, diff * 1.35));
        if (sat > 0.12 && lum > 0.15) a = Math.max(a, Math.min(1, 0.55 + sat * 2));
      }

      /**
       * 抑制「圆形底板」与「投影」造成的残留。
       *
       * 电商/社媒常见的 logo 导出图是「白底 + 圆形浅灰底板 + 投影长这样」，
       * 只按亮度抠会把底板边缘的浅灰弧线一起留下 —— 贴到深色页脚上
       * 就是一圈脏灰线（Chengwang 那张实测就踩到了）。
       *
       * 判据：一个像素如果**既不够暗、又几乎无色**（低饱和），
       * 那它是背景/投影，不是图形。真正的图形要么有品牌色，要么是深墨。
       * 这条规则对纯黑 logo 也安全 —— 黑是无色但足够暗，会被保留。
       */
      const DARK_INK = 0.42;   // 比这更暗的算墨
      const COLOR_INK = 0.10;  // 饱和度超过这算品牌色
      if (bgIsLight) {
        if (lum > DARK_INK && sat < COLOR_INK) a = 0;
      } else {
        // 深底反推：太亮的近灰像素也是底板残留
        if (lum < 0.58 && sat < COLOR_INK) a = 0;
      }

      alpha[y * W + x] = Math.round(a * 255);
    }
  }

  /**
   * 4.5) 连通域过滤：去掉圆形底板/投影留下的细弧残留。
   *
   * 【为什么不能用阈值或邻域法】
   * 实测 Chengwang 那张：底板弧线的 alpha 高达 202~206（因为只有 1px 宽，
   * 抗锯齿后中心像素几乎是实色），像素数却只有 2~9 个/行。所以：
   *  - 按 alpha 阈值截断 → 截不掉（它比阈值高得多）
   *  - 按邻域密度过滤 → 也失效（它是一条连续的细线，邻居不少）
   *
   * 真正可靠的判据是**连通域面积**：真实图形是几千像素的大块，
   * 底板弧线是几百像素的细环。用泛洪标记连通域，丢掉面积过小的。
   *
   * 阈值取「最大连通域的 0.5%」——自适应，不依赖素材尺寸。
   */
  {
    const BIN = 40; // 二值化阈值：alpha 低于这视为空
    const label = new Int32Array(W * H).fill(-1);
    const areas: number[] = [];
    const stack: number[] = [];
    let next = 0;

    for (let y0 = 0; y0 < H; y0++) {
      for (let x0 = 0; x0 < W; x0++) {
        const p0 = y0 * W + x0;
        if (label[p0] !== -1 || alpha[p0]! < BIN) continue;
        // 泛洪
        const id = next++;
        let area = 0;
        stack.length = 0;
        stack.push(p0);
        label[p0] = id;
        while (stack.length) {
          const p = stack.pop()!;
          area++;
          const x = p % W;
          const y = (p - x) / W;
          // 4 邻域
          if (x > 0) {
            const q = p - 1;
            if (label[q] === -1 && alpha[q]! >= BIN) { label[q] = id; stack.push(q); }
          }
          if (x < W - 1) {
            const q = p + 1;
            if (label[q] === -1 && alpha[q]! >= BIN) { label[q] = id; stack.push(q); }
          }
          if (y > 0) {
            const q = p - W;
            if (label[q] === -1 && alpha[q]! >= BIN) { label[q] = id; stack.push(q); }
          }
          if (y < H - 1) {
            const q = p + W;
            if (label[q] === -1 && alpha[q]! >= BIN) { label[q] = id; stack.push(q); }
          }
        }
        areas.push(area);
      }
    }

    const maxArea = areas.length ? Math.max(...areas) : 0;
    // 保留面积 >= 最大块 0.5% 的连通域；同时给一个绝对下限避免碎片
    const minArea = Math.max(24, Math.round(maxArea * 0.005));
    if (maxArea > 0) {
      const keep = new Set<number>();
      areas.forEach((a, i) => { if (a >= minArea) keep.add(i); });
      for (let i = 0; i < W * H; i++) {
        const id = label[i]!;
        if (id !== -1 && !keep.has(id)) alpha[i] = 0;
      }
    }
  }

  // 5) 裁到内容 bbox（去掉四周大片透明边）
  let nMinX = W;
  let nMaxX = -1;
  let nMinY = H;
  let nMaxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (alpha[y * W + x]! >= 40) {
        if (x < nMinX) nMinX = x;
        if (x > nMaxX) nMaxX = x;
        if (y < nMinY) nMinY = y;
        if (y > nMaxY) nMaxY = y;
      }
    }
  }
  if (nMaxX < 0) throw new Error('未能从上传图里识别出图形内容（整张都是底色）');

  const trim = opts.trim !== false;
  const pad = trim ? 2 : 0;
  const cropX = Math.max(0, nMinX - pad);
  const cropY = Math.max(0, nMinY - pad);
  const cropW = Math.min(W - cropX, nMaxX - nMinX + 1 + pad * 2);
  const cropH = Math.min(H - cropY, nMaxY - nMinY + 1 + pad * 2);

  let inkPixels = 0;

  // 6) 深色版：保留原始 RGB，应用 alpha
  const darkRaw = Buffer.alloc(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const sx = cropX + x;
      const sy = cropY + y;
      const [r, g, b] = at(sx, sy);
      const a = alpha[sy * W + sx]!;
      const o = (y * cropW + x) * 4;
      darkRaw[o] = r;
      darkRaw[o + 1] = g;
      darkRaw[o + 2] = b;
      darkRaw[o + 3] = a;
      if (a > 12) inkPixels++;
    }
  }

  // 7) 浅色版：纯白填充 + 同一 alpha（用于深色页脚条）
  const lightRaw = Buffer.alloc(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const sx = cropX + x;
      const sy = cropY + y;
      const a = alpha[sy * W + sx]!;
      const o = (y * cropW + x) * 4;
      lightRaw[o] = 0xff;
      lightRaw[o + 1] = 0xff;
      lightRaw[o + 2] = 0xff;
      lightRaw[o + 3] = a;
    }
  }

  const rawOpts = { width: cropW, height: cropH, channels: 4 as const };
  const darkFile = `logo-dark-${Date.now()}.png`;
  const lightFile = `logo-light-${Date.now()}.png`;
  await sharp(darkRaw, { raw: rawOpts }).png({ compressionLevel: 9 }).toFile(path.join(dir, darkFile));
  await sharp(lightRaw, { raw: rawOpts }).png({ compressionLevel: 9 }).toFile(path.join(dir, lightFile));

  return {
    darkFile,
    lightFile,
    width: cropW,
    height: cropH,
    cutoutThreshold,
    inkRatio: inkPixels / (cropW * cropH),
  };
}

/**
 * 读取套件里的素材为 data URI（渲染器直接用）。
 *
 * 与 cards.ts 里 brandAssetDataUri 的区别：那读的是仓库内置资产
 * （server/assets），这里读用户上传的 data/brand-kits，路径基准不同。
 */
export async function brandKitAssetDataUri(sourceId: number, file: string): Promise<string | null> {
  try {
    // 只允许纯文件名，防路径穿越
    if (!/^[\w\-./]+\.png$/i.test(file) || file.includes('..')) return null;
    const abs = path.join(brandKitDir(sourceId), file);
    const buf = await fs.readFile(abs);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/** 同步版：渲染器是同步的，这里预加载后缓存。 */
const syncCache = new Map<string, string | null>();

export function brandKitAssetDataUriSync(sourceId: number, file: string): string | null {
  const key = `${sourceId}:${file}`;
  if (syncCache.has(key)) return syncCache.get(key)!;
  let uri: string | null = null;
  try {
    if (!/^[\w\-./]+\.png$/i.test(file) || file.includes('..')) {
      syncCache.set(key, null);
      return null;
    }
    const abs = path.join(brandKitDir(sourceId), file);
    const buf = fsSync.readFileSync(abs);
    uri = `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    uri = null;
  }
  syncCache.set(key, uri);
  return uri;
}

/** 删除套件目录下的旧素材（换 logo 时清理）。 */
export async function clearBrandKitAssets(sourceId: number): Promise<void> {
  // 清缓存
  for (const k of [...syncCache.keys()]) {
    if (k.startsWith(`${sourceId}:`)) syncCache.delete(k);
  }
  try {
    const dir = brandKitDir(sourceId);
    const files = await fs.readdir(dir);
    await Promise.all(files.map((f) => fs.unlink(path.join(dir, f)).catch(() => undefined)));
  } catch {
    /* 目录不存在就没事 */
  }
}
