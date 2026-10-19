/**
 * 一次性重蒸馏 runner（ask 专用）：
 * 清空 source 10 的 note_styles，然后走 analyzeSource + buildStyleProfile。
 * 与生产 job 相同的函数，绕过 HTTP 与任务队列。
 *
 *   node server/dist/diagnostics/redistill-source10.js
 */
import { run, count } from '../db/index.js';
import { analyzeSource } from '../corpus/analyze.js';
import { buildStyleProfile, getStyleProfile } from '../corpus/profile.js';

const sourceId = Number(process.argv[2] ?? 10);

const before = count('SELECT COUNT(*) FROM notes n JOIN note_styles ns ON ns.note_id = n.id WHERE n.source_id = ?', sourceId);
console.log(`source ${sourceId} 现有蒸馏 ${before} 篇，清空后重蒸…`);
run('DELETE FROM note_styles WHERE note_id IN (SELECT id FROM notes WHERE source_id = ?)', sourceId);

const res = await analyzeSource(sourceId, 200, (p) => {
  if (p.done % 20 === 0 || p.failed > 0) {
    console.log(`  蒸馏进度 ${p.done}/${p.total}（失败 ${p.failed}）`);
  }
});
console.log('蒸馏完成：', JSON.stringify(res));

const profile = await buildStyleProfile(sourceId);
const spec = (profile?.card_template_spec ?? {}) as { account_template?: unknown };
console.log('画像已生成，account_template =', JSON.stringify(spec.account_template ?? null));

const stored = getStyleProfile(sourceId);
const storedSpec = (stored?.profile?.card_template_spec ?? {}) as { account_template?: unknown };
console.log('库里 account_template =', JSON.stringify(storedSpec.account_template ?? null));
process.exit(0);
