import { migrateLegacySpec } from './migrate.js';
import { resolveSpec } from './resolve.js';
import type { DesignContract, ResolvedSpec } from './contract.js';

export * from './contract.js';
export { PALETTES, TYPE_SCALES, DENSITY_SPECS, FONT_SERIF, FONT_SANS, FONT_MONO } from './palettes.js';
export { resolveSpec, maxTitleLines, describeThemeOptions, THEME_RECIPES } from './resolve.js';
export { migrateLegacySpec } from './migrate.js';
export { textureLayer, backgroundCss, photoScrim, hazeBlobs, type TextureLayerOptions } from './textures.js';
export { motifLayer, inlineMotif, badgeText, type MotifContext } from './motifs.js';

/**
 * 任何形状的规格 → 可直接渲染的 ResolvedSpec。
 *
 * 存在的意义是让调用方不用关心数据是新契约还是旧画像：
 *  - 新契约（有 `theme` 字段）→ resolveSpec
 *  - 旧 CardTemplateSpec（有 `background`/`title_size`）→ migrateLegacySpec → resolveSpec
 *  - null / 垃圾 → 默认契约
 *
 * 这样 `buildCardHtml` / `renderCard` 只有一个入口，而且**永远不会抛**。
 */
export function toResolved(raw: unknown): ResolvedSpec {
  return resolveSpec(normalizeContract(raw));
}

/**
 * 把任意形状归一成**新契约**。
 *
 * 与 `toResolved` 的区别：这个只返回契约本身，不展开成 token。
 * 用于「存库」与「进提示词」—— 库里从此只落新契约，读旧数据时
 * 顺手迁移一次，下次写回就统一了。
 */
export function normalizeContract(raw: unknown): DesignContract {
  const o = (raw ?? {}) as Record<string, unknown>;
  const looksLikeContract = typeof o.theme === 'string';
  return resolveSpec(looksLikeContract ? o : migrateLegacySpec(o)).contract;
}

export type { DesignContract, ResolvedSpec };
