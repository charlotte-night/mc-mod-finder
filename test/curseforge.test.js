import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../server/config.js';
import { curseforge, parseProjectId, CurseForgeError } from '../server/sources/curseforge.js';
import { projectCache, searchCache } from '../server/cache.js';

const MOD_PAYLOAD = {
  data: {
    id: 238222,
    name: 'Just Enough Items',
    slug: 'jei',
    summary: 'View items and recipes',
    downloadCount: 500_000_000,
    thumbsUpCount: 3000,
    classId: 6,
    allowModDistribution: true,
    dateCreated: '2015-11-01T00:00:00Z',
    dateModified: '2026-09-01T00:00:00Z',
    links: { websiteUrl: 'https://www.curseforge.com/minecraft/mc-mods/jei' },
    logo: { thumbnailUrl: 'https://media.forgecdn.net/thumb.png' },
    authors: [{ name: 'mezz' }],
    categories: [{ name: 'Map and Information' }],
    modLoaders: [{ id: 'fabric-0.15', primary: true }],
  },
};

const FILES_PAYLOAD = {
  data: [
    {
      id: 8964934,
      fileName: 'jei-1.20.1-fabric-15.62.0.216.jar',
      displayName: 'jei-1.20.1-fabric-15.62.0.216.jar',
      fileLength: 2_263_284,
      downloadUrl: 'https://edge.forgecdn.net/files/8964/934/jei.jar',
      gameVersions: ['1.20.1', 'Fabric', 'Client'],
      fileDate: '2026-08-01T00:00:00Z',
      isAvailable: true,
    },
    {
      id: 1,
      fileName: 'jei-1.20.1-forge.jar',
      fileLength: 100,
      downloadUrl: null,
      gameVersions: ['1.20.1', 'Forge'],
      fileDate: '2026-07-01T00:00:00Z',
      isAvailable: true,
    },
  ],
};

function mockFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    for (const [pattern, handler] of routes) {
      if (url.includes(pattern)) {
        const result = typeof handler === 'function' ? handler(url) : handler;
        if (result === 'THROW') return new Response('boom', { status: 500 });
        return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function forbidFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error('unexpected network call: ' + (typeof input === 'string' ? input : input.url));
  };
  return () => { globalThis.fetch = original; };
}

function withKey(value = 'test-key') {
  const previous = config.curseforgeApiKey;
  config.curseforgeApiKey = value;
  return () => { config.curseforgeApiKey = previous; };
}

function clearCaches() {
  projectCache.clear();
  searchCache.clear();
}

test('parseProjectId 只接受数字形式', () => {
  assert.equal(parseProjectId('238222'), 238222);
  assert.equal(parseProjectId(238222), 238222);
  assert.equal(parseProjectId({ id: '462042' }), 462042);
  assert.equal(parseProjectId('https://example.com/x?projectId=12345'), 12345);
  assert.equal(parseProjectId('jei'), null, 'slug 无法解析成 ID');
  assert.equal(parseProjectId('https://www.curseforge.com/minecraft/mc-mods/jei'), null);
  assert.equal(parseProjectId(''), null);
  assert.equal(parseProjectId(null), null);
});

test('没有 key 时 status 报告未启用', () => {
  const restore = withKey('');
  try {
    const status = curseforge.status();
    assert.equal(status.enabled, false);
    assert.match(status.reason, /CURSEFORGE_API_KEY/);
  } finally {
    restore();
  }
});

test('diagnose 在没有 key 时不发起网络请求', async () => {
  const restoreKey = withKey('');
  const restoreFetch = forbidFetch();
  try {
    const result = await curseforge.diagnose({ force: true });
    assert.equal(result.state, 'no-key');
    assert.match(result.hint, /console\.curseforge\.com/);
  } finally {
    restoreFetch();
    restoreKey();
  }
});

test('diagnose 区分「key 无效」与「key 有效但搜索未授权」', async () => {
  const restoreKey = withKey('k');
  clearCaches();

  // detail 403 -> invalid key
  let mock = mockFetch([
    ['/mods/238222', 'THROW'],
    ['/mods/search', { data: [] }],
  ]);
  try {
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      return new Response('Forbidden', { status: url.includes('/mods/search') ? 200 : 403 });
    };
    const invalid = await curseforge.diagnose({ force: true });
    assert.equal(invalid.state, 'invalid-key');
    assert.match(invalid.hint, /重新生成/);
  } finally {
    mock.restore();
  }

  // detail 200, search 403 -> search blocked (this is the state this key is in)
  mock = mockFetch([['/mods/238222', MOD_PAYLOAD]]);
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/mods/search')) return new Response('Forbidden: API Key missing or invalid', { status: 403 });
    return new Response(JSON.stringify(MOD_PAYLOAD), { status: 200 });
  };
  try {
    const blocked = await curseforge.diagnose({ force: true });
    assert.equal(blocked.state, 'search-blocked');
    assert.equal(blocked.endpoints.detail, 200);
    assert.equal(blocked.endpoints.search, 403);
    assert.match(blocked.message, /未被授权/);
    assert.match(blocked.hint, /按数字 ID 查询/, '提示必须给出可用的替代方案');
  } finally {
    globalThis.fetch = original;
    mock.restore();
    restoreKey();
  }
});

test('diagnose 在两端都通时报告 ok', async () => {
  const restoreKey = withKey('k');
  const mock = mockFetch([
    ['/mods/238222', MOD_PAYLOAD],
    ['/mods/search', { data: [], pagination: { totalCount: 0 } }],
  ]);
  try {
    const result = await curseforge.diagnose({ force: true });
    assert.equal(result.state, 'ok');
    assert.equal(result.hint, null);
  } finally {
    mock.restore();
    restoreKey();
  }
});

test('search 在搜索被拒时抛出带 SEARCH_BLOCKED 的错误', async () => {
  const restoreKey = withKey('k');
  clearCaches();
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/mods/search')) return new Response('Forbidden: API Key missing or invalid', { status: 403 });
    return new Response(JSON.stringify(MOD_PAYLOAD), { status: 200 });
  };
  try {
    await assert.rejects(
      () => curseforge.search({ query: 'jei', projectTypes: ['mod'], limit: 3 }),
      (error) => {
        assert.ok(error instanceof CurseForgeError);
        assert.equal(error.code, 'SEARCH_BLOCKED');
        assert.match(error.message, /按 ID 查询/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
    restoreKey();
  }
});

test('search 成功时归一化 CurseForge 字段', async () => {
  const restoreKey = withKey('k');
  clearCaches();
  const mock = mockFetch([
    ['/mods/search', { data: [{ ...MOD_PAYLOAD.data, latestFiles: FILES_PAYLOAD.data }], pagination: { totalCount: 1 } }],
  ]);
  try {
    const result = await curseforge.search({ query: 'jei', projectTypes: ['mod'], gameVersion: '1.20.1', limit: 3 });
    assert.equal(result.total, 1);
    const [item] = result.items;
    assert.equal(item.key, 'curseforge:238222');
    assert.equal(item.sourceLabel, 'CurseForge');
    assert.equal(item.projectType, 'mod');
    assert.equal(item.author, 'mezz');
    assert.equal(item.downloads, 500_000_000);
    assert.equal(item.free.directDownload, true);
    assert.ok(item.download.url.startsWith('https://edge.forgecdn.net/'));
    assert.ok(!item.gameVersions.includes('Client'), 'Client/Server 这类标签不应混进版本列表');
    assert.ok(!item.gameVersions.includes('Fabric'), '加载器标签应归到 loaders 而不是版本');
    assert.ok(item.loaders.includes('fabric'));
  } finally {
    mock.restore();
    restoreKey();
  }
});

test('lookupById 按版本与加载器取文件', async () => {
  const restoreKey = withKey('k');
  clearCaches();
  const mock = mockFetch([
    ['/mods/238222/files', FILES_PAYLOAD],
    ['/mods/238222', MOD_PAYLOAD],
  ]);
  try {
    const item = await curseforge.lookupById('238222', { gameVersion: '1.20.1', loaders: ['fabric'] });
    assert.equal(item.id, '238222');
    assert.equal(item.download.filename, 'jei-1.20.1-fabric-15.62.0.216.jar');
    assert.equal(item.download.size, 2_263_284);

    const filesCall = mock.calls.find((url) => url.includes('/files'));
    assert.ok(filesCall.includes('gameVersion=1.20.1'));
    assert.ok(filesCall.includes('modLoaderType=4'), 'fabric 应映射为 modLoaderType=4');
  } finally {
    mock.restore();
    restoreKey();
  }
});

test('lookupById 对 slug 给出可操作的错误', async () => {
  const restoreKey = withKey('k');
  const restoreFetch = forbidFetch();
  try {
    await assert.rejects(
      () => curseforge.lookupById('jei'),
      (error) => {
        assert.equal(error.code, 'BAD_ID');
        assert.match(error.message, /数字项目 ID/);
        return true;
      },
    );
  } finally {
    restoreFetch();
    restoreKey();
  }
});

test('resolveDownload 优先用条目自带的直链', async () => {
  const restoreKey = withKey('k');
  clearCaches();
  const restoreFetch = forbidFetch();
  try {
    const download = await curseforge.resolveDownload({
      id: '238222',
      download: { url: 'https://edge.forgecdn.net/x.jar', filename: 'x.jar', size: 10 },
    });
    assert.equal(download.url, 'https://edge.forgecdn.net/x.jar');
  } finally {
    restoreFetch();
    restoreKey();
  }
});

test('resolveDownload 在文件对象没有直链时回退到 download-url 接口', async () => {
  const restoreKey = withKey('k');
  clearCaches();
  const mock = mockFetch([
    ['/download-url', { data: 'https://edge.forgecdn.net/resolved.jar' }],
    ['/mods/238222/files', {
      data: [{
        id: 777,
        fileName: 'no-url.jar',
        fileLength: 5,
        downloadUrl: null,
        gameVersions: ['1.20.1'],
        isAvailable: true,
      }],
    }],
  ]);
  try {
    const download = await curseforge.resolveDownload({ id: '238222' }, { gameVersion: '1.20.1' });
    assert.ok(download, '应通过 download-url 接口拿到直链');
    assert.equal(download.url, 'https://edge.forgecdn.net/resolved.jar');
    assert.ok(mock.calls.some((url) => url.includes('/download-url')));
  } finally {
    mock.restore();
    restoreKey();
  }
});

test('作者禁止分发时标记为需网页下载', async () => {
  const restoreKey = withKey('k');
  clearCaches();
  const blockedMod = {
    data: {
      ...MOD_PAYLOAD.data,
      allowModDistribution: false,
      latestFiles: [{ ...FILES_PAYLOAD.data[0], downloadUrl: null }],
    },
  };
  const mock = mockFetch([
    ['/mods/238222/files', { data: [{ ...FILES_PAYLOAD.data[0], downloadUrl: null }] }],
    ['/mods/238222', blockedMod],
  ]);
  try {
    const item = await curseforge.lookupById('238222');
    assert.equal(item.free.directDownload, false);
    assert.equal(item.free.isFree, true);
    assert.match(item.free.reasons[0], /禁止第三方直链/);
  } finally {
    mock.restore();
    restoreKey();
  }
});
