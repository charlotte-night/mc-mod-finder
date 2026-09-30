// End-to-end check of the CurseForge integration against the real API, ending in
// the payoff: a side-by-side download speed comparison across two different CDNs.
const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const j = async (path, init) => {
  const res = await fetch(BASE + path, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log('=== 1. 数据源诊断 ===');
const diag = await j('/api/diagnose?force=1');
for (const s of diag.body.sources) {
  const d = s.diagnosis ?? {};
  console.log(`  ${s.label.padEnd(12)} enabled=${String(s.enabled).padEnd(5)} state=${(d.state ?? '-').padEnd(15)} ${d.message ?? ''}`);
  if (d.endpoints && Object.keys(d.endpoints).length) {
    console.log(`  ${''.padEnd(12)} 探针: ${JSON.stringify(d.endpoints)}`);
  }
}

console.log('\n=== 2. CurseForge 按 ID 查询（JEI 238222, 1.20.1 + fabric）===');
const lookup = await j('/api/curseforge/lookup?id=238222&version=1.20.1&loader=fabric');
if (lookup.status !== 200) {
  console.log(`  失败 ${lookup.status}: ${lookup.body?.error}`);
} else {
  const item = lookup.body.item;
  console.log(`  标题     : ${item.title}`);
  console.log(`  作者     : ${item.author}`);
  console.log(`  下载量   : ${item.downloads}`);
  console.log(`  加载器   : ${item.loaders.join(', ')}`);
  console.log(`  版本     : ${item.gameVersions.join(', ')}`);
  console.log(`  匹配文件 : ${item.download?.filename} (${(item.download.size / 1048576).toFixed(2)} MB)`);
  console.log(`  直链主机 : ${item.download ? new URL(item.download.url).host : '无'}`);
  console.log(`  免费判定 : ${item.free.reasons[0]}`);
}

console.log('\n=== 3. 跨 CDN 测速对比 ===');
const mr = await j('/api/search?q=jei&type=mod&version=1.20.1&loader=fabric&limit=1');
const targets = [];
if (mr.body?.items?.[0]) {
  targets.push({ key: mr.body.items[0].key, source: 'modrinth', id: mr.body.items[0].id, slug: mr.body.items[0].slug, title: mr.body.items[0].title, label: 'Modrinth / jei' });
}
if (lookup.body?.item) {
  targets.push({ key: lookup.body.item.key, source: 'curseforge', id: lookup.body.item.id, slug: lookup.body.item.slug, title: lookup.body.item.title, label: 'CurseForge / jei' });
}

if (targets.length === 0) {
  console.log('  没有可测速的目标');
} else {
  const speed = await j('/api/speedtest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: targets, limit: targets.length, version: '1.20.1', loaders: ['fabric'] }),
  });
  console.log(`  真实探测 ${speed.body.stats.probes} 次（不同 CDN 主机各一次），共读取 ${(speed.body.stats.bytesRead / 1048576).toFixed(2)} MB\n`);
  for (const t of targets) {
    const r = speed.body.results[t.key];
    if (!r) { console.log(`  ${t.label.padEnd(20)} 无结果`); continue; }
    console.log(`  ${t.label.padEnd(20)} ${r.ok ? String(r.kbps + ' KB/s').padEnd(12) : 'FAILED'.padEnd(12)} ttfb ${String(r.ttfbMs).padStart(5)}ms  主机 ${r.host}  ${r.filename ?? ''}`);
  }
  const rows = targets.map((t) => speed.body.results[t.key]).filter((r) => r?.ok);
  if (rows.length > 1) {
    const fastest = rows.reduce((a, b) => (a.kbps >= b.kbps ? a : b));
    console.log(`\n  => 这次更快的是 ${fastest.host}（${fastest.kbps} KB/s）`);
    console.log('     这正是速度维度真正产生区分度的场景：不同 CDN 之间的差异。');
  } else {
    console.log('\n  （只有一个 CDN 测出了结果，无法对比）');
  }
}
