/**
 * Unit tests for the browser modules that contain logic rather than DOM work.
 *
 * The scoring maths is the same code that used to run on the server - these tests are
 * also the regression net for that port, so the ranking a visitor sees matches what the
 * old `/api/search` produced.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WEIGHTS, NEUTRAL_SPEED_SCORE, compareBy, freeScore, freshnessScore, followersScore,
  normalizeWeights, popularityScore, relevanceScore, scoreItem, speedLabel, speedScore, formatScoreSummary,
} from '../web/lib/scoring.js';
import { clamp, classifyLicense, formatBytes, formatCount, hostOf, daysSince } from '../web/lib/normalize.js';
import { TtlCache } from '../web/lib/cache.js';

function item(overrides = {}) {
  return {
    title: 'Just Enough Items',
    slug: 'jei',
    description: 'View items and recipes',
    author: 'mezz',
    downloads: 100000,
    followers: 500,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ------------------------------------------------------------------ normalize

test('clamp bounds both ends', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});

test('hostOf survives malformed urls', () => {
  assert.equal(hostOf('https://cdn.modrinth.com/a/b.jar'), 'cdn.modrinth.com');
  assert.equal(hostOf('not a url'), null);
  assert.equal(hostOf(''), null);
});

test('daysSince returns Infinity for missing or unparsable dates', () => {
  assert.equal(daysSince(null), Number.POSITIVE_INFINITY);
  assert.equal(daysSince('garbage'), Number.POSITIVE_INFINITY);
});

test('classifyLicense separates open, restrictive and unknown licences', () => {
  assert.equal(classifyLicense('mit', 'MIT License').openSource, true);
  assert.equal(classifyLicense('arr').restrictive, true);
  assert.equal(classifyLicense('arr').openSource, false);
  const unknown = classifyLicense(null, null);
  assert.equal(unknown.id, null);
  assert.equal(unknown.openSource, false);
  assert.equal(unknown.restrictive, true);
});

test('formatters render Chinese unit scales', () => {
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(12000), '1.2万');
  assert.equal(formatCount(250000000), '2.5亿');
  assert.equal(formatBytes(0), null);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

// ------------------------------------------------------------------ scoring

test('normalizeWeights always returns a distribution summing to one', () => {
  const normalized = normalizeWeights({ relevance: 2, popularity: 2, speed: 2, free: 2, freshness: 1, followers: 1 });
  const total = Object.values(normalized).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `sum was ${total}`);
  assert.equal(normalized.relevance, 0.2);
});

test('normalizeWeights falls back to defaults on garbage and all-zero input', () => {
  assert.deepEqual(normalizeWeights({ relevance: -3, speed: 'x' }), DEFAULT_WEIGHTS);
  const zeros = normalizeWeights({ relevance: 0, popularity: 0, speed: 0, free: 0, freshness: 0, followers: 0 });
  assert.deepEqual(zeros, DEFAULT_WEIGHTS);
});

test('percent weights are re-normalized before scoring', () => {
  const score = scoreItem(item(), { query: 'jei', weights: { relevance: 50, popularity: 50, speed: 0, free: 0, freshness: 0, followers: 0 } });
  assert.equal(score.parts.relevance.weight, 0.5);
  assert.equal(score.parts.popularity.weight, 0.5);
  assert.ok(Math.abs(score.total - (score.parts.relevance.contribution + score.parts.popularity.contribution)) < 0.05);
});

test('relevance orders exact, prefix, contains, author and description matches', () => {
  const q = 'jei';
  const exact = relevanceScore(item({ title: 'JEI' }), q);
  const prefix = relevanceScore(item({ title: 'JEI Extra' }), q);
  const contains = relevanceScore(item({ title: 'Not Enough JEI' }), q);
  const viaAuthor = relevanceScore(item({ title: 'Something', slug: 'other', author: 'jei-fan' }), q);
  const viaAuthorWord = relevanceScore(item({ title: 'Something', slug: 'other', author: 'create' }), 'create rails');
  const viaDescription = relevanceScore(item({ title: 'Something', slug: 'other', author: 'x', description: 'jei helper' }), q);
  const unrelated = relevanceScore(item({ title: 'Something', slug: 'other', author: 'x', description: 'y' }), q);

  assert.equal(exact, 1);
  assert.ok(exact > prefix);
  assert.ok(prefix > contains);
  assert.ok(contains > viaAuthor);
  assert.ok(viaAuthor > viaDescription);
  assert.ok(viaDescription > unrelated);
  assert.equal(unrelated, 0.3);
  assert.ok(viaAuthorWord > relevanceScore(item({ title: 'Something', slug: 'other', author: 'x' }), 'create rails'));
});

test('multi-word queries reward titles that contain all tokens', () => {
  const all = relevanceScore(item({ title: 'Create Steam Rails' }), 'create rails');
  const some = relevanceScore(item({ title: 'Create Additions' }), 'create rails');
  assert.ok(all > some);
});

test('speedScore is a bounded log scale', () => {
  assert.equal(speedScore(0), null);
  assert.equal(speedScore(-5), null);
  assert.equal(speedScore(50), 0);
  assert.equal(speedScore(5000), 1);
  assert.ok(speedScore(500) > 0.4 && speedScore(500) < 0.7);
});

test('speedLabel buckets match the badge wording', () => {
  assert.equal(speedLabel(0), '未测速');
  assert.equal(speedLabel(100), '较慢');
  assert.equal(speedLabel(400), '一般');
  assert.equal(speedLabel(1500), '较快');
  assert.equal(speedLabel(9000), '很快');
});

test('freeScore prefers open-source direct downloads over web-only ones', () => {
  assert.equal(freeScore({ isFree: true, directDownload: true, openSource: true }), 1);
  assert.equal(freeScore({ isFree: true, directDownload: true, openSource: false }), 0.85);
  assert.equal(freeScore({ isFree: true, directDownload: false }), 0.45);
  assert.equal(freeScore({ isFree: false }), 0);
  assert.equal(freeScore(null), 0.5);
});

test('followersScore is bounded and monotonic', () => {
  assert.equal(followersScore(0), 0);
  assert.equal(followersScore(20000), 1);
  assert.ok(followersScore(500) > followersScore(50));
});

test('freshness decays with age and floors at zero', () => {
  assert.equal(freshnessScore(null), 0);
  assert.equal(freshnessScore(new Date().toISOString()), 1);
  const old = freshnessScore(new Date(Date.now() - 4000 * 86400000).toISOString());
  assert.equal(old, 0);
});

test('an unmeasured item scores a neutral speed term, not zero', () => {
  const score = scoreItem(item(), { query: 'jei', weights: DEFAULT_WEIGHTS, speed: null });
  assert.equal(score.speedMeasured, false);
  assert.equal(score.parts.speed.score, NEUTRAL_SPEED_SCORE);
  assert.equal(score.parts.speed.measured, false);
  assert.ok(score.explanation.some((line) => line.includes('尚未测速')));
});

test('a measured speed overrides the neutral term and shows up in the reasons', () => {
  const score = scoreItem(item(), { query: 'jei', speed: { ok: true, kbps: 5000, bytes: 1048576, ttfbMs: 40, host: 'cdn-alt.modrinth.com' } });
  assert.equal(score.speedMeasured, true);
  assert.equal(score.parts.speed.score, 1);
  assert.ok(score.explanation.some((line) => line.includes('实测下载 5000 KB/s')));
});

test('a failed measurement stays neutral and explains itself', () => {
  const score = scoreItem(item(), { query: 'jei', speed: { ok: false, kbps: 0, error: 'timeout' } });
  assert.equal(score.speedMeasured, false);
  assert.equal(score.parts.speed.score, NEUTRAL_SPEED_SCORE);
  assert.ok(score.explanation.some((line) => line.includes('测速未完成')));
});

test('a source that cannot be sampled is reported as unsupported, not as slow', () => {
  const score = scoreItem(item(), { query: 'jei', speed: { ok: false, unsupported: true, error: 'CORS' } });
  assert.equal(score.parts.speed.score, NEUTRAL_SPEED_SCORE);
  assert.ok(score.explanation.some((line) => line.includes('不允许浏览器读取文件内容')));
});

test('weights shift the ranking between two otherwise equal items', () => {
  const fastButOld = item({ title: 'A', downloads: 1000, updatedAt: new Date(Date.now() - 900 * 86400000).toISOString() });
  const freshButSmall = item({ title: 'A', downloads: 1000, updatedAt: new Date().toISOString() });
  const speedOnly = { relevance: 0, popularity: 0, speed: 1, free: 0, freshness: 0, followers: 0 };
  const freshOnly = { relevance: 0, popularity: 0, speed: 0, free: 0, freshness: 1, followers: 0 };
  const speed = { ok: true, kbps: 4000, bytes: 1 };

  const a = scoreItem(fastButOld, { weights: speedOnly, speed });
  const b = scoreItem(freshButSmall, { weights: speedOnly, speed: null });
  assert.ok(a.total > b.total);

  const a2 = scoreItem(fastButOld, { weights: freshOnly, speed });
  const b2 = scoreItem(freshButSmall, { weights: freshOnly, speed: null });
  assert.ok(b2.total > a2.total);
});

test('compareBy implements every sort the UI offers', () => {
  const low = { downloads: 1, followers: 1, updatedAt: '2020-01-01T00:00:00Z', speed: { kbps: 10 }, score: { total: 20, parts: { relevance: { score: 0.1 }, free: { score: 0.1 } } } };
  const high = { downloads: 9, followers: 9, updatedAt: '2024-01-01T00:00:00Z', speed: { kbps: 900 }, score: { total: 80, parts: { relevance: { score: 0.9 }, free: { score: 0.9 } } } };

  for (const sort of ['score', 'downloads', 'followers', 'updated', 'newest', 'speed', 'relevance', 'free']) {
    const sorted = [low, high].sort(compareBy(sort));
    assert.equal(sorted[0], high, `sort=${sort} kept the wrong order`);
  }
  // speed falls back to the total score when nothing was measured
  const a = { speed: null, score: { total: 90, parts: {} } };
  const b = { speed: null, score: { total: 10, parts: {} } };
  assert.equal([b, a].sort(compareBy('speed'))[0], a);
});

test('formatScoreSummary prints every contribution', () => {
  const summary = formatScoreSummary(scoreItem(item(), { query: 'jei' }));
  for (const key of Object.keys(DEFAULT_WEIGHTS)) assert.ok(summary.includes(key), `missing ${key}`);
});

test('popularityScore spans the documented range', () => {
  assert.equal(popularityScore(0), 0);
  assert.equal(popularityScore(1_000_000_000), 1);
  assert.ok(popularityScore(1_000_000) > 0.5);
});

// ------------------------------------------------------------------ cache

/** Minimal in-memory localStorage so the persistence paths can be exercised in Node. */
class MemoryStorage {
  constructor() { this.map = new Map(); this.failOnSet = false; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) {
    if (this.failOnSet) {
      const error = new Error('QuotaExceededError');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.map.set(key, String(value));
  }
  removeItem(key) { this.map.delete(key); }
}

test('TtlCache stores, expires and reports stats', () => {
  const cache = new TtlCache({ name: 'unit', ttlMs: 1000, max: 10, persistent: false });
  assert.equal(cache.get('missing'), undefined);
  cache.set('a', { v: 1 });
  assert.deepEqual(cache.get('a'), { v: 1 });
  cache.set('b', 2, -1); // already expired
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('a'), false);
  const stats = cache.stats();
  assert.equal(stats.hits, 1);
  assert.ok(stats.misses >= 2);
  assert.equal(stats.persistent, false);
});

test('TtlCache evicts oldest entries past its count budget', () => {
  const cache = new TtlCache({ name: 'unit-count', ttlMs: 60000, max: 3, persistent: false });
  for (const key of ['a', 'b', 'c', 'd']) cache.set(key, key);
  assert.equal(cache.entries.size, 3);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('d'), 'd');
});

test('TtlCache evicts past its byte budget', () => {
  const cache = new TtlCache({ name: 'unit-bytes', ttlMs: 60000, max: 100, maxBytes: 200, persistent: false });
  for (let i = 0; i < 20; i++) cache.set(`key-${i}`, 'x'.repeat(50));
  assert.ok(cache.bytes <= 200, `bytes=${cache.bytes}`);
});

test('TtlCache persists and restores through localStorage', () => {
  globalThis.localStorage = new MemoryStorage();
  try {
    const writing = new TtlCache({ name: 'unit-persist', ttlMs: 60000, max: 10 });
    assert.equal(writing.canPersist(), true);
    writing.set('k', { hello: 'world' });

    const reading = new TtlCache({ name: 'unit-persist', ttlMs: 60000, max: 10 });
    assert.equal(reading.load(), 1);
    assert.deepEqual(reading.get('k'), { hello: 'world' });
  } finally {
    delete globalThis.localStorage;
  }
});

test('TtlCache degrades to memory-only when storage writes fail', () => {
  const storage = new MemoryStorage();
  globalThis.localStorage = storage;
  try {
    const cache = new TtlCache({ name: 'unit-quota', ttlMs: 60000, max: 10 });
    storage.failOnSet = true;
    cache.set('k', { big: 'x'.repeat(100) });
    // the value is still served from memory even though it could not be persisted
    assert.deepEqual(cache.get('k'), { big: 'x'.repeat(100) });
    assert.ok(cache.stats().skippedWrites >= 1);
  } finally {
    delete globalThis.localStorage;
  }
});

test('TtlCache works with no localStorage at all', () => {
  delete globalThis.localStorage;
  const cache = new TtlCache({ name: 'unit-nostorage', ttlMs: 60000 });
  cache.set('k', 1);
  assert.equal(cache.get('k'), 1);
  assert.equal(cache.canPersist(), false);
  cache.clear();
  assert.equal(cache.get('k'), undefined);
});

test('wrap only calls the factory on a miss', async () => {
  const cache = new TtlCache({ name: 'unit-wrap', ttlMs: 60000, persistent: false });
  let calls = 0;
  const factory = async () => { calls++; return { value: calls }; };
  const first = await cache.wrap('key', factory);
  const second = await cache.wrap('key', factory);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
});
