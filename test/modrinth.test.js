import test from 'node:test';
import assert from 'node:assert/strict';
import { modrinth } from '../server/sources/modrinth.js';
import { searchCache, tagCache, projectCache } from '../server/cache.js';

const SEARCH_PAYLOAD = {
  hits: [
    {
      project_id: 'A1',
      project_type: 'mod',
      slug: 'jei',
      author: 'mezz',
      title: 'Just Enough Items',
      description: 'View items and recipes',
      categories: ['fabric', 'forge', 'library'],
      versions: ['1.20.1', '1.21.1'],
      downloads: 78_000_000,
      follows: 11_000,
      icon_url: 'https://cdn.modrinth.com/icon.webp',
      date_created: '2023-01-29T05:17:57Z',
      date_modified: '2026-09-25T17:19:18Z',
      latest_version: 'V1',
      license: 'MIT',
    },
  ],
  total_hits: 1,
  offset: 0,
};

const VERSION_PAYLOAD = [
  {
    id: 'V1',
    version_number: '15.0.0',
    game_versions: ['1.20.1'],
    loaders: ['fabric'],
    date_published: '2026-09-25T00:00:00Z',
    files: [
      { url: 'https://cdn.modrinth.com/data/A1/versions/V1/jei.jar', filename: 'jei.jar', primary: true, size: 2_263_284 },
      { url: 'https://cdn.modrinth.com/data/A1/versions/V1/jei-sources.jar', filename: 'jei-sources.jar', primary: false, size: 100 },
    ],
  },
];

const LOADER_PAYLOAD = [
  { name: 'fabric', supported_project_types: ['mod', 'modpack'] },
  { name: 'forge', supported_project_types: ['mod', 'modpack'] },
  { name: 'neoforge', supported_project_types: ['mod'] },
  { name: 'iris', supported_project_types: ['shader'] },
];

/** Capture request URLs and serve canned payloads. */
function installFetchMock() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    let payload = null;
    if (href.includes('/tag/loader')) payload = LOADER_PAYLOAD;
    else if (href.includes('/search?')) payload = SEARCH_PAYLOAD;
    else if (href.includes('/version?')) payload = VERSION_PAYLOAD;
    else return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

test('Modrinth 搜索会归一化字段并区分加载器与分类', async () => {
  searchCache.clear();
  tagCache.clear();
  const mock = installFetchMock();
  try {
    const result = await modrinth.search({ query: 'jei', projectTypes: ['mod'], gameVersion: '1.20.1', limit: 5 });
    assert.equal(result.total, 1);
    const [item] = result.items;

    assert.equal(item.key, 'modrinth:A1');
    assert.equal(item.source, 'modrinth');
    assert.equal(item.title, 'Just Enough Items');
    assert.equal(item.downloads, 78_000_000);
    assert.equal(item.followers, 11_000);
    assert.equal(item.pageUrl, 'https://modrinth.com/mod/jei');
    assert.equal(item.license.id, 'MIT');
    assert.equal(item.license.openSource, true);
    assert.equal(item.supportsRequestedVersion, true);
    assert.deepEqual(item.loaders.sort(), ['fabric', 'forge'], 'loaders 应只含加载器');
    assert.deepEqual(item.categories, ['library'], 'categories 应剔除加载器');
    assert.equal(item.free.directDownload, true);
    assert.equal(item.free.openSource, true);

    const searchCall = mock.calls.find((url) => url.includes('/search?'));
    assert.ok(searchCall.includes('versions%3A1.20.1') || searchCall.includes('versions:1.20.1'), '应带版本 facet');
    assert.ok(searchCall.includes('project_type%3Amod') || searchCall.includes('project_type:mod'), '应带类型 facet');
  } finally {
    mock.restore();
  }
});

test('Modrinth resolveDownload 优先使用 primary 文件并带上版本信息', async () => {
  searchCache.clear();
  projectCache.clear();
  const mock = installFetchMock();
  try {
    const download = await modrinth.resolveDownload({ id: 'A1' }, { gameVersion: '1.20.1', loaders: ['fabric'] });
    assert.equal(download.url, 'https://cdn.modrinth.com/data/A1/versions/V1/jei.jar');
    assert.equal(download.filename, 'jei.jar');
    assert.equal(download.size, 2_263_284);
    assert.equal(download.versionNumber, '15.0.0');
    assert.deepEqual(download.loaders, ['fabric']);

    const versionCall = mock.calls.find((url) => url.includes('/version?'));
    assert.ok(versionCall.includes('game_versions'), '应按游戏版本过滤');
    assert.ok(versionCall.includes('loaders'), '应按加载器过滤');
  } finally {
    mock.restore();
  }
});

test('Modrinth resolveDownload 在无匹配版本时退回最新版本', async () => {
  searchCache.clear();
  projectCache.clear();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/version?')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(VERSION_PAYLOAD), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const download = await modrinth.resolveDownload({ id: 'A1' }, { gameVersion: '1.7.10' });
    assert.ok(download, '应回退到最新版本而不是返回 null');
    assert.equal(download.filename, 'jei.jar');
    assert.equal(calls.filter((url) => url.includes('/version')).length, 2, '应先按条件查询，再回退到全量查询');
  } finally {
    globalThis.fetch = original;
  }
});

test('Modrinth 搜索失败时抛出可识别的错误', async () => {
  searchCache.clear();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('boom', { status: 503 });
  try {
    await assert.rejects(() => modrinth.search({ query: 'x', limit: 1 }), /HTTP 503/);
  } finally {
    globalThis.fetch = original;
  }
});
