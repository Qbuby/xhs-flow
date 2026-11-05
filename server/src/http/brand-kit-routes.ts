import type { FastifyInstance } from 'fastify';
import { getStyleProfile } from '../corpus/profile.js';
import { logger } from '../logger.js';
import { toResolved, buildCardHtml, CARD_WIDTH, CARD_HEIGHT } from '../generate/cards.js';
import { AccountTemplateSchema } from '../generate/design/contract.js';
import {
  applyPatch,
  coercePatch,
  parseKitRequest,
} from '../visual/templates/brand-kit-nl.js';
import {
  brandKitOverrideCount,
  describeBrandKitDiff,
  emptyBrandKit,
  isBrandKitActive,
} from '../visual/templates/brand-kit.js';
import { prepareBrandLogo, clearBrandKitAssets } from '../visual/templates/brand-kit-assets.js';
import {
  getBrandKit,
  overlayBrandKit,
  resetBrandKit,
  saveBrandKit,
} from '../visual/templates/brand-kit-store.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { MEDIA_DIR } from '../config.js';

/**
 * 模板调整（品牌套件）接口。
 *
 * 三组能力，对应「自然语言交互 + 上传素材 + 预览」：
 *   GET    /api/sources/:id/brand-kit          读当前套件与可对比信息
 *   POST   /api/sources/:id/brand-kit/chat     自然语言改套件（不落库，返回 patch 预览）
 *   POST   /api/sources/:id/brand-kit/apply    应用 patch（落库）
 *   POST   /api/sources/:id/brand-kit/logo     上传 logo 素材（multipart，抠底出双版）
 *   POST   /api/sources/:id/brand-kit/preview  按当前套件渲染预览图（不落库）
 *   POST   /api/sources/:id/brand-kit/reset    还原成模板原样
 *
 * 【预览为什么不落库】
 * 用户在反复调「品牌名换成 X」「logo 换一张」时会点很多次预览。
 * 每次落库会污染 settings 的历史，也让「取消」变得困难。
 * 所以预览接受一个**临时套件**参数，只在内存里叠加后渲染。
 */

/** 从风格画像里取模板族的身份基线（用于展示「从什么变成什么」）。 */
function templateBaseline(sourceId: number): {
  brandName: string;
  brandTagline: string;
  accent: string;
  hasLogo: boolean;
  family: string;
} {
  const prof = getStyleProfile(sourceId)?.profile;
  const raw = (prof?.card_template_spec ?? {}) as Record<string, unknown>;
  const tpl = (raw.account_template ?? {}) as Record<string, unknown>;
  return {
    brandName: String(tpl.cover_header_text ?? ''),
    brandTagline: String(tpl.cover_header_sub ?? ''),
    accent: String(tpl.accent ?? ''),
    hasLogo: Boolean(tpl.logo_asset_dark || tpl.logo_asset_light),
    family: String(tpl.family ?? 'generic-enum-v1'),
  };
}

/** 套件 → 渲染用 spec（与生产链同一条叠加逻辑）。 */
function specWithKit(sourceId: number, kitOverride?: unknown) {
  const prof = getStyleProfile(sourceId)?.profile;
  const base = toResolved(prof?.card_template_spec);
  const kit = kitOverride ? (kitOverride as ReturnType<typeof getBrandKit>) : getBrandKit(sourceId);
  if (!isBrandKitActive(kit)) return base;
  const overlaid = overlayBrandKit(base.accountTemplate, kit);
  const parsed = AccountTemplateSchema.safeParse(overlaid);
  return {
    ...base,
    accountTemplate: parsed.success ? parsed.data : base.accountTemplate,
  };
}

/** 预览卡片：覆盖封面 + 内页两种，最能看出 logo/署名/强调色效果。 */
function previewCards(): Array<{ layout: 'cover' | 'list'; index: number; blocks: Record<string, unknown> }> {
  return [
    {
      layout: 'cover',
      index: 0,
      blocks: {
        eyebrow: 'BRAND NOTE',
        title: '新中式热潮里，\n品牌靠什么出圈',
        hint: '东方美学成为流量密码，品牌拼的不只是国风设计',
        items: ['从"打造人设"', '到"建立信任"', '从"追求流量"', '到"承接生意"'],
      },
    },
    {
      layout: 'list',
      index: 1,
      blocks: {
        title: '品牌真正该学的是什么',
        items: [
          { text: '找到一个属于自己的视觉记忆点', note: '不用看 LOGO，也知道是你' },
          { text: '把品牌哲学做成可感知的界面', note: '让用户三秒内抓到判断' },
          { text: '让每个触点都指向同一个印象', note: '内容、门店、包装同构' },
        ],
      },
    },
  ];
}

export async function registerBrandKitRoutes(app: FastifyInstance): Promise<void> {
  /* ---------- 读 ---------- */

  app.get('/api/sources/:id/brand-kit', async (req) => {
    const sourceId = Number((req.params as { id: string }).id);
    const kit = getBrandKit(sourceId);
    const baseline = templateBaseline(sourceId);
    return {
      sourceId,
      kit,
      active: isBrandKitActive(kit),
      overrideCount: brandKitOverrideCount(kit),
      diff: describeBrandKitDiff(kit, baseline),
      baseline,
      /** 界面提示：套件改的是身份层，版式几何不受影响 */
      note:
        '品牌套件只替换 logo、品牌署名、副行文案与强调色；' +
        '页眉/页脚条高、编号形态、分栏与页面坐标仍取自语料实测的模板族，不会被改动。',
    };
  });

  /* ---------- 自然语言解析（不落库） ---------- */

  app.post('/api/sources/:id/brand-kit/chat', async (req) => {
    const sourceId = Number((req.params as { id: string }).id);
    const { instruction } = (req.body ?? {}) as { instruction?: string };
    const text = String(instruction ?? '').trim();
    if (!text) return { error: '缺少 instruction' };

    const kit = getBrandKit(sourceId);
    const patch = await parseKitRequest(text, kit);
    // 用 patch 试算一次，让界面能显示「改完会是什么样」
    const preview = applyPatch(kit, patch);

    return {
      patch,
      /** 应用 patch 后的套件（仅用于界面预览） */
      draftKit: preview,
      diff: describeBrandKitDiff(preview, templateBaseline(sourceId)),
      /** 需要用户上传素材才能完成的部分 */
      needsUpload: Boolean(patch.wantsLogoUpload),
    };
  });

  /* ---------- 应用（落库） ---------- */

  app.post('/api/sources/:id/brand-kit/apply', async (req) => {
    const sourceId = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { patch?: unknown; kit?: unknown };

    // 两种入口：应用模型解析出的 patch，或直接提交整个套件（前端手工编辑）
    let next = getBrandKit(sourceId);
    if (body.patch) {
      next = applyPatch(next, coercePatch(body.patch));
    } else if (body.kit) {
      const incoming = body.kit as Record<string, unknown>;
      next = {
        ...next,
        brandName: typeof incoming.brandName === 'string' ? incoming.brandName : next.brandName,
        brandTagline:
          typeof incoming.brandTagline === 'string' ? incoming.brandTagline : next.brandTagline,
        accent: typeof incoming.accent === 'string' ? incoming.accent : next.accent,
      };
    } else {
      return { error: '缺少 patch 或 kit' };
    }

    const saved = saveBrandKit({ ...next, sourceId });
    logger.info(
      { sourceId, overrides: brandKitOverrideCount(saved) },
      '品牌套件已更新',
    );
    return {
      ok: true,
      kit: saved,
      active: isBrandKitActive(saved),
      diff: describeBrandKitDiff(saved, templateBaseline(sourceId)),
    };
  });

  /* ---------- 上传 logo ---------- */

  /**
   * 接收 base64（而不是 multipart）。
   *
   * 理由：这个项目没有 multipart 插件，而为一次上传引一个依赖不值得。
   * 前端用 FileReader 读成 data URL 提交，体积上限 8MB（一张 logo 足够）。
   */
  app.post('/api/sources/:id/brand-kit/logo', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const sourceId = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { dataUrl?: string; fileName?: string; mode?: string };
    const dataUrl = String(body.dataUrl ?? '');
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m?.[2]) {
      reply.code(400);
      return { error: '图片格式不支持，请上传 PNG/JPG/WEBP' };
    }

    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 8 * 1024 * 1024) {
      reply.code(400);
      return { error: '图片超过 8MB，请压缩后再上传' };
    }

    try {
      // 换 logo 时清掉旧素材，避免目录堆积
      await clearBrandKitAssets(sourceId);
      const prepared = await prepareBrandLogo(buf, sourceId);

      const kit = getBrandKit(sourceId);
      const now = new Date().toISOString();
      const next = saveBrandKit({
        ...kit,
        sourceId,
        logoDark: {
          file: prepared.darkFile,
          originalName: String(body.fileName ?? 'logo.png').slice(0, 80),
          width: prepared.width,
          height: prepared.height,
          uploadedAt: now,
          mode: 'cutout',
          cutoutThreshold: prepared.cutoutThreshold,
        },
        logoLight: {
          file: prepared.lightFile,
          originalName: String(body.fileName ?? 'logo.png').slice(0, 80),
          width: prepared.width,
          height: prepared.height,
          uploadedAt: now,
          mode: 'cutout',
          cutoutThreshold: prepared.cutoutThreshold,
        },
      });

      return {
        ok: true,
        kit: next,
        prepared: {
          width: prepared.width,
          height: prepared.height,
          inkRatio: Number(prepared.inkRatio.toFixed(3)),
        },
        diff: describeBrandKitDiff(next, templateBaseline(sourceId)),
      };
    } catch (err) {
      reply.code(400);
      logger.warn({ err, sourceId }, 'logo 素材处理失败');
      return { error: `素材处理失败：${(err as Error).message}` };
    }
  });

  /* ---------- 预览 ---------- */

  app.post('/api/sources/:id/brand-kit/preview', async (req, reply) => {
    const sourceId = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { kit?: unknown; layouts?: string[] };
    // 允许传临时套件（未落库），用于「改完先看看」
    const spec = specWithKit(sourceId, body.kit);

    const cards = previewCards();
    const chromium = await import('playwright');
    const ctx = await chromium.chromium.launch({ headless: true });
    const page = await ctx.newPage();
    await page.setViewportSize({ width: CARD_WIDTH, height: CARD_HEIGHT });

    // 必须落在 MEDIA_DIR 下，/media/ 静态根才服务得到
    const outDir = path.join(MEDIA_DIR, 'brand-kits', String(sourceId), 'preview');
    await fs.mkdir(outDir, { recursive: true });
    const files: Array<{ layout: string; url: string; width: number; height: number }> = [];

    try {
      for (const card of cards) {
        const html = buildCardHtml(
          { layout: card.layout, blocks: card.blocks, index: card.index },
          spec,
          undefined,
          sourceId,
        );
        await page.setContent(html, { waitUntil: 'load' });
        await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<void> } }).fonts?.ready);
        await page.waitForTimeout(120);
        const name = `preview-${card.layout}.png`;
        const abs = path.join(outDir, name);
        await page.screenshot({ path: abs, type: 'png' });
        files.push({
          layout: card.layout,
          url: `/media/brand-kits/${sourceId}/preview/${name}?t=${Date.now()}`,
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
        });
      }
    } catch (err) {
      reply.code(500);
      logger.error({ err, sourceId }, '预览渲染失败');
      return { error: `预览渲染失败：${(err as Error).message}` };
    } finally {
      await ctx.close().catch(() => undefined);
    }

    return { ok: true, files };
  });

  /* ---------- 还原 ---------- */

  app.post('/api/sources/:id/brand-kit/reset', async (req) => {
    const sourceId = Number((req.params as { id: string }).id);
    const fresh = resetBrandKit(sourceId);
    await clearBrandKitAssets(sourceId);
    logger.info({ sourceId }, '品牌套件已还原');
    return { ok: true, kit: fresh, active: false };
  });

  /* ---------- 素材尺寸探测（前端上传前预览用） ---------- */

  app.post('/api/sources/:id/brand-kit/inspect', { bodyLimit: 12 * 1024 * 1024 }, async (req, reply) => {
    const body = (req.body ?? {}) as { dataUrl?: string };
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(
      String(body.dataUrl ?? ''),
    );
    if (!m?.[2]) {
      reply.code(400);
      return { error: '图片格式不支持' };
    }
    try {
      const meta = await sharp(Buffer.from(m[2], 'base64')).metadata();
      return {
        ok: true,
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        format: meta.format ?? '',
      };
    } catch (err) {
      reply.code(400);
      return { error: `无法读取图片：${(err as Error).message}` };
    }
  });
}
