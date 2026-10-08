const UA = { 'User-Agent': 'xhsflow/0.1 (+local tool)' };

async function tryOne(name, url) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(url, { headers: UA, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    const ct = res.headers.get('content-type') ?? '';
    const ms = Date.now() - t0;
    if (ct.startsWith('image/')) {
      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`✓ ${name}: HTTP ${res.status} ${ct} ${(buf.length/1024).toFixed(0)}KB ${ms}ms`);
      console.log(`    最终URL: ${res.url.slice(0, 88)}`);
    } else {
      const t = (await res.text()).slice(0, 90).replace(/\s+/g, ' ');
      console.log(`✗ ${name}: HTTP ${res.status} ${ct || '(无type)'} ${ms}ms — ${t}`);
    }
  } catch (e) {
    console.log(`✗ ${name}: ${String(e.message).slice(0, 70)} ${Date.now()-t0}ms`);
  }
}

console.log('--- 图片直链（免 key）---');
await tryOne('LoremFlickr  ', 'https://loremflickr.com/1080/1440/coffee,desk');
await tryOne('Picsum       ', 'https://picsum.photos/1080/1440');
await tryOne('Placehold.co ', 'https://placehold.co/1080x1440.jpg');

console.log('\n--- 搜索 API ---');
try {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  const r = await fetch('https://api.openverse.org/v1/images/?q=coffee&page_size=3', { headers: UA, signal: ctrl.signal });
  clearTimeout(timer);
  const j = await r.json();
  console.log(`✓ Openverse: ${j.result_count} 条`);
  (j.results || []).slice(0,3).forEach(x => console.log(`    ${String(x.title).slice(0,28)} | ${x.license} | ${x.url.slice(0,60)}`));
} catch (e) { console.log('✗ Openverse:', String(e.message).slice(0, 70)); }
