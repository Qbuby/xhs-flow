/**
 * 重算 note_images.palette。
 *
 * 背景：旧的 extractPalette 把 5bit 量化键当 hex 打印，白色算成 #007FFF
 * （一个蓝）。库里 700 张图有 632 张带这个指纹。解码已经修好，但这批存量
 * 数据是坏的，画像据此归纳出来的色板自然对不上真实图片。
 *
 * 这里用修好的 extractPalette 对每张本地图重算，覆盖 palette 列。
 * 纯本地 sharp 运算，不发任何网络请求。
 *
 *   node server/dist/diagnostics/recompute-palette.js
 */
import fs from 'node:fs/promises';
import { all, run } from '../db/index.js';
import { extractPalette } from '../media/palette.js';

interface Row {
  id: number;
  local_path: string | null;
}

const rows = all<Row>(
  `SELECT id, local_path FROM note_images
   WHERE palette LIKE '%#007FFF%' AND local_path IS NOT NULL`,
);

let fixed = 0;
let missing = 0;
let failed = 0;

for (const r of rows) {
  let buf: Buffer;
  try {
    buf = await fs.readFile(r.local_path!);
  } catch {
    missing++;
    continue;
  }
  const pal = await extractPalette(buf);
  if (pal.length === 0) {
    failed++;
    continue;
  }
  run('UPDATE note_images SET palette = ? WHERE id = ?', JSON.stringify(pal), r.id);
  fixed++;
  if (fixed % 100 === 0) console.log(`  已重算 ${fixed}/${rows.length}`);
}

console.log(`\n重算完成：修复 ${fixed}，文件缺失 ${missing}，解码失败 ${failed}，共 ${rows.length}`);
