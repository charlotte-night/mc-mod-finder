// End-to-end check against the running server (uses Node TLS since PowerShell's
// schannel is blocked in this environment).
const BASE = process.argv[2] || 'http://127.0.0.1:8765';

const j = async (path, init) => {
  const res = await fetch(BASE + path, init);
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) return { status: res.status, text: (await res.text()).slice(0, 200) };
  return { status: res.status, body: await res.json() };
};

const health = await j('/api/health');
console.log('GET /api/health      ->', health.status, '| url:', health.body?.url);
console.log('   sources:', health.body?.sources?.map((s) => `${s.label}=${s.enabled ? 'on' : 'off'}`).join(' '));

const page = await fetch(BASE + '/');
const html = await page.text();
console.log('GET /                ->', page.status, '| html bytes:', html.length, '| has app.js:', html.includes('/app.js'));

for (const [label, path] of [
  ['模组 create + fabric + 1.20.1', '/api/search?q=create&type=mod&version=1.20.1&loader=fabric&limit=6'],
  ['整合包 1.20.1', '/api/search?q=&type=modpack&version=1.20.1&limit=4'],
  ['光影', '/api/search?q=shader&type=shader&limit=3'],
]) {
  const r = await j(path);
  const items = r.body?.items ?? [];
  console.log(`\nGET ${label} -> ${r.status} | ${items.length} 条 / 共 ${r.body?.total ?? '-'} | ${r.body?.tookMs} ms`);
  for (const item of items.slice(0, 4)) {
    const speed = item.speed?.ok ? `${item.speed.kbps} KB/s` : '未测速';
    console.log(`   ${String(item.score.total).padStart(5)} 分  ${item.title.slice(0, 34).padEnd(36)} ${item.sourceLabel}  ${speed}  ${item.free.directDownload ? '免费直链' : '需网页'}`);
  }
}

// speed test the top mods, then confirm the ranking reacts
const search = await j('/api/search?q=create&type=mod&version=1.20.1&loader=fabric&limit=8');
const items = search.body.items.map((i) => ({ key: i.key, source: i.source, id: i.id, slug: i.slug, title: i.title }));
console.log('\nPOST /api/speedtest  -> 对前 8 个结果实测...');
const speed = await j('/api/speedtest', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ items, limit: 8, version: '1.20.1', loaders: ['fabric'] }),
});
console.log(`   实测 ${speed.body.measured} 个，失败 ${speed.body.failed.length} 个，真实探测 ${speed.body.stats.probes} 次（同一 CDN 主机去重），读取 ${(speed.body.stats.bytesRead / 1048576).toFixed(2)} MB`);
for (const [key, value] of Object.entries(speed.body.results).slice(0, 3)) {
  console.log(`   ${key.padEnd(20)} ${value.ok ? value.kbps + ' KB/s  ttfb ' + value.ttfbMs + 'ms  ' + value.filename : 'FAILED ' + value.error}`);
}

const after = await j('/api/search?q=create&type=mod&version=1.20.1&loader=fabric&limit=8');
console.log('\n测速后的推荐排序（速度权重 20%）:');
for (const item of after.body.items.slice(0, 5)) {
  console.log(`   ${String(item.score.total).padStart(5)} 分  速度项 ${String((item.score.parts.speed.score * 100).toFixed(0)).padStart(3)}  ${item.title.slice(0, 34).padEnd(36)} ${item.speed?.ok ? item.speed.kbps + ' KB/s' : '未测速'}`);
}
console.log('\n推荐依据示例:');
console.log('   ' + after.body.items[0].score.explanation.join(' / '));
