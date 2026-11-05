import { getSetting, setSetting } from '../../db/index.js';
import { logger } from '../../logger.js';
import { BrandKitSchema, emptyBrandKit, type BrandKit } from './brand-kit.js';

/**
 * 品牌套件的持久化。
 *
 * 存 settings 表，键 `brand_kit:<sourceId>`。为什么不用新表：
 *  - 套件是「每来源一份」的单例配置，不是需要查询/关联的业务实体
 *  - settings 已经有 KV 语义与 updated_at，复用它省一次迁移
 * 如果将来要支持「一套语料 → 多个品牌」的并排对比，再升级成表。
 */

const keyOf = (sourceId: number): string => `brand_kit:${sourceId}`;

export function getBrandKit(sourceId: number): BrandKit {
  try {
    const raw = getSetting(keyOf(sourceId));
    if (!raw) return emptyBrandKit(sourceId);
    const parsed = BrandKitSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    logger.warn({ sourceId }, '品牌套件数据不合法，按空套件处理');
    return emptyBrandKit(sourceId);
  } catch (err) {
    logger.warn({ err, sourceId }, '读取品牌套件失败');
    return emptyBrandKit(sourceId);
  }
}

export function saveBrandKit(kit: BrandKit): BrandKit {
  const parsed = BrandKitSchema.parse({ ...kit, updatedAt: new Date().toISOString() });
  setSetting(keyOf(kit.sourceId), JSON.stringify(parsed));
  return parsed;
}

/** 清空套件（恢复成原模板身份）。 */
export function resetBrandKit(sourceId: number): BrandKit {
  const fresh = emptyBrandKit(sourceId);
  setSetting(keyOf(sourceId), JSON.stringify(fresh));
  return fresh;
}

/**
 * 套件叠加到模板上的**唯一入口**。
 *
 * 渲染链（specForSource）与预览接口都调它，保证「预览所见 = 生产所得」。
 * 预览走另一条路径是常见坑：预览对了、生产不对，或者反过来。
 *
 * 语义：套件字段为空 → 保留模板原值；非空 → 覆盖。
 */
export function overlayBrandKit(
  template: {
    cover_header_text: string;
    cover_header_sub: string;
    inner_footer_text: string;
    inner_footer_sub: string;
    accent: string;
    [k: string]: unknown;
  },
  kit: BrandKit | null,
): typeof template {
  if (!kit) return template;
  const out = { ...template };

  if (kit.brandName?.trim()) {
    // 封面页眉与内页页脚使用同一个品牌名（原账号就是这样一致的）
    out.cover_header_text = kit.brandName.trim();
    out.inner_footer_text = kit.brandName.trim();
  }
  if (kit.brandTagline?.trim()) {
    out.cover_header_sub = kit.brandTagline.trim();
    out.inner_footer_sub = kit.brandTagline.trim();
  }
  if (kit.accent?.trim()) {
    out.accent = kit.accent.trim();
  }

  // logo：套件里有上传素材就替换掉模板内置资产路径，
  // 用特殊前缀 `kit:` 标记来源，渲染器据此去 data/brand-kits 读文件。
  if (kit.logoDark) out.logo_asset_dark = `kit:${kit.logoDark.file}`;
  if (kit.logoLight) out.logo_asset_light = `kit:${kit.logoLight.file}`;

  return out;
}
