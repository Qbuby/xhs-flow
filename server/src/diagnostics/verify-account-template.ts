/**
 * 账号视觉模板链路的离线诊断。
 *
 *   node server/dist/diagnostics/verify-account-template.js
 *   node server/dist/diagnostics/verify-account-template.js --no-llm   # 只渲染，不调模型
 *   node server/dist/diagnostics/verify-account-template.js --source 10
 *
 * 不访问小红书：图片全部来自 data/media/corpus/<noteId>/*.jpg 本地文件，
 * 模型调用走已配置的 LLM（openai / anthropic 两种协议都支持）。
 *
 * 流程：
 *   1. 从库里挑一个有本地图片的笔记，把前 4 张图发给视觉模型，
 *      用 analyze.ts 同一条 prepareVisionImages → chatJson 链路
 *      提取 visual 四项模板证据（页眉/页脚/编号/分栏）。
 *   2. 用 aggregateAccountTemplate 聚合该来源全部蒸馏证据（与生产同函数）。
 *   3. 对比库里 style_profiles.card_template_spec.account_template 是否落库。
 *   4. 用库里的画像渲染一组对照图（封面页眉 + 内页页脚 + 递增编号），
 *      输出到 data/media/_sample/account-template/。
 */

const args = process.argv.slice(2);
const flag = (name: string, def: string | null = null): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? String(args[i + 1]) : def;
};
const hasFlag = (name: string) => args.includes(name);

import { all, get } from '../db/index.js';
import { prepareVisionImages } from '../llm/vision.js';
import { chatJson } from '../llm/client.js';
import { getLlmConfig } from '../llm/runtime.js';
import { aggregateAccountTemplate, getStyleProfile } from '../corpus/profile.js';
import { NoteStyleSchema } from '../corpus/analyze.js';
import { asTemplate } from '../corpus/schema-template.js';
import { closeRenderer, toResolved } from '../generate/cards.js';
import { renderAccountComparison } from '../generate/render-compare.js';
import { MEDIA_DIR } from '../config.js';
import fs from 'node:fs/promises';
import path from 'node:path';

interface NoteRow {
  id: number;
  title: string;
  source_id: number;
}

async function pickNote(sourceId: number): Promise<NoteRow | null> {
  const row = get<NoteRow>(
    `SELECT n.id, n.title, n.source_id FROM notes n
     JOIN note_images ni ON ni.note_id = n.id AND ni.local_path IS NOT NULL
     WHERE n.source_id = ?
     GROUP BY n.id HAVING COUNT(ni.id) >= 2
     ORDER BY n.liked_count DESC LIMIT 1`,
    sourceId,
  );
  return row ?? null;
}

/** 与 analyzeNote 相同的形状调用模型，但只跑单篇、结果不落库。 */
async function extractFromLocalImages(notePk: number): Promise<{ ok: boolean; visual: unknown; error?: string }> {
  const images = all<{ local_path: string | null }>(
    'SELECT local_path FROM note_images WHERE note_id = ? ORDER BY idx LIMIT 9',
    notePk,
  );
  const paths = images.map((i) => i.local_path).filter((p): p is string => Boolean(p));
  if (paths.length === 0) return { ok: false, visual: null, error: '该笔记没有本地图片' };

  const { images: visionImages, failed } = await prepareVisionImages(paths);
  console.log(`   本地图片 ${paths.length} 张，进入负载 ${visionImages.length} 张（失败 ${failed}）`);
  if (visionImages.length === 0) return { ok: false, visual: null, error: '所有图片都没能进入负载' };

  const cfg = getLlmConfig();
  console.log(`   模型协议：${cfg.api} → ${cfg.baseURL}（${cfg.model}）`);

  const user = [
    '请拆解下面这篇小红书笔记，按 JSON schema 输出。',
    '',
    `【标题】(诊断脚本：只看图)`,
    '',
    `已附上 ${visionImages.length} 张真实配图（按原顺序：第 1 张通常是封面，其余是内页）。`,
    'visual 必须以这些图片中实际看到的为准，并逐张检查页眉、页脚、编号、分栏：',
    '- cover_header：只有封面顶部那条整宽色条才算；文字逐字抄，底色给 #hex。',
    '- inner_footer：只有内页底部那条整宽色条才算；同样逐字抄 + #hex。',
    '- numbering：看内页角落的序号长什么样、是否逐张递增（如 01/02/03）。',
    '- columns：数内页正文分几栏。',
    '看不到就写“未体现”。只输出 JSON 对象本身。',
  ].join('\n');

  try {
    const raw = await chatJson<unknown>({
      system:
        '你是小红书内容策略分析师。只描述图片里真实看到的，绝不脑补。\n' +
        '【输出格式】按这份范例的结构输出，字段名固定，值换成你看到的内容：\n' +
        JSON.stringify(asTemplate(NoteStyleSchema), null, 2) +
        '\n只输出 JSON 对象本身，不要代码块围栏。\n' +
        'visual.cover_header / visual.inner_footer / numbering / columns 只看图片本身：' +
        '页眉=封面顶部整宽色条+其上品牌文字，页脚=内页底部整宽色条+其上文字，' +
        '有就把文字逐字抄下来并给底色 #hex，没有就 present=false、文字和底色留空。',
      user,
      images: visionImages,
      temperature: 0.3,
      maxTokens: 16_384,
    });
    const parsed = NoteStyleSchema.safeParse(raw);
    if (!parsed.success) {
      // 打印顶层键，诊断「模型给了什么形状」
      console.log('   模型返回顶层键：', Object.keys((raw ?? {}) as object).join(','));
    }
    return { ok: true, visual: parsed.success ? parsed.data.visual : (raw as { visual?: unknown })?.visual ?? raw };
  } catch (err) {
    return { ok: false, visual: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function renderComparison(sourceId: number, outDir: string): Promise<string[]> {
  const found = getStyleProfile(sourceId);
  if (!found) throw new Error(`来源 ${sourceId} 没有风格画像，先跑蒸馏+画像`);
  const spec = toResolved(found.profile.card_template_spec);
  const t = spec.accountTemplate;
  console.log(`   渲染规格：theme=${spec.theme} accent=${t.accent} numbering=${t.numbering} columns=${t.columns}`);
  console.log(`   页眉文字：${JSON.stringify(t.cover_header_text)} / 页脚文字：${JSON.stringify(t.inner_footer_text)}`);
  return renderAccountComparison(spec, outDir);
}

async function main(): Promise<void> {
  const sourceId = Number(flag('--source', '10'));
  const outDir = path.join(MEDIA_DIR, '_sample', 'account-template');
  await fs.mkdir(outDir, { recursive: true });

  console.log('════════ 账号视觉模板链路诊断（不访问小红书）════════\n');

  /* 1. 单篇在线提取 */
  if (!hasFlag('--no-llm')) {
    const note = await pickNote(sourceId);
    if (!note) {
      console.log(`① 来源 ${sourceId} 没有带本地图片的笔记，跳过单篇提取`);
    } else {
      console.log(`① 单篇提取：note ${note.id}「${note.title.slice(0, 30)}」`);
      const res = await extractFromLocalImages(note.id);
      if (res.ok) {
        const v = res.visual as Record<string, unknown>;
        console.log('   cover_header :', JSON.stringify(v?.cover_header));
        console.log('   inner_footer :', JSON.stringify(v?.inner_footer));
        console.log('   numbering    :', JSON.stringify(v?.numbering));
        console.log('   columns      :', JSON.stringify(v?.columns));
      } else {
        console.log('   提取失败：', res.error);
      }
    }
  } else {
    console.log('① 跳过单篇提取（--no-llm）');
  }

  /* 2. 聚合 */
  console.log('\n② 全量蒸馏证据聚合（aggregateAccountTemplate）：');
  const agg = aggregateAccountTemplate(sourceId);
  console.log(`   证据支持度：页眉 ${agg.evidence.header} 篇 / 页脚 ${agg.evidence.footer} 篇 / 编号 ${agg.evidence.numbering} 篇 / 分栏 ${agg.evidence.columns} 篇`);
  console.log(`   强调色票选：${agg.accentVotes.slice(0, 3).map((a: { hex: string; count: number }) => `${a.hex}×${a.count}`).join('、') || '无'}`);
  console.log(`   聚合模板  ：${JSON.stringify(agg.template)}`);

  /* 3. 库里画像落库核对 */
  console.log('\n③ 库内画像的 account_template：');
  const stored = getStyleProfile(sourceId);
  const storedSpec = (stored?.profile?.card_template_spec ?? {}) as { account_template?: unknown };
  console.log(`   ${JSON.stringify(storedSpec.account_template ?? null)}`);
  if (!storedSpec.account_template) {
    console.log('   ⚠️ 库里没有 account_template —— 若刚跑完画像，说明落库仍丢字段，链路没修好');
  }

  /* 4. 渲染对照图 */
  console.log('\n④ 渲染对照图：');
  try {
    const files = await renderComparison(sourceId, outDir);
    console.log(`   输出 ${files.length} 张 → ${outDir}`);
    for (const f of files) console.log('   ✓', path.basename(f));
  } catch (err) {
    console.log('   渲染失败：', err instanceof Error ? err.message : String(err));
  } finally {
    await closeRenderer();
  }

  console.log('\n诊断结束。对照图里应能看到：封面顶部白底品牌页眉、内页底部深色页脚条、内页左上角递增编号。');
}

main().catch((err) => {
  console.error('诊断失败：', err);
  process.exit(1);
});
