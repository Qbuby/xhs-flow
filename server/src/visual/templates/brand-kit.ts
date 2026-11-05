import { z } from 'zod';

/**
 * 品牌套件（Brand Kit）—— 账号视觉系统之上的**身份覆盖层**。
 *
 * 【为什么需要它，以及它为什么不能塞进 AccountTemplate】
 *
 * AccountTemplate 描述的是**版式几何**：条高、编号形态、分栏、区域坐标。
 * 那些值是从原账号语料逐页像素测量出来的，改了就不再是复刻。
 *
 * 而「把 WOW 换成 Chengwang」要改的是**身份**：logo 图形、品牌名、
 * 副行文案。这些东西换掉之后，版式几何应当**一字不动** —— 页脚还是
 * 127px、编号还是浅蓝 88px、蓝底还是 #007CFE。
 *
 * 早期把两者混在一起的后果是可预见的：换一个 logo 就要重写整个模板，
 * 或者反过来，换个品牌名把实测几何带跑偏。所以这里分成两层：
 *
 *   TemplateFamily（版式，只读） + BrandKit（身份，可覆盖） → 渲染
 *
 * 【归属】
 * 套件按**来源**（source_id）保存，落库在 settings 里，键为
 * `brand_kit:<sourceId>`。这样同一套语料的模板可以导出给不同品牌复用。
 */

/** 套件里的一项素材（logo 图形）。 */
export const BrandAssetSchema = z.object({
  /** 相对 data/brand-kits/ 的文件名 */
  file: z.string(),
  /** 原始上传文件名，界面展示用 */
  originalName: z.string().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** 上传时间 */
  uploadedAt: z.string(),
  /**
   * 处理方式：
   *  - `cutout`  抠成透明底（推荐，能贴任意底色）
   *  - `plain`   原样保留（本身已是透明 PNG 时）
   */
  mode: z.enum(['cutout', 'plain']),
  /** 抠图时的底色判定阈值（0-255 亮度），便于复现 */
  cutoutThreshold: z.number().optional(),
});
export type BrandAsset = z.infer<typeof BrandAssetSchema>;

/**
 * 品牌套件。
 *
 * 所有字段可空：空的含义是「沿用模板族里的原值」，不是「置空」。
 * 这条语义很重要 —— 用户只想换 logo 时，不该把品牌名也清掉。
 */
export const BrandKitSchema = z.object({
  sourceId: z.number().int(),
  /** 品牌名，替换封面页眉/内页页脚右对齐的主行文字 */
  brandName: z.string().optional(),
  /** 副行文案（如「新媒体各渠道电商代运营服务 专业0-1 成功案例100+」） */
  brandTagline: z.string().optional(),
  /**
   * 图形 logo：同一张原图派生出深色/浅色两版。
   * 深色版用于浅色底（封面页眉），浅色版用于深色底（内页页脚）。
   */
  logoDark: BrandAssetSchema.optional(),
  logoLight: BrandAssetSchema.optional(),
  /** 品牌强调色。留空则沿用模板族的 accent。 */
  accent: z.string().optional(),
  updatedAt: z.string(),
});

export type BrandKit = z.infer<typeof BrandKitSchema>;

/** 空套件（什么都没覆盖）。 */
export function emptyBrandKit(sourceId: number): BrandKit {
  return { sourceId, updatedAt: new Date().toISOString() };
}

/**
 * 套件是否真的覆盖了什么。
 *
 * 界面用它决定显示「未启用」还是「已覆盖 N 项」——
 * 空套件不算启用，避免「看起来配了但其实没生效」。
 */
export function brandKitOverrideCount(kit: BrandKit | null | undefined): number {
  if (!kit) return 0;
  let n = 0;
  if (kit.brandName?.trim()) n++;
  if (kit.brandTagline?.trim()) n++;
  if (kit.logoDark) n++;
  if (kit.logoLight) n++;
  if (kit.accent?.trim()) n++;
  return n;
}

export function isBrandKitActive(kit: BrandKit | null | undefined): boolean {
  return brandKitOverrideCount(kit) > 0;
}

/**
 * 套件对渲染的**净效果**。界面用它展示「哪些字段会被替换」。
 *
 * 与 brandKitOverrideCount 的区别：这里返回具体的新旧值，
 * 用户能一眼看出「品牌名 WOW Culture Media Co., Ltd → Chengwang」。
 */
export interface BrandKitDiff {
  field: 'brandName' | 'brandTagline' | 'logo' | 'accent';
  label: string;
  from: string;
  to: string;
}

export function describeBrandKitDiff(
  kit: BrandKit | null | undefined,
  current: { brandName?: string; brandTagline?: string; accent?: string; hasLogo?: boolean },
): BrandKitDiff[] {
  if (!kit) return [];
  const out: BrandKitDiff[] = [];
  // 只列**真的改变**的字段。逐字相同的覆盖没有信息量 ——
  // 实测把副行文案原样填一遍，界面会显示「→ 同一个值」，看起来像没生效。
  const same = (a: string | undefined, b: string): boolean =>
    (a ?? '').trim() === b.trim();

  if (kit.brandName?.trim() && !same(current.brandName, kit.brandName)) {
    out.push({
      field: 'brandName',
      label: '品牌署名',
      from: current.brandName || '(未设置)',
      to: kit.brandName.trim(),
    });
  }
  if (kit.brandTagline?.trim() && !same(current.brandTagline, kit.brandTagline)) {
    out.push({
      field: 'brandTagline',
      label: '副行文案',
      from: current.brandTagline || '(未设置)',
      to: kit.brandTagline.trim(),
    });
  }
  if (kit.logoDark || kit.logoLight) {
    out.push({
      field: 'logo',
      label: '图形 Logo',
      from: current.hasLogo ? '原图形 Logo' : '(文字 Logo)',
      to: kit.logoDark?.originalName || kit.logoLight?.originalName || '已上传',
    });
  }
  if (kit.accent?.trim() && !same(current.accent, kit.accent)) {
    out.push({
      field: 'accent',
      label: '强调色',
      from: current.accent || '(模板默认)',
      to: kit.accent.trim(),
    });
  }
  return out;
}
