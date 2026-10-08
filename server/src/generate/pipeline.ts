import { z } from 'zod';
import { run, get, all } from '../db/index.js';
import { chatJson } from '../llm/client.js';
import { getStyleProfile, type StyleProfile } from '../corpus/profile.js';
import { retrieveWithFallback, type RetrievedNote } from '../corpus/retrieve.js';
import { logger } from '../logger.js';
import { MEDIA_DIR } from '../config.js';
import { renderCards, type Card, type Layout, LAYOUTS } from './cards.js';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* 生成契约                                                            */
/* ------------------------------------------------------------------ */

const CardSchema = z.object({
  layout: z.enum(LAYOUTS),
  blocks: z.record(z.any()),
  photoQuery: z.string().optional().describe('photo_text 版式用的配图检索词，中文即可'),
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

铁律：
1. 标题必须 ≤20 个字符（小红书会截断），要有钩子但不能标题党。
2. 卡片文案要口语化、有节奏、能独立成立，不要写成说明书。
3. 关键词要打成 [[方括号]] 标记强调，渲染器会把它变成高亮样式。
4. 必须严格遵守 do_list / dont_list。
5. 只输出 JSON。`;

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
    `- 每百字 emoji 数：${profile.language.emoji_per_100_chars}`,
    `- 口头禅：${profile.language.signature_phrases.join('、')}`,
    `- 开头套路：${profile.language.opening_patterns.join('；')}`,
    `- 结尾套路：${profile.language.ending_patterns.join('；')}`,
    `- 修辞：${profile.language.rhetoric.join('、')}`,
    `- 话题标签策略：${profile.hashtag_strategy.count_range} 个，${profile.hashtag_strategy.mix}`,
    '',
    `- 常用图片版式：${profile.visual.dominant_layouts.join('、')}`,
    `- 封面套路：${profile.visual.cover_patterns.join('；')}`,
    `- 配色：${profile.visual.palette_summary}（主色 ${c.palette.join('、')}）`,
    '',
    '【必须做】',
    ...profile.do_list.map((d) => `    ✓ ${d}`),
    '',
    '【必须避免】',
    ...profile.dont_list.map((d) => `    ✗ ${d}`),
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
  "body": "完整正文，1000 字以内，可含 #话题",
  "tags": ["话题1", "话题2"],
  "cards": [
    { "layout": "cover", "blocks": { "eyebrow": "短标签", "title": "主标题，用 [[强调]]", "items": ["短句1", "短句2"], "hint": "引导语" } },
    { "layout": "quote", "blocks": { "text": "金句", "note": "补充解释", "attribution": "出处" } },
    { "layout": "list", "blocks": { "eyebrow": "重点", "title": "标题", "items": [{ "text": "要点", "note": "补充" }] } },
    { "layout": "steps", "blocks": { "eyebrow": "怎么做", "title": "标题", "items": [{ "text": "步骤", "note": "说明" }] } },
    { "layout": "compare", "blocks": { "eyebrow": "对比", "title": "标题", "left": { "title": "A", "items": ["…"] }, "right": { "title": "B", "items": ["…"] }, "conclusion": "结论" } },
    { "layout": "photo_text", "blocks": { "title": "标题", "subtitle": "副标题", "photoQuery": "配图检索词" } },
    { "layout": "cta", "blocks": { "emoji": "👋", "title": "标题", "action": "引导语" } }
  ]
}`;

export interface ComposeResult {
  draftId: number;
  title: string;
  cards: number;
  rendered: number;
}

export async function composeDraft(opts: {
  sourceId: number;
  topic: string;
  angle?: string;
  brief?: string;
  brand?: string;
  cardCount?: number;
}): Promise<ComposeResult> {
  const { sourceId, topic, angle, brief, brand = '', cardCount = 7 } = opts;

  const profile = getStyleProfile(sourceId)?.profile ?? null;
  const examples = retrieveWithFallback(`${topic} ${angle ?? ''}`, sourceId, 4);

  const user = [
    `【本次选题】${topic}`,
    angle ? `【切入角度】${angle}` : '',
    brief ? `【补充要求】${brief}` : '',
    brand ? `【品牌署名】页脚署名用「${brand}」` : '',
    `【卡片数量】${cardCount} 张，第 1 张必须 layout="cover" 作为封面，最后一张建议 layout="cta"。`,
    '',
    buildStyleBlock(profile),
    buildExamplesBlock(examples),
    '',
    '【每张卡片的内容要求】',
    '- cover：eyebrow(短标签)/title(主标题，用 [[强调]])/items(3-4 个短句)/hint(引导语)',
    '- quote：text(金句)/note(补充解释)/attribution(出处或"我")',
    '- list：title + items[{text, note}]，4-6 条',
    '- steps：title + items[{text, note}]，3-5 步',
    '- compare：title + left{title,items} + right{title,items} + conclusion',
    '- photo_text：title + subtitle + photoQuery(配图检索词，如 "咖啡 桌面")',
    '- cta：title + action(引导语) + emoji',
    '',
    '【最重要的要求】严格按下面这份 JSON 结构输出。',
    '每张卡片的文案字段必须**嵌套在 blocks 对象内**，不要平铺到卡片对象上。',
    '```json',
    DRAFT_TEMPLATE,
    '```',
    '',
    '现在输出 JSON。',
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await chatJson<Draft>({ system: SYSTEM, user, temperature: 0.85, maxTokens: 16_384 });


  const draft = coerceDraft(raw);

  /* --- 落库 --- */
  const ins = run(
    `INSERT INTO drafts(source_id, title, body, tags, status, ref_note_ids)
     VALUES (?,?,?,?, 'pending', ?)`,
    sourceId,
    draft.title.slice(0, 40),
    draft.body,
    JSON.stringify(draft.tags),
    JSON.stringify(examples.map((e) => e.notePk)),
  );
  const draftId = Number(ins.lastInsertRowid);

  const cards: Card[] = draft.cards.slice(0, 10).map((c) => ({
    layout: c.layout,
    blocks: { ...c.blocks, brand },
  }));

  cards.forEach((c, i) => {
    run(
      'INSERT INTO draft_cards(draft_id, idx, layout, content, photo_url) VALUES (?,?,?,?,?)',
      draftId,
      i,
      c.layout,
      JSON.stringify(c.blocks),
      c.blocks.photoQuery ? String(c.blocks.photoQuery) : null,
    );
  });

  const rendered = await renderDraftCards(draftId, sourceId);

  return { draftId, title: draft.title, cards: cards.length, rendered };
}

/** 模型偶尔不守 schema，这里硬兜底，保证下游渲染器拿到的形状永远是对的。 */
function coerceDraft(raw: Draft): Draft {
  const title = String(raw.title ?? '').trim().slice(0, 20) || '未命名笔记';
  const body = String(raw.body ?? '').trim().slice(0, 1000);
  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).replace(/^#/, '')).filter(Boolean) : [];

  let cards = Array.isArray(raw.cards) ? raw.cards : [];

  cards = cards.map((c, i) => {
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

    return { layout, blocks, photoQuery: c?.photoQuery };
  });

  // 封面必须有
  if (cards.length === 0 || cards[0]?.layout !== 'cover') {
    cards.unshift({
      layout: 'cover',
      blocks: { eyebrow: '', title, items: [], hint: '' },
    });
  }
  if (cards.length > 10) cards = cards.slice(0, 10);

  return { title, body, tags, cards };
}

/** 渲染某草稿的全部卡片并回写路径。 */
export async function renderDraftCards(draftId: number, sourceId: number | null): Promise<number> {
  const rows = all<{ id: number; layout: string; content: string; photo_url: string | null }>(
    'SELECT id, layout, content, photo_url FROM draft_cards WHERE draft_id = ? ORDER BY idx',
    draftId,
  );

  const outputDir = path.join(MEDIA_DIR, 'drafts', String(draftId));
  const cards: Card[] = rows.map((r) => {
    let blocks: Record<string, unknown> = {};
    try {
      blocks = JSON.parse(r.content) as Record<string, unknown>;
    } catch {
      /* 内容坏了就渲染成空卡 */
    }
    if (!blocks.photoQuery && r.photo_url) blocks.photoQuery = r.photo_url;
    return { layout: r.layout as Layout, blocks };
  });

  const paths = await renderCards(cards, { sourceId, outputDir });

  rows.forEach((r, i) => {
    const p = paths[i];
    if (p) run('UPDATE draft_cards SET image_path = ? WHERE id = ?', p, r.id);
  });

  if (paths.length) {
    run("UPDATE drafts SET rendered = 1, updated_at = datetime('now') WHERE id = ?", draftId);
  }
  return paths.length;
}

/* ------------------------------------------------------------------ */
/* 选题                                                                */
/* ------------------------------------------------------------------ */

const IDEATE_SYSTEM = `你是一位小红书选题策划。给定一个博主的风格档案和她的历史选题分布，
产出该博主"下一个阶段可能会写"的选题。

要求：
- 选题要能落地成 6-9 张图的图文，不能是纯文字感悟类
- 每个选题给出明确的切入角度
- 覆盖不同的内容类型，不要全是同一类
- 不要重复已有的老选题，除非能从新角度重做`;

export async function ideateTopics(sourceId: number, count = 6): Promise<Array<{ title: string; angle: string; brief: string }>> {
  const profile = getStyleProfile(sourceId)?.profile ?? null;

  const existing = all<{ title: string; tags: string }>(
    'SELECT title, tags FROM notes WHERE source_id = ? ORDER BY published_at DESC LIMIT 60',
    sourceId,
  );

  const history = existing
    .map((n) => `- ${n.title} [${JSON.parse(n.tags || '[]').slice(0, 4).join(',')}]`)
    .join('\n');

  const topicBlock = profile?.topic_map?.length
    ? profile.topic_map.map((t) => `- ${t.topic}（${t.note_count} 篇 / 均赞 ${t.avg_liked}）`).join('\n')
    : '（无历史分布）';

  const raw = await chatJson<{ topics: Array<{ title: string; angle: string; brief: string }> }>({
    system: IDEATE_SYSTEM,
    user: [
      `【博主风格】${profile?.persona.one_liner ?? '未知'}`,
      `【常做题材】${topicBlock}`,
      '',
      '【她已经写过的选题（避免重复）】',
      history || '（无）',
      '',
      `请产出 ${count} 个新选题。`,
    ].join('\n'),
    temperature: 0.9,
    maxTokens: 8_192,
  });

  const topics = Array.isArray(raw?.topics) ? raw.topics : [];
  const inserted: Array<{ title: string; angle: string; brief: string }> = [];

  for (const t of topics.slice(0, count)) {
    if (!t?.title) continue;
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