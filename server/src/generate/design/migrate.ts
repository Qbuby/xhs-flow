import { DEFAULT_CONTRACT, type DesignContract, type Motif, type Texture } from './contract.js';
import { PALETTES } from './palettes.js';

/**
 * 旧规格 → 新契约的迁移。
 *
 * 已存的 `style_profiles.card_template_spec` 是旧的 18 字段形状
 * （`background` / `text_primary` / `title_size` / `radius` / `decoration` …）。
 * 重新蒸馏能拿到新形状，但那要花一次 200 秒量级的模型调用，而且我们
 * 已经有一份可用的画像。所以这里做**确定性映射**：
 *
 *  - 从旧色板的色相/明度推断该走哪套视觉语言
 *  - 从旧 `title_size` 推断字号档位
 *  - 旧 `decoration` → 新 `motifs`
 *  - 旧 `background_image` → 新 `texture`
 *
 * 映射不追求「完全还原旧效果」—— 旧效果本来就是我们要摆脱的东西。
 * 目标是「**不崩、不违和、比原来好**」。
 */

interface LegacySpec {
  background?: string;
  text_primary?: string;
  text_secondary?: string;
  accent?: string;
  palette?: string[];
  title_size?: number;
  body_size?: number;
  line_height?: number;
  font_family?: string;
  font_weight_bold?: number;
  radius?: number;
  accent_style?: string;
  decoration?: string;
  background_image?: string;
  text_ratio?: number;
}

/** hex → HSL 的 H（0-360）与 L（0-1）。解析失败返回 null。 */
function hexToHsl(hex: unknown): { h: number; s: number; l: number } | null {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

/**
 * 挑最接近的色板。
 *
 * 判据按重要性排：明暗（深底/浅底）> 色相 > 饱和度。
 * 明暗错了最刺眼（深底变浅底整个气质就崩了），色相差一点只是"换了个色"。
 */
function pickClosestPalette(theme: keyof typeof PALETTES, bg: unknown, accent: unknown): number {
  const set = PALETTES[theme]!;
  const targetBg = hexToHsl(bg);
  const targetAccent = hexToHsl(accent);

  let best = 0;
  let bestScore = Infinity;
  for (const [i, p] of set.entries()) {
    const pBg = hexToHsl(p.bg);
    const pAccent = hexToHsl(p.accent);
    let score = 0;
    if (targetBg && pBg) {
      score += Math.abs(targetBg.l - pBg.l) * 320; // 明暗权重最高
      if (targetBg.l < 0.5 !== pBg.l < 0.5) score += 220; // 跨明暗直接重罚
    }
    if (targetAccent && pAccent) {
      const dh = Math.min(Math.abs(targetAccent.h - pAccent.h), 360 - Math.abs(targetAccent.h - pAccent.h));
      score += (dh / 180) * 120;
    }
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** 从旧字号推档位。旧默认 68，我们三档是 60 / 72 / 88。 */
function pickTypeScale(titleSize: unknown): DesignContract['type_scale'] {
  const n = Number(titleSize);
  if (!Number.isFinite(n)) return 'standard';
  if (n <= 64) return 'compact';
  if (n >= 82) return 'display';
  return 'standard';
}

/** 旧 decoration → 新 motifs。 */
function mapDecoration(decoration: unknown, accentStyle: unknown): Motif[] {
  switch (decoration) {
    case 'dots':
      return ['dots', 'page-num'];
    case 'corner_mark':
      return ['corner', 'page-num'];
    case 'emoji':
      // 旧值被 sanitizeSpec 强制改成 none 过，但万一还在也别回 emoji
      return ['rule', 'page-num'];
    default:
      // accent_style 是 block/bracket 的说明作者喜欢"有框感"的强调，
      // 顺手给 pair 装饰；否则给最通用的一对
      return accentStyle === 'block' || accentStyle === 'bracket'
        ? ['rule', 'badge', 'page-num']
        : ['rule', 'page-num'];
  }
}

/** 旧 background_image → 新 texture。 */
function mapTexture(backgroundImage: unknown, theme: DesignContract['theme']): Texture {
  const allowed = themeAllowedTextures(theme);
  const pick = (t: Texture): Texture => (allowed.includes(t) ? t : (allowed[0] ?? 'none'));
  switch (backgroundImage) {
    case 'texture':
      // 旧的 texture 是 45° 条纹，非常廉价；换成真正的纸感颗粒
      return pick('paper-grain');
    case 'photo':
      return pick('film-grain');
    case 'gradient':
      return pick('paper-grain');
    default:
      return pick('none');
  }
}

/** 各主题允许的纹理，与 resolve.ts 的 RECIPES 保持一致（避免循环依赖，这里只列数据）。 */
function themeAllowedTextures(theme: DesignContract['theme']): readonly Texture[] {
  switch (theme) {
    case 'still-paper':
      return ['paper-grain', 'film-grain', 'haze-blob', 'none'];
    case 'signal-proof':
      return ['hairline-grid', 'halftone', 'paper-grain', 'none'];
    case 'bridge-canvas':
      return ['film-grain', 'none'];
  }
}

/**
 * 旧 spec → 新契约。
 *
 * 传入任何东西都不会抛 —— 上游（`specForSource`）可能拿到 null、坏 JSON、
 * 或缺字段的旧对象。
 */
export function migrateLegacySpec(raw: unknown): DesignContract {
  const o = (raw ?? {}) as LegacySpec;

  // 先定主题：深底 → 图桥（本来就是为暗底设计的），
  // 冷色调 + 低饱和 → 实证，其余 → 静纸
  const bg = hexToHsl(o.background);
  const accent = hexToHsl(o.accent);
  let theme: DesignContract['theme'] = 'still-paper';
  if (bg && bg.l < 0.35) {
    theme = 'bridge-canvas';
  } else if (accent && accent.h >= 180 && accent.h <= 280 && accent.s > 0.35) {
    theme = 'signal-proof';
  }

  const paletteIndex = pickClosestPalette(theme, o.background, o.accent);

  return {
    theme,
    palette_index: paletteIndex,
    type_scale: pickTypeScale(o.title_size),
    density: 'standard',
    texture: mapTexture(o.background_image, theme),
    motifs: mapDecoration(o.decoration, o.accent_style),
    accent_style: normalizeAccentStyle(o.accent_style),
  };
}

function normalizeAccentStyle(v: unknown): DesignContract['accent_style'] {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  // 旧实现的 'none' 是坏的（掉进 else 变成高亮），这里让它**真的是 none**
  return (['underline', 'block', 'highlight', 'bracket', 'none'] as const).includes(
    s as (typeof DEFAULT_CONTRACT)['accent_style'],
  )
    ? (s as DesignContract['accent_style'])
    : DEFAULT_CONTRACT.accent_style;
}
