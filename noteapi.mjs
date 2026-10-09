import { harvestNoteList } from './server/dist/xhs/scrape-browser.js';
import { browser } from './server/dist/xhs/browser.js';

const list = await harvestNoteList('68713e54000000001b018eda', 2);
console.log('列表:', list.length);

const ctx = await browser.ensureLaunched();
const page = await ctx.newPage();

const caught = [];
page.on('response', async (r) => {
  const u = r.url();
  if (!/edith\.xiaohongshu\.com\/api\/sns\/web/.test(u)) return;
  let j = null; try { j = await r.json(); } catch {}
  const item = j?.data?.items?.[0]?.note_card ?? j?.data?.items?.[0];
  caught.push({
    path: u.replace(/^https:\/\/edith\.xiaohongshu\.com/, '').split('?')[0],
    code: j?.code,
    hasItem: Boolean(item),
    title: item?.title?.slice(0, 26),
    imgs: (item?.image_list ?? []).length,
    liked: item?.interact_info?.liked_count,
  });
});

const n = list[0];
await page.goto(`https://www.xiaohongshu.com/explore/${n.noteId}?xsec_token=${n.xsecToken}&xsec_source=pc_user`,
  { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(9000);
const body = (await page.locator('body').innerText().catch(()=>'')).replace(/\s+/g,' ').slice(0,80);
console.log('页面:', body);
console.log('页面自己发的接口:');
caught.forEach(c => console.log(' ', JSON.stringify(c)));
await ctx.close();
