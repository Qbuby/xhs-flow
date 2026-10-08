import type { Page } from 'playwright';
import sharp from 'sharp';
import { browser } from '../xhs/browser.js';
import { MEDIA_DIR } from '../config.js';
import { getStyleProfile, type CardTemplateSpec } from '../corpus/profile.js';
import { logger } from '../logger.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { searchStock, toSearchHint, type StockImage } from '../media/stock.js';

/**
 * 卡片渲染器。
 *
 * 走 Playwright + HTML/CSS 而不是 satori：satori 不支持 .ttc 字体集合，
 * 而 Windows 上默认的中文字体（微软雅黑 msyh.ttc）恰好就是 .ttc，
 * 走那条路必踩字体坑。用 Chromium 则系统字体栈免费拿，
 * 中文断行、grid、阴影、渐变全都正常。
 *
 * 尺寸固定 1080×1440 —— 小红书原生 3:4。
 */

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1440;

export const LAYOUTS = ['cover', 'quote', 'list', 'steps', 'compare', 'photo_text', 'cta'] as const;
export type Layout = (typeof LAYOUTS)[number];

export interface CardContent {
  layout: Layout;
  /** 版式相关的文案块，字段由各版式自行解释 */
  blocks: Record<string, unknown>;
  /** photo_text 用的检索关键词（渲染时去图库取图） */
  photoQuery?: string;
  /** 已下载好的底图（本地绝对路径），有则优先用它 */
  photoPath?: string;
}

export interface Card {
  layout: Layout;
  blocks: Record<string, unknown>;
  photoUrl?: string;
  imagePath?: string;
}

/* ------------------------------------------------------------------ */
/* 默认规格（还没生成画像时用）                                          */
/* ------------------------------------------------------------------ */

export const DEFAULT_SPEC: CardTemplateSpec = {
  background: '#FFF9F2',
  text_primary: '#2B2320',
  text_secondary: '#7A6A60',
  accent: '#E8604C',
  palette: ['#FFF9F2', '#F5E6D3', '#E8604C'],
  title_size: 68,
  body_size: 34,
  line_height: 1.6,
  font_family: '"Microsoft YaHei", "微软雅黑", "PingFang SC", "Noto Sans SC", sans-serif',
  font_weight_bold: 800,
  radius: 28,
  accent_style: 'highlight',
  decoration: 'emoji',
  background_image: 'gradient',
  text_ratio: 0.6,
};

export function specForSource(sourceId: number | null): CardTemplateSpec {
  if (!sourceId) return DEFAULT_SPEC;
  const found = getStyleProfile(sourceId);
  return found?.profile.card_template_spec ?? DEFAULT_SPEC;
}

/* ------------------------------------------------------------------ */
/* HTML 构建                                                            */
/* ------------------------------------------------------------------ */

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // 模型经常在文案里用 \n 分行。默认 HTML 会把它压成空格，
    // 必须显式转成 <br>，否则整段标题会挤成一行。
    .replace(/\r?\n/g, '<br/>');
}

/** 把模型给的强调标记 [[词]] 渲染成 accent 样式的 span。 */
function highlight(text: string, spec: CardTemplateSpec): string {
  const safe = esc(text);
  const style =
    spec.accent_style === 'underline'
      ? `border-bottom:6px solid ${spec.accent};`
      : spec.accent_style === 'block'
        ? `background:${spec.accent};color:#fff;padding:0 10px;border-radius:8px;`
        : spec.accent_style === 'bracket'
          ? `color:${spec.accent};box-shadow:inset 4px 0 0 ${spec.accent};padding-left:8px;`
          : `background:linear-gradient(transparent 60%, ${spec.accent}55 60%);`;
  return safe.replace(/\[\[(.+?)\]\]/g, `<span style="${style}">$1</span>`);
}

function backgroundCss(spec: CardTemplateSpec): string {
  if (spec.background_image === 'photo') return `background:${spec.background};`;
  if (spec.background_image === 'gradient') {
    const p = spec.palette;
    const c2 = p[1] ?? spec.background;
    const c3 = p[2] ?? spec.accent;
    return `background:linear-gradient(160deg, ${spec.background} 0%, ${c2} 55%, ${mix(spec.background, c3, 0.15)} 100%);`;
  }
  if (spec.background_image === 'texture') {
    return `background:repeating-linear-gradient(45deg, ${spec.background} 0 20px, ${spec.palette[1] ?? spec.background} 20px 40px);`;
  }
  return `background:${spec.background};`;
}

function mix(a: string, b: string, t: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  if (!pa || !pb) return a;
  const c = pa.map((v, i) => Math.round(v + ((pb[i] ?? v) - v) * t));
  return '#' + c.map((v) => clampByte(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function hexToRgb(h: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(h.trim());
  if (!m?.[1]) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function decoration(spec: CardTemplateSpec): string {
  if (spec.decoration === 'corner_mark')
    return `<div style="position:absolute;top:0;right:0;width:0;height:0;border-top:120px solid ${spec.accent};border-left:120px solid transparent;"></div>`;
  if (spec.decoration === 'dots')
    return `<div style="position:absolute;bottom:60px;right:70px;font-size:40px;opacity:.35;letter-spacing:14px;color:${spec.accent};">· · ·</div>`;
  return '';
}

function baseCss(spec: CardTemplateSpec, photoDataUri?: string): string {
  const bg = photoDataUri
    ? `background-image:linear-gradient(180deg, rgba(0,0,0,.15) 0%, rgba(0,0,0,.72) 100%), url('${photoDataUri}');
       background-size:cover; background-position:center;`
    : backgroundCss(spec);

  return `
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    html,body{width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px;overflow:hidden}
    body{font-family:${spec.font_family};-webkit-font-smoothing:antialiased;
         color:${photoDataUri ? '#FFFFFF' : spec.text_primary};${bg}}
    .card{width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px;position:relative;
          padding:96px 88px;display:flex;flex-direction:column;
          border-radius:${spec.radius}px;overflow:hidden}
    .content{flex:1;display:flex;flex-direction:column;justify-content:center;
             text-shadow:${photoDataUri ? '0 2px 18px rgba(0,0,0,.45)' : 'none'}}
    .title{font-size:${spec.title_size}px;font-weight:${spec.font_weight_bold};line-height:1.25;
           letter-spacing:-1px;margin-bottom:36px}
    .body{font-size:${spec.body_size}px;line-height:${spec.line_height};color:${photoDataUri ? '#F2EDE8' : spec.text_secondary}}
    .eyebrow{font-size:26px;letter-spacing:6px;color:${spec.accent};font-weight:700;margin-bottom:28px;
             text-transform:uppercase}
    .footer{font-size:24px;opacity:.6;display:flex;justify-content:space-between;align-items:flex-end}
    .num{font-weight:800;color:${spec.accent};margin-right:14px}
  `;
}

/** 各版式的正文片段 */
function layoutBody(
  layout: Layout,
  b: Record<string, unknown>,
  spec: CardTemplateSpec,
  photoDataUri?: string,
): string {
  switch (layout) {
    case 'cover': {
      const items = (b.items as string[]) ?? [];
      return `
        <div class="eyebrow">${esc(b.eyebrow ?? '')}</div>
        <div class="title">${highlight(String(b.title ?? ''), spec)}</div>
        ${items.length ? `<div class="body" style="font-size:${spec.body_size - 4}px">${items.map((t) => `<div style="margin-bottom:12px">· ${highlight(t, spec)}</div>`).join('')}</div>` : ''}
        <div style="margin-top:40px;font-size:30px;color:${spec.accent};font-weight:700">${esc(b.hint ?? '')}</div>`;
    }

    case 'quote': {
      return `
        <div style="font-size:${spec.title_size + 34}px;color:${spec.accent};line-height:.6;margin-bottom:24px">"</div>
        <div class="title" style="font-size:${spec.title_size}px">${highlight(String(b.text ?? ''), spec)}</div>
        <div class="body" style="margin-top:40px;font-size:${spec.body_size - 2}px">${esc(b.note ?? '')}</div>
        <div style="margin-top:44px;font-size:26px;color:${spec.accent};font-weight:700">— ${esc(b.attribution ?? '')}</div>`;
    }

    case 'list': {
      const items = (b.items as Array<{ text: string; note?: string }>) ?? [];
      return `
        <div class="eyebrow">${esc(b.eyebrow ?? '重点')}</div>
        <div class="title" style="font-size:${Math.round(spec.title_size * 0.82)}px">${highlight(String(b.title ?? ''), spec)}</div>
        <div style="display:flex;flex-direction:column;gap:26px;margin-top:16px">
          ${items
            .map(
              (it, i) => `
            <div style="display:flex;gap:22px;align-items:flex-start">
              <div class="num" style="flex:0 0 auto;font-size:${spec.title_size * 0.72}px;line-height:1">${String(i + 1).padStart(2, '0')}</div>
              <div>
                <div style="font-size:${spec.body_size + 4}px;font-weight:700;line-height:1.4">${highlight(it.text ?? '', spec)}</div>
                ${it.note ? `<div class="body" style="font-size:${spec.body_size - 6}px;margin-top:8px">${esc(it.note)}</div>` : ''}
              </div>
            </div>`,
            )
            .join('')}
        </div>`;
    }

    case 'steps': {
      const items = (b.items as Array<{ text: string; note?: string }>) ?? [];
      return `
        <div class="eyebrow">${esc(b.eyebrow ?? '怎么做')}</div>
        <div class="title" style="font-size:${Math.round(spec.title_size * 0.76)}px;margin-bottom:44px">${highlight(String(b.title ?? ''), spec)}</div>
        <div style="display:flex;flex-direction:column;gap:30px;border-left:3px solid ${spec.accent}44;padding-left:36px">
          ${items
            .map(
              (it, i) => `
            <div style="position:relative">
              <div style="position:absolute;left:-52px;top:2px;width:30px;height:30px;border-radius:50%;
                          background:${spec.accent};color:#fff;font-size:17px;font-weight:700;
                          display:flex;align-items:center;justify-content:center">${i + 1}</div>
              <div style="font-size:${spec.body_size + 2}px;font-weight:700;line-height:1.4">${highlight(it.text ?? '', spec)}</div>
              ${it.note ? `<div class="body" style="font-size:${spec.body_size - 6}px;margin-top:8px">${esc(it.note)}</div>` : ''}
            </div>`,
            )
            .join('')}
        </div>`;
    }

    case 'compare': {
      const left = (b.left as { title?: string; items?: string[] }) ?? {};
      const right = (b.right as { title?: string; items?: string[] }) ?? {};
      const col = (c: { title?: string; items?: string[] }, hi: boolean) => `
        <div style="flex:1;background:${hi ? spec.accent + '18' : '#00000008'};border-radius:18px;padding:36px 30px;border:2px solid ${hi ? spec.accent : '#00000014'}">
          <div style="font-size:${spec.body_size + 6}px;font-weight:800;margin-bottom:24px;color:${hi ? spec.accent : spec.text_primary}">${esc(c.title ?? '')}</div>
          ${(c.items ?? [])
            .map((t) => `<div class="body" style="font-size:${spec.body_size - 6}px;margin-bottom:16px;line-height:1.5">· ${esc(t)}</div>`)
            .join('')}
        </div>`;
      return `
        <div class="eyebrow">${esc(b.eyebrow ?? '对比')}</div>
        <div class="title" style="font-size:${Math.round(spec.title_size * 0.74)}px;margin-bottom:44px">${highlight(String(b.title ?? ''), spec)}</div>
        <div style="display:flex;gap:26px">${col(left, false)}${col(right, true)}</div>
        ${b.conclusion ? `<div style="margin-top:40px;padding:26px;background:#0000000a;border-radius:16px;font-size:${spec.body_size - 4}px;font-weight:700">${highlight(String(b.conclusion), spec)}</div>` : ''}`;
    }

    case 'photo_text': {
      // 有底图时是「图 + 底部压字」，没有底图时退化成普通文字卡，
      // 否则会变成一张大面积留白、文字还撞到页脚的废图。
      if (!photoDataUri) {
        return `
        <div class="eyebrow">${esc(b.eyebrow ?? '随手记')}</div>
        <div class="title">${highlight(String(b.title ?? ''), spec)}</div>
        ${b.subtitle ? `<div class="body" style="font-size:${spec.body_size + 2}px;margin-top:28px">${esc(b.subtitle)}</div>` : ''}`;
      }
      return `
        <div class="content" style="justify-content:flex-end;padding-bottom:24px">
          <div class="title" style="font-size:${spec.title_size}px;text-shadow:0 4px 26px rgba(0,0,0,.6)">${highlight(String(b.title ?? ''), spec)}</div>
          ${b.subtitle ? `<div style="font-size:${spec.body_size}px;margin-top:26px;line-height:1.5;text-shadow:0 2px 14px rgba(0,0,0,.7)">${esc(b.subtitle)}</div>` : ''}
        </div>`;
    }

    case 'cta': {
      return `
        <div style="text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1">
          <div style="font-size:${spec.title_size + 26}px;margin-bottom:34px">${esc(b.emoji ?? '👋')}</div>
          <div class="title" style="font-size:${spec.title_size}px;text-align:center">${highlight(String(b.title ?? ''), spec)}</div>
          <div class="body" style="font-size:${spec.body_size + 4}px;margin-top:36px;text-align:center;
               background:${spec.accent}22;color:${spec.accent};padding:22px 44px;border-radius:999px;font-weight:700">
            ${esc(b.action ?? '')}
          </div>
        </div>`;
    }

    default:
      return `<div class="title">${highlight(String(b.title ?? ''), spec)}</div>`;
  }
}

export function buildCardHtml(card: Card, spec: CardTemplateSpec, photoDataUri?: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>${baseCss(spec, photoDataUri)}</style></head>
<body><div class="card">
  ${decoration(spec)}
  <div class="content">${layoutBody(card.layout, card.blocks, spec, photoDataUri)}</div>
  <div class="footer">
    <span>${esc(card.blocks.brand ?? '')}</span>
    <span>${esc(card.blocks.watermark ?? '')}</span>
  </div>
</div></body></html>`;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

async function toDataUri(localPath: string): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(localPath);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

/** 共享的渲染页，避免每张卡都新建 Chromium page */
let renderPage: Page | null = null;

async function getRenderPage(): Promise<Page> {
  if (renderPage && !renderPage.isClosed()) return renderPage;
  const ctx = await browser.ensureLaunched();
  renderPage = await ctx.newPage();
  await renderPage.setViewportSize({ width: CARD_WIDTH, height: CARD_HEIGHT });
  return renderPage;
}

export interface RenderOptions {
  sourceId: number | null;
  outputDir: string;
  allowStock?: boolean;
}

export async function renderCard(card: Card, opts: RenderOptions): Promise<string> {
  const spec = specForSource(opts.sourceId);
  const page = await getRenderPage();

  // photo_text 需要底图
  let photoUri: string | undefined;
  if (card.layout === 'photo_text') {
    if (card.blocks.photoPath) {
      photoUri = await toDataUri(String(card.blocks.photoPath));
    } else if (card.photoUrl || card.blocks.photoQuery) {
      const query = String(card.blocks.photoQuery ?? '');
      let picked: StockImage | undefined;
      if (card.photoUrl) {
        picked = {
          url: String(card.photoUrl),
          thumbUrl: '',
          width: 1080,
          height: 1440,
          author: '',
          sourceProvider: 'preset',
          sourceUrl: '',
        };
      } else if (opts.allowStock !== false) {
        picked = (await searchStock(toSearchHint(query), 1))[0];
      }
      if (picked) {
        await fs.mkdir(opts.outputDir, { recursive: true });
        const tmp = path.join(opts.outputDir, `.photo-${Date.now()}.jpg`);
        try {
          const buf = Buffer.from(
            await (await fetch(picked.url, {
              headers: { 'User-Agent': 'xhsflow/0.1' },
            })).arrayBuffer(),
          );
          const norm = await sharp(buf)
            .resize(CARD_WIDTH, CARD_HEIGHT, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 88, mozjpeg: true })
            .toBuffer();
          await fs.writeFile(tmp, norm);
          photoUri = await toDataUri(tmp);
          await fs.unlink(tmp).catch(() => undefined);
        } catch (err) {
          logger.warn({ err, query }, '配图下载失败，退回纯文字卡');
        }
      }
    }
  }

  const html = buildCardHtml(card, spec, photoUri);
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => (document as any).fonts?.ready);
  await page.waitForTimeout(120); // 让 emoji 字体渲染完

  await fs.mkdir(opts.outputDir, { recursive: true });
  const out = path.join(opts.outputDir, `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);

  const buf = await page.screenshot({ type: 'jpeg', quality: 90 });
  await fs.writeFile(out, buf);
  return out;
}

export async function renderCards(
  cards: Card[],
  opts: RenderOptions,
): Promise<string[]> {
  const out: string[] = [];
  for (const c of cards) {
    try {
      out.push(await renderCard(c, opts));
    } catch (err) {
      logger.error({ err, layout: c.layout }, '卡片渲染失败');
    }
  }
  return out;
}

export async function closeRenderer(): Promise<void> {
  await renderPage?.close().catch(() => undefined);
  renderPage = null;
}

export { MEDIA_DIR };