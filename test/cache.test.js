import test from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../server/cache.js';

test('TtlCache 命中后返回值', () => {
  const cache = new TtlCache({ name: 'test-hit', ttlMs: 1000 });
  assert.equal(cache.get('a'), undefined);
  cache.set('a', 42);
  assert.equal(cache.get('a'), 42);
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().misses, 1);
});

test('TtlCache 过期后返回 undefined', async () => {
  const cache = new TtlCache({ name: 'test-ttl', ttlMs: 30 });
  cache.set('a', 'value');
  assert.equal(cache.get('a'), 'value');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(cache.get('a'), undefined);
});

test('TtlCache.wrap 只调用一次工厂函数', async () => {
  const cache = new TtlCache({ name: 'test-wrap', ttlMs: 1000 });
  let calls = 0;
  const factory = async () => { calls++; return { ok: true }; };
  await cache.wrap('k', factory);
  await cache.wrap('k', factory);
  assert.equal(calls, 1);
});

test('TtlCache 超过容量时淘汰最旧条目', () => {
  const cache = new TtlCache({ name: 'test-max', ttlMs: 1000, max: 3 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  cache.set('d', 4);
  assert.equal(cache.entries.size, 3);
  assert.equal(cache.get('a'), undefined, '最旧的条目应被淘汰');
  assert.equal(cache.get('d'), 4);
});

test('TtlCache 支持自定义 TTL 覆盖', async () => {
  const cache = new TtlCache({ name: 'test-override', ttlMs: 1000 });
  cache.set('short', 'x', 20);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(cache.get('short'), undefined);
});

test('TtlCache.clear 清空所有条目', () => {
  const cache = new TtlCache({ name: 'test-clear', ttlMs: 1000 });
  cache.set('a', 1);
  cache.clear();
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.entries.size, 0);
});
