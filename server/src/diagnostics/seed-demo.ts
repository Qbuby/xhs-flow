/**
 * 演示数据播种。
 *
 * 用途：在**不碰小红书**的前提下，把「蒸馏 → 创作 → 渲染 → 审核」整条管线跑通。
 * 账号被风控时没法抓真语料，但除抓取外的所有环节都该能独立验收。
 *
 * 数据全部是合成的，source 会明确标成「[演示]」，不会和真实语料混淆。
 *
 *   npm run seed:demo      播种
 *   npm run seed:reset     清掉演示数据
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { PROFILE_DIR, MEDIA_DIR } from '../config.js';
import { run, get, all, db, transaction } from '../db/index.js';
import { browser } from '../xhs/browser.js';
import { renderCard, DEFAULT_SPEC, type Card } from '../generate/cards.js';
import sharp from 'sharp';
import { logger } from '../logger.js';

const DEMO_MARK = '[演示]';

interface DemoNote {
  title: string;
  desc: string;
  tags: string[];
  liked: number;
  color: string;
  accent: string;
}

const NOTES: DemoNote[] = [
  {
    title: '厨房只有3㎡，我把台面空出了一半',
    desc:
      '改造前每次做饭都要挪三样东西，锅都不敢常年摆着。\n\n' +
      '我只改了三件事：灶台往里推 15cm、上方加一排挂杆、把调料全部换成统一规格。\n' +
      '操作台立刻多出 40cm，调料从五层抽屉压缩到一层。\n\n' +
      '真别买免打孔置物架，承重差，我被砸过脚。\n' +
      '唯一回购的是磁吸刀架。\n\n' +
      '预算 2000 以内，住了一年半，现在还是这么顺手。',
    tags: ['小户型', '厨房改造', '收纳', '家居', '租房改造', '断舍离'],
    liked: 12800,
    color: '#FFF6EE',
    accent: '#E8604C',
  },
  {
    title: '花2000块，把出租屋厨房改到房东都问我要链接',
    desc:
      '预算卡死在 2000，不能动硬装，全部靠可拆卸方案。\n\n' +
      '· 台面：贴一次性贴膜，30 块\n' +
      '· 收纳：统一换成同款透明盒，视觉立刻整齐\n' +
      '· 光线：加一条磁吸灯带，120 块\n\n' +
      '最值的不是收纳盒，是那条灯带。晚上做饭的时候差别巨大。\n\n' +
      '退租时全部拆下来带走，房东没意见。',
    tags: ['出租屋', '租房改造', '厨房', '预算', '家居好物'],
    liked: 8900,
    color: '#F2F7F4',
    accent: '#4C8C7A',
  },
  {
    title: '这5样厨房收纳，我劝你别买',
    desc:
      '都是血泪。\n\n' +
      '1. 免打孔置物架 —— 承重差，掉下来砸过脚\n' +
      '2. 网红分层收纳盒 —— 尺寸全是一个模子，买回来全是浪费\n' +
      '3. 折叠沥水篮 —— 洗一次就卡住\n' +
      '4. 台面小推车 —— 占地方，拿东西还得弯腰\n' +
      '5. 硅胶隔热垫 —— 一周就发黄\n\n' +
      '真正常回购的只有磁吸刀架和一个挂钩。收纳不是买得多，是买得准。',
    tags: ['避坑', '厨房收纳', '家居好物', '断舍离'],
    liked: 23400,
    color: '#FDF2F0',
    accent: '#D1483A',
  },
  {
    title: '装修第三年，我终于承认台面留空是对的',
    desc:
      '以前我以为厨房要"塞满"才叫充分利用。\n\n' +
      '住久了才发现，真正高频用的就那几样：锅、铲、砧板、调料。剩下的全是"以防万一"，然后永远不用。\n\n' +
      '现在台面常年只留当天要用的，洗完立刻收。\n\n' +
      '差别不在收纳盒，在有没有做减法。',
    tags: ['家居', '断舍离', '厨房', '生活方式'],
    liked: 15600,
    color: '#FBF7F0',
    accent: '#B07D4A',
  },
  {
    title: '30㎡出租屋，我用3个盒子解决全部收纳',
    desc:
      '搬家第4次了，终于总结出一套不用动墙的方案。\n\n' +
      '所有东西只分三类：用得上 / 用不上 / 不知道。\n' +
      '"用不上"当场扔，"不知道"全部堆到一个月后再看一次。\n\n' +
      '剩下的统一换成同款透明盒，视觉上立刻安静。\n\n' +
      '盒子不用买贵的，尺寸统一比什么都重要。',
    tags: ['出租屋', '收纳', '断舍离', '搬家', '小户型'],
    liked: 6700,
    color: '#F5F3EF',
    accent: '#6B7A8F',
  },
  {
    title: '把厨房灯带换掉之后，我开始天天做饭',
    desc:
      '之前一直不太想做饭，理由是"太暗了看不清"。\n\n' +
      '换了条磁吸灯带，直接粘在吊柜底下，120 块。\n' +
      '同一个厨房，体感完全不同。\n\n' +
      '真的，灯光对做家务这件事的影响被严重低估了。',
    tags: ['厨房', '灯光', '家居好物', '出租屋', '氛围感'],
    liked: 11200,
    color: '#FFF8E7',
    accent: '#E0A03C',
  },
  {
    title: '我把调料瓶全换了，厨房直接清空一半',
    desc:
      '起因是发现灶台上有11种调料，其中6种一个月没动过。\n\n' +
      '统一规格这一步做了三遍：\n' +
      '· 全部换成同一种方瓶，能摞起来\n' +
      '· 只留高频的6种，其余送人\n' +
      '· 立着放在灶台右侧固定位置，不许放别处\n\n' +
      '台面直接空出一半，做菜顺手很多。',
    tags: ['厨房', '收纳', '断舍离', '台面'],
    liked: 9800,
    color: '#FDF6F3',
    accent: '#C96A54',
  },
  {
    title: '厨房好不好用，先看动线别看颜值',
    desc:
      '装修那会儿花了90%的精力在台面材质上，忽略了动线。\n\n' +
      '现在复盘，正确顺序应该是：\n' +
      '洗 → 切 → 炒 → 盛，四个动作要在同一条线上完成。\n' +
      '我后来把冰箱挪了位置，动线顺了，做饭时间少了大概十分钟。\n\n' +
      '丑一点没关系，别让人在厨房里来回转身。',
    tags: ['厨房', '装修', '动线', '家居', '经验分享'],
    liked: 7400,
    color: '#F4F6F4',
    accent: '#5A8C7B',
  },
  {
    title: '扔东西这件事，我是彻底戒不掉了',
    desc:
      '从去年开始扔东西，现在已经变成习惯。\n\n' +
      '但有两个坑：\n' +
      '· 别在半夜扔，会越想越多，第二天全买回来\n' +
      '· 别囤"以后可能用"，这个"以后"基本不会来\n\n' +
      '上个月扔了三大袋，看着空了很多，其实什么都没少。\n\n' +
      '空间这个东西，扔一次才知道有多少。',
    tags: ['断舍离', '生活方式', '极简', '收纳'],
    liked: 21000,
    color: '#FDF2F5',
    accent: '#B0577F',
  },
  {
    title: '出租屋改造 | 2000块的完整清单和踩坑',
    desc:
      '清单在评论区，先说踩坑：\n\n' +
      '灯带买短了 30cm，退货又花了 15 块运费。\n' +
      '收纳盒买了两种尺寸，最后多出一半没用上。\n' +
      '挂钩承重虚标，挂了 3 天自己掉下来。\n\n' +
      '教训：所有尺寸先量再买，别看图省事。',
    tags: ['出租屋', '改造', '清单', '踩坑', '预算'],
    liked: 13500,
    color: '#F2F4F8',
    accent: '#4A6B9C',
  },
  {
    title: '厨房台面永远空着的人，后来都怎么样了',
    desc:
      '观察了身边十几位保持台面空的人，两年后有三个共同点：\n\n' +
      '· 做饭频率明显变高\n' +
      '· 外卖次数大幅下降\n' +
      '· 收拾厨房的时间减半\n\n' +
      '不是自律，是台面空着之后，"先收拾一下再做饭"这个心理负担直接没了。\n\n' +
      '环境真的会反过来塑造行为。',
    tags: ['厨房', '生活方式', '台面', '收纳', '习惯'],
    liked: 17800,
    color: '#FBF8F1',
    accent: '#9A7B4F',
  },
  {
    title: '半年没买任何收纳用品，我的厨房反而更整齐了',
    desc:
      '记录一下。\n\n' +
      '1月：冲动买了6个收纳盒\n' +
      '2月：发现两个根本没用，送给同事\n' +
      '4月：又买了一个，这次是量好尺寸才买的\n' +
      '6月：唯一还在用的是那个透明长盒\n\n' +
      '半年下来净增一个盒子。\n\n' +
      '收纳这件事，买十次退八次才是常态。',
    tags: ['收纳', '家居好物', '极简', '断舍离', '年度总结'],
    liked: 10600,
    color: '#F0F5F3',
    accent: '#3F8574',
  },
];

/* ------------------------------------------------------------------ */

async function resetDemo(): Promise<void> {
  const rows = all<{ id: number }>(`SELECT id FROM sources WHERE nickname LIKE ?`, `%${DEMO_MARK}%`);
  for (const r of rows) {
    run('DELETE FROM sources WHERE id = ?', r.id);
  }
  logger.info({ removed: rows.length }, '演示数据已清除');
  console.log(`已清除 ${rows.length} 个演示语料源`);
}

async function seed(): Promise<void> {
  // 先清掉旧的
  await resetDemo();

  const profileUrl = `https://demo.local/${DEMO_MARK}sample`;
  const ins = run(
    `INSERT INTO sources(profile_url, nickname, status, red_id, note_count)
     VALUES (?, ?, 'active', 'demo0000000000000000000000', ?)`,
    profileUrl,
    `${DEMO_MARK} 厨房收纳笔记`,
    NOTES.length,
  );
  const sourceId = Number(ins.lastInsertRowid);

  // 让渲染器复用同一个浏览器上下文
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    locale: 'zh-CN',
    viewport: { width: 1080, height: 1440 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  (browser as unknown as { ctx: unknown }).ctx = ctx;

  const outDir = path.join(MEDIA_DIR, 'corpus', `demo-${sourceId}`);
  await fs.mkdir(outDir, { recursive: true });

  console.log(`播种 ${NOTES.length} 篇演示笔记到 source #${sourceId} …`);

  for (const [i, n] of NOTES.entries()) {
    const noteIns = run(
      `INSERT INTO notes(source_id, note_id, url, type, title, desc, tags,
         published_at, liked_count, collected_count, comment_count, share_count, image_count)
       VALUES (?,?,?, 'normal', ?,?,?,?,?,?,?,?, 3)`,
      sourceId,
      `demo${String(i + 1).padStart(22, '0')}`,
      `https://demo.local/explore/demo${i + 1}`,
      n.title,
      n.desc,
      JSON.stringify(n.tags),
      Date.now() - (NOTES.length - i) * 5 * 24 * 3600 * 1000,
      n.liked,
      Math.round(n.liked * 0.42),
      Math.round(n.liked * 0.06),
      Math.round(n.liked * 0.03),
    );
    const notePk = Number(noteIns.lastInsertRowid);

    // FTS 索引
    transaction(() => {
      run('DELETE FROM notes_fts WHERE rowid = ?', notePk);
      run('DELETE FROM notes_fts_map WHERE rowid = ?', notePk);
      run('INSERT INTO notes_fts(rowid, title, desc, tags) VALUES (?,?,?,?)', notePk, n.title, n.desc, n.tags.join(' '));
      run('INSERT INTO notes_fts_map(rowid, note_pk) VALUES (?,?)', notePk, notePk);
    });

    // 用我们自己的渲染器生成 3 张「笔记配图」——既是占位，也是给渲染器再做一次回归
    const spec = { ...DEFAULT_SPEC, background: n.color, accent: n.accent };
    const cards: Card[] = [
      {
        layout: 'cover',
        blocks: {
          eyebrow: n.tags[0] ?? '',
          title: n.title,
          items: n.tags.slice(1, 4),
          hint: '',
          watermark: String(i + 1).padStart(2, '0'),
        },
      },
      {
        layout: 'list',
        blocks: {
          eyebrow: '正文要点',
          title: n.title.split('，')[0] ?? n.title,
          items: n.desc
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s.length > 4)
            .slice(0, 5)
            .map((s) => ({ text: s.slice(0, 22) })),
        },
      },
      {
        layout: 'photo_text',
        blocks: { title: n.title.split('，')[0] ?? n.title, subtitle: n.tags.join(' · ') },
      },
    ];

    for (const [idx, card] of cards.entries()) {
      try {
        const file = await renderCard(card, { sourceId: null, outputDir: outDir });
        const buf = await fs.readFile(file);
        const meta = await sharp(buf).stats();
        const bright = meta.channels.map((c) => c.mean).reduce((a, b) => a + b, 0) / 255 / 3;
        const info = await sharp(buf).metadata();
        run(
          `INSERT INTO note_images(note_id, idx, remote_url, local_path, width, height, bytes, palette, brightness, is_cover)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          notePk,
          idx,
          `demo://${i}/${idx}`,
          file,
          info.width ?? 1080,
          info.height ?? 1440,
          buf.length,
          JSON.stringify([
            { hex: n.color, weight: 0.62 },
            { hex: n.accent, weight: 0.24 },
            { hex: '#FFFFFF', weight: 0.14 },
          ]),
          bright,
          idx === 0 ? 1 : 0,
        );
      } catch (err) {
        logger.warn({ err, i, idx }, '演示配图渲染失败，跳过');
      }
    }

    console.log(`  ✓ [${i + 1}/${NOTES.length}] ${n.title}`);
  }

  // 一个演示选题，让「创作」按钮有东西可用
  run(
    `INSERT INTO topics(source_id, title, angle, brief, origin)
     VALUES (?,?,?,?, 'manual')`,
    sourceId,
    '厨房台面为什么一定要留空',
    '从「环境反过来塑造行为」的角度切入',
    '用我自己一年台面从未被占满的经历做证据，给出可执行的三步',
  );
  run(
    `INSERT INTO topics(source_id, title, angle, brief, origin)
     VALUES (?,?,?,?, 'ai')`,
    sourceId,
    '2000块改造出租屋厨房，哪些钱可以省',
    '逐项标注「值/不值」，把预算花在刀刃上',
    '',
  );

  await ctx.close().catch(() => undefined);
  (browser as unknown as { ctx: unknown }).ctx = null;

  console.log(`
✓ 演示数据就绪（source #${sourceId}）

接下来可以试：
  1. 打开「语料库」→ 点进这个演示作者
  2. 点「蒸馏语料」   —— 需要配置模型 key
  3. 点「立即创作」   —— 需要配置模型 key
  4. 到「草稿审核」看卡片大图

清掉演示数据：npm run seed:reset
`);
}

const mode = process.argv[2] ?? 'seed';
if (mode === 'reset') {
  resetDemo().finally(() => db.close());
} else {
  seed()
    .catch((err) => {
      console.error('播种失败：', err);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}
