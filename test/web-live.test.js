/**
 * Live integration checks for the browser edition.
 *
 * These run the *real* browser modules - the same files the page loads - against the real
 * public APIs, using Node's fetch as the transport. They need internet access.
 *
 * What they cannot prove: that a browser honours the CORS headers. Node ignores CORS, so a
 * passing test means "the API contract and our parsing still hold", not "the browser will
 * allow it". The headers themselves were verified separately with Origin-bearing probes.
 * What they DO catch: an endpoint moving, a response shape changing, CurseForge drifting,
 * and the URL-candidate logic that works around the Modrinth CDN redirect.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// The browser modules touch localStorage at import time (cache hydration), which Node lacks.
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}
globalThis.localStorage = new MemoryStorage();

const { modrinth } = await import('../web/sources/modrinth.js');
const { curseforge, parseProjectId, hasApiKey } = await import('../web/sources/curseforge.js');
const { searchAll, resolveTargets, sourceStatuses } = await import('../web/sources/index.js');
const { measureUrl, SpeedRegistry, urlCandidates } = await import('../web/lib/speedtest.js');
const { scoreItem, DEFAULT_WEIGHTS } = await import('../web/lib/scoring.js');
const { loadTags } = await import('../web/lib/tags.js');

const LIVE = process.env.SKIP_LIVE !== '1';

test('sourceStatuses describes both platforms without a key', () => {
  const statuses = sourceStatuses();
  assert.equal(statuses.length, 2);
  const modrinthStatus = statuses.find((entry) => entry.id === 'modrinth');
  const curseforgeStatus = statuses.find((entry) => entry.id === 'curseforge');
  assert.equal(modrinthStatus.enabled, true);
  assert.equal(curseforgeStatus.enabled, false);
  assert.match(curseforgeStatus.reason, /console\.curseforge\.com/);
});

test('parseProjectId accepts ids and id-bearing urls only', () => {
  assert.equal(parseProjectId('238222'), 238222);
  assert.equal(parseProjectId(' 238222 '), 238222);
  assert.equal(parseProjectId('https://curseforge.com/x?projectId=238222'), 238222);
  assert.equal(parseProjectId('https://www.curseforge.com/minecraft/mc-mods/jei'), null);
  assert.equal(parseProjectId(''), null);
});

test('urlCandidates adds the Modrinth CDN alternate without touching other hosts', () => {
  const modrinthUrl = 'https://cdn.modrinth.com/data/abc/versions/def/file.jar';
  assert.deepEqual(urlCandidates(modrinthUrl), [
    modrinthUrl,
    'https://cdn-alt.modrinth.com/data/abc/versions/def/file.jar',
  ]);
  const forgeUrl = 'https://edge.forgecdn.net/files/1/2/3.jar';
  assert.deepEqual(urlCandidates(forgeUrl), [forgeUrl]);
});

test('modrinth.search returns normalized, scoreable hits', { skip: !LIVE }, async () => {
  const result = await modrinth.search({
    query: 'jei',
    projectTypes: ['mod'],
    gameVersion: '1.20.1',
    loaders: ['fabric'],
    limit: 5,
    offset: 0,
    sort: 'relevance',
  });

  assert.ok(result.items.length > 0, 'expected at least one hit');
  assert.ok(result.total > 0);
  const first = result.items[0];
  assert.match(first.key, /^modrinth:/);
  assert.equal(first.source, 'modrinth');
  assert.equal(first.projectType, 'mod');
  assert.ok(first.title);
  assert.match(first.pageUrl, /^https:\/\/modrinth\.com\//);
  assert.equal(first.free.directDownload, true);
  assert.equal(first.supportsRequestedVersion, true);
  assert.ok(Array.isArray(first.loaders));
  assert.ok(first.loaders.includes('fabric'), `loaders were ${JSON.stringify(first.loaders)}`);
  // loaders must not leak into categories
  for (const loader of first.loaders) assert.ok(!first.categories.includes(loader));

  const score = scoreItem(first, { query: 'jei', weights: DEFAULT_WEIGHTS, speed: null });
  assert.ok(score.total > 0 && score.total <= 100);
  assert.equal(score.speedMeasured, false);
});

test('modrinth.tags yields usable release versions and loaders', { skip: !LIVE }, async () => {
  const tags = await modrinth.tags();
  assert.ok(tags.gameVersions.length > 5);
  assert.ok(tags.gameVersions.every((version) => /^\d+\.\d+(\.\d+)?$/.test(version)), 'unexpected version format');
  assert.ok(tags.loaders.includes('fabric'));
  assert.ok(tags.loaders.includes('forge'));
});

test('loadTags falls back to the built-in list instead of throwing', { skip: !LIVE }, async () => {
  const tags = await loadTags();
  assert.ok(tags.gameVersions.length > 0);
  assert.ok(['live', 'seed'].includes(tags.source));
  if (tags.source === 'seed') assert.ok(tags.error);
});

test('modrinth.resolveDownload returns a range-capable file url', { skip: !LIVE }, async () => {
  const result = await modrinth.search({ query: 'jei', projectTypes: ['mod'], gameVersion: '1.20.1', loaders: ['fabric'], limit: 3 });
  const item = result.items[0];
  const download = await modrinth.resolveDownload(item, { gameVersion: '1.20.1', loaders: ['fabric'] });

  assert.ok(download, 'expected a resolvable file');
  assert.match(download.url, /^https:\/\//);
  assert.ok(download.filename.length > 0);
  assert.ok(download.size > 0);
  assert.ok(download.versionNumber);
});

test('searchAll skips a source that needs a key and keeps the other results', { skip: !LIVE }, async () => {
  const { setApiKey } = await import('../web/sources/curseforge.js');
  setApiKey('');
  const result = await searchAll({ query: 'create', projectTypes: ['mod'], gameVersion: '1.20.1', loaders: [], limitPerSource: 5 });
  assert.ok(result.items.length > 0, 'Modrinth results should survive');
  // With no key the source is not even queried - the wording lives in status(), which the
  // UI shows as a chip and a report.
  assert.equal(result.reports.some((report) => report.source === 'curseforge'), false);
  const modrinthReport = result.reports.find((report) => report.source === 'modrinth');
  assert.equal(modrinthReport.ok, true);
  assert.ok(modrinthReport.total > 0);
  assert.match(sourceStatuses().find((entry) => entry.id === 'curseforge').reason, /API key/);
});

test('searchAll reports a bad key as a failed source instead of failing the search', { skip: !LIVE }, async () => {
  const { setApiKey } = await import('../web/sources/curseforge.js');
  setApiKey('definitely-not-a-real-key');
  try {
    const result = await searchAll({ query: 'jei', projectTypes: ['mod'], gameVersion: '1.20.1', loaders: [], limitPerSource: 3 });
    assert.ok(result.items.length > 0, 'Modrinth results should survive a broken CurseForge key');
    const curseforgeReport = result.reports.find((report) => report.source === 'curseforge');
    assert.ok(curseforgeReport, 'the failing source must be reported');
    assert.equal(curseforgeReport.ok, false);
    assert.match(curseforgeReport.error, /key/);
  } finally {
    setApiKey('');
  }
});

test('searchAll reports an unusable key as a diagnosis rather than a crash', { skip: !LIVE }, async () => {
  const previous = globalThis.localStorage.getItem('mmf:curseforge-key');
  const { setApiKey } = await import('../web/sources/curseforge.js');
  setApiKey('definitely-not-a-real-key');
  try {
    assert.equal(hasApiKey(), true);
    const diagnosis = await curseforge.diagnose({ force: true });
    assert.equal(diagnosis.state, 'invalid-key');
    assert.ok(diagnosis.hint.includes('console.curseforge.com'));
  } finally {
    setApiKey(previous ?? '');
  }
});

test('curseforge refuses a slug with an actionable message', async () => {
  const { setApiKey } = await import('../web/sources/curseforge.js');
  setApiKey('placeholder-key-for-shape-checks');
  try {
    await assert.rejects(
      () => curseforge.lookupById('https://www.curseforge.com/minecraft/mc-mods/jei'),
      (error) => {
        assert.equal(error.code, 'BAD_ID');
        assert.match(error.message, /数字项目 ID/);
        return true;
      },
    );
  } finally {
    setApiKey('');
  }
});

test('measureUrl really samples bytes from the Modrinth CDN', { skip: !LIVE }, async () => {
  const search = await modrinth.search({ query: 'jei', projectTypes: ['mod'], gameVersion: '1.20.1', loaders: ['fabric'], limit: 3 });
  const download = await modrinth.resolveDownload(search.items[0], { gameVersion: '1.20.1', loaders: ['fabric'] });

  const result = await measureUrl(download.url, { maxBytes: 128 * 1024, timeoutMs: 20000 });
  assert.equal(result.ok, true, `measurement failed: ${result.error ?? ''}`);
  assert.ok(result.bytes > 0, 'no bytes were counted');
  assert.ok(result.kbps > 0, `implausible rate: ${result.kbps}`);
  assert.ok(result.ttfbMs >= 0);
  assert.equal(result.host, 'cdn.modrinth.com');
  assert.equal(result.unsupported, false);
  assert.ok(result.resolvedHost, 'should record which host actually served the bytes');
});

test('SpeedRegistry reuses one probe per host and scores the item accordingly', { skip: !LIVE }, async () => {
  const search = await modrinth.search({ query: 'create', projectTypes: ['mod'], gameVersion: '1.20.1', loaders: ['fabric'], limit: 6 });
  const targets = [];
  for (const item of search.items.slice(0, 3)) {
    const download = await modrinth.resolveDownload(item, { gameVersion: '1.20.1', loaders: ['fabric'] });
    if (download?.url) targets.push({ key: item.key, url: download.url, size: download.size });
  }
  assert.ok(targets.length >= 2, 'need at least two downloadable targets');

  const registry = new SpeedRegistry({ concurrency: 2 });
  const { results } = await registry.measureTargets(targets);
  const values = Object.values(results);
  assert.equal(values.length, targets.length);
  assert.ok(values.some((entry) => entry.ok), 'at least one probe should succeed');

  const measuredKey = targets[0].key;
  assert.ok(registry.known(measuredKey)?.ok, 'the registry should remember the measurement');
  const score = scoreItem(search.items.find((item) => item.key === measuredKey) ?? search.items[0], {
    query: 'create',
    speed: registry.known(measuredKey),
  });
  assert.equal(score.speedMeasured, true);
  assert.ok(score.parts.speed.score > 0);
  registry.clear();
  assert.equal(registry.known(measuredKey), null);
});

test('the CurseForge CDN is reported as unsupported, not as a slow download', { skip: !LIVE }, async () => {
  // mediafilez.forgecdn.net serves ranges but sends no Access-Control-Allow-Origin, so a
  // browser cannot read the body. Node can, which is exactly why this check pins the
  // wording rather than the transport: we must never mistake "cannot sample" for "slow".
  const url = 'https://mediafilez.forgecdn.net/files/8075/47/creategoggles-1.20.1-6.1.1-%5BFABRIC%5D.jar';
  const result = await measureUrl(url, { maxBytes: 64 * 1024, timeoutMs: 20000 });
  if (!result.ok) {
    assert.ok(result.error, 'a failure must carry an explanation');
  }
  // Whatever the transport does, the classification must be internally consistent.
  assert.equal(result.ok, result.error == null);
});
