import { getBrandKit, saveBrandKit } from '../visual/templates/brand-kit-store.js';
import { brandKitOverrideCount, isBrandKitActive } from '../visual/templates/brand-kit.js';
import { closeRenderer } from '../generate/cards.js';

/**
 * 给某来源装上 Chengwang 品牌套件（身份层覆盖）。
 *
 *   node server/dist/diagnostics/apply-chengwang-kit.js [sourceId]
 *
 * 只改身份：品牌名、副行、Logo（复用已抠好的素材）。
 * 版式几何（条高、编号形态、页面坐标）一字不动 —— 那是语料实测值。
 */
const sourceId = Number(process.argv[2] ?? '10');

const before = getBrandKit(sourceId);
console.log('原套件：', JSON.stringify({
  brandName: before.brandName,
  brandTagline: before.brandTagline,
  logo: Boolean(before.logoDark),
  accent: before.accent,
}));

// 复用已上传的素材（先前抠好的一对），只改文字身份
const logoDark = before.logoDark ?? {
  file: 'logo-dark-1793862070134.png',
  originalName: 'chengwang-logo.png',
  width: 800,
  height: 401,
  uploadedAt: new Date().toISOString(),
  mode: 'cutout' as const,
};
const logoLight = before.logoLight ?? {
  file: 'logo-light-1793862070134.png',
  originalName: 'chengwang-logo.png',
  width: 800,
  height: 401,
  uploadedAt: new Date().toISOString(),
  mode: 'cutout' as const,
};

const next = saveBrandKit({
  ...before,
  sourceId,
  brandName: 'Chengwang',
  brandTagline: '新媒体各渠道电商代运营服务 专业0-1 成功案例100+',
  logoDark,
  logoLight,
});

console.log('新套件：', JSON.stringify({
  brandName: next.brandName,
  brandTagline: next.brandTagline,
  logo: Boolean(next.logoDark),
  accent: next.accent,
}));
console.log(`生效：${isBrandKitActive(next)}   覆盖项：${brandKitOverrideCount(next)}`);

await closeRenderer();
