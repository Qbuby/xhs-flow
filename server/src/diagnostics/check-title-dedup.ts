import { titleSimilarity, TITLE_NEAR_DUP_THRESHOLD } from '../util/text-sim.js';

/**
 * 检查选题近似判重的阈值是否落在正确区间。
 *
 *   node server/dist/diagnostics/check-title-dedup.js
 *
 * 成稿实测：改标点的重复能到 1.00，同义改写 0.71~0.73；
 * 语料内部不同命题最高只有 0.26。阈值 0.62 落在两者之间。
 */
const DUP_PAIRS: Array<[string, string]> = [
  ['主理人IP和品牌IP先做哪个', '主理人IP和品牌IP，先做哪个？'],
  ['主理人IP和品牌IP先做哪个', '主理人IP和品牌号，先做哪个'],
  ['为什么出圈的新品牌，都不太像品牌', '为什么出圈的品牌，都不太像品牌了'],
  ['品牌手册里最难写的，是语气', '品牌手册里最难写的,是语气'],
];

const DISTINCT_PAIRS: Array<[string, string]> = [
  ['品牌升级，到底在升级什么', '品牌全案到底都包含了什么'],
  ['为什么真正厉害的品牌，总能出圈', '为什么别人家的品牌总能做出爆款'],
  ['个人IP的玩法，真的变了', '做个人IP，顺序真的很重要'],
  ['为什么先被记住的是颜色，不是Logo', '品牌调性别再只停留在高级感上了'],
  ['品牌做VI，究竟要做哪些内容', '品牌号做小红书，先定不说什么'],
];

console.log(`阈值 ${TITLE_NEAR_DUP_THRESHOLD}\n`);

let ok = 0;
console.log('—— 应判重复 ——');
for (const [a, b] of DUP_PAIRS) {
  const s = titleSimilarity(a, b);
  const pass = s >= TITLE_NEAR_DUP_THRESHOLD;
  if (pass) ok++;
  console.log(`  ${s.toFixed(3)}  ${pass ? '✓' : '✗'}  「${a}」/「${b}」`);
}

console.log('\n—— 应判不同 ——');
let ok2 = 0;
for (const [a, b] of DISTINCT_PAIRS) {
  const s = titleSimilarity(a, b);
  const pass = s < TITLE_NEAR_DUP_THRESHOLD;
  if (pass) ok2++;
  console.log(`  ${s.toFixed(3)}  ${pass ? '✓' : '✗'}  「${a}」/「${b}」`);
}

const total = DUP_PAIRS.length + DISTINCT_PAIRS.length;
const good = ok + ok2;
console.log(`\n${good}/${total} ${good === total ? 'PASS ✓' : 'FAIL ✗'}`);
process.exit(good === total ? 0 : 1);
