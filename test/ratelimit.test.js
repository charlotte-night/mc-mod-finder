import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, TokenBucket, clientKey } from '../server/ratelimit.js';

test('TokenBucket 允许突发到容量上限后拒绝', () => {
  const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 });
  assert.equal(bucket.consume().allowed, true);
  assert.equal(bucket.consume().allowed, true);
  assert.equal(bucket.consume().allowed, true);
  const denied = bucket.consume();
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSeconds >= 1);
});

test('TokenBucket 随时间补充令牌', () => {
  const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 10 });
  const now = Date.now();
  bucket.consume(1, now);
  bucket.consume(1, now);
  assert.equal(bucket.consume(1, now).allowed, false, '瞬时用尽后应拒绝');
  assert.equal(bucket.consume(1, now + 100).allowed, true, '100ms 后应补回 1 个令牌');
});

test('TokenBucket 不会超过容量', () => {
  const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 100 });
  bucket.consume(2, Date.now());
  bucket.consume(1, Date.now() + 60_000);
  assert.ok(bucket.tokens <= bucket.capacity);
});

test('RateLimiter 按客户端独立计数', () => {
  const limiter = new RateLimiter({ name: 'test', capacity: 2, perMinute: 60 });
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, false, 'a 已用尽');
  assert.equal(limiter.check('b').allowed, true, 'b 不受 a 影响');
});

test('RateLimiter 统计被拦截次数', () => {
  const limiter = new RateLimiter({ name: 'test', capacity: 1, perMinute: 60 });
  limiter.check('x');
  limiter.check('x');
  limiter.check('x');
  assert.equal(limiter.stats().blocked, 2);
});

test('RateLimiter 在客户端数量超限时淘汰空闲桶', () => {
  const limiter = new RateLimiter({ name: 'test', capacity: 2, perMinute: 600, maxClients: 10 });
  for (let i = 0; i < 40; i++) {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 10 });
    // make it look long idle so it is eligible for pruning
    bucket.updatedAt = Date.now() - 60_000;
    limiter.buckets.set('idle-' + i, bucket);
  }
  limiter.check('fresh');
  assert.ok(limiter.buckets.size <= 10, `应收缩到上限内，实际 ${limiter.buckets.size}`);
  assert.ok(limiter.buckets.has('fresh'));
});

test('RateLimiter 无 key 时放行', () => {
  const limiter = new RateLimiter({ name: 'test', capacity: 1, perMinute: 60 });
  assert.equal(limiter.check(null).allowed, true);
});

test('clientKey 默认忽略 X-Forwarded-For', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientKey(req, { trustProxy: false }), '127.0.0.1', '不信任代理时不能采信可伪造的头');
});

test('clientKey 在信任代理时取 X-Forwarded-For 第一段', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientKey(req, { trustProxy: true }), '1.2.3.4');
});

test('clientKey 信任代理时回退到 X-Real-IP', () => {
  const req = { headers: { 'x-real-ip': '5.6.7.8' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientKey(req, { trustProxy: true }), '5.6.7.8');
});
