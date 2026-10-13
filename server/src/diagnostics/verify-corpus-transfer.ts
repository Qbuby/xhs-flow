/**
 * 语料库导入导出的端到端验证。
 *
 *   node server/dist/diagnostics/verify-corpus-transfer.js
 *
 * 流程：
 *   1. 从**真实库**导出全部语料（含图片）到临时 zip
 *   2. 起一个带 XHSFLOW_DATA_DIR 的**子进程**（一次性沙盒库），把 zip 导进去
 *   3. 校验沙盒库：行数对得上、图片文件真实存在且字节一致、FTS 能搜到
 *   4. 同一个包再导一遍 —— 应当全部跳过（幂等）
 *   5. 清理临时产物
 *
 * 全程不写主库（第 1 步只读），所以处置期/冷静期也能跑。
 */
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..');
const TMP = path.join(ROOT, 'data', 'tmp-transfer');
const CHILD_SCRIPT = path.join(here, 'verify-corpus-transfer-child.js');

interface ChildResult {
  ok: boolean;
  error?: string;
  summary?: Record<string, unknown>;
  counts?: Record<string, number>;
  imageCheck?: { compared: number; mismatched: string[]; missingOnDisk: number };
  ftsHit?: number;
  ftsTerm?: string;
}

function runChild(zipPath: string, mode: 'import' | 'reimport'): ChildResult {
  const res = spawnSync(
    process.execPath,
    [CHILD_SCRIPT, zipPath, mode],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, XHSFLOW_DATA_DIR: path.join(TMP, 'sandbox') },
      timeout: 300_000,
    },
  );
  const out = (res.stdout ?? '').split('\n').filter((l) => l.startsWith('RESULT:'));
  if (out.length === 0) {
    return { ok: false, error: `子进程没有产出结果（exit=${res.status}）stderr: ${(res.stderr ?? '').slice(0, 400)}` };
  }
  try {
    return JSON.parse(out[out.length - 1]!.slice('RESULT:'.length)) as ChildResult;
  } catch (err) {
    return { ok: false, error: `子进程输出解析失败：${String(err)}` };
  }
}

async function main(): Promise<void> {
  console.log('════════ 语料库导入导出验证 ════════\n');

  /* 1. 从真实库导出 */
  const { exportCorpusZip } = await import('../corpus/transfer.js');
  await fs.mkdir(TMP, { recursive: true });
  const { buf, filename, summary } = await exportCorpusZip(null);
  const zipPath = path.join(TMP, filename);
  await fs.writeFile(zipPath, buf);
  console.log(`① 导出：${filename} ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
  console.log(`   counts = ${JSON.stringify(summary.counts)}，磁盘缺文件 ${summary.missingFiles} 张\n`);

  /* 2+3. 沙盒库导入并校验 */
  console.log('② 沙盒库导入（XHSFLOW_DATA_DIR=data/tmp-transfer/sandbox，不碰主库）…');
  const first = runChild(zipPath, 'import');
  if (!first.ok) {
    console.error('✗ 导入失败：', first.error);
    process.exit(1);
  }
  console.log(`   ${JSON.stringify(first.summary)}\n`);

  const problems: string[] = [];
  const counts = first.counts ?? {};
  const expect = (label: string, got: number | undefined, want: number | undefined) => {
    if (got !== want) problems.push(`${label}: 期望 ${want}，实际 ${got}`);
  };
  expect('sources', counts.sources, summary.counts.sources);
  expect('notes', counts.notes, summary.counts.notes);
  expect('note_images', counts.images, summary.counts.noteImages);
  expect('note_styles', counts.styles, summary.counts.noteStyles);
  expect('style_profiles', counts.profiles, summary.counts.styleProfiles);
  expect('topics', counts.topics, summary.counts.topics);

  const ic = first.imageCheck ?? { compared: 0, mismatched: [], missingOnDisk: -1 };
  expect('落盘图片数', ic.compared, summary.counts.imageFiles);
  if (ic.mismatched.length > 0) problems.push(`图片字节不一致：${ic.mismatched.slice(0, 3).join(', ')}`);
  if (ic.missingOnDisk !== 0) problems.push(`沙盒库说有图但磁盘上没有：${ic.missingOnDisk} 张`);
  console.log(
    `③ 校验：行数与图片落盘对比完成，FTS 用「${first.ftsTerm ?? '?'}」搜到 ${first.ftsHit ?? 0} 条\n`,
  );
  if ((first.ftsHit ?? -1) <= 0) problems.push('FTS 全文索引没建出来（导入后搜不到任何笔记）');

  /* 4. 幂等性：再导一遍应全部跳过 */
  console.log('④ 同一个包再导一遍（应全部跳过）…');
  const second = runChild(zipPath, 'reimport');
  if (!second.ok) {
    problems.push(`重导入失败：${second.error}`);
  } else {
    const s2 = (second.summary ?? {}) as Record<string, number>;
    const addedKeys = ['sourcesAdded', 'notesAdded', 'imagesAdded', 'stylesAdded', 'profilesAdded', 'topicsAdded'];
    const notIdempotent = addedKeys.filter((k) => (s2[k] ?? 0) > 0);
    if (notIdempotent.length > 0) problems.push(`重导入不幂等，又新增了：${notIdempotent.join(', ')}`);
    console.log(`   重导入 summary = ${JSON.stringify(s2)}\n`);
  }

  /* 5. 清理 */
  await fs.rm(TMP, { recursive: true, force: true });
  console.log('⑤ 临时产物已清理\n');

  console.log('─'.repeat(60));
  if (problems.length === 0) {
    console.log('✓ 全部通过：导出 → 沙盒导入 → 行数/图片/FTS 校验 → 幂等重导');
  } else {
    console.log('✗ 发现问题：');
    for (const p of problems) console.log('  ·', p);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('验证脚本异常：', err);
  process.exit(1);
});
