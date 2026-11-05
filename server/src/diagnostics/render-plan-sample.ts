import path from 'node:path';
import fs from 'node:fs/promises';
import { renderCards, closeRenderer, specForSource, type Card } from '../generate/cards.js';
import { buildDeckPlan } from '../generate/design/plan.js';
import { corpusPhotoPool, pickCorpusPhoto } from '../visual/templates/corpus-photo-match.js';
import { MEDIA_DIR } from '../config.js';

/**
 * 渲染一整套稿件计划，检查「逐页模板族」真的落到画面上。
 *
 *   node server/dist/diagnostics/render-plan-sample.js [sourceId] [topic]
 *
 * 这是「每篇都很雷同」的可视化验收：取一份真实计划（页数/骨架/逐页族都来自语料），
 * 按计划渲染每张卡，输出到 data/media/diagnostics/plan-sample/。
 *
 * 与 verify-golden-template 的分工：那个验「单页几何对不对」，
 * 这个验「整篇是不是按语料结构在换骨架」。
 */
const args = process.argv.slice(2);
const sourceId = Number(args.filter((a) => /^\d+$/.test(a))[0] ?? '10');
const topic = args.filter((a) => !/^\d+$/.test(a)).join(' ') || '为什么先被记住的是颜色，不是Logo';

const plan = buildDeckPlan(sourceId, topic);
if (!plan) {
  console.error('造不出计划（语料不足或骨架全空）');
  process.exit(1);
}

console.log(`选题：${topic}`);
console.log(`样稿：${plan.exemplarNoteId}《${plan.exemplarTitle}》`);
console.log(`页数：${plan.cardCount}  骨架：${plan.skeleton}`);
console.log(`版式：${plan.roles.join(' > ')}`);
console.log(`族  ：${plan.families.join(' > ')}`);
console.log(`前缀：${plan.numberingPrefix || '(无)'}\n`);

/** 按版式造一份样板文案（只为验证版式落到画面，不是成稿内容）。 */
function blocksFor(role: string, beat: string): Record<string, unknown> {
  switch (role) {
    case 'cover':
      return {
        eyebrow: 'BRAND NOTE',
        title: '为什么先被记住的\n是颜色',
        hint: '颜色比 Logo 更早进入记忆',
        items: ['从"看图"', '到"记色"', '从"认字"', '到"认调"'],
      };
    case 'quote':
      return { text: `关于「${beat}」，真正要说的是一句话。`, note: '一句补充解释。', attribution: 'WOW' };
    case 'list':
      return {
        title: `${beat}：四个判断点`,
        items: [
          { text: '第一个判断点', note: '附一句说明' },
          { text: '第二个判断点', note: '附一句说明' },
          { text: '第三个判断点', note: '附一句说明' },
        ],
      };
    case 'steps':
      return {
        title: `${beat}怎么做`,
        items: [
          { text: '先定标准', note: '把模糊的要求写成可判定的' },
          { text: '再挑栏目', note: '固定下来，不要每期换' },
          { text: '最后定节奏', note: '让读者形成预期' },
        ],
      };
    case 'compare':
      return {
        title: `${beat}的两种做法`,
        left: { title: '旧做法', items: ['只讲功能', '每次换风格'] },
        right: { title: '新做法', items: ['讲判断', '风格固定'] },
        conclusion: '差别不在预算，在有没有一套能复用的标准。',
      };
    case 'photo_text':
      return { title: `${beat}：真实案例`, subtitle: '用真实案例说明这条判断。' };
    case 'cta':
      return { title: '先定标准，再谈执行', action: '把你的做法发到评论区，我挑几条帮你看看。' };
    default:
      return { title: beat, items: [{ text: '要点', note: '' }] };
  }
}

const cards: Card[] = plan.roles.map((role, i) => ({
  layout: role,
  blocks: blocksFor(role, plan.slotBeats[i] || '主题'),
  index: i,
  family: plan.families[i],
  numberingPrefix: plan.numberingPrefix || undefined,
}));

/**
 * 配图：与生产链同一条逻辑（pipeline.renderDraftCards 里那段）。
 * 走语料案例图池，不走免费图库 —— 这里复刻一遍是为了让本脚本
 * 能验到「配图是否真的选到了相关内容」。
 */
const used: number[] = [];
for (const card of cards) {
  if (card.layout !== 'photo_text') continue;
  const text = [
    String(card.blocks.title ?? ''),
    String(card.blocks.subtitle ?? ''),
  ].join(' ');
  const file = pickCorpusPhoto(sourceId, text, used);
  if (file) {
    card.blocks.photoPath = file;
    console.log(`配图（按内容匹配）：${path.basename(file)}`);
    used.push(...corpusPhotoPool(sourceId).filter((p) => p.file === file).map((p) => p.id));
  } else {
    console.log('配图：无相关语料图 → 该页走纯文字版式');
  }
}

const spec = specForSource(sourceId);
console.log(`渲染规格：family=${spec.accountTemplate.family} numbering=${spec.accountTemplate.numbering}`);
console.log(`内容层族由 card.family 逐页覆盖 → ${[...new Set(plan.families)].join(', ')}\n`);

const outDir = path.join(MEDIA_DIR, 'diagnostics', 'plan-sample');
await fs.mkdir(outDir, { recursive: true });

const paths = await renderCards(cards, { sourceId, outputDir: outDir });
console.log('—— 渲染结果 ——');
paths.forEach((p, i) => {
  console.log(`${i + 1}. ${plan.roles[i]}  [${plan.families[i]}]  ${p ? path.basename(p) : '✗ 失败'}`);
});

const ok = paths.filter(Boolean).length;
console.log(`\n${ok}/${paths.length} 张渲染成功 → ${outDir}`);

await closeRenderer();
