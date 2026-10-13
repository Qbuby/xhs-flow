/**
 * `extractPalette` 解码正确性单测。
 *
 *   node server/dist/diagnostics/verify-palette.js
 *
 * 这条最值得一测，因为旧实现的 bug **看起来完全正常**：
 * 它确实返回 5 个 `#RRGGBB`，不报错、不崩、类型对，只是颜色全错 ——
 * 白色算出来是 `#007FFF`（蓝），灰色算出来是 `#004210`（近黑）。
 * 这种错误没有任何运行时信号，只有断言真实色值才能抓住。
 *
 * 断言分三组：
 *   1. 纯色：白/黑/红/绿/蓝 必须原样还原（±1 量化误差）
 *   2. 主次：一张 80% 白 + 20% 红的图，白必须排第一且权重≈0.8
 *   3. 顺序：权重降序，且不出现重复色
 */
import assert from 'node:assert/strict';
import { paletteFromRgb } from '../media/palette.js';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

/** `n` 个同色像素。 */
function solid(r: number, g: number, b: number, n: number): Buffer {
  const buf = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
  return buf;
}

/** hex → [r,g,b]。 */
function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  assert.ok(m, `不是合法的 #rrggbb：${hex}`);
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

/**
 * 量化到 5bit 再还原，取色时用的是**还原后的真实像素均值**，
 * 所以允许 ±8 的误差（5bit 桶宽是 8）。
 */
function assertNear(got: string, want: [number, number, number], label: string): void {
  const g = rgb(got);
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(g[i]! - want[i]!) <= 8,
      `${label}：期望约 rgb(${want.join(',')})，实际 ${got} = rgb(${g.join(',')})`,
    );
  }
}

console.log('extractPalette 解码正确性\n');

/* ---- 1. 纯色必须原样还原 ---- */
check('白色 (255,255,255) → #FFFFFF 附近，绝不能是蓝色', () => {
  const p = paletteFromRgb(solid(255, 255, 255, 100));
  assert.ok(p.length > 0, '没有返回任何颜色');
  assertNear(p[0]!.hex, [255, 255, 255], '白色');
  // 旧 bug 的指纹：R 和 B 互换/串位会产生这种结果
  assert.notEqual(p[0]!.hex.toUpperCase(), '#007FFF', '命中了旧 bug（白变蓝）');
});

check('黑色 (0,0,0) → #000000 附近', () => {
  const p = paletteFromRgb(solid(0, 0, 0, 100));
  assertNear(p[0]!.hex, [0, 0, 0], '黑色');
});

check('灰色 (128,128,128) → 三通道相等，不能是近黑', () => {
  const p = paletteFromRgb(solid(128, 128, 128, 100));
  const g = rgb(p[0]!.hex);
  assert.ok(
    Math.abs(g[0] - g[1]) <= 8 && Math.abs(g[1] - g[2]) <= 8,
    `灰色应当三通道相等，实际 ${p[0]!.hex}`,
  );
  assertNear(p[0]!.hex, [128, 128, 128], '灰色');
});

check('奶油色 (250,240,225) 保持暖调（R > G > B）', () => {
  const p = paletteFromRgb(solid(250, 240, 225, 100));
  const g = rgb(p[0]!.hex);
  assert.ok(g[0] > g[1] && g[1] > g[2], `暖调顺序被破坏：${p[0]!.hex} = rgb(${g.join(',')})`);
  assertNear(p[0]!.hex, [250, 240, 225], '奶油色');
});

check('朱红 (232,96,76) 保持红调（R 明显 > G,B）', () => {
  const p = paletteFromRgb(solid(232, 96, 76, 100));
  const g = rgb(p[0]!.hex);
  assert.ok(g[0] > g[1] + 40 && g[0] > g[2] + 40, `红色通道没有拉开：${p[0]!.hex}`);
  assertNear(p[0]!.hex, [232, 96, 76], '朱红');
});

/* ---- 2. 主次与权重 ---- */
check('80% 白 + 20% 红 → 白排第一，权重≈0.8', () => {
  const buf = Buffer.concat([solid(250, 250, 250, 800), solid(230, 60, 60, 200)]);
  const p = paletteFromRgb(buf, 5);
  assert.ok(p.length >= 2, `应当至少分出两个色，实际 ${p.length}`);
  assertNear(p[0]!.hex, [250, 250, 250], '主色');
  assert.ok(
    Math.abs(p[0]!.weight - 0.8) < 0.05,
    `主色权重应当≈0.8，实际 ${p[0]!.weight.toFixed(3)}`,
  );
  assertNear(p[1]!.hex, [230, 60, 60], '次色');
});

check('权重降序排列', () => {
  const buf = Buffer.concat([
    solid(10, 10, 10, 100),
    solid(120, 120, 120, 300),
    solid(240, 240, 240, 600),
  ]);
  const p = paletteFromRgb(buf, 5);
  for (let i = 1; i < p.length; i++) {
    assert.ok(
      p[i - 1]!.weight >= p[i]!.weight,
      `第 ${i} 项权重 ${p[i]!.weight} 大于前一项 ${p[i - 1]!.weight}`,
    );
  }
  assertNear(p[0]!.hex, [240, 240, 240], '占比最大的那色');
});

check('没有重复色值', () => {
  const p = paletteFromRgb(solid(200, 100, 50, 500), 5);
  const set = new Set(p.map((e) => e.hex));
  assert.equal(set.size, p.length, `出现重复色值：${p.map((e) => e.hex).join(', ')}`);
});

/* ---- 3. 边界 ---- */
check('空输入返回空数组，不抛', () => {
  assert.deepEqual(paletteFromRgb(Buffer.alloc(0)), []);
});

check('残缺的尾部像素被忽略（长度不是 3 的倍数）', () => {
  const buf = Buffer.concat([solid(255, 255, 255, 10), Buffer.from([1])]);
  const p = paletteFromRgb(buf);
  assert.ok(p.length > 0, '应当仍然取到颜色');
  assertNear(p[0]!.hex, [255, 255, 255], '白色');
});

check('top 参数生效', () => {
  const buf = Buffer.concat([
    solid(10, 10, 10, 100),
    solid(80, 80, 80, 100),
    solid(150, 150, 150, 100),
    solid(220, 220, 220, 100),
  ]);
  assert.equal(paletteFromRgb(buf, 2).length, 2);
  assert.equal(paletteFromRgb(buf, 5).length, 4);
});

console.log(`\n通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
