import { chatJson } from '../../llm/client.js';
import { logger } from '../../logger.js';
import { BrandKitSchema, type BrandKit } from './brand-kit.js';

/**
 * 自然语言 → 品牌套件修正项。
 *
 * 【为什么用模型解析而不是正则】
 * 用户会说「把品牌名换成 Chengwang」「logo 用这张图」「副标题也一起改掉，
 * 写成 新媒体内容服务」「强调色用橙一点」。这些意图的组合、指代、省略
 * 都不是正则能覆盖的。而输出必须是**严格结构化的** —— 所以让模型只做
 * 「抽取」，不做「决策」：它返回 { field, value } 列表，我们负责校验与合并。
 *
 * 【安全边界】
 * 模型不能自由写 hex、不能改版式几何（条高/编号/分栏）。它只能填
 * brandName / brandTagline / accent 三个字段，且 accent 必须过 hex 校验。
 * 这是刻意的限制 —— 版式几何是像素实测值，不该被自然语言改掉。
 */

export interface KitPatch {
  brandName?: string;
  brandTagline?: string;
  accent?: string;
  /** 用户提到了「用这张图/换成这个 logo」，需要前端上传后才生效 */
  wantsLogoUpload?: boolean;
  /** 用户要求「还原/清除」某项 */
  clear?: Array<'brandName' | 'brandTagline' | 'logo' | 'accent'>;
  /** 给用户看的解释 */
  reply: string;
}

const PATCH_SYSTEM = `你是「模板调整助手」。用户会用自然语言要求修改一个小红书账号图文模板的**身份层**。

你能改的只有这 3 个字段：
- brandName    品牌名（显示在封面页眉、内页页脚右侧的主行）
- brandTagline 副行文案（品牌名下面那行小字）
- accent       强调色（#RRGGBB）

你**不能**改版式：条带高度、编号大小与位置、分栏数、页面坐标都是从原账号语料像素测量出来的，改了就毁掉复刻。用户如果要求改这些，要在 reply 里说明不能改，并建议改哪个字段能达成类似效果。

规则：
1. 只抽取用户明确表达的修改。没提到的字段不要填。
2. 用户说「换成 Chengwang」这种，只填 brandName，不要顺手改 tagline。
3. 用户说「logo 也换掉」「用我上传的图」这类，置 wantsLogoUpload=true —— 图形素材必须由用户上传，你不能编造。
4. 用户说「还原」「恢复原样」「去掉」某项，写进 clear 数组。
5. accent 只接受 #RRGGBB。用户说「蓝一点」「橙一点」这类模糊描述，请给出一个具体的 #RRGGBB 并说明你的选择。
6. reply 用中文，一句话说清你要做什么，或为什么不能做。

只输出 JSON：
{"brandName":"...","brandTagline":"...","accent":"#RRGGBB","wantsLogoUpload":true,"clear":["logo"],"reply":"..."}
不需要的键直接省略。`;

/**
 * 解析用户的自然语言要求。
 *
 * 永不抛：模型失败时返回一个「没听懂」的 patch，交给界面提示，
 * 而不是让整个页面报错。
 */
export async function parseKitRequest(
  instruction: string,
  current: BrandKit,
): Promise<KitPatch> {
  const text = instruction.trim();
  if (!text) return { reply: '请告诉我要改什么，比如「品牌名换成 Chengwang」。' };

  try {
    const raw = await chatJson<Record<string, unknown>>({
      system: PATCH_SYSTEM,
      user: [
        `【当前品牌套件】`,
        `  品牌名：${current.brandName ?? '(沿用模板)'}`,
        `  副行文案：${current.brandTagline ?? '(沿用模板)'}`,
        `  强调色：${current.accent ?? '(沿用模板)'}`,
        `  Logo：${current.logoDark || current.logoLight ? '已上传自定义 logo' : '(沿用模板)'}`,
        '',
        `【用户的修改要求】${text}`,
      ].join('\n'),
      temperature: 0.2,
      maxTokens: 2048,
    });

    return coercePatch(raw);
  } catch (err) {
    logger.warn({ err, instruction: text }, '自然语言解析失败');
    return {
      reply: `没能理解「${text}」。可以直接说「品牌名换成 XXX」「副行文案改成 XXX」「强调色改成 #RRGGBB」，或者上传 logo 图后说「用这张图」。`,
    };
  }
}

/** 把模型的返回收敛成合法 patch —— 不信任任何字段。 */
export function coercePatch(raw: unknown): KitPatch {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: KitPatch = { reply: '' };

  const str = (v: unknown, max: number): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const s = v.trim().replace(/\s+/g, ' ');
    return s ? s.slice(0, max) : undefined;
  };

  const brandName = str(o.brandName, 60);
  if (brandName) out.brandName = brandName;

  const tagline = str(o.brandTagline, 120);
  if (tagline) out.brandTagline = tagline;

  // accent 必须严格 #RRGGBB —— 模型经常给 #fff 或 rgb()
  const accentRaw = str(o.accent, 20);
  if (accentRaw) {
    const m = /^#?([0-9a-f]{6})$/i.exec(accentRaw.replace(/^#/, '#'));
    if (m?.[1]) out.accent = `#${m[1].toUpperCase()}`;
  }

  if (o.wantsLogoUpload === true) out.wantsLogoUpload = true;

  const CLEARABLE = ['brandName', 'brandTagline', 'logo', 'accent'] as const;
  if (Array.isArray(o.clear)) {
    const c = o.clear
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter((v): v is (typeof CLEARABLE)[number] => (CLEARABLE as readonly string[]).includes(v));
    if (c.length > 0) out.clear = [...new Set(c)];
  }

  out.reply = str(o.reply, 200) ?? '';

  // 什么都没抽到又没解释 → 给个通用提示
  const changed =
    out.brandName || out.brandTagline || out.accent || out.wantsLogoUpload || out.clear?.length;
  if (!changed && !out.reply) {
    out.reply = '这一句里没有识别到可执行的修改。可以说「品牌名换成 XXX」这样具体的指令。';
  }
  return out;
}

/** 把 patch 合并进套件（纯函数，便于测试）。 */
export function applyPatch(kit: BrandKit, patch: KitPatch): BrandKit {
  const next: BrandKit = { ...kit, updatedAt: new Date().toISOString() };

  if (patch.brandName !== undefined) next.brandName = patch.brandName;
  if (patch.brandTagline !== undefined) next.brandTagline = patch.brandTagline;
  if (patch.accent !== undefined) next.accent = patch.accent;

  for (const c of patch.clear ?? []) {
    if (c === 'brandName') delete next.brandName;
    if (c === 'brandTagline') delete next.brandTagline;
    if (c === 'accent') delete next.accent;
    if (c === 'logo') {
      delete next.logoDark;
      delete next.logoLight;
    }
  }

  // 再次过 schema，防止手改数据留下脏值
  const parsed = BrandKitSchema.safeParse(next);
  return parsed.success ? parsed.data : next;
}
