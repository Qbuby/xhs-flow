/**
 * `stripEmoji` 白名单单测。
 *
 *   node server/dist/diagnostics/verify-stripemoji.js
 *
 * 这条同样值得单测，因为旧实现**删得太干净**：它的正则里含
 * `\u{2460}-\u{24FF}`（带圈数字 ①-⑳）和 `\u{2190}-\u{21FF}`（箭头），
 * 于是 ①②③、→ ↑ ↓ 全被静默删掉。
 *
 * 而 pipeline 的 SYSTEM prompt 第 5 条明确告诉模型
 * 「可以用 ①②③ 和「」这类中文标点做结构标记」——
 * **两处直接矛盾**：模型按指令写，进卡片时被抹掉，只留两个空格。
 *
 * 判据：emoji 平面必须删（渲染成彩色位图会毁掉版面），
 * 几何符号与中文标点必须留（它们是文案的一部分）。
 */
import assert from 'node:assert/strict';
import { stripEmoji } from '../util/text.js';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

/** 断言 `out` 是 `input` 清洗后只剩 `want`（按字符集比较，忽略空格差异）。 */
function assertKeeps(input: string, want: string, label: string): void {
  const out = stripEmoji(input);
  assert.ok(
    out.includes(want),
    `${label}：应当保留 "${want}"，实际得到 "${out}"`,
  );
}

console.log('stripEmoji 白名单\n');

/* ---- 1. 必须保留：prompt 明确允许的符号 ---- */
check('带圈数字 ①②③④⑤ 必须保留（prompt 允许用它做结构标记）', () => {
  assertKeeps('可以用 ①②③ 做标记', '①②③', '带圈数字');
});

check('箭头 → ← ↑ ↓ 必须保留', () => {
  assertKeeps('建议先收藏再看 ↓', '↓', '下箭头');
  assertKeeps('从上往下 → 从左往右', '→', '右箭头');
  assertKeeps('结果 ↑ 明显', '↑', '上箭头');
});

check('对错符号 ✓ ✗ ❌ 必须保留', () => {
  assertKeeps('✓ 之后', '✓', '勾');
  assertKeeps('✗ 别买', '✗', '叉');
  assertKeeps('❌ 之前', '❌', '叉 emoji');
});

check('星号 ★ ☆ 必须保留', () => {
  assertKeeps('★ 重点 ☆ 次要', '★', '实心星');
  assertKeeps('★ 重点 ☆ 次要', '☆', '空心星');
});

check('几何形状 ● ◆ ▲ ■ 必须保留', () => {
  assertKeeps('● ◆ ▲ ■', '●', '圆点');
  assertKeeps('● ◆ ▲ ■', '◆', '菱形');
  assertKeeps('● ◆ ▲ ■', '▲', '三角');
  assertKeeps('● ◆ ▲ ■', '■', '方块');
});

check('中文标点与书名号、引号必须保留', () => {
  assertKeeps('他说：「这样不行」', '「这样不行」', '直角引号');
  assertKeeps('—— 转折', '——', '破折号');
  assertKeeps('价格…… 有点贵', '……', '省略号');
});

check('数字与拉丁字母必须保留', () => {
  assertKeeps('2.6m 层高，40cm 台面', '2.6m', '数字+单位');
  assertKeeps('USB-C 接口', 'USB-C', '拉丁');
});

/* ---- 2. 必须删掉：真正的 emoji ---- */
check('表情 emoji 🔥 必须删掉', () => {
  const out = stripEmoji('招牌好物 🔥 必看');
  assert.equal(out, '招牌好物 必看', `实际 "${out}"`);
});

check('高码位 emoji（🫠 🧑‍🍳）必须删掉', () => {
  assert.ok(!stripEmoji('新出的 🫠 好物').includes('🫠'), '🫠 没删掉');
  assert.ok(!stripEmoji('🧑‍🍳 厨师').includes('🧑'), 'ZWJ 组合没删干净');
});

check('肤色修饰符 👍🏽 要连基字符一起删', () => {
  const out = stripEmoji('赞 👍🏽 一个');
  assert.ok(!out.includes('👍'), `基字符没删掉："${out}"`);
  assert.ok(!out.includes('🏽'), `肤色修饰符没删掉："${out}"`);
});

check('键帽 1️⃣ 要删干净（不留残影）', () => {
  const out = stripEmoji('第 1️⃣ 步');
  assert.ok(!out.includes('⃣'), `组合用键帽符残留："${out}"`);
  assert.ok(!out.includes('\uFE0F'), `变体选择符残留："${out}"`);
});

check('变体选择符 FE0F 不残留', () => {
  const out = stripEmoji('❤️ 喜欢');
  assert.ok(!out.includes('\uFE0F'), `FE0F 残留："${out}"`);
});

check('ZWJ 零宽连接符不残留', () => {
  const out = stripEmoji('👨‍👩‍👧 一家人');
  assert.ok(!out.includes('\u200D'), `ZWJ 残留："${out}"`);
});

/* ---- 3. 综合：一句话里混着允许的与禁止的 ---- */
check('混合输入：只删 emoji，其余原样', () => {
  const out = stripEmoji('① 先看封面 🔥 ② 再看正文 ↓');
  assert.equal(out, '① 先看封面 ② 再看正文 ↓', `实际 "${out}"`);
});

check('删除后不留连续空格', () => {
  const out = stripEmoji('好物 🔥 必看');
  assert.ok(!/ {2,}/.test(out), `留下了连续空格："${out}"`);
});

check('纯 emoji 输入 → 空串，不抛', () => {
  assert.equal(stripEmoji('🔥🎉👍').trim(), '');
});

check('无 emoji 的普通中文原样返回', () => {
  const s = '厨房只有 3㎡，还能装下什么？';
  assert.equal(stripEmoji(s), s);
});

console.log(`\n通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
