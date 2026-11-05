import { buildDeckPlan, layoutForBeat } from '../generate/design/plan.js';
import { closeRenderer } from '../generate/cards.js';
import { run } from '../db/index.js';

/**
 * 检查稿件计划的多样性 —— 「每篇都很雷同」的直接验收。
 *
 *   node server/dist/diagnostics/check-plan-diversity.js [sourceId] [n]
 *
 * 对同一来源连造 n 份计划（模拟连续 n 天的定时创作），
 * 报告页数、骨架、版式序列、内页族的分布。
 * 旧实现下这里会全部相同（7 张 / cover>quote>list>steps>compare>photo_text>cta）。
 *
 * 【为什么要写临时行】
 * buildDeckPlan 靠「最近几篇的计划」来避开重复结构。不落库的话每份计划
 * 都看到空历史，测不出轮换效果 —— 那样这个脚本就只会验证「同一选题得到同一结构」，
 * 而不是验证「连续创作会轮换」。
 * 所以这里插一批临时 draft（标 _plancheck_ 前缀），跑完删掉。
 */
const args = process.argv.slice(2);
const sourceId = Number(args[0] ?? '10');
const n = Number(args[1] ?? '12');


// 模拟连续 12 次创作：每次选题不同，且每次都把上一份"落库"成历史
// （这里用内存数组代替 DB —— buildDeckPlan 读的是 recentPlanSignatures，
//  但那需要真实落库；为纯离线验收，这里直接检查候选池本身的多样性）
const topics = [
  '为什么先被记住的是颜色，不是Logo',
  '品牌手册里最难写的，是语气',
  '个人IP的选题，别只从自己身上找',
  '品牌号做小红书，先定不说什么',
  '为什么出圈的品牌，都不太像品牌了',
  '情绪价值一旦被写成卖点就失效',
  '品牌手册没人翻，问题在第一页',
  '主理人IP和品牌IP先做哪个',
  '为什么品牌号越官方越没人看',
  '为什么出新的品牌，都不太像品牌',
  '品牌做VI，究竟要做哪些内容',
  '品牌调性别再只停留在高级感上了',
];

interface PlanRow {
  topic: string;
  plan: ReturnType<typeof buildDeckPlan>;
}

const rows: PlanRow[] = [];

const CHECK_TAG = '__plancheck__';

/** 清掉临时行（脚本中途失败会留下）。 */
function clearTemp(): void {
  run(`DELETE FROM drafts WHERE substr(title,1,13) = ?`, CHECK_TAG);
}

clearTemp();

for (let i = 0; i < n; i++) {
  const topic = topics[i % topics.length]!;
  const plan = buildDeckPlan(sourceId, topic);
  rows.push({ topic, plan });

  // 落库成"上几篇"，让下一轮的 recentPlanSignatures 能看到 —— 这才是真实场景
  if (plan) {
    const ins = run(
      `INSERT INTO drafts(source_id, title, body, tags, status, plan)
       VALUES (?,?, '', '[]', 'rejected', ?)`,
      sourceId,
      `__plancheck__${i} ${topic}`.slice(0, 40),
      JSON.stringify({
        exemplarNoteId: plan.exemplarNoteId,
        cardCount: plan.cardCount,
        beats: plan.beats,
        roles: plan.roles,
        families: plan.families,
        numberingPrefix: plan.numberingPrefix,
        skeleton: plan.skeleton,
      }),
    );
    const id = Number(ins.lastInsertRowid);
    plan.roles.forEach((layout, idx) => {
      run(
        'INSERT INTO draft_cards(draft_id, idx, layout, content, family) VALUES (?,?,?,?,?)',
        id,
        idx,
        layout,
        '{}',
        plan.families[idx] ?? null,
      );
    });
  }
}

clearTemp();

console.log(`来源 ${sourceId}，连造 ${n} 份计划\n`);
const pageCounts = new Set<number>();
const skeletons = new Set<string>();
const roleSeqs = new Set<string>();
const innerFams = new Set<string>();

for (const [i, r] of rows.entries()) {
  if (!r.plan) {
    console.log(`${String(i + 1).padStart(2)}. ${r.topic}\n    ✗ 无法造计划（语料不足）`);
    continue;
  }
  const p = r.plan;
  pageCounts.add(p.cardCount);
  skeletons.add(p.skeleton);
  roleSeqs.add(p.roles.join('>'));
  for (const f of p.families.slice(1)) innerFams.add(f);
  console.log(
    `${String(i + 1).padStart(2)}. ${r.topic}\n` +
      `    样稿 ${p.exemplarNoteId}《${p.exemplarTitle.slice(0, 24)}》\n` +
      `    ${p.cardCount} 张 | 骨架 ${p.skeleton}\n` +
      `    版式 ${p.roles.join(' > ')}\n` +
      `    族   ${p.families.join(' > ')}${p.numberingPrefix ? `  前缀 ${p.numberingPrefix}` : ''}`,
  );
}

const built = rows.filter((r) => r.plan).length;
console.log(`\n—— 多样性 ——`);
console.log(`成功造计划        ${built}/${n}`);
console.log(`不同页数          ${pageCounts.size} 种：${[...pageCounts].sort((a, b) => a - b).join(', ')}`);
console.log(`不同正文骨架      ${skeletons.size} 种`);
console.log(`不同版式序列      ${roleSeqs.size} 种`);
console.log(`不同内页族        ${innerFams.size} 种：${[...innerFams].join(', ')}`);

// 顺带验一下节拍映射没退化（全落 list 就说明词表没起作用）
const beatHits = new Map<string, number>();
for (const r of rows) for (const b of r.plan?.beats ?? []) beatHits.set(layoutForBeat(b), (beatHits.get(layoutForBeat(b)) ?? 0) + 1);
console.log(`节拍→版式分布      ${[...beatHits].map(([k, v]) => `${k}:${v}`).join('  ')}`);

await closeRenderer();
