import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WEIGHTS,
  NEUTRAL_SPEED_SCORE,
  freeScore,
  normalizeWeights,
  relevanceScore,
  scoreItem,
  speedScore,
  followersScore,
} from '../server/scoring.js';

test('normalizeWeights 让权重之和为 1', () => {
  const weights = normalizeWeights({ relevance: 1, popularity: 1, speed: 1, free: 1, freshness: 1, followers: 1 });
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  for (const value of Object.values(weights)) assert.ok(Math.abs(value - 1 / 6) < 1e-9);
});

test('normalizeWeights 忽略非法值并回退默认', () => {
  const weights = normalizeWeights({ speed: -5, free: 'abc' });
  assert.equal(weights.speed, DEFAULT_WEIGHTS.speed / sumOfDefaults());
  assert.ok(weights.free > 0);
});

test('normalizeWeights 处理全零权重', () => {
  const weights = normalizeWeights({ relevance: 0, popularity: 0, speed: 0, free: 0, freshness: 0, followers: 0 });
  assert.deepEqual(weights, { ...DEFAULT_WEIGHTS });
});

function sumOfDefaults() {
  return Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
}

test('relevanceScore 按匹配强度排序', () => {
  const exact = relevanceScore({ title: 'jei' }, 'jei');
  const prefix = relevanceScore({ title: 'jei extras' }, 'jei');
  const contains = relevanceScore({ title: 'the jei thing' }, 'jei');
  const descOnly = relevanceScore({ title: 'other', description: 'works with jei' }, 'jei');
  const none = relevanceScore({ title: 'other', description: 'nothing' }, 'jei');

  assert.equal(exact, 1);
  assert.ok(exact > prefix);
  assert.ok(prefix > contains);
  assert.ok(contains > descOnly);
  assert.ok(descOnly > none);
  assert.ok(none > 0, '仍应给一个基础分，避免完全归零');
});

test('relevanceScore 空查询返回中性值', () => {
  assert.equal(relevanceScore({ title: 'x' }, ''), 0.5);
});

test('relevanceScore 多词查询按命中比例给分', () => {
  const both = relevanceScore({ title: 'create steam n rails' }, 'create rails');
  const one = relevanceScore({ title: 'create something' }, 'create rails');
  assert.ok(both > one);
});

test('speedScore 单调且夹在 0..1', () => {
  assert.equal(speedScore(0), null);
  assert.equal(speedScore(50), 0);
  assert.ok(speedScore(500) > 0 && speedScore(500) < 1);
  assert.equal(speedScore(5000), 1);
  assert.equal(speedScore(999999), 1, '超过上限应夹到 1');
});

test('freeScore 区分直链、开源与网页下载', () => {
  assert.equal(freeScore({ isFree: true, directDownload: true, openSource: true }), 1);
  assert.equal(freeScore({ isFree: true, directDownload: true, openSource: false }), 0.85);
  assert.equal(freeScore({ isFree: true, directDownload: false }), 0.45);
  assert.equal(freeScore({ isFree: false }), 0);
  assert.equal(freeScore(null), 0.5);
});

test('followersScore 有界且单调', () => {
  assert.equal(followersScore(0), 0);
  assert.equal(followersScore(20000), 1);
  assert.ok(followersScore(1000) > followersScore(100));
});

const baseItem = {
  title: 'Just Enough Items',
  slug: 'jei',
  description: 'View items and recipes',
  author: 'mezz',
  downloads: 78_000_000,
  followers: 11_000,
  updatedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
  license: { id: 'MIT', openSource: true },
  free: { isFree: true, directDownload: true, openSource: true },
};

test('scoreItem 总分在 0..100 且给出分项', () => {
  const score = scoreItem(baseItem, { query: 'jei' });
  assert.ok(score.total > 0 && score.total <= 100);
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    assert.ok(score.parts[key], `缺少分项 ${key}`);
    assert.ok(score.parts[key].score >= 0 && score.parts[key].score <= 1);
  }
  assert.equal(score.speedMeasured, false);
  assert.ok(score.explanation.length > 0);
});

test('未测速时速度项使用中性值', () => {
  const score = scoreItem(baseItem, { query: 'jei' });
  assert.equal(score.parts.speed.score, NEUTRAL_SPEED_SCORE);
  assert.equal(score.parts.speed.measured, false);
});

test('实测速度会改变总分并标记为已测', () => {
  const slow = scoreItem(baseItem, { query: 'jei', speed: { ok: true, kbps: 100 } });
  const fast = scoreItem(baseItem, { query: 'jei', speed: { ok: true, kbps: 4000 } });
  assert.equal(slow.speedMeasured, true);
  assert.equal(fast.speedMeasured, true);
  assert.ok(fast.total > slow.total, '速度更快的条目总分应更高');
  assert.ok(fast.total > scoreItem(baseItem, { query: 'jei' }).total, '快于中性值应高于未测速');
});

test('测速失败时退回中性值而不是零分', () => {
  const failed = scoreItem(baseItem, { query: 'jei', speed: { ok: false, error: 'timeout', kbps: 0 } });
  assert.equal(failed.speedMeasured, false);
  assert.equal(failed.parts.speed.score, NEUTRAL_SPEED_SCORE);
  assert.ok(failed.explanation.some((line) => line.includes('测速失败')));
});

test('提高速度权重会放大速度差异', () => {
  const slowItem = { ...baseItem, title: 'Slow' };
  const fastItem = { ...baseItem, title: 'Fast', slug: 'fast' };
  const slowSpeed = { ok: true, kbps: 120 };
  const fastSpeed = { ok: true, kbps: 4000 };

  const lowSpeedWeight = { relevance: 30, popularity: 20, speed: 0, free: 15, freshness: 10, followers: 5 };
  const highSpeedWeight = { relevance: 5, popularity: 5, speed: 80, free: 5, freshness: 3, followers: 2 };

  const gapLow = scoreItem(fastItem, { query: 'x', weights: lowSpeedWeight, speed: fastSpeed }).total
    - scoreItem(slowItem, { query: 'x', weights: lowSpeedWeight, speed: slowSpeed }).total;
  const gapHigh = scoreItem(fastItem, { query: 'x', weights: highSpeedWeight, speed: fastSpeed }).total
    - scoreItem(slowItem, { query: 'x', weights: highSpeedWeight, speed: slowSpeed }).total;

  assert.ok(gapHigh > gapLow, '速度权重越高，快慢差距应越大');
});

test('免费程度影响推荐结果', () => {
  const paid = { ...baseItem, title: 'Paid', free: { isFree: false } };
  const freeDirect = { ...baseItem, title: 'Free' };
  const freeWeight = { relevance: 10, popularity: 10, speed: 10, free: 60, freshness: 5, followers: 5 };

  const paidScore = scoreItem(paid, { query: 'x', weights: freeWeight });
  const freeScoreValue = scoreItem(freeDirect, { query: 'x', weights: freeWeight });
  assert.ok(freeScoreValue.total > paidScore.total);
  assert.equal(paidScore.parts.free.score, 0);
  assert.equal(freeScoreValue.parts.free.score, 1);
});
