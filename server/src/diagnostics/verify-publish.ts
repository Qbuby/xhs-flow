/**
 * 发布链路自检 / 实发。
 *
 * 默认 dry run：走完整条链路（打开页面 → 传图 → 等解析 → 填标题 → 填正文 → 加话题）
 * 但**不点发布**。加 --live 才真的提交。
 *
 *   node server/dist/diagnostics/verify-publish.js 8          # 只到发布为止
 *   node server/dist/diagnostics/verify-publish.js 8 --live   # 真的发出去
 *
 * ⚠️ live 模式下会像调度器一样回写草稿状态（publishing → published/failed），
 *    否则界面上看不到这次发布的任何记录。
 */
import { publishNote, markPublishing, markPublishResult } from '../xhs/publish.js';
import { get, all } from '../db/index.js';

const draftId = Number(process.argv[2] ?? 8);
const live = process.argv.includes('--live');

function main(): void {
  const draft = get<{
    id: number;
    title: string;
    body: string;
    tags: string;
    source_id: number | null;
    status: string;
  }>('SELECT id, title, body, tags, source_id, status FROM drafts WHERE id = ?', draftId);

  if (!draft) {
    console.error(`草稿 ${draftId} 不存在`);
    process.exit(1);
  }

  const cards = all<{ image_path: string | null; idx: number; layout: string }>(
    `SELECT image_path, idx, layout FROM draft_cards
      WHERE draft_id = ? AND image_path IS NOT NULL ORDER BY idx`,
    draftId,
  );

  console.log('════════ 发布输入 ════════');
  console.log('草稿       :', draft.id, `(${draft.status})`);
  console.log('标题       :', draft.title);
  console.log('正文长度   :', draft.body.length, '字');
  console.log('标签       :', JSON.parse(draft.tags || '[]').join(' '));
  console.log('卡片       :', cards.length, `张 → ${cards.map((c) => c.layout).join(', ')}`);
  console.log('模式       :', live ? '⚠️  LIVE —— 会真的发布' : 'dry run —— 不点发布');
  console.log('');

  const imagePaths = cards.map((c) => c.image_path as string);

  // live 模式要和调度器一样先置 publishing，否则一旦中途异常，
  // 草稿会停在 pending，界面上看不出「正在发」
  if (live) markPublishing(draftId);

  publishNote({
    draftId,
    title: draft.title,
    body: draft.body,
    tags: JSON.parse(draft.tags || '[]') as string[],
    imagePaths,
    dryRun: !live,
  })
    .then((r) => {
      console.log('════════ 步骤 ════════');
      for (const s of r.steps ?? []) console.log('  ·', s);
      console.log('\n════════ 结果 ════════');
      console.log(JSON.stringify(r, null, 2));
      if (r.screenshot) console.log('截图 :', r.screenshot);

      // dry run 不碰状态；live 必须落库，否则发布记录里看不到这次
      if (live) {
        markPublishResult(draftId, r.ok, r.noteUrl, r.error);
        console.log(r.ok ? `\n已写入发布记录：${r.noteUrl}` : '\n已写入发布失败记录');
      }
      process.exit(r.ok || r.error === 'dryRun' ? 0 : 1);
    })
    .catch((err) => {
      if (live) markPublishResult(draftId, false, undefined, String(err));
      console.error('异常：', err);
      process.exit(1);
    });
}

main();
