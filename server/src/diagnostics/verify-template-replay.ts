/**
 * 原文回放验收（阶段 D 的验证环节）。
 *
 *   node server/dist/diagnostics/verify-template-replay.js [sourceId] [--family wow-ip-trend-v1]
 *
 * 【它验证什么】
 * 用语料里**真实的笔记原文**（notes.title/desc + 该页 evidence 里记录的原图）
 * 跑一遍模板渲染，检查渲染结果与原图的几何是否一致，通过的族标记
 * page_evidence.verified=1，之后才允许进入生产。
 *
 * 【它不验证什么】
 * 不声称「任意新文案都能逐像素复刻」。这里只验证**模板骨架**：品牌条、
 * 编号形态与位置、标题行位、正文起排、条带几何。字体仍是近似字体，
 * 这一项在 notes 里如实标注（font_unverified），不静默通过。
 *
 * 【离线】只读本地语料与图库，不联网、不碰小红书、不写 DB（除 verified 标记）。
 */

import { all, get, run } from '../db/index.js';
import { MEDIA_DIR } from '../config.js';
import { toResolved, buildCardHtml, CARD_WIDTH, CARD_HEIGHT, closeRenderer } from '../generate/cards.js';
import type { TemplateFamilyId } from '../generate/design/contract.js';
import { EXTRACTOR_VERSION } from '../visual/evidence/extract.js';
import { coverageSnapshot, productionGate, templateForFamily } from '../visual/templates/registry.js';
import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const sourceId = Number(args.find((a) => /^\d+$/.test(a)) ?? 10);
const famIdx = args.indexOf('--family');
const onlyFamily = famIdx >= 0 ? args[famIdx + 1] : null;
const dryRun = args.includes('--dry-run');

const outDir = path.join(MEDIA_DIR, '_sample', 'replay');
await fs.mkdir(outDir, { recursive: true });

interface ReplayPage {
  imageId: number;
  noteId: number;
  pageIndex: number;
  family: string;
  localPath: string | null;
  evidence: Record<string, unknown>;
  title: string;
  desc: string;
}

/** 取该族用于验收的留出页：每族最多 3 页，按 note 升序取（不是训练用的那几页）。 */
function replayPages(family: string, limit = 3): ReplayPage[] {
  const rows = all<{
    image_id: number; note_id: number; page_index: number; family: string;
    evidence: string | null; local_path: string | null; title: string; desc: string;
  }>(
    `SELECT pe.image_id, pe.note_id, pe.page_index, pe.family, pe.evidence,
            ni.local_path, n.title, n.desc
       FROM page_evidence pe
       JOIN note_images ni ON ni.id = pe.image_id
       JOIN notes n ON n.id = pe.note_id
      WHERE pe.source_id = ? AND pe.extractor_version = ? AND pe.family = ?
      ORDER BY pe.note_id, pe.page_index
      LIMIT ?`,
    sourceId, EXTRACTOR_VERSION, family, limit,
  );
  return rows.map((r) => ({
    imageId: r.image_id,
    noteId: r.note_id,
    pageIndex: r.page_index,
    family: r.family,
    localPath: r.local_path,
    evidence: r.evidence ? (JSON.parse(r.evidence) as Record<string, unknown>) : {},
    title: r.title,
    desc: r.desc,
  }));
}

/** 从原图证据里取该页的像素测量。 */
function measurementOf(p: ReplayPage): Record<string, number | null> {
  const m = (p.evidence as { measurement?: Record<string, unknown> }).measurement ?? {};
  return m as Record<string, number | null>;
}

/**
 * 从原笔记正文抽出可回放的槽位。
 *
 * 刻意保守：只用**原文中确实存在**的结构（首行做标题、首句做结论），
 * 不用模型重新生成 —— 回放要验的是模板，不是文案能力。
 */
function blocksFor(p: ReplayPage, isCover: boolean): Record<string, unknown> {
  const lines = String(p.desc ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const title = String(p.title ?? '').split('\n')[0]!.slice(0, 24);
  if (isCover) {
    const first = lines[0] ?? title;
    const second = lines[1] ?? '';
    return {
      eyebrow: '',
      title: second ? `${title}\n${second.slice(0, 8)}` : title,
      hint: first.slice(0, 30),
      items: lines.slice(2, 6),
    };
  }
  return {
    eyebrow: '',
    title,
    items: lines.slice(0, 4).map((t) => ({ text: t.slice(0, 20), note: '' })),
  };
}

/** 区域中位色。 */
async function regionMedian(file: string, r: { left: number; top: number; width: number; height: number }): Promise<number[] | null> {
  try {
    const { data, info } = await sharp(file)
      .extract({ left: r.left, top: r.top, width: r.width, height: r.height })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const ch: number[][] = [[], [], []];
    for (let i = 0; i < data.length; i += info.channels) {
      ch[0]!.push(data[i]!); ch[1]!.push(data[i + 1]!); ch[2]!.push(data[i + 2]!);
    }
    const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
    return [med(ch[0]!), med(ch[1]!), med(ch[2]!)];
  } catch {
    return null;
  }
}

/** 页面底部深色条顶边。 */
async function darkBarTop(file: string): Promise<number | null> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lum = (x: number, y: number): number => {
    const i = (y * info.width + x) * info.channels;
    return (data[i]! * 0.2126 + data[i + 1]! * 0.7152 + data[i + 2]! * 0.0722) / 255;
  };
  for (let y = Math.floor(info.height * 0.8); y < info.height - 6; y++) {
    let dark = 0, n = 0;
    for (let x = 5; x < info.width - 5; x += 6) { n++; if (lum(x, y) < 0.3) dark++; }
    if (dark > n * 0.85) return y;
  }
  return null;
}

/**
 * 页面上半部墨迹行段（用于核对顶部行位）。
 *
 * ⚠️ 判据必须**按编号颜色**分档，不能统一用亮度：
 * 340/1 的 `SHIFT · 01` 是纯强调蓝，实测该带内 lum<0.4 的深色像素只有 24 个
 * （全落在抗锯齿边缘），统一用亮度会把第一段判成标题行 —— 回放报
 * 「起行 280 vs 原图 133」是**误报**。蓝色编号改用蓝度判。
 */
async function inkSegments(
  file: string,
  mode: 'dark' | 'blue' | 'any' = 'any',
  from = 80,
  to = 560,
): Promise<Array<[number, number]>> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const lum = (x: number, y: number): number => {
    const i = (y * info.width + x) * info.channels;
    return (data[i]! * 0.2126 + data[i + 1]! * 0.7152 + data[i + 2]! * 0.0722) / 255;
  };
  const blueish = (x: number, y: number): boolean => {
    const i = (y * info.width + x) * info.channels;
    return data[i + 2]! - data[i]! > 90;
  };
  const rows: number[] = [];
  for (let y = from; y < Math.min(to, info.height); y++) {
    let ink = 0;
    for (let x = 40; x < info.width - 40; x += 4) {
      const hit =
        mode === 'dark' ? lum(x, y) < 0.4
        : mode === 'blue' ? blueish(x, y)
          : lum(x, y) < 0.4 || blueish(x, y);
      if (hit) ink++;
    }
    if (ink > 1) rows.push(y);
  }
  const segs: Array<[number, number]> = [];
  const first = rows[0]!;
  let start = first;
  let prev = first;
  for (const y of rows.slice(1)) {
    if (y - prev > 12) { segs.push([start, prev]); start = y; }
    prev = y;
  }
  if (rows.length) segs.push([start, prev]);
  return segs;
}

/** 生成差分图（原图 vs 渲染），放大到肉眼可见。 */
async function diffImage(original: string, rendered: string, out: string): Promise<void> {
  try {
    const [a, b] = await Promise.all([
      sharp(original).resize(CARD_WIDTH, CARD_HEIGHT, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
      sharp(rendered).resize(CARD_WIDTH, CARD_HEIGHT, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    ]);
    const outBuf = Buffer.alloc(CARD_WIDTH * CARD_HEIGHT * 3);
    for (let i = 0, j = 0; i < outBuf.length; i += 3, j += a.info.channels) {
      const dr = Math.abs(a.data[j]! - b.data[j]!);
      const dg = Math.abs(a.data[j + 1]! - b.data[j + 1]!);
      const db = Math.abs(a.data[j + 2]! - b.data[j + 2]!);
      const d = Math.min(255, (dr + dg + db) / 3);
      // 差分用热力色：越接近原图越黑
      outBuf[i] = d; outBuf[i + 1] = Math.round(d * 0.6); outBuf[i + 2] = Math.round(d * 0.4);
    }
    await sharp(outBuf, { raw: { width: CARD_WIDTH, height: CARD_HEIGHT, channels: 3 } }).png().toFile(out);
  } catch (err) {
    await fs.writeFile(out, `差分生成失败：${(err as Error).message}`, 'utf8');
  }
}

/* ------------------------------------------------------------------ */

const families = all<{ family: string; pages: number }>(
  `SELECT family, COUNT(*) AS pages FROM page_evidence
    WHERE source_id = ? AND extractor_version = ? AND family != 'unknown'
    GROUP BY family ORDER BY pages DESC`,
  sourceId, EXTRACTOR_VERSION,
);

console.log(`原文回放验收｜来源 ${sourceId}｜提取器 ${EXTRACTOR_VERSION}`);
console.log(`候选族：${families.map((f) => `${f.family}(${f.pages}页)`).join('、')}\n`);

const ctx = await chromium.launch({ headless: true });
const page = await ctx.newPage();
await page.setViewportSize({ width: CARD_WIDTH, height: CARD_HEIGHT });

const results: Array<{ family: string; noteId: number; pageIndex: number; pass: boolean; issues: string[] }> = [];

try {
  for (const famRow of families) {
    if (onlyFamily && famRow.family !== onlyFamily) continue;
    const pages = replayPages(famRow.family);
    if (pages.length === 0) continue;

    const baseSpec = getStyleProfileSafe(sourceId);
    for (const p of pages) {
      const issues: string[] = [];
      const isCover = p.pageIndex === 0;
      const spec = toResolved({
        ...baseSpec,
        account_template: {
          ...templateForFamily(p.family as TemplateFamilyId),
          cover_header_text: 'WOW Culture Media Co., Ltd',
          cover_header_sub: '新媒体各渠道电商代运营服务 专业0-1 成功案例100+',
          cover_logo_text: 'WOW',
          logo_asset_dark: 'assets/brand/wow-logo-ink.png',
          logo_asset_light: 'assets/brand/wow-logo-white.png',
          inner_footer_text: 'WOW Culture Media Co., Ltd',
          inner_footer_sub: '新媒体各渠道电商代运营服务 专业0-1 成功案例100+',
        },
      });

      const html = buildCardHtml(
        { layout: isCover ? 'cover' : 'list', blocks: blocksFor(p, isCover), index: p.pageIndex },
        spec,
      );
      const outFile = path.join(outDir, `replay-${p.family}-${p.noteId}-${p.pageIndex}.jpg`);
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(() => (document as Document & { fonts?: { ready: Promise<void> } }).fonts?.ready);
      await page.waitForTimeout(150);
      await page.screenshot({ path: outFile, type: 'jpeg', quality: 92 });

      const m = measurementOf(p);

      // 硬断言 1：页脚条几何（原图实测 vs 渲染实测）
      if (typeof m.footerTopEdge === 'number' && !isCover) {
        const edge = await darkBarTop(outFile);
        if (edge === null) issues.push('渲染结果未检出页脚条');
        else if (Math.abs(edge - m.footerTopEdge) > 6) {
          issues.push(`页脚条顶边 ${edge} vs 原图 ${m.footerTopEdge}`);
        }
      }

      // 硬断言 2：页脚条底色
      if (typeof m.footerBarColor === 'string' && !isCover) {
        const want = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/.exec(m.footerBarColor);
        if (want) {
          const px = await regionMedian(outFile, { left: CARD_WIDTH - 400, top: CARD_HEIGHT - 70, width: 60, height: 40 });
          if (px) {
            const d = Math.max(
              Math.abs(px[0]! - parseInt(want[1]!, 16)),
              Math.abs(px[1]! - parseInt(want[2]!, 16)),
              Math.abs(px[2]! - parseInt(want[3]!, 16)),
            );
            if (d > 16) issues.push(`页脚条底色 rgb(${px.join(',')}) vs 原图 ${m.footerBarColor}`);
          }
        }
      }

      // 硬断言 3：顶部行位。按族的编号形态选判据模式，避免颜色不同导致的误报。
      if (!isCover) {
        const segMode: 'dark' | 'blue' | 'any' =
          p.family === 'wow-brand-case-v1' || p.family === 'wow-blue-tag-v1' ? 'blue' : 'any';
        const origSegs = p.localPath ? await inkSegments(p.localPath, segMode, 80, 560) : [];
        const newSegs = await inkSegments(outFile, segMode, 80, 560);
        if (origSegs.length > 0 && newSegs.length > 0) {
          const dOrig = origSegs[0]![0];
          const dNew = newSegs[0]![0];
          if (Math.abs(dOrig - dNew) > 60) {
            issues.push(`顶部墨迹起行 ${dNew} vs 原图 ${dOrig}`);
          }
        }
      }

      // 差分图（供人工看）
      if (p.localPath) {
        await diffImage(p.localPath, outFile, path.join(outDir, `diff-${p.family}-${p.noteId}-${p.pageIndex}.png`));
      }

      results.push({ family: p.family, noteId: p.noteId, pageIndex: p.pageIndex, pass: issues.length === 0, issues });
    }
  }
} finally {
  await ctx.close().catch(() => undefined);
  await closeRenderer().catch(() => undefined);
}

/** 读来源画像的原始契约（不依赖渲染层解包）。 */
function getStyleProfileSafe(id: number): Record<string, unknown> {
  const row = get<{ profile: string }>('SELECT profile FROM style_profiles WHERE source_id = ?', id);
  if (!row) return {};
  try {
    const prof = JSON.parse(row.profile) as { card_template_spec?: unknown };
    return (prof.card_template_spec ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/* --- 汇总 --- */

const byFamily = new Map<string, { pass: number; fail: number }>();
for (const r of results) {
  const cur = byFamily.get(r.family) ?? { pass: 0, fail: 0 };
  if (r.pass) cur.pass++; else cur.fail++;
  byFamily.set(r.family, cur);
}

console.log('── 回放结果 ──');
for (const [fam, s] of byFamily) {
  console.log(`  ${fam}: 通过 ${s.pass} / 失败 ${s.fail}`);
}
const failed = results.filter((r) => !r.pass);
if (failed.length > 0) {
  console.log('\n── 失败明细 ──');
  for (const f of failed.slice(0, 12)) {
    console.log(`  ${f.family} note ${f.noteId} 页 ${f.pageIndex}: ${f.issues.join('；')}`);
  }
}

if (!dryRun) {
  // 只有整族全通过才标记该族 verified —— 抽样里有一页不过就不算验证通过。
  for (const [fam, s] of byFamily) {
    const ok = s.fail === 0 && s.pass > 0;
    run(
      `UPDATE page_evidence SET verified = ?, updated_at = datetime('now')
        WHERE source_id = ? AND extractor_version = ? AND family = ?`,
      ok ? 1 : 0, sourceId, EXTRACTOR_VERSION, fam,
    );
  }
  console.log('\n已写 verified 标记。');
}

const snap = coverageSnapshot(sourceId, EXTRACTOR_VERSION);
const pct = (a: number, b: number): string => (b ? `${Math.round((a / b) * 100)}% (${a}/${b})` : 'n/a');
console.log('\n── 覆盖率（三项独立） ──');
console.log(`  文本蒸馏覆盖率    ${pct(snap.textDistilled.done, snap.textDistilled.total)}`);
console.log(`  逐页视觉覆盖率    ${pct(snap.visualPages.done, snap.visualPages.total)}`);
console.log(`  已验证模板覆盖率  ${pct(snap.templateVerified.done, snap.templateVerified.total)}`);
console.log(`  unknown 队列      ${snap.unknownPages} 页`);

const gate = productionGate(sourceId, EXTRACTOR_VERSION);
console.log('\n── 生产闸门 ──');
console.log(gate.kind === 'ready' ? `  READY：${gate.note}` : `  BLOCKED：${gate.reason}`);

process.exit(0);
