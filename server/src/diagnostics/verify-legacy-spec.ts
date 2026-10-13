/**
 * 旧规格回归 —— 已存画像 + 已发布草稿必须还能渲染。
 *
 *   node server/dist/diagnostics/verify-legacy-spec.js
 *
 * 为什么需要这条：库里 `style_profiles` 存的是**旧的 18 字段形状**
 * （`background` / `title_size` / `palette: string[]` …），而渲染器现在只吃新契约。
 * 中间靠 `migrateLegacySpec()` 做确定性映射。这条映射一旦写错，
 * 表现是「所有历史画像的图突然全变成同一个默认样」—— 不报错、不崩，
 * 只是静默地所有作者长一样。所以必须真的把旧画像喂进去渲染一遍。
 *
 * 覆盖面：
 *   1. 旧画像 → toResolved：主题/色板/字号档必须落在一个合法值上
 *   2. 各种垃圾输入（null / {} / 半个字段 / 字段类型错）都不能抛
 *   3. 旧画像下渲染 draft 8 与 draft 21 的全部卡片，一张都不许失败
 *
 * 不写库、不发网络请求，处置期也能跑。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { all, get } from '../db/index.js';
import { MEDIA_DIR } from '../config.js';
import { closeRenderer, renderCards, toResolved, type Card, type Layout } from '../generate/cards.js';
import { PALETTES, THEME_IDS } from '../generate/design/index.js';

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

/** 各主题色板数量，用来断言 palette_index 合法性。 */
const paletteCount: Record<string, number> = Object.fromEntries(
  THEME_IDS.map((t: string) => [t, (PALETTES[t] ?? []).length]),
);

console.log('旧规格 → 新契约\n');

/* ---- 1. 真实旧画像 ---- */
const row = get<{ source_id: number; profile: string }>(
  'SELECT source_id, profile FROM style_profiles LIMIT 1',
);

if (!row) {
  console.log('  （库里没有 style_profiles，跳过真实画像这一组）');
} else {
  const legacy = JSON.parse(row.profile) as { card_template_spec: unknown };

  check(`源 ${row.source_id}：旧 spec 解析出合法主题/色板/字号`, () => {
    const r = toResolved(legacy.card_template_spec);
    assert.ok(THEME_IDS.includes(r.theme), `主题不在枚举里：${r.theme}`);
    const n = paletteCount[r.theme] ?? 0;
    assert.ok(n > 0, `主题 ${r.theme} 没有色板`);
    // resolveSpec 内部会取模，所以下标一定在范围内；这里再验一次色值形状
    assert.match(r.palette.bg, /^#[0-9a-fA-F]{6}$/, `底色不是 hex：${r.palette.bg}`);
    assert.match(r.palette.accent, /^#[0-9a-fA-F]{6}$/, `强调色不是 hex：${r.palette.accent}`);
    assert.ok(r.type.title > 0 && r.type.body > 0, '字号没解出来');
    assert.ok(r.density.maxItems > 0, '密度没解出来');
    assert.ok(r.fontTitle.length > 0 && r.fontBody.length > 0, '字体栈为空');
  });

  check('旧 spec 原样免疫：不修改传入对象', () => {
    const before = JSON.stringify(legacy.card_template_spec);
    toResolved(legacy.card_template_spec);
    assert.equal(JSON.stringify(legacy.card_template_spec), before, 'toResolved 改动了入参');
  });

  check('旧 spec 的色相被映射到语义相符的主题', () => {
    const spec = legacy.card_template_spec as { background?: string; accent?: string };
    const r = toResolved(spec);
    const t = r.theme;
    // 深底必须走图桥；浅底绝不能走图桥（图桥全是暗色板）
    if (typeof spec.background === 'string') {
      const n = parseInt(spec.background.replace('#', ''), 16);
      const lum = (((n >> 16) & 255) * 0.2126 + ((n >> 8) & 255) * 0.7152 + (n & 255) * 0.0722) / 255;
      if (lum < 0.35) {
        assert.equal(t, 'bridge-canvas', `深底 ${spec.background} 应走图桥，实际 ${t}`);
      } else {
        assert.notEqual(t, 'bridge-canvas', `浅底 ${spec.background} 不该走图桥`);
      }
    }
  });
}

/* ---- 2. 垃圾输入永不抛 ---- */
console.log('\n异常输入不得抛');
for (const [label, input] of [
  ['null', null],
  ['undefined', undefined],
  ['空对象', {}],
  ['只有 background', { background: '#123456' }],
  ['字段类型全错', { background: 42, palette: 'not-an-array', title_size: 'big' }],
  ['枚举值不存在', { theme: 'warm-paper', texture: 'sparkles', motifs: ['unicorn'] }],
  ['数字写成字符串', { theme: 'still-paper', palette_index: '3', type_scale: 'DISPLAY' }],
  ['motifs 是 null', { theme: 'still-paper', motifs: null }],
] as Array<[string, unknown]>) {
  check(`toResolved(${label}) 不抛且可用`, () => {
    const r = toResolved(input);
    assert.ok(r.type.title > 0, '字号解不出来');
    assert.ok(r.motifs.length > 0, '装饰件为空');
    assert.ok(r.density.maxItems >= 1, '密度不合法');
  });
}

check('palette_index 越界时不报错（取模）', () => {
  const r = toResolved({ theme: 'signal-proof', palette_index: 999 });
  assert.match(r.palette.bg, /^#[0-9a-fA-F]{6}$/);
});

/* ---- 3. 已发布草稿的回归渲染 ---- */
const TARGETS = [8, 21];
const outRoot = path.join(MEDIA_DIR, '_legacy-regression');

async function renderDraft(draftId: number): Promise<{ total: number; ok: number; failed: string[] }> {
  const draft = get<{ id: number; source_id: number | null; title: string }>(
    'SELECT id, source_id, title FROM drafts WHERE id = ?',
    draftId,
  );
  assert.ok(draft, `草稿 ${draftId} 不存在`);

  const cardRows = all<{ id: number; layout: string; content: string }>(
    'SELECT id, layout, content FROM draft_cards WHERE draft_id = ? ORDER BY idx',
    draftId,
  );
  assert.ok(cardRows.length > 0, `草稿 ${draftId} 没有卡片`);

  const cards: Card[] = cardRows.map((r) => {
    let blocks: Record<string, unknown> = {};
    try {
      blocks = JSON.parse(r.content) as Record<string, unknown>;
    } catch {
      /* 内容坏了就当空卡渲染，这也是要验的路径 */
    }
    return { layout: r.layout as Layout, blocks };
  });

  const outDir = path.join(outRoot, String(draftId));
  await fs.rm(outDir, { recursive: true, force: true });

  const paths = await renderCards(cards, { sourceId: draft.source_id, outputDir: outDir });

  assert.equal(paths.length, cards.length, 'renderCards 返回长度与输入不等（下标会错位）');

  const bad: string[] = [];
  for (const [i, p] of paths.entries()) {
    if (!p) {
      bad.push(`${cardRows[i]!.layout}(idx ${i})`);
      continue;
    }
    const st = await fs.stat(p).catch(() => null);
    if (!st || st.size < 20_000) bad.push(`${cardRows[i]!.layout}(idx ${i}, ${st?.size ?? 0}B)`);
  }
  return { total: cards.length, ok: paths.filter(Boolean).length, failed: bad };
}

console.log('\n已发布草稿的旧规格回归渲染');
for (const id of TARGETS) {
  const draft = get<{ title: string }>('SELECT title FROM drafts WHERE id = ?', id);
  if (!draft) {
    console.log(`  ⚠ 跳过草稿 ${id}（库里没有）`);
    continue;
  }
  let res: { total: number; ok: number; failed: string[] };
  try {
    res = await renderDraft(id);
  } catch (err) {
    failed++;
    console.log(`  ✗ 草稿 ${id}「${draft.title}」渲染抛异常`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  if (res.failed.length === 0) {
    passed++;
    console.log(`  ✓ 草稿 ${id}「${draft.title}」 ${res.ok}/${res.total} 张全部渲染成功`);
  } else {
    failed++;
    console.log(`  ✗ 草稿 ${id}「${draft.title}」 ${res.ok}/${res.total}，失败：${res.failed.join(', ')}`);
  }
}

await closeRenderer();
await fs.rm(outRoot, { recursive: true, force: true }).catch(() => undefined);

console.log(`\n通过 ${passed}，失败 ${failed}`);
if (failed > 0) process.exitCode = 1;
