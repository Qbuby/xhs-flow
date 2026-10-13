/**
 * 样张内容与主题契约。
 *
 * 单独抽出来是因为 `render-sample.ts` 和 `check-layout.ts` 都要用 ——
 * 后者如果直接 import 前者，就会连带把前者的 `main()` 也跑一遍。
 *
 * 样例内容刻意贴近真实产出：带 `[[强调]]`、带换行、带 ①②③、
 * 带容易被旧清洗管线误删的符号（✓ ❌ ↓）。这样一眼就能看出
 * 「prompt 允许的符号有没有真的渲染出来」。
 */
import type { Card } from '../generate/cards.js';
import type { ThemeName } from '../generate/design/index.js';

export const CARDS: Card[] = [
  {
    layout: 'cover',
    blocks: {
      eyebrow: '小户型改造',
      title: '厨房只有 [[3㎡]]\n还能装下什么？',
      items: ['真实住过的 6 个方案', '每一版的踩坑记录', '预算控制在 2000 内'],
      hint: '建议先收藏再看 ↓',
      brand: '小家研究所',
      watermark: '01',
    },
  },
  {
    layout: 'quote',
    blocks: {
      text: '不是厨房太小，\n是你没把台面[[让出来]]',
      note: '把灶台往里推 15cm，操作台立刻多出 40cm。',
      attribution: '装修第三年的我',
      brand: '小家研究所',
      watermark: '02',
    },
  },
  {
    layout: 'list',
    blocks: {
      eyebrow: '重点',
      title: '这 4 样东西\n我劝你别买',
      items: [
        { text: '层高不到 2.6m 的吊柜', note: '装完仰头就顶，拿取还要搬凳子' },
        { text: '抽屉式调料架', note: '油瓶一倒，整层都是黏的' },
        { text: '水槽上方置物架', note: '挡住窗户，白天也要开灯' },
        { text: '磁性刀架', note: '吸在瓷砖上，三个月就掉' },
      ],
      brand: '小家研究所',
      watermark: '03',
    },
  },
  {
    layout: 'steps',
    blocks: {
      eyebrow: '怎么做',
      title: '台面留空\n分这 5 步走',
      items: [
        { text: '先清空台面，只留三件', note: '刀、砧板、常用锅' },
        { text: '把调料移进抽屉', note: '分层斜插，一眼看到' },
        { text: '墙面改成洞洞板', note: '锅铲挂起来，台面又空一块' },
        { text: '每天睡前 3 分钟归位', note: '这一步比买什么都管用' },
      ],
      brand: '小家研究所',
      watermark: '04',
    },
  },
  {
    layout: 'compare',
    blocks: {
      eyebrow: '对比',
      title: '改造前 vs 改造后',
      left: { title: '❌ 之前', items: ['台面摆满瓶罐', '做饭要先挪东西', '每次收拾 40 分钟'] },
      right: { title: '✓ 之后', items: ['台面只有三件', '伸手就能拿到', '睡前 3 分钟收尾'] },
      conclusion: '差别不在柜子多少，在于有没有给动作留出通道。',
      brand: '小家研究所',
      watermark: '05',
    },
  },
  {
    layout: 'photo_text',
    blocks: {
      title: '关于[[断舍离]]\n我踩过的坑',
      subtitle: '扔东西真的会上瘾，但别扔到半夜。',
      brand: '小家研究所',
      watermark: '06',
    },
  },
  {
    layout: 'cta',
    blocks: {
      title: '你家厨房\n最大的问题是啥？',
      action: '评论区告诉我，我帮你看看怎么改',
      brand: '小家研究所',
      watermark: '07',
    },
  },
];

/** 每个主题一套有代表性的契约参数。 */
export const THEME_CONTRACTS: Record<ThemeName, Record<string, unknown>> = {
  'still-paper': {
    theme: 'still-paper',
    palette_index: 0,
    type_scale: 'display',
    density: 'airy',
    texture: 'paper-grain',
    motifs: ['rule', 'page-num', 'bracket'],
    accent_style: 'highlight',
  },
  'signal-proof': {
    theme: 'signal-proof',
    palette_index: 0,
    type_scale: 'standard',
    density: 'standard',
    texture: 'hairline-grid',
    motifs: ['rule-fade', 'badge', 'seal', 'page-num'],
    accent_style: 'block',
  },
  'bridge-canvas': {
    theme: 'bridge-canvas',
    palette_index: 0,
    type_scale: 'display',
    density: 'standard',
    texture: 'film-grain',
    motifs: ['ticker', 'vertical-tag', 'page-num'],
    accent_style: 'underline',
  },
};
