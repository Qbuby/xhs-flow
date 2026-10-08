const UA = { 'User-Agent': 'xhsflow/0.1' };
async function head(name, url, asJson) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    const ct = res.headers.get('content-type') ?? '';
    if (asJson && ct.includes('json')) {
      const j = await res.json();
      console.log(`✓ ${name} (${Date.now()-t0}ms)`);
      return j;
    }
    console.log(`✓ ${name}: HTTP ${res.status} ${ct} ${Date.now()-t0}ms`);
    return null;
  } catch (e) {
    clearTimeout(timer);
    console.log(`✗ ${name}: ${String(e.message).slice(0,60)} ${Date.now()-t0}ms`);
    return null;
  }
}
console.log('--- DNS/连通性对照 ---');
await head('Pexels api   ', 'https://api.pexels.com/v1/search?query=coffee');
await head('LoremFlickr  ', 'https://loremflickr.com/320/240/coffee');
await head('Openverse    ', 'https://api.openverse.org/v1/images/?q=coffee&page_size=2');
await head('Wikimedia    ', 'https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=coffee&format=json&srlimit=2');
await head('Pixabay      ', 'https://pixabay.com/api/?key=test&q=coffee');
