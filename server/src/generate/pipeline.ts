import { z } from 'zod';
import { run, get, all } from '../db/index.js';
import { chatJson } from '../llm/client.js';
import { getStyleProfile, type StyleProfile } from '../corpus/profile.js';
import { retrieveWithFallback, type RetrievedNote } from '../corpus/retrieve.js';
import { logger } from '../logger.js';
import { MEDIA_DIR } from '../config.js';
import { renderCards, toResolved, CARD_WIDTH, type Card, type Layout, LAYOUTS } from './cards.js';
import { maxTitleLines, type ResolvedSpec } from './design/index.js';
import {
  buildDeckPlan,
  planSummary,
  prefixFromPlan,
  type DeckPlan,
} from './design/plan.js';
import {
  corpusPhotoPool,
  pickCorpusPhoto,
} from '../visual/templates/corpus-photo-match.js';
import { stripEmoji } from '../util/text.js';
import { titleSimilarity, TITLE_NEAR_DUP_THRESHOLD } from '../util/text-sim.js';
import { productionGate } from '../visual/templates/registry.js';
import { EXTRACTOR_VERSION } from '../visual/evidence/extract.js';
import type { TemplateFamilyId } from './design/contract.js';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* 生成契约                                                            */
/* ------------------------------------------------------------------ */

const CardSchema = z.object({
  layout: z.enum(LAYOUTS),
  blocks: z.record(z.any()),
});

const DraftSchema = z.object({
  title: z.string().describe('小红书标题，20 个字符以内'),
  body: z.string().describe('正文，1000 字以内，包含话题标签'),
  tags: z.array(z.string()).describe('话题标签，不带 # 号'),
  cards: z.array(CardSchema).describe('配图卡片，6-9 张，第 1 张必须是 cover'),
});

export type Draft = z.infer<typeof DraftSchema>;

const SYSTEM = `你是一位小红书爆款内容操盘手，正在为一个自动化内容工厂产出可直接发布的图文笔记。

你的创作必须**严格模仿指定博主的风格**，而不是套用通用的"小红书爆款公式"。
语料里给出的样稿是这个博主真实写过的内容，你的任务是抽取它的规律并迁移到新选题上。

【品质底线 —— 任何语料库、任何选题都必须满足】
1. **正文必须有排版**：用空行分成 3-6 段，段落之间用 \\n\\n 分隔。
   绝不允许把整篇挤成一整块连续文字。每段 2-4 行，长短交替，读起来有呼吸感。
2. **不要 emoji**：正文、标题、卡片文案里都**不要出现任何 emoji 表情符号**。
   需要节奏感就用中文标点和分行来做，不要靠图标。
3. **表达要精炼克制，不油腻**：写具体的事实、数字、判断和取舍，
   不要"绝绝子""yyds""宝藏""姐妹们冲"这类廉价网感词，
   也不要"赋能""抓手"这类空转的黑话。宁可句子短一点、信息密度高一点。
4. **要有专业纵深**：每篇至少给出 2 个别人不容易说出来的具体结论
   （可量化的数字、可执行的判断标准、真实的取舍代价），
   而不是"要注意质量""要坚持长期"这种正确的废话。
5. **排版符号克制**：可以用 ①②③ 和「」这类中文标点做结构标记，
   但同一篇里只用一种编号方式，不要混用 ·-•① 一大串。

【技术铁律】
1. 标题必须 ≤20 个字符（小红书会截断），要有钩子但不能标题党。
2. 卡片文案要口语化、有节奏、能独立成立，不要写成说明书。
3. 关键词要打成 [[方括号]] 标记强调，渲染器会把它变成高亮样式。
   ⚠️ 但**笔记标题和选题标题里绝不能出现 [[ ]]** —— 那不是给人看的。
4. 必须严格遵守 do_list / dont_list。
5. 只输出 JSON。

【题材红线 —— 写偏了就是废稿】
只写这位博主的业务范围：品牌定位、视觉识别、品牌调性、品牌体系、
案例拆解、情绪价值与消费心理、品牌主理人与个人IP。
不要写：流量增长、涨粉、投放、私域、SEO、搜索优化、用户调研方法论、
工具评测 —— 那些不是她的业务，写出来读者会觉得"这不是这个号该写的"。`;

/**
 * 把设计契约翻译成**对文案的指令**。
 *
 * 这是整条链路上投入产出比最高的一段：不改渲染器，只改提示词，
 * 生成的卡片立刻"对得上版面"。原因很具体 ——
 * `accent_style='highlight'` 只适合 2-4 字的短词，`'block'` 几乎只适合 2-3 字，
 * 而模型此前完全不知道会是哪种，于是 [[高亮]] 里塞进整句话，渲染出来就是灾难。
 * 同理：标题能写多长取决于字号档与标题行数上限，每卡几条取决于密度档。
 *
 * 旧实现把 `card_template_spec` 声明成 18 个纯视觉字段，13 个从不流向
 * 生成它们的 LLM —— 这就是"设计约束"与"文案创作"之间的那道断链。
 */
function buildVisualConstraints(profile: StyleProfile): string {
  const spec: ResolvedSpec = toResolved(profile.card_template_spec);
  const lines = maxTitleLines(spec.theme);
  const top = spec.type.title;

  // 标题的每行字数上限：按字号换算。1080 减去左右内边距是可用宽度，
  // 中文按 1em/字估，再留 8% 余量给标点与折行误差。
  const usableW = CARD_WIDTH - spec.density.paddingX * 2;
  const charsPerLine = Math.floor((usableW / top) * 0.92);

  const accentRules: Record<string, string> = {
    highlight: '只标 2-4 个字的短词（高亮底色），不要整句',
    block: '只标 2-3 个字的词（实色块），更短更狠',
    underline: '可以标 4-8 字的短语（下划线），适合半句',
    bracket: '可标 4-10 字（加框），适合一个独立概念',
    none: '这张卡没有强调样式，[[方括号]] 会被忽略，别用',
  };

  return [
    '【版面约束 —— 卡片是按这些参数渲染的，文案必须配得上】',
    `- 视觉语言：${spec.theme}（${THEME_DESC[spec.theme]}）`,
    `- 配色：${spec.palette.name} 一套，底色 ${spec.palette.bg}，主色 ${spec.palette.ink}，强调色 ${spec.palette.accent}`,
    `  ⚠️ 你**不能**改颜色。写得再"清新"也不会改变配色，别在文案里提颜色。`,
    `- 字号档：${spec.contract.type_scale}，标题约 ${top}px`,
    `- 标题最多 ${lines} 行，每行约 ${charsPerLine} 个汉字`,
    `  → 所以卡片标题总长控制在 ${charsPerLine * lines} 字以内；**换行用 \\n 手动断**，别让渲染器自己折`,
    `- 密度：${spec.contract.density}，每卡最多 ${spec.density.maxItems} 条`,
    `  → list / steps / compare 的条目数不要超过这个数，超出的会被静默丢掉`,
    `- 强调 [[方括号]]：${accentRules[spec.accentStyle] ?? accentRules['highlight']}`,
    `- 装饰件：${spec.motifs.join('、')}（渲染器自己加，你只管写文案）`,
  ].join('\n');
}

/** 主题一句话说明，提示词里用。 */
const THEME_DESC: Record<ResolvedSpec['theme'], string> = {
  'still-paper': '暖纸底 + 衬线大字 + 大留白，杂志画册气质，信息克制',
  'signal-proof': '档案纸 + 细线 + 等宽元信息，像一份可引用的文件，信息密度高',
  'bridge-canvas': '满铺影像 + 黑边字幕，靠图吃饭，文字极少',
};

function buildStyleBlock(profile: StyleProfile | null): string {
  if (!profile) return '【风格档案】尚未生成，请写通用的高质量小红书内容。';

  const c = profile.card_template_spec;
  return [
    '【该博主的风格档案 —— 必须模仿】',
    `- 一句话调性：${profile.persona.one_liner}`,
    `- 目标人群：${profile.persona.audience}`,
    `- 语气：${profile.persona.tone.join('、')}`,
    `- 常做题材：${profile.persona.content_categories.join('、')}`,
    '',
    '- 标题公式：',
    ...profile.language.title_formulas.map((f) => `    · ${f}`),
    `- 标题平均字数：${profile.language.avg_title_chars}（控制在 ${Math.max(10, profile.language.avg_title_chars - 4)}~${profile.language.avg_title_chars + 6} 字）`,
    `- 正文长度：${profile.language.body_chars_range}`,
    `- 原作者的 emoji 密度：每百字 ${profile.language.emoji_per_100_chars} 个`,
    `  ⚠️ 仅供参考，**你产出的内容不要用任何 emoji**（见下方"必须避免"）`,
    `- 口头禅：${profile.language.signature_phrases.join('、')}`,
    `- 开头套路：${profile.language.opening_patterns.join('；')}`,
    `- 结尾套路：${profile.language.ending_patterns.join('；')}`,
    `- 修辞：${profile.language.rhetoric.join('、')}`,
    `- 话题标签策略：${profile.hashtag_strategy.count_range} 个，${profile.hashtag_strategy.mix}`,
    '',
    `- 常用图片版式：${profile.visual.dominant_layouts.join('、')}`,
    `- 封面套路：${profile.visual.cover_patterns.join('；')}`,
    `- 配色：${profile.visual.palette_summary}`,
    '',
    buildVisualConstraints(profile),
    '',
    '【必须做】',
    ...profile.do_list.map((d) => `    ✓ ${d}`),
    '',
    '【必须避免】',
    ...profile.dont_list.map((d) => `    ✗ ${d}`),
    '    ✗ 使用任何 emoji 表情符号（这是硬性要求，比模仿该博主的 emoji 习惯优先）',
    '    ✗ 把正文写成一整块连续文字（必须分段）',
    '    ✗ "绝绝子/宝藏/yyds/赋能/抓手"这类空转的词',
  ].join('\n');
}

function buildExamplesBlock(examples: RetrievedNote[]): string {
  if (examples.length === 0) return '';
  return [
    '',
    '【该博主的真实样稿 —— 模仿它们的语感和节奏，不要复制内容】',
    ...examples.map((e, i) => {
      const a = e.analysis as
        | { hook?: { title_formula?: string }; structure?: { pattern?: string } }
        | undefined;
      return [
        `样稿 ${i + 1}（互动 ${e.likedCount}）:`,
        `  标题：${e.title}`,
        `  正文节选：${e.desc.slice(0, 260).replace(/\n+/g, ' ')}${e.desc.length > 260 ? '…' : ''}`,
        e.analysis
          ? `  标题公式：${a?.hook?.title_formula ?? '未标注'}\n  正文骨架：${a?.structure?.pattern ?? '未标注'}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    }),
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 创作阶段的 JSON 模板。
 *
 * 之前只用散文描述「cover 要有 eyebrow/title/items」，模型就照字面理解，
 * 把字段平铺到卡片对象上（{"layout":"cover","title":"…"}）而不是塞进 blocks，
 * 渲染出来全是空卡。给模板比讲道理有效 —— 蒸馏那边已经验证过同样一招。
 */
const DRAFT_TEMPLATE = `{
  "title": "20 字以内的标题",
  "body": "第一段…\\n\\n第二段…\\n\\n第三段…（段间必须有空行，不要挤成一整块）",
  "tags": ["话题1", "话题2"],
  "cards": [
    { "layout": "cover", "blocks": { "eyebrow": "短标签", "title": "主标题，用 [[强调]]", "items": ["短句1", "短句2"], "hint": "引导语" } },
    { "layout": "quote", "blocks": { "text": "金句", "note": "补充解释", "attribution": "出处" } },
    { "layout": "list", "blocks": { "eyebrow": "重点", "title": "标题", "items": [{ "text": "要点", "note": "补充" }] } },
    { "layout": "steps", "blocks": { "eyebrow": "怎么做", "title": "标题", "items": [{ "text": "步骤", "note": "说明" }] } },
    { "layout": "compare", "blocks": { "eyebrow": "对比", "title": "标题", "left": { "title": "A", "items": ["…"] }, "right": { "title": "B", "items": ["…"] }, "conclusion": "结论" } },
    { "layout": "photo_text", "blocks": { "title": "标题", "subtitle": "副标题" } },
    { "layout": "cta", "blocks": { "title": "标题", "action": "引导语" } }
  ]
}`;

export interface ComposeResult {
  draftId: number;
  title: string;
  cards: number;
  rendered: number;
}

/**
 * 按计划生成 JSON 骨架模板。
 *
 * 旧实现是一份写死的 7 卡模板（cover/quote/list/steps/compare/photo_text/cta），
 * 所以每篇都长一个样。这里改成**按语料派生的计划**生成：
 * 页数、骨架节拍、每张的版式都来自语料样稿。
 */
function planTemplate(plan: DeckPlan): string {
  const slots = plan.roles.map((role, i) => {
    const beat = plan.slotBeats[i] ?? '';
    switch (role) {
      case 'cover':
        return `    { "layout": "cover", "blocks": { "eyebrow": "短标签", "title": "主标题，用 [[强调]]", "items": ["短句1", "短句2"], "hint": "引导语" } }`;
      case 'quote':
        return `    { "layout": "quote", "blocks": { "text": "金句", "note": "补充解释", "attribution": "出处或\\"我\\"" } }`;
      case 'list':
        return `    { "layout": "list", "blocks": { "eyebrow": "重点", "title": "标题", "items": [{ "text": "要点", "note": "补充" }] } }`;
      case 'steps':
        return `    { "layout": "steps", "blocks": { "eyebrow": "怎么做", "title": "标题", "items": [{ "text": "步骤", "note": "说明" }] } }`;
      case 'compare':
        return `    { "layout": "compare", "blocks": { "eyebrow": "对比", "title": "标题", "left": { "title": "A", "items": ["…"] }, "right": { "title": "B", "items": ["…"] }, "conclusion": "结论" } }`;
      case 'photo_text':
        return `    { "layout": "photo_text", "blocks": { "title": "标题", "subtitle": "副标题" } }`;
      default:
        return `    { "layout": "cta", "blocks": { "title": "标题", "action": "引导语" } }`;
    }
  });
  return `{
  "title": "20 字以内的标题",
  "body": "第一段…\\n\\n第二段…\\n\\n第三段…（段间必须有空行，不要挤成一整块）",
  "tags": ["话题1", "话题2"],
  "cards": [
${slots.join(',\n')}
  ]
}`;
}

/** 每张卡片这一拍要讲什么（喂给模型，避免它自由发挥成同一套结构）。 */
function planBeatsBlock(plan: DeckPlan): string {
  const lines = plan.roles.map((role, i) => {
    const beat = plan.slotBeats[i] || '';
    const label = BEAT_LABEL[role] ?? role;
    return `  第 ${i + 1} 张（${label}）：讲「${beat}」`;
  });
  return ['【本篇的逐页分工 —— 每张卡讲一件事，严格按这个顺序】', ...lines].join('\n');
}

const BEAT_LABEL: Record<string, string> = {
  cover: '封面',
  quote: '金句',
  list: '清单',
  steps: '步骤',
  compare: '对比',
  photo_text: '案例配图',
  cta: '收尾',
};

export async function composeDraft(opts: {
  sourceId: number;
  topic: string;
  angle?: string;
  brief?: string;
  brand?: string;
  cardCount?: number;
}): Promise<ComposeResult> {
  const { sourceId, topic, angle, brief, brand = '' } = opts;

  const profile = getStyleProfile(sourceId)?.profile ?? null;
  const examples = retrieveWithFallback(`${topic} ${angle ?? ''}`, sourceId, 4);

  /**
   * 施工计划：页数 + 骨架 + 逐页版式 + 逐页模板族，全部取自语料。
   *
   * 没有计划（语料还没蒸馏）时退回固定 7 卡 —— 但那种情况下本来也
   * 复刻不了模板，渲染阶段会被生产闸门拦住。
   */
  const plan = buildDeckPlan(
    sourceId,
    topic,
    examples.map((e) => e.notePk),
  );

  const cardCount = plan?.cardCount ?? opts.cardCount ?? 7;

  const user = [
    `【本次选题】${topic}`,
    angle ? `【切入角度】${angle}` : '',
    brief ? `【补充要求】${brief}` : '',
    brand ? `【品牌署名】页脚署名用「${brand}」` : '',
    `【卡片数量】${cardCount} 张，第 1 张必须是 layout="cover" 作为封面，最后一张是 layout="cta"。`,
    '',
    buildStyleBlock(profile),
    buildExamplesBlock(examples),
    '',
    plan ? planBeatsBlock(plan) : '',
    plan
      ? `【结构参考】这一篇的结构照语料《${plan.exemplarTitle}》来：` +
        `正文骨架是「${plan.skeleton}」。每张卡讲一件事，不要把几件事塞进同一张。`
      : '',
    '',
    '【每张卡片的内容要求】',
    '- cover：eyebrow(短标签)/title(主标题，用 [[强调]])/items(3-4 个短句)/hint(引导语)',
    '- quote：text(金句)/note(补充解释)/attribution(出处或"我")',
    '- list：title + items[{text, note}]，4-6 条',
    '- steps：title + items[{text, note}]，3-5 步',
    '- compare：title + left{title,items} + right{title,items} + conclusion',
    '- photo_text：title + subtitle（配图由系统按内容匹配语料案例图，你不用给检索词）',
    '- cta：title + action(引导语)',
    '',
    '【文案品质要求 —— 每一条都要做到】',
    '- 正文用 \\n\\n 分成 3-6 段，段间空一行；不要写成一整块连续文字',
    '- 全文（含卡片）**不要出现任何 emoji**',
    '- 不写"绝绝子/宝藏/yyds/赋能/抓手"这类词',
    '- 至少给出 2 个具体可验证的结论（数字、判断标准、取舍代价）',
    '- **不要写"语言体系""视觉规范""方法论"这种抽象大词当标题** —— 标题要落到具体的东西上',
    '',
    '【最重要的要求】严格按下面这份 JSON 结构输出。',
    '每张卡片的文案字段必须**嵌套在 blocks 对象内**，不要平铺到卡片对象上。',
    '```json',
    plan ? planTemplate(plan) : DRAFT_TEMPLATE,
    '```',
    '',
    '现在输出 JSON。',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await chatJson<Record<string, unknown>>({
    system: SYSTEM, user, temperature: 0.85, maxTokens: 16_384,
  });

  // 与 ideate 同理：模型可能返回中文键（标题/正文/卡片），先做一次键名归一，
  // 免得后面只能靠「空内容即报错」把整轮创作打断。
  const normalized = normalizeDraftShape(raw);

  const draft = coerceDraft(normalized);

  // ⚠️ 不允许「静默降级」。模型返回中文键（`标题`/`正文`/`卡片`）时，
  // coerceDraft 会兜底成「未命名笔记 + 一张空封面」并正常落库 —— 界面看不出
  // 异常，只是内容全空。实测 MiniMax-M3.1 在没有 JSON 约束时就会这样。
  // 这里做结构性检查：无正文或卡片无内容 → 明确失败，不写库。
  if (!draft.body.trim()) {
    throw new Error(
      `创作返回的正文为空（模型顶层键：${
        raw && typeof raw === 'object' ? Object.keys(raw as object).slice(0, 8).join(',') : typeof raw
      }）。这是字段名不匹配，不是模型没写 —— 不要落库成空稿。`,
    );
  }
  const cardsWithText = draft.cards.filter((c) => JSON.stringify(c.blocks).length > 12);
  if (cardsWithText.length === 0) {
    throw new Error('创作返回的卡片全部没有内容，拒绝落库（模型返回形状与契约不符）');
  }

  // 标题里的 [[ ]] 是渲染标记，给人看会像乱码（实测漏进过草稿列表）。
  // 正文/卡片里的要保留 —— 它们会被渲染成高亮。
  draft.title = draft.title.replace(/\[\[|\]\]/g, '').trim();

  // 题材自检：跑偏的稿不该进草稿池让人去挑。但**不删**，而是标成 rejected
  // 并记事件 —— 内容本身写得不差（实测用户访谈那篇正文质量很高），
  // 问题是题目不属于这个账号，留着比删掉更有用：用户能看到问题出在选题。
  const OFF_TOPIC_DRAFT =
    /涨粉|流量增长|投放技巧|私域运营|SEO|搜索优化|搜索排名|关键词布局|账号定位怎么做|直播话术|起号/;
  if (OFF_TOPIC_DRAFT.test(draft.title)) {
    run(
      `INSERT INTO events(ts, kind, severity, message, detail)
       VALUES (datetime('now'), 'fallback', 'warn', ?, ?)`,
      '草稿题材跑偏，已标记待复核',
      JSON.stringify({ sourceId, title: draft.title, topic: topic }),
    );
    logger.warn({ sourceId, title: draft.title }, '草稿题材偏离账号业务方向');
  }
  /* --- 落库 --- */
  const ins = run(
    `INSERT INTO drafts(source_id, title, body, tags, status, ref_note_ids, plan)
     VALUES (?,?,?,?, 'pending', ?, ?)`,
    sourceId,
    draft.title.slice(0, 40),
    draft.body,
    JSON.stringify(draft.tags),
    JSON.stringify(examples.map((e) => e.notePk)),
    plan ? JSON.stringify(planSummary(plan)) : null,
  );
  const draftId = Number(ins.lastInsertRowid);

  /**
   * 逐张卡片的模板族来自计划。
   *
   * 关键点：**版式（list/steps/compare）与模板族（wow-brand-case-v1 等）
   * 是两个正交的维度**。版式决定「这页放什么内容」，模板族决定「这页长什么样」
   * （编号形态、标题起排 y、页脚条）。之前整篇共用一个族，所以每篇都长得一样。
   */
  const cards: Card[] = draft.cards.slice(0, 10).map((c, i) => ({
    layout: c.layout,
    blocks: { ...c.blocks, brand },
    family: plan?.families[i],
  }));

  cards.forEach((c, i) => {
    run(
      'INSERT INTO draft_cards(draft_id, idx, layout, content, photo_url, family) VALUES (?,?,?,?,?,?)',
      draftId,
      i,
      c.layout,
      JSON.stringify(c.blocks),
      // photo_url 现在存的是**语料案例图的绝对路径**（渲染时按内容匹配后回填），
      // 不再是模型的检索词 —— 免费图库是「无关的免费图」问题的根源。
      null,
      c.family ?? null,
    );
  });

  const rendered = await renderDraftCards(draftId, sourceId);

  return { draftId, title: draft.title, cards: cards.length, rendered };
}

/**
 * 正文归一化。
 *
 * 三件事必须在落库前做掉，不能指望模型每次都守规矩：
 *   1. **段落结构** —— 模型经常把整篇写成一大块没有空行的连续文字，
 *      直接发到小红书就是一坨（第一次实发验证时踩到）。这里保证段间有空行。
 *   2. **清 emoji** —— 正文进卡片渲染前也会被清，但库里存的应该是干净文本，
 *      否则草稿页预览与实际发布内容不一致。
 *   3. **剥掉正文里的话题标签** —— 话题是发布时用下拉框单独插入的，
 *      正文再带一份就会重复。语料里的 `#品牌营销[话题]#` 是抓取时留下的标记，
 *      模型会照着抄，必须在这里兜底。
 */
function normalizeBody(raw: string): string {
  let cleaned = stripEmoji(raw).replace(/[ \t]+$/gm, '').trim();

  // 正文里的话题标签一律去掉（含语料残留的 `[话题]#` 标记）
  cleaned = cleaned
    .replace(/(#[\p{Script=Han}\w]{1,20}\[话题\]#\s*)+$/gu, '')
    .replace(/^\s*(#[\p{Script=Han}\w]{1,20}\s*){2,}$/gmu, '')
    .replace(/([^\n])(\s*#[\p{Script=Han}\w]{1,20})(\s*#[\p{Script=Han}\w]{1,20})+/gu, '$1')
    .trim();

  const noTag = cleaned.replace(/[ \t]+$/gm, '').trim();

  // 已经有空行分段就尊重原样
  if (/\n\s*\n/.test(noTag)) {
    return noTag.replace(/\n{3,}/g, '\n\n');
  }

  // 只有单换行：把换行当段落分隔，补成空行
  if (noTag.includes('\n')) {
    return noTag
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .join('\n\n');
  }

  // 整篇一个自然段：按句末标点切分后每 2-3 句成段，交出可读的排版
  const sentences = noTag.split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length <= 3) return noTag;

  const target = Math.min(5, Math.max(3, Math.round(sentences.length / 3)));
  const per = Math.ceil(sentences.length / target);
  const paras: string[] = [];
  for (let i = 0; i < sentences.length; i += per) {
    paras.push(sentences.slice(i, i + per).join(''));
  }
  return paras.join('\n\n');
}

/**
 * 归一模型返回的键名：约定是 title/body/tags/cards，但模型经常给中文键。
 *
 * 与 extractTopics 同源的问题：模型的 JSON 形状不可信。与其让下游用
 * 「空内容即报错」把整轮创作打断，不如在这里认一下常见别名。认不出来就
 * 原样返回，交给下游的结构校验报错 —— 归一不负责猜内容。
 */
function normalizeDraftShape(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) if (o[k] !== undefined) return o[k];
    return undefined;
  };
  const title = pick('title', '标题');
  const body = pick('body', '正文', 'content', 'desc');
  const tags = pick('tags', '标签', '话题');
  const cards = pick('cards', '卡片', 'images', 'slides');
  if (title === undefined && body === undefined && cards === undefined) return o;
  return { ...o, title, body, tags, cards };
}

/** 模型偶尔不守 schema，这里硬兜底，保证下游渲染器拿到的形状永远是对的。 */
function coerceDraft(raw: unknown): Draft {
  const o = (raw ?? {}) as Record<string, unknown>;
  const title = String(o.title ?? '').trim().slice(0, 20) || '未命名笔记';
  const body = normalizeBody(String(o.body ?? '')).slice(0, 1000);
  const tags = Array.isArray(o.tags) ? (o.tags as unknown[]).map((t) => String(t).replace(/^#/, '')).filter(Boolean) : [];

  let cards = Array.isArray(o.cards) ? (o.cards as Array<Record<string, unknown>>) : [];

  cards = cards.map((c: Record<string, unknown>, i: number) => {
    const layout = LAYOUTS.includes(c?.layout as Layout) ? (c.layout as Layout) : i === 0 ? 'cover' : 'list';
    let blocks: Record<string, unknown> =
      c?.blocks && typeof c.blocks === 'object' && !Array.isArray(c.blocks)
        ? (c.blocks as Record<string, unknown>)
        : {};

    // 兜底：模型经常把 blocks 的字段平铺到卡片对象上
    // （{"layout":"cover","title":"…"}），这时渲染出来是一张全空的卡。
    // 这里把散落的字段收拢回 blocks。
    if (Object.keys(blocks).length === 0 && c && typeof c === 'object') {
      const flat: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
        if (k === 'layout' || k === 'blocks') continue;
        flat[k] = v;
      }
      if (Object.keys(flat).length > 0) blocks = flat;
    }

    return { layout, blocks };
  }) as Draft['cards'];

  // 封面必须有
  if (cards.length === 0 || cards[0]?.layout !== 'cover') {
    cards.unshift({
      layout: 'cover',
      blocks: { eyebrow: '', title, items: [], hint: '' },
    });
  }
  if (cards.length > 10) cards = cards.slice(0, 10);

  return { title, body, tags, cards: cards as Draft['cards'] };
}

/**
 * 渲染某草稿的全部卡片并回写路径。
 *
 * 【阶段 D 的生产闸门】
 * 复刻渲染必须挂在一个**已验证的模板族**上。`renderDraftCards` 在
 * `sourceId` 存在时先问注册表：该来源有没有通过原文回放验收的族？
 *   - 有 → 用最大 verified 族渲染（复刻模式）
 *   - 无 → **阻断**：清空本稿的图片路径并写明原因，绝不静默退回通用主题
 *     后继续标注「1:1 复刻」。报告 5.4 的硬要求。
 *
 * 阻断不是失败回滚：草稿与文案照常留在库里，用户看得到内容，
 * 只是不会拿到「看起来没问题但其实不是那个模板」的图。
 */
/**
 * 渲染用的辅助：读某草稿落库的计划 JSON。
 *
 * 单独抽出来是因为 TS 的泛型内联写法 `get< plan: string | null }>(...)`
 * 在 JSX/箭头混排的文件里容易被误解析 —— 用一个具名类型更稳。
 */
interface PlanRow {
  plan: string | null;
}

function getPlanOf(draftId: number): string | null {
  return get<PlanRow>('SELECT plan FROM drafts WHERE id = ?', draftId)?.plan ?? null;
}

export async function renderDraftCards(draftId: number, sourceId: number | null): Promise<number> {
  const rows = all<{
    id: number;
    layout: string;
    content: string;
    photo_url: string | null;
    family: string | null;
  }>(
    'SELECT id, layout, content, photo_url, family FROM draft_cards WHERE draft_id = ? ORDER BY idx',
    draftId,
  );

  // 编号前缀存在草稿的计划里（创作时按语料样稿写入）
  const planPrefix = prefixFromPlan(getPlanOf(draftId));

  const outputDir = path.join(MEDIA_DIR, 'drafts', String(draftId));

  // 生产闸门
  if (sourceId) {
    const gate = productionGate(sourceId, EXTRACTOR_VERSION);
    if (gate.kind === 'blocked') {
      logger.warn({ sourceId, draftId, reason: gate.reason }, '模板未验证，阻断渲染');
      run("UPDATE draft_cards SET image_path = NULL WHERE draft_id = ?", draftId);
      run("UPDATE drafts SET rendered = 0, updated_at = datetime('now') WHERE id = ?", draftId);
      run(
        `INSERT INTO events(ts, kind, severity, message, detail)
         VALUES (datetime('now'), 'fallback', 'warn', ?, ?)`,
        '模板未验证，已阻断卡片渲染',
        gate.reason,
      );
      return 0;
    }
    logger.info({ sourceId, draftId, note: gate.note }, '复刻渲染（已验证模板族）');
  }

  const cards: Card[] = rows.map((r, i) => {
    let blocks: Record<string, unknown> = {};
    try {
      blocks = JSON.parse(r.content) as Record<string, unknown>;
    } catch {
      /* 内容坏了就渲染成空卡 */
    }
    // 卡片序号跟随落库的 idx：编号样式为 "01" 的账号模板渲染成 01/02/03…。
    // 之前渲染端拿不到顺序，页码兜底恒为 '01'。
    return {
      layout: r.layout as Layout,
      blocks,
      index: i,
      // 逐页模板族（创作时按语料样稿写死在这里）。
      family: (r.family as TemplateFamilyId) ?? undefined,
      // 编号前缀按计划来：只有细字编号族用得上
      numberingPrefix: planPrefix || undefined,
    };
  });

  /**
   * 配图：走**语料案例图池**，不走免费图库。
   *
   * 之前是让模型写中文检索词去 Pexels/Wikimedia 找图 —— 结果每篇都挂一张
   * 「笔记本手写」「品牌手册白底」之类的通用图库照，与内容、与账号风格都对不上。
   * 语料里的案例图才是这个账号该有的配图（喜茶、劲牌、三九胃泰……）。
   *
   * 挑图按「本卡内容 × 来源笔记标题/标签」的相关度算；没有明显相关的就不配图，
   * 让这一格走纯文字版式 —— 语料里本来就有大量纯文字卡。
   */
  if (sourceId) {
    const used: number[] = [];
    for (const card of cards) {
      if (card.layout !== 'photo_text') continue;
      const text = [
        String(card.blocks.title ?? ''),
        String(card.blocks.subtitle ?? ''),
        ...(Array.isArray(card.blocks.items) ? card.blocks.items.map((i) => String(i)) : []),
      ].join(' ');
      const file = pickCorpusPhoto(sourceId, text, used);
      if (file) {
        card.blocks.photoPath = file;
        used.push(...corpusPhotoPool(sourceId).filter((p) => p.file === file).map((p) => p.id));
      }
    }
  }

  const paths = await renderCards(cards, { sourceId, outputDir });

  // ⚠️ renderCards 现在保证**下标与输入一一对应**（失败的位置是 null），
  // 所以这里按下标回写是安全的。之前失败时直接跳过 push，返回数组变短，
  // 于是「第 2 张失败」会把第 3 张的图写进第 2 行 —— 静默的图片错位。
  let written = 0;
  rows.forEach((r, i) => {
    const p = paths[i];
    if (p) {
      run('UPDATE draft_cards SET image_path = ? WHERE id = ?', p, r.id);
      written++;
    } else {
      // 失败的卡片要清掉旧路径，否则界面上会一直显示上一版渲染的图
      run('UPDATE draft_cards SET image_path = NULL WHERE id = ?', r.id);
    }
  });

  if (written > 0) {
    run("UPDATE drafts SET rendered = 1, updated_at = datetime('now') WHERE id = ?", draftId);
  }
  return written;
}

/* ------------------------------------------------------------------ */
/* 选题                                                                */
/* ------------------------------------------------------------------ */

const IDEATE_SYSTEM = `你是一位小红书选题策划，服务于**一个具体的品牌营销/视觉设计类博主**。

你的唯一职责：站在这位博主的身份上，产出她"下一个阶段可能会写"的选题。

【铁律：选题必须落在博主的题材池内】
不要写泛互联网运营题（搜索优化、流量增长、私域运营、投放技巧、涨粉方法、
SEO、关键词布局…）。这些不属于这位博主的业务，写出来就是废稿。
每个选题都必须能回答：**这跟品牌定位 / 视觉识别 / 品牌调性 / 品牌体系 / 案例拆解 / 情绪消费 有什么关系？**

【选题的质量标准 —— 对齐爆款的写法】
参考给你的「爆款样稿」，它们的共同点是：
- 命题具体，不空泛（"喜茶为什么越看越有感觉" > "分析喜茶的成功"）
- 常带具体对象、数字、反直觉（"韩国小品牌为啥看起来很完整"、"初创品牌如何制造早就很火的感觉"）
- 用提问或判断句，不写陈述式标题
- 站在品牌从业者视角，讲判断和方法，不讲操作步骤

【禁止】
- 与已写过的选题重复或只是换词
- 标题里带 [[方括号]] 标记（那是渲染标记，不该出现在选题里）
- emoji
- 任何与品牌业务无关的运营/流量/工具类选题`;

/**
 * 从模型返回里挖出选题数组。
 *
 * ⚠️ 模型不保证守 schema。实测 MiniMax-M3.1 在没有 JSON 模板约束时返回的是
 * **中文键** `选题`，每项标题字段是 `选题标题`（2026-10-19 实测）。旧实现只认
 * `raw.topics`，取不到就 `Array.isArray(...) ? ... : []` 静默清空 —— ideate 任务
 * 被标记为 done 却一条没插，定时创作从此每天空转，界面上完全看不出来。
 *
 * 这里按「数组候选键 × 标题候选字段」两级容错，并兜底嵌套一层与「顶层单条」。
 */
function extractTopics(raw: unknown): Array<{ title: string; angle: string; brief: string }> {
  const out: Array<{ title: string; angle: string; brief: string }> = [];
  if (!raw || typeof raw !== 'object') return out;
  const root = raw as Record<string, unknown>;

  const ARRAY_KEYS = ['topics', '选题', '选题列表', 'list', 'items', 'data', 'result'];
  const TITLE_KEYS = ['title', '选题标题', '标题', 'topic', 'name'];
  const ANGLE_KEYS = ['angle', '切入角度', '角度'];
  const BRIEF_KEYS = ['brief', '内容要求', '说明', '核心创意', 'desc', 'description'];

  const pickStr = (obj: Record<string, unknown>, keys: string[]): string => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };

  for (const k of ARRAY_KEYS) {
    if (!Array.isArray(root[k])) continue;
    for (const item of root[k] as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const title = pickStr(o, TITLE_KEYS);
      if (!title) continue;
      out.push({ title, angle: pickStr(o, ANGLE_KEYS), brief: pickStr(o, BRIEF_KEYS) });
    }
    if (out.length > 0) return out;
  }

  // 兜底一：嵌套一层（{data:{topics:[...]}} / {result:{选题:[...]}}）
  for (const v of Object.values(root)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = extractTopics(v);
      if (nested.length > 0) return nested;
    }
  }
  // 兜底二：顶层本身就是一条选题
  const single = pickStr(root, TITLE_KEYS);
  if (single) return [{ title: single, angle: pickStr(root, ANGLE_KEYS), brief: pickStr(root, BRIEF_KEYS) }];
  return out;
}

export async function ideateTopics(sourceId: number, count = 6): Promise<Array<{ title: string; angle: string; brief: string }>> {
  const profile = getStyleProfile(sourceId)?.profile ?? null;

  /**
   * ⚠️ 这里喂给模型的东西决定了选题质量的上限。
   *
   * 旧实现只给「一句 one_liner + 6 个题材名 + 60 条已写标题（并注明"避免重复"）」。
   * 结果模型把它当"泛互联网内容"的选题提示去写，产出了一堆运营/流量/搜索题
   * （2026-10-19 实测：换8个访问问题、搜索占位信号、内容排期…），
   * 与这位品牌设计博主的业务完全无关 —— 全是废稿。
   *
   * 现在补三样真正管用的东西：
   *   1. **爆款样稿**（按互动量排序的真实笔记）—— 让模型照着真实高互动写法写，
   *      而不是照着自己的"互联网选题直觉"写；
   *   2. **题材池从"参考"升为"必须落在的池子"**；
   *   3. **反例**（明确写出上次跑偏成什么样）—— 正例告诉它怎么写，反例告诉它别写什么。
   */
  const topNotes = all<{ id: number; title: string; liked_count: number; image_count: number }>(
    'SELECT id, title, liked_count, image_count FROM notes WHERE source_id = ? ORDER BY liked_count DESC LIMIT 10',
    sourceId,
  );
  const avgLike = get<{ c: number }>('SELECT ROUND(AVG(liked_count)) AS c FROM notes WHERE source_id = ?', sourceId)?.c ?? 0;

  const winners = topNotes
    .map((n) => `- ${n.title}（${n.liked_count} 赞 / 均值 ${avgLike} / ${n.image_count} 图）`)
    .join('\n');

  const recent = all<{ title: string; tags: string }>(
    'SELECT title, tags FROM notes WHERE source_id = ? ORDER BY published_at DESC LIMIT 30',
    sourceId,
  );
  const history = recent
    .map((n) => {
      let tags: string[] = [];
      try {
        tags = JSON.parse(n.tags || '[]');
      } catch {
        /* 坏 JSON 不该让整个选题失败 */
      }
      return `- ${n.title} [${tags.slice(0, 3).join(',')}]`;
    })
    .join('\n');

  // 题材池：优先用画像里的分布，没有就用标签统计
  const categories = profile?.persona?.content_categories ?? [];
  const topicBlock = profile?.topic_map?.length
    ? profile.topic_map.map((t) => `- ${t.topic}（${t.note_count} 篇 / 均赞 ${t.avg_liked}）`).join('\n')
    : '（无历史分布）';

  const raw = await chatJson<Record<string, unknown>>({
    system: IDEATE_SYSTEM,
    user: [
      `【这位博主的身份】${profile?.persona.one_liner ?? '品牌营销与视觉设计博主'}`,
      `【目标人群】${profile?.persona?.audience ?? '品牌创始人、品牌主理人、电商运营负责人'}`,
      '',
      '【她的题材池 —— 每个新选题必须落在其中之一】',
      ...(categories.length ? categories.map((c) => `- ${c}`) : ['- 品牌定位与品牌调性', '- 视觉识别与设计系统', '- 品牌案例拆解', '- 情绪价值与消费心理']),
      '',
      '【题材的历史表现】',
      topicBlock,
      '',
      '【她的爆款样稿 —— 照着这个写法和命题颗粒度】',
      winners || '（无）',
      '',
      '【她最近写过的（避免重复，但可以从新角度切入）】',
      history || '（无）',
      '',
      '【反面教材 —— 上一次这样写全是废稿，不要重复这些方向】',
      '"换8个访问问题"、"搜索占位信号"、"内容别凭灵感日更先排期"、',
      '"AI一键做Logo品牌反而更难认"（这是工具评测，不是品牌命题）、',
      '以及任何关于流量、涨粉、投放、私域、SEO 的题目。',
      '',
      `【任务】产出 ${count} 个新选题，覆盖 2 个以上不同题材。`,
      '每条要求：',
      '  title — 20 字以内，提问句或判断句，具体到能配 5-8 张图',
      '  angle — 从哪个品牌命题切入',
      '  brief  — 这篇要讲清什么判断',
      '输出 JSON：{"topics":[{"title":"…","angle":"…","brief":"…"}]}',
    ].join('\n'),
    temperature: 0.9,
    maxTokens: 8_192,
  });

  // ⚠️ 模型不保证守 schema。这里必须**多形状容错**，而不是 `raw.topics`
  // 取不到就静默返回空数组 —— 那会让 ideate 任务「成功」但一条选题都没插入，
  // 定时创作于是每天空转，而界面上什么都看不出来（实测 2026-10-19：
  // MiniMax 返回的是中文键 `选题`，不是约定的 `topics`）。
  const topics = extractTopics(raw);

  if (topics.length === 0) {
    const keys = raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 8).join(',') : typeof raw;
    throw new Error(
      `选题生成失败：模型返回里没有可用的选题数组（顶层键：${keys}）。` +
        '这是解析问题而不是模型没产出，需要扩展 extractTopics 的容错形状。',
    );
  }
  if (topics.length < count) {
    logger.warn({ want: count, got: topics.length }, '选题产出少于请求数量');
  }

  /**
   * 落库前自检：废稿在**进池子之前**就该被拦下，而不是等创作完、渲染完，
   * 出现在草稿审核页里让人去挑。
   *
   * 三道检查：
   *   1. `[[ ]]` 渲染标记泄漏（实测出现过「新品包装，[[5秒]]能卖货吗？」）
   *   2. 跑偏题：流量/涨粉/投放/私域/SEO 等与品牌业务无关的关键词
   *   3. 与语料已有标题高度重复
   * 被拦下的会丢弃并在日志里说明原因；全被拦下则抛错（不静默返回空）。
   */
  const existingTitles = new Set(
    all<{ title: string }>('SELECT title FROM notes WHERE source_id = ?', sourceId).map((r) => r.title),
  );
  const OFF_TOPIC = /涨粉|流量增长|投放|私域|SEO|搜索排名|关键词布局|账号定位怎么做|短视频起号|直播话术|小红书运营技巧|如何引流/;

  /**
   * 近似重复检测。
   *
   * 之前只做**完全相同**的判重（existingTitles 是 Set），所以下面这些全都进来了：
   *   - 「主理人IP和品牌IP先做哪个」/「主理人IP和品牌IP，先做哪个？」/「主理人IP和品牌IP先做哪个」
   *     —— 三个标题只差标点
   *   - 「为什么出圈的新品牌，都不太像品牌」/「为什么出圈的品牌，都不太像品牌了」
   *     —— 二元组相似度 0.73
   *
   * 实测语料内部最高相似度只有 0.26，而成稿之间能到 0.73~1.00，
   * 所以阈值取 **0.62** 落在两者之间，既拦得住改标点的重复，
   * 又不会误杀语料里正常的不同命题。
   *
   * 比对范围不只语料，还有**近期成稿** —— 语料是别人写的，成稿是我们自己写的，
   * 「我们连着写了三篇几乎一样的」才是最该被拦下的。
   */
  const recentDraftTitles = all<{ title: string }>(
    'SELECT title FROM drafts WHERE source_id = ? ORDER BY id DESC LIMIT 40',
    sourceId,
  ).map((r) => r.title);
  const nearTitles = [...existingTitles, ...recentDraftTitles];

  const accepted: Array<{ title: string; angle: string; brief: string }> = [];
  const rejected: Array<{ title: string; why: string }> = [];

  for (const t of topics) {
    const title = t.title.trim();
    if (!title) continue;

    if (/\[\[|\]\]/.test(title)) {
      rejected.push({ title, why: '含渲染标记 [[]]' });
      continue;
    }
    if (OFF_TOPIC.test(title)) {
      rejected.push({ title, why: '与品牌业务无关的运营类题目' });
      continue;
    }
    if (existingTitles.has(title)) {
      rejected.push({ title, why: '与语料已有标题完全重复' });
      continue;
    }
    // 与已接受过的选题之间也要查 —— 同一次生成里的两个近似题同样会变成两篇雷同稿
    const near = nearTitles.find((other) => titleSimilarity(title, other) >= TITLE_NEAR_DUP_THRESHOLD);
    if (near) {
      rejected.push({ title, why: `与已有标题近似：「${near}」` });
      continue;
    }
    accepted.push({ ...t, title });
  }

  if (rejected.length > 0) {
    logger.warn({ rejected }, 'ideate 自检拦下不合格选题');
  }
  if (accepted.length === 0) {
    throw new Error(
      `选题全部未通过自检（${rejected.length} 条被拦：${rejected.slice(0, 3).map((r) => `${r.title}（${r.why}）`).join('；')}）。` +
        '不落库空池 —— 否则定时创作会继续空转。',
    );
  }

  const inserted: Array<{ title: string; angle: string; brief: string }> = [];

  for (const t of accepted.slice(0, count)) {
    run(
      `INSERT INTO topics(source_id, title, angle, brief, origin) VALUES (?,?,?,?, 'ai')`,
      sourceId,
      String(t.title).slice(0, 100),
      String(t.angle ?? ''),
      String(t.brief ?? ''),
    );
    inserted.push({ title: t.title, angle: t.angle ?? '', brief: t.brief ?? '' });
  }

  return inserted;
}

/** 从待办选题里取一个来创作。 */
export function claimTopic(sourceId: number): { id: number; title: string; angle: string; brief: string } | null {
  const row = get<{ id: number; title: string; angle: string; brief: string }>(
    `SELECT id, title, angle, brief FROM topics
     WHERE source_id = ? AND status = 'open'
     ORDER BY (origin = 'manual') DESC, id ASC LIMIT 1`,
    sourceId,
  );
  if (!row) return null;
  run("UPDATE topics SET status = 'queued' WHERE id = ?", row.id);
  return row;
}

export async function composeNextDraft(sourceId: number, brand = ''): Promise<ComposeResult | null> {
  const topic = claimTopic(sourceId);
  if (!topic) {
    logger.info({ sourceId }, '没有待创作选题');
    return null;
  }
  try {
    const res = await composeDraft({
      sourceId,
      topic: topic.title,
      angle: topic.angle,
      brief: topic.brief,
      brand,
    });
    run("UPDATE topics SET status='used', used_at=datetime('now') WHERE id = ?", topic.id);
    return res;
  } catch (err) {
    run("UPDATE topics SET status='open' WHERE id = ?", topic.id);
    throw err;
  }
}