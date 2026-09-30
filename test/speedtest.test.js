import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { measureUrl, SpeedRegistry } from '../server/speedtest.js';

/**
 * Test server that deliberately delays the first byte and then streams at a known rate.
 * This is what proves the throughput maths excludes time-to-first-byte.
 */
function startServer({ ttfbMs = 600, chunkBytes = 16 * 1024, chunkDelayMs = 6, totalBytes = 1024 * 1024 } = {}) {
  let requests = 0;
  const body = Buffer.alloc(chunkBytes, 7);
  const server = http.createServer((req, res) => {
    requests++;
    if (req.url === '/missing') {
      res.writeHead(404).end('nope');
      return;
    }
    const rangeMatch = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ''));
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const requestedEnd = rangeMatch[2] ? Number(rangeMatch[2]) : totalBytes - 1;
      const end = Math.min(requestedEnd, totalBytes - 1);
      const length = Math.max(0, end - start + 1);
      setTimeout(() => {
        res.writeHead(206, {
          'Content-Type': 'application/java-archive',
          'Content-Range': `bytes ${start}-${start + length - 1}/${totalBytes}`,
          'Content-Length': String(length),
        });
        let sent = 0;
        const tick = () => {
          if (sent >= length) return res.end();
          const size = Math.min(chunkBytes, length - sent);
          res.write(size === chunkBytes ? body : body.subarray(0, size));
          sent += size;
          setTimeout(tick, chunkDelayMs);
        };
        tick();
      }, ttfbMs);
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { 'Content-Length': String(totalBytes) });
      res.end(Buffer.alloc(totalBytes, 3));
    }, ttfbMs);
  });
  return { server, stats: () => ({ requests }) };
}

async function withServer(options, fn) {
  const { server, stats } = startServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    return await fn({ base: `http://127.0.0.1:${port}`, stats });
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
  }
}

test('measureUrl 用分块请求并排除首字节延迟', async () => {
  // 2 MB file, we only sample 512 KB of it.
  await withServer({ ttfbMs: 800, chunkBytes: 16 * 1024, chunkDelayMs: 5, totalBytes: 2 * 1024 * 1024 }, async ({ base }) => {
    const result = await measureUrl(`${base}/file.jar`, { maxBytes: 512 * 1024, timeoutMs: 20000 });

    assert.equal(result.ok, true, `应测速成功，实际 error=${result.error}`);
    assert.equal(result.status, 206, '应使用 Range 分块请求');
    assert.equal(result.rangeSupported, true);
    assert.ok(result.bytes >= 480 * 1024 && result.bytes <= 512 * 1024, `应读取约 512KB，实际 ${result.bytes}`);
    assert.ok(result.ttfbMs >= 750, `首字节应反映 800ms 延迟，实际 ${result.ttfbMs}`);
    assert.equal(result.partial, true, '只读取了 2MB 文件的一部分');
    assert.equal(result.size, 2 * 1024 * 1024, '应记录完整文件大小');

    // The reported rate must be bytes divided by streaming time only.
    const expectedFromStream = result.bytes / 1024 / (result.streamMs / 1000);
    assert.ok(Math.abs(result.kbps - expectedFromStream) <= 3,
      `速率应为 bytes/streamMs，实际 ${result.kbps} 期望 ${Math.round(expectedFromStream)}`);

    // And it must be clearly higher than a naive bytes/(ttfb+stream) figure,
    // which is exactly the mistake this excludes.
    const naive = result.bytes / 1024 / ((result.streamMs + result.ttfbMs) / 1000);
    assert.ok(result.kbps > naive * 1.5,
      `排除 TTFB 后应明显高于朴素算法：实测 ${result.kbps} KB/s vs 朴素 ${Math.round(naive)} KB/s`);
  });
});

test('measureUrl 短样本会被标记为低置信度', async () => {
  await withServer({ ttfbMs: 10, chunkBytes: 64 * 1024, chunkDelayMs: 0, totalBytes: 128 * 1024 }, async ({ base }) => {
    const result = await measureUrl(`${base}/tiny.jar`, { maxBytes: 1024 * 1024, timeoutMs: 10000 });
    assert.equal(result.ok, true);
    assert.equal(result.lowConfidence, true, '瞬时完成的小文件应标记低置信度');
  });
});

test('measureUrl 对拒绝 Range 的 CDN 会先解析重定向再测速', async () => {
  // Mirrors edge.forgecdn.net: 404 whenever a Range header is present, but a clean
  // 302 to the real file (which does support ranges) when there is none.
  const chunk = Buffer.alloc(16 * 1024, 9);
  const totalBytes = 512 * 1024;
  let redirectorSawRange = false;
  let redirectorPlainHits = 0;

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/real')) {
      const match = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range ?? ''));
      const start = match ? Number(match[1]) : 0;
      const length = Math.min(totalBytes - start, 256 * 1024);
      res.writeHead(match ? 206 : 200, {
        'Content-Type': 'application/java-archive',
        'Content-Range': `bytes ${start}-${start + length - 1}/${totalBytes}`,
        'Content-Length': String(length),
      });
      let sent = 0;
      const tick = () => {
        if (sent >= length) return res.end();
        const size = Math.min(16 * 1024, length - sent);
        res.write(size === 16 * 1024 ? chunk : chunk.subarray(0, size));
        sent += size;
        setTimeout(tick, 4);
      };
      return tick();
    }
    if (req.headers.range) {
      redirectorSawRange = true;
      return void res.writeHead(404).end('no ranged requests here');
    }
    redirectorPlainHits++;
    res.writeHead(302, { Location: '/real.jar' }).end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const result = await measureUrl(`http://127.0.0.1:${port}/redirector.jar`, { maxBytes: 256 * 1024, timeoutMs: 15000 });

    assert.equal(redirectorSawRange, true, '第一跳应当用过 Range 并被拒');
    assert.equal(redirectorPlainHits, 1, '被拒后应当不带 Range 解析一次重定向');
    assert.equal(result.ok, true, `解析重定向后应测速成功：${result.error}`);
    assert.equal(result.rangeSupported, true);
    assert.ok(result.resolvedUrl.endsWith('/real.jar'), `resolvedUrl 应为真实文件，实际 ${result.resolvedUrl}`);
    assert.equal(result.resolvedFrom, `http://127.0.0.1:${port}/redirector.jar`);
    assert.equal(result.host, `127.0.0.1:${port}`, '缓存键仍应是调用方给出的主机');
    assert.ok(result.kbps > 0);
    assert.ok(result.bytes >= 240 * 1024);
  } finally {
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
  }
});

test('measureUrl 超时但已读到足够样本时仍给出有效速率', async () => {
  // 100 MB file streamed slowly: the deadline always fires before maxBytes.
  await withServer({ ttfbMs: 10, chunkBytes: 8 * 1024, chunkDelayMs: 20, totalBytes: 100 * 1024 * 1024 }, async ({ base }) => {
    const result = await measureUrl(`${base}/huge.jar`, { maxBytes: 1024 * 1024, timeoutMs: 1500 });

    assert.equal(result.ok, true, '读到足够数据后超时不应判为失败');
    assert.equal(result.truncated, true, '应标记样本被超时截断');
    assert.ok(result.bytes >= 32 * 1024, `应读到可用样本，实际 ${result.bytes} 字节`);
    assert.ok(result.kbps > 0, `应算出速率，实际 ${result.kbps}`);
    assert.equal(result.error, null);
    assert.match(result.note, /超时/);
    assert.ok(result.size === 100 * 1024 * 1024, '应保留完整文件大小');
  });
});

test('measureUrl 对 HTTP 错误返回失败而不是抛异常', async () => {
  await withServer({}, async ({ base }) => {
    const result = await measureUrl(`${base}/missing`, { maxBytes: 1024, timeoutMs: 5000 });
    assert.equal(result.ok, false);
    assert.match(result.error, /404/);
    assert.equal(result.kbps, 0);
  });
});

test('measureUrl 对无法解析的地址返回失败', async () => {
  const result = await measureUrl('http://127.0.0.1:1/nope.jar', { maxBytes: 1024, timeoutMs: 3000 });
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test('SpeedRegistry 对同一主机只做一次真实探测', async () => {
  await withServer({ ttfbMs: 20, chunkBytes: 32 * 1024, chunkDelayMs: 2, totalBytes: 256 * 1024 }, async ({ base, stats }) => {
    const registry = new SpeedRegistry({ hostTtlMs: 60000 });
    const targets = [
      { key: 'a', url: `${base}/one.jar`, size: 1000 },
      { key: 'b', url: `${base}/two.jar`, size: 2000 },
      { key: 'c', url: `${base}/three.jar`, size: 3000 },
    ];
    const results = await registry.measureTargets(targets);

    assert.equal(stats().requests, 1, '同一主机应只发一次请求');
    assert.equal(Object.keys(results).length, 3, '三个条目都应有结果');
    assert.equal(results.a.kbps, results.b.kbps, '同主机应复用同一速率');
    assert.equal(results.b.size, 2000, '复用速率时仍需保留各自的文件大小');
    assert.equal(results.a.cached, false);
    assert.equal(registry.stats().probes, 1);

    // Second call should hit the host cache and make no further requests.
    const again = await registry.measureTargets([{ key: 'd', url: `${base}/four.jar` }]);
    assert.equal(stats().requests, 1, '主机速率缓存命中后不应再发请求');
    assert.equal(again.d.cached, true);
    assert.equal(registry.stats().probes, 1);
  });
});

test('SpeedRegistry 跳过无效 URL', async () => {
  const registry = new SpeedRegistry();
  const results = await registry.measureTargets([{ key: 'bad', url: 'not-a-url' }]);
  assert.equal(results.bad.ok, false);
  assert.equal(results.bad.error, 'invalid url');
});
