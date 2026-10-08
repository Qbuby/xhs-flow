const UA = { 'User-Agent': 'xhsflow/0.1' };
// Wikimedia Commons：先搜文件，再取原图直链
const api = 'https://commons.wikimedia.org/w/api.php';
const q = new URLSearchParams({
  action:'query', generator:'search', gsrsearch:'file: coffee latte', gsrnamespace:'6',
  gsrlimit:'4', prop:'imageinfo', iiprop:'url|size|mime', iiurlwidth:'1080', format:'json', origin:'*',
});
const r = await fetch(`${api}?${q}`, { headers: UA });
const j = await r.json();
const pages = Object.values(j.query?.pages ?? {});
console.log('命中文件数:', pages.length);
for (const p of pages) {
  const ii = p.imageinfo?.[0];
  if (!ii) continue;
  console.log(` ${p.title.replace('File:','').slice(0,40)}`);
  console.log(`   ${ii.mime} ${ii.width}x${ii.height} thumb=${!!ii.thumburl}`);
  console.log(`   url=${(ii.url||'').slice(0,95)}`);
}
