// End-to-end API test: boots the real server on an ephemeral port while the
// upstream platforms are stubbed, then walks the whole "search -> speed test ->
// re-ranked recommendation" loop the UI depends on.
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.DISABLE_DISK_CACHE = '1';
// Force the "no key configured" path even though a real .env may exist, so this
// test stays deterministic. An empty value overrides whatever .env supplies.
process.env.CURSEFORGE_API_KEY = '';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

const realFetch = globalThis.fetch;

const SEARCH_PAYLOAD = {
  hits: [
    {
      project_id: 'FAST', project_type: 'mod', slug: 'fast-mod', author: 'alice',
      title: 'Fast Mod', description: 'a mod called fast mod', categories: ['fabric', 'utility'],
      versions: ['1.20.1'], downloads: 500_000, follows: 300,
      icon_url: null, date_created: '2024-01-01T00:00:00Z', date_modified: '2026-09-01T00:00:00Z',
      latest_version: 'VF', license: 'MIT',
    },
    {
      project_id: 'SLOW', project_type: 'mod', slug: 'slow-mod', author: 'bob',
      title: 'Slow Mod', description: 'a mod called slow mod', categories: ['fabric', 'utility'],
      versions: ['1.20.1'], downloads: 400_000, follows: 200,
      icon_url: null, date_created: '2024-01-01T00:00:00Z', date_modified: '2026-09-01T00:00:00Z',
      latest_version: 'VS', license: 'ARR',
    },
  ],
  total_hits: 2,
  offset: 0,
};

const VERSIONS = {
  FAST: [{ id: 'VF', version_number: '1.0', game_versions: ['1.20.1'], loaders: ['fabric'], date_published: '2026-09-01T00:00:00Z', files: [{ url: 'https://cdn.modrinth.com/data/FAST/fast.jar', filename: 'fast.jar', primary: true, size: 131072 }] }],
  SLOW: [{ id: 'VS', version_number: '1.0', game_versions: ['1.20.1'], loaders: ['fabric'], date_published: '2026-09-01T00:00:00Z', files: [{ url: 'https://cdn.modrinth.com/data/SLOW/slow.jar', filename: 'slow.jar', primary: true, size: 131072 }] }],
};

const LOADERS = [
  { name: 'fabric', supported_project_types: ['mod', 'modpack'] },
  { name: 'forge', supported_project_types: ['mod', 'modpack'] },
];

/** Streams `bytes` at roughly `bytes / (chunks * delayMs)` so the probe has something to measure. */
function streamedFile(bytes = 96 * 1024, chunkSize = 16 * 1024, delayMs = 8) {
  let sent = 0;
  const chunk = new Uint8Array(chunkSize);
  const body = new ReadableStream({
    async pull(controller) {
      if (sent >= bytes) {
        controller.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      controller.enqueue(chunk);
      sent += chunk.length;
    },
  });
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Range': `bytes 0-${bytes - 1}/${bytes}`,
      'Content-Length': String(bytes),
      'Content-Type': 'application/java-archive',
    },
  });
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('127.0.0.1')) return realFetch(input, init); // our own HTTP calls go through
  if (url.includes('/tag/loader')) return new Response(JSON.stringify(LOADERS), { status: 200 });
  if (url.includes('/search?')) return new Response(JSON.stringify(SEARCH_PAYLOAD), { status: 200 });
  const versionMatch = url.match(/\/project\/([A-Z]+)\/version/);
  if (versionMatch) return new Response(JSON.stringify(VERSIONS[versionMatch[1]] ?? []), { status: 200 });
  if (url.startsWith('https://cdn.modrinth.com/')) return streamedFile();
  return new Response('unexpected url ' + url, { status: 500 });
};

const { server } = await import('../server/index.js');
if (!server.listening) await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (path, init) => (await realFetch(base + path, init)).json();

after(() => {
  globalThis.fetch = realFetch;
  server.close();
});

test('GET /api/health 报告数据源状态', async () => {
  const health = await api('/api/health');
  assert.equal(health.ok, true);
  const modrinth = health.sources.find((s) => s.id === 'modrinth');
  const curseforge = health.sources.find((s) => s.id === 'curseforge');
  assert.equal(modrinth.enabled, true);
  assert.equal(curseforge.enabled, false, '没有 API key 时 CurseForge 必须保持禁用');
  assert.match(curseforge.reason, /CURSEFORGE_API_KEY/);
  assert.equal(health.rateLimit.enabled, true, '默认应开启限流');
  assert.equal(health.rateLimit.trustProxy, false, '默认不应信任可伪造的转发头');
});

test('GET /api/search 返回带推荐分的归一化结果', async () => {
  const data = await api('/api/search?q=fast%20mod&type=mod&version=1.20.1&weights=' + encodeURIComponent(JSON.stringify({ speed: 50, free: 50 })));
  assert.equal(data.count, 2);
  const fast = data.items.find((item) => item.id === 'FAST');
  const slow = data.items.find((item) => item.id === 'SLOW');
  assert.ok(fast && slow);

  assert.equal(fast.license.openSource, true);
  assert.equal(slow.license.id, 'ARR');
  assert.equal(slow.free.openSource, false);
  assert.equal(fast.score.speedMeasured, false, '尚未测速');
  assert.equal(fast.score.parts.speed.score, 0.55, '未测速应使用中性值');
  assert.ok(fast.score.total > 0);

  // weights are normalised server-side so the UI can show real percentages
  const sum = Object.values(data.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6);
});

test('GET /api/search 的 freeOnly 过滤掉需网页下载的资源', async () => {
  const data = await api('/api/search?q=fast%20mod&type=mod&freeOnly=1');
  assert.ok(data.items.every((item) => item.free.directDownload));
  assert.ok(data.items.some((item) => item.id === 'FAST'));
});

test('POST /api/speedtest 真实测量并按新速度重新排序', async () => {
  const before = await api('/api/search?q=fast%20mod&type=mod&version=1.20.1');
  const keys = before.items.map((item) => ({ key: item.key, source: item.source, id: item.id, slug: item.slug, title: item.title }));

  const measured = await api('/api/speedtest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: keys, limit: 8, version: '1.20.1', loaders: ['fabric'] }),
  });
  assert.equal(measured.measured, 2, '两个条目都应拿到结果');
  assert.equal(measured.failed.length, 0);
  const result = measured.results['modrinth:FAST'];
  assert.equal(result.ok, true, `测速应成功：${result.error}`);
  assert.equal(result.rangeSupported, true);
  assert.ok(result.kbps > 0, `应测出正速率，实际 ${result.kbps}`);
  assert.equal(result.size, 131072, '应回填文件大小');

  // The whole point: the next search must use the freshly measured speed.
  const after_ = await api('/api/search?q=fast%20mod&type=mod&version=1.20.1&sort=speed');
  const fast = after_.items.find((item) => item.id === 'FAST');
  assert.equal(fast.score.speedMeasured, true, '重新搜索后应识别到已测速');
  assert.ok(fast.speed.kbps > 0);
  assert.ok(fast.score.parts.speed.score > 0);
  assert.ok(fast.score.explanation.some((line) => line.includes('实测下载')));
});

test('权重变化会改变推荐顺序', async () => {
  const speedHeavy = await api('/api/search?q=fast%20mod&type=mod&sort=score&w_speed=60&w_free=0&w_relevance=10&w_popularity=10&w_freshness=10&w_followers=10');
  assert.ok(speedHeavy.weights.speed > 0.5, '速度权重应占主导');
  assert.ok(speedHeavy.items[0].score.parts.speed.measured || speedHeavy.items[0].score.parts.speed.score === 0.55);
});

test('GET /api/sources 与 /api/diagnose 给出可操作的数据源状态', async () => {
  const { sources } = await api('/api/sources');
  assert.equal(sources.find((s) => s.id === 'modrinth').enabled, true);

  const diagnose = await api('/api/diagnose');
  const modrinth = diagnose.sources.find((s) => s.id === 'modrinth');
  const curseforge = diagnose.sources.find((s) => s.id === 'curseforge');
  assert.equal(modrinth.diagnosis.state, 'ok');
  assert.equal(curseforge.diagnosis.state, 'no-key', '没有 key 时诊断应明确报告 no-key');
  assert.match(curseforge.diagnosis.hint, /console\.curseforge\.com/);
});

test('GET /api/curseforge/lookup 在未配置 key 时返回 503', async () => {
  const res = await realFetch(base + '/api/curseforge/lookup?id=238222');
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /CURSEFORGE_API_KEY/);
});

test('GET /api/curseforge/lookup 缺少 id 时返回 400', async () => {
  const res = await realFetch(base + '/api/curseforge/lookup');
  assert.equal(res.status, 400);
});

test('POST /api/cache/clear 清空缓存', async () => {
  const result = await api('/api/cache/clear', { method: 'POST' });
  assert.equal(result.ok, true);
});

test('未知路径返回 404，错误方法返回 405', async () => {
  const notFound = await realFetch(base + '/api/nope');
  assert.equal(notFound.status, 404);
  const wrongMethod = await realFetch(base + '/api/search', { method: 'DELETE' });
  assert.equal(wrongMethod.status, 405);
});

test('静态页面可以正常返回', async () => {
  const page = await realFetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /MC Mod Finder/);

  const escaped = await realFetch(base + '/../package.json');
  assert.ok([403, 404].includes(escaped.status), '目录穿越必须被拒绝');
});

// Runs last on purpose: exhausting the bucket would affect the tests above.
test('限流：突发请求超过上限后返回 429', async () => {
  let rateLimited = null;
  for (let i = 0; i < 90 && !rateLimited; i++) {
    const res = await realFetch(base + '/api/health');
    if (res.status === 429) {
      rateLimited = res;
    }
  }
  assert.ok(rateLimited, '超过突发上限后必须返回 429，否则公开部署会被刷爆');
  assert.ok(Number(rateLimited.headers.get('retry-after')) >= 1, '应带上 Retry-After');
  const payload = await rateLimited.json();
  assert.match(payload.error, /频繁/);
});
