import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../config.js';
import { all, run } from '../../db/index.js';

/**
 * 语料配图抽取 —— 把原账号笔记里的**实拍/案例图**抠出来建成素材池。
 *
 * 【为什么必须自己抽，而不是去图库找】
 *
 * 这个账号（WOW传媒）的视觉语言是**排版卡片**，不是生活方式摄影。
 * 实测 736 页语料：内页 546 页里，只有 12 页有大面积实拍/案例图，
 * 其余是纯文字卡片 + 小插画。
 *
 * 之前的做法是让模型写一个中文检索词，再去 Pexels/Wikimedia 找图 ——
 * 结果每篇草稿都挂一张「笔记本手写」「品牌手册白底」之类的通用图库照，
 * 与内容、与账号风格都对不上（实测成稿里出现过空白米色渐变、
 * 一张手写 BRANDING AND MARKETING 的图库照）。
 *
 * 正确的做法：**图来自语料本身**。原账号用的就是自己客户的案例图
 * （喜茶、劲牌、三九胃泰……），那才是这个账号该有的配图。
 * 所以这里把语料页面里的照片区域检测出来、裁出来、连同它所属的
 * 笔记（= 题材）一起索引，之后按题材匹配使用。
 *
 * 【检测原理】
 *
 * 照片和排版卡片的区别在**色彩多样性**：照片区域在同一小块里有几十种
 * 色相，而文字卡片只有白底 + 黑字 + 一个强调色。所以：
 *   1. 把页面按 10px 切成格子，逐格统计「有饱和度的色相数量」；
 *   2. 色相数 ≥14 的格子算作照片格；
 *   3. 取最大的四连通块 = 一张照片的外接框。
 *
 * 不用「亮度方差」「边缘密度」之类的指标 —— 实拍图里大量大面积纯白
 * 墙面/桌面会让那些指标失灵，色相多样性对白墙不敏感、对照片敏感。
 */

/** 格子边长（原图像素）。 */
const TILE = 10;
/** 一格至少要有这么多种「有饱和度的色相」才算照片格。 */
const MIN_HUES = 14;
/** 连通块至少多少格（= 面积）才算一张值得留的照片。 */
const MIN_TILES = 40;
/** 照片区域至少这么宽/高（像素）。 */
const MIN_W = 100;
const MIN_H = 70;
/**
 * 裁出来的图至少要有这么多种**整体**色相。
 *
 * 光靠格子色相数会误判「蓝底白字」—— 那种块每格也有十几个色相（抗锯齿边缘），
 * 但整体只有蓝 + 白两种色。所以裁完再整体数一遍色相：真照片有几十种，
 * 色块只有两三种。
 */
const MIN_CROP_HUES = 6;

export interface PhotoRegion {
  noteId: number;
  pageIndex: number;
  /** 裁切框（原图坐标） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 面积（格） */
  tiles: number;
  /** 裁出来的文件绝对路径 */
  file: string;
}

/** 素材池目录。 */
export function corpusPhotoDir(): string {
  return path.join(DATA_DIR, 'media', 'corpus-photos');
}

/**
 * 检测一页里的照片区域。
 *
 * 返回按面积降序排列的区域（可能 0 个）。空数组 = 这页没有照片。
 */
export async function detectPhotoRegions(
  file: string,
): Promise<Array<{ x: number; y: number; w: number; h: number; tiles: number }>> {
  const { data, info } = await sharp(file)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const cols = Math.floor(width / TILE);
  const rows = Math.floor(height / TILE);
  if (cols < 4 || rows < 4) return [];

  const isPhoto = new Uint8Array(cols * rows);
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const hues = new Set<string>();
      for (let y = ty * TILE; y < (ty + 1) * TILE; y += 2) {
        for (let x = tx * TILE; x < (tx + 1) * TILE; x += 2) {
          const i = (y * width + x) * channels;
          const r = data[i]!;
          const g = data[i + 1]!;
          const b = data[i + 2]!;
          const mx = Math.max(r, g, b);
          const mn = Math.min(r, g, b);
          if ((mx - mn) / 255 <= 0.2) continue;
          hues.add(`${r >> 4},${g >> 4},${b >> 4}`);
        }
      }
      if (hues.size >= MIN_HUES) isPhoto[ty * cols + tx] = 1;
    }
  }

  // 最大连通块
  const label = new Int32Array(cols * rows).fill(-1);
  const stack: number[] = [];
  let best = 0;
  let bestBox: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
  let next = 0;
  for (let y0 = 0; y0 < rows; y0++) {
    for (let x0 = 0; x0 < cols; x0++) {
      const p0 = y0 * cols + x0;
      if (label[p0] !== -1 || !isPhoto[p0]) continue;
      const id = next++;
      let area = 0;
      let minX = cols;
      let maxX = -1;
      let minY = rows;
      let maxY = -1;
      stack.length = 0;
      stack.push(p0);
      label[p0] = id;
      while (stack.length) {
        const q = stack.pop()!;
        area++;
        const qx = q % cols;
        const qy = (q - qx) / cols;
        if (qx < minX) minX = qx;
        if (qx > maxX) maxX = qx;
        if (qy < minY) minY = qy;
        if (qy > maxY) maxY = qy;
        const push = (n: number) => {
          if (label[n] === -1 && isPhoto[n]) {
            label[n] = id;
            stack.push(n);
          }
        };
        if (qx > 0) push(q - 1);
        if (qx < cols - 1) push(q + 1);
        if (qy > 0) push(q - cols);
        if (qy < rows - 1) push(q + cols);
      }
      if (area > best) {
        best = area;
        bestBox = { minX, maxX, minY, maxY };
      }
    }
  }

  if (!bestBox || best < MIN_TILES) return [];
  const x = bestBox.minX * TILE;
  const y = bestBox.minY * TILE;
  const w = (bestBox.maxX - bestBox.minX + 1) * TILE;
  const h = (bestBox.maxY - bestBox.minY + 1) * TILE;
  // 太小 / 太扁的切块不是「一张图」，是版面里某个色块或小插画
  if (w < MIN_W || h < MIN_H) return [];
  return [{ x, y, w, h, tiles: best }];
}

/**
 * 裁切区域整体有多少种色相（判「这是不是一张真照片」）。
 *
 * 格子级判定会误判「蓝底白字」—— 每格因抗锯齿也有十几个色相，
 * 但整块只有蓝 + 白。所以这里按整块统计，不按格子。
 */
function cropHueVariety(file: string, box: { x: number; y: number; w: number; h: number }): Promise<number> {
  return sharp(file)
    .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
    .resize(160, 160, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info }) => {
      const hues = new Set<string>();
      for (let i = 0; i < data.length; i += info.channels) {
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        if ((mx - mn) / 255 <= 0.15) continue;
        hues.add(`${r >> 4},${g >> 4},${b >> 4}`);
      }
      return hues.size;
    });
}

/**
 * 抽取整个来源的配图池。
 *
 * 裁出来的图存到 data/media/corpus-photos/<note>-<page>.jpg，
 * 并写进 corpus_photos 表（带 note_id → 题材信息）。
 */
export async function extractCorpusPhotos(sourceId: number): Promise<PhotoRegion[]> {
  // ⚠️ 注意取的是 `ni.note_id`（notes.id），不是 `ni.id`（note_images.id）。
  // 两者都是自增主键但不相干：note_images.id 是全局的（939、940…），
  // 拿错会让配图池指向根本不存在的语料笔记，选图时按标题匹配就永远匹配不上。
  const rows = all<{ note_id: number; local_path: string | null; idx: number }>(
    `SELECT ni.note_id, ni.local_path, ni.idx
       FROM note_images ni JOIN notes n ON n.id = ni.note_id
      WHERE n.source_id = ? AND ni.local_path IS NOT NULL
      ORDER BY ni.note_id, ni.idx`,
    sourceId,
  );

  const dir = corpusPhotoDir();
  fs.mkdirSync(dir, { recursive: true });

  const out: PhotoRegion[] = [];
  run(`DELETE FROM corpus_photos WHERE source_id = ?`, sourceId);

  for (const r of rows) {
    if (!r.local_path || !fs.existsSync(r.local_path)) continue;
    let regions: Awaited<ReturnType<typeof detectPhotoRegions>> = [];
    try {
      regions = await detectPhotoRegions(r.local_path);
    } catch {
      continue;
    }
    for (const [i, reg] of regions.entries()) {
      // 整体色相太少 → 是色块/文字条，不是照片
      let variety = 0;
      try {
        variety = await cropHueVariety(r.local_path, reg);
      } catch {
        continue;
      }
      if (variety < MIN_CROP_HUES) continue;

      const name = `${r.note_id}-${r.idx}-${i}.jpg`;
      const abs = path.join(dir, name);
      try {
        await sharp(r.local_path)
          .extract({ left: reg.x, top: reg.y, width: reg.w, height: reg.h })
          .jpeg({ quality: 90, mozjpeg: true })
          .toFile(abs);
      } catch {
        continue;
      }
      const info = { noteId: r.note_id, pageIndex: r.idx, ...reg, file: abs };
      out.push(info);
      run(
        `INSERT INTO corpus_photos(source_id, note_id, page_index, file, x, y, w, h, tiles)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        sourceId,
        r.note_id,
        r.idx,
        abs,
        reg.x,
        reg.y,
        reg.w,
        reg.h,
        reg.tiles,
      );
    }
  }
  return out;
}
