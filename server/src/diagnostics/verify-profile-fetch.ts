/**
 * 用当前登录态验证「作者主页 → 全量笔记」链路。
 *
 * 这是 M1 最后一块拼图：user_posted 是全行业公认脆弱的端点
 * （redbook 社区报过 code:-1），之前没有登录态一直没跑过真数据。
 *
 *   node server/dist/diagnostics/verify-profile-fetch.js
 */
import { chromium } from 'playwright';
import { PROFILE_DIR } from '../config.js';
import { XHS_ORIGIN } from '../xhs/browser.js';
import { probeSigner, sign, resetSigner } from '../xhs/signing.js';

const API = 'https://edith.xiaohongshu.com';

async function main(): Promise<void> {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();

  try {
    await page.goto(`${XHS_ORIGIN}/explore`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(5000);

    resetSigner();
    const st = await probeSigner(page);
    if (!st.ready) throw new Error(`签名器不可用：${st.diagnostic}`);
    console.log('✓ 签名器就绪');

    /* --- 1. 拿当前账号 --- */
    const mePath = '/api/sns/web/v2/user/me';
    const meSig = await sign(page, mePath);
    const meRes = await ctx.request.fetch(`${API}${mePath}`, {
      headers: { ...meSig!, Accept: 'application/json', Referer: `${XHS_ORIGIN}/` },
      timeout: 30_000,
      failOnStatusCode: false,
    });
    const meBody = await meRes.text();
    const meJson = JSON.parse(meBody);
    if (!meJson.success) throw new Error(`user/me 失败：code=${meJson.code} msg=${meJson.msg}`);
    const basic = meJson.data.basic_info ?? {};
    const userId = String(meJson.data.user_id ?? basic.redId ?? '');
    console.log(`✓ 当前账号: ${basic.nickname ?? '(未知)'}  user_id=${userId}`);

    /* --- 2. 作者主页作品列表（两套端点都试）--- */
    const paths = ['/api/sns/web/v1/user_posted', '/api/sns/web/v1/user/posted'];
    let listed: any[] | null = null;
    let usedPath = '';

    for (const p of paths) {
      const qs = `num=30&cursor=&user_id=${userId}&image_formats=jpg,webp,avif`;
      const sig = await sign(page, `${p}?${qs}`);
      if (!sig) {
        console.log(`  ✗ ${p} —— 签名失败`);
        continue;
      }
      const full = `${API}${p}?${qs}`;
      const r2 = await ctx.request.fetch(full, {
        headers: { ...sig, Accept: 'application/json', Referer: `${XHS_ORIGIN}/` },
        timeout: 30_000,
        failOnStatusCode: false,
      });
      const body = await r2.text();
      console.log(`  → ${p} HTTP ${r2.status()}`);
      try {
        const j = JSON.parse(body);
        const notes = j?.data?.notes ?? j?.data?.noteCards ?? [];
        console.log(`     success=${j.success} code=${j.code} msg=${j.msg} notes=${notes.length} has_more=${j?.data?.has_more}`);
        if (notes.length > 0) {
          listed = notes;
          usedPath = p;
          break;
        }
      } catch {
        console.log(`     非 JSON：${body.slice(0, 120)}`);
      }
    }

    if (!listed) {
      console.log('\n✗ 两套端点都没拿到作品列表');
      await ctx.close();
      process.exit(2);
    }

    console.log(`\n✓ ${usedPath} 返回 ${listed.length} 条`);
    const sample = listed.slice(0, 3).map((n: any) => {
      const c = n.noteCard ?? n;
      return {
        noteId: c.noteId ?? c.note_id,
        type: c.type,
        title: (c.interactInfo?.likedCount ?? '?') + '赞',
        imgs: (c.imageList ?? []).length,
        hasToken: Boolean(c.xsecToken),
      };
    });
    console.table(sample);

    /* --- 3. 单篇详情 --- */
    const first = listed[0].noteCard ?? listed[0];
    const noteId = first.noteId ?? first.note_id;
    const token = first.xsecToken ?? '';
    const feedPath = '/api/sns/web/v1/feed';
    const feedBody = JSON.stringify({
      source_note_id: noteId,
      image_formats: 'jpg,webp,avif',
      extra: { need_body_topic: 1 },
      xsec_token: token,
    });
    const feedSig = await sign(page, feedPath, feedBody);
    if (feedSig) {
      const r = await ctx.request.fetch(`${API}${feedPath}`, {
        method: 'POST',
        headers: { ...feedSig, 'Content-Type': 'application/json;charset=UTF-8', Referer: `${XHS_ORIGIN}/` },
        data: feedBody,
        timeout: 30_000,
        failOnStatusCode: false,
      });
      const body = await r.text();
      console.log(`\n→ POST /feed HTTP ${r.status()}`);
      try {
        const j = JSON.parse(body);
        const items = j?.data?.items ?? [];
        const note = items[0]?.note_card ?? items[0];
        console.log(`   success=${j.success} code=${j.code} msg=${j.msg}`);
        if (note) {
          console.log(`   ✓ 标题: ${note.title ?? note.display_title ?? '(无)'}`);
          console.log(`   ✓ 正文: ${String(note.desc ?? '').slice(0, 60)}…`);
          console.log(`   ✓ 图片: ${(note.image_list ?? []).length} 张`);
        }
      } catch {
        console.log(`   非 JSON：${body.slice(0, 150)}`);
      }
    }
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error('验证失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
