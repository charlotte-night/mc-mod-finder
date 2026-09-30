import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLicense, hostOf, popularityScore, freshnessScore, formatBytes, daysSince } from '../server/normalize.js';

test('classifyLicense 识别开源许可', () => {
  const mit = classifyLicense('MIT', 'MIT License');
  assert.equal(mit.openSource, true);
  assert.equal(mit.restrictive, false);

  const gpl = classifyLicense('GPL-3.0-only', 'GNU General Public License v3.0');
  assert.equal(gpl.openSource, true);
});

test('classifyLicense 识别受限许可', () => {
  for (const id of ['ARR', 'All-Rights-Reserved', 'Custom']) {
    const result = classifyLicense(id, id);
    assert.equal(result.restrictive, true, `${id} 应被判定为受限`);
    assert.equal(result.openSource, false);
  }
});

test('classifyLicense 处理缺失许可', () => {
  const missing = classifyLicense(null, null);
  assert.equal(missing.id, null);
  assert.equal(missing.openSource, false);
  assert.equal(missing.restrictive, true);
});

test('popularityScore 单调递增且有界', () => {
  assert.equal(popularityScore(0), 0);
  assert.equal(popularityScore(500), 0, '低于下限应夹到 0');
  assert.ok(popularityScore(50_000_000) >= 1, '达到上限应为 1');
  assert.ok(popularityScore(1_000_000) > popularityScore(10_000));
  assert.ok(popularityScore(10_000_000) <= 1);
});

test('freshnessScore 新项目高于旧项目', () => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 900 * 86400000).toISOString();
  assert.ok(freshnessScore(now) > freshnessScore(old));
  assert.equal(freshnessScore(new Date(Date.now() + 86400000).toISOString()), 1);
  assert.equal(freshnessScore(null), 0);
});

test('daysSince 对非法输入返回 Infinity', () => {
  assert.equal(daysSince('not-a-date'), Number.POSITIVE_INFINITY);
  assert.equal(daysSince(null), Number.POSITIVE_INFINITY);
});

test('hostOf 解析主机名', () => {
  assert.equal(hostOf('https://cdn.modrinth.com/data/x/y.jar'), 'cdn.modrinth.com');
  assert.equal(hostOf('nonsense'), null);
});

test('formatBytes 输出人类可读单位', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.match(formatBytes(3 * 1024 ** 3), /GB$/);
});
