/**
 * Unit tests for the community-search module.
 *
 * The value here is query *translation*: Chinese mod communities search differently from
 * how the rest of the site works, and a wrong search string is the difference between a
 * useful jump-out and a dead end. The relay parsing is covered too, since a self-hosted
 * RSSHub returns whichever flavour of RSS/Atom it feels like.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMUNITY_TARGETS, QUERY_ALIASES, buildBilibiliUploadUrl, buildSearchTerms, getRelay,
  parseFeed, relayUrl, setRelay, targetsFor,
} from '../web/sources/community.js';

/** Minimal localStorage so the relay config can be exercised in Node. */
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}
globalThis.localStorage = new MemoryStorage();

// ------------------------------------------------------------------ query building

test('the search string carries the platform habits each community uses', () => {
  const tieba = buildSearchTerms('ATM10', { platform: 'tieba', type: 'modpack', gameVersion: '1.20.1' });
  assert.equal(tieba.primary, 'ATM10 我的世界 整合包 1.20.1');

  const bilibili = buildSearchTerms('create', { platform: 'bilibili', type: 'mod', gameVersion: '1.20.1', loader: 'fabric', loaderNames: new Set(['fabric', 'forge']) });
  assert.equal(bilibili.primary, 'create 我的世界 模组 1.20.1 fabric');
});

test('the resource type decides which Chinese noun is added', () => {
  assert.match(buildSearchTerms('钠', { platform: 'bilibili', type: 'mod' }).primary, /模组/);
  assert.match(buildSearchTerms('钠', { platform: 'bilibili', type: 'modpack' }).primary, /整合包/);
  assert.match(buildSearchTerms('钠', { platform: 'bilibili', type: 'shader' }).primary, /光影/);
  assert.match(buildSearchTerms('钠', { platform: 'bilibili', type: 'resourcepack' }).primary, /材质包/);
  assert.match(buildSearchTerms('钠', { platform: 'bilibili', type: 'datapack' }).primary, /数据包/);
});

test('a query that already says 整合包 is not double-annotated', () => {
  const terms = buildSearchTerms('生活大冒险整合包', { platform: 'tieba', type: 'mod' });
  assert.equal((terms.primary.match(/整合包/g) ?? []).length, 1);
});

test('loader names are only added when they are really loaders', () => {
  const withLoader = buildSearchTerms('create', { platform: 'tieba', type: 'mod', loader: 'neoforge', loaderNames: new Set(['neoforge']) });
  assert.match(withLoader.primary, /neoforge/);

  // an author name or an unknown token would just add noise to the search
  const junk = buildSearchTerms('create', { platform: 'tieba', type: 'mod', loader: 'some-author', loaderNames: new Set(['neoforge']) });
  assert.doesNotMatch(junk.primary, /some-author/);
});

test('every platform gets a variant list starting with the primary term', () => {
  const terms = buildSearchTerms('机械动力', { platform: 'bilibili', type: 'mod', gameVersion: '1.20.1' });
  assert.equal(terms.variants[0], terms.primary);
  assert.ok(terms.variants.length >= 2);
  assert.ok(terms.variants.every((variant) => variant.length > 0));
  // alias expansion should surface the English name people also search with
  assert.ok(terms.variants.some((variant) => /Create/i.test(variant)), `variants were ${JSON.stringify(terms.variants)}`);
});

test('an empty query degrades to the platform noun instead of a malformed string', () => {
  const terms = buildSearchTerms('', { platform: 'tieba', type: 'modpack' });
  assert.equal(terms.primary, '我的世界 整合包');
  assert.ok(!terms.primary.startsWith(' '));
  assert.ok(!terms.primary.includes('  '));
});

test('aliases stay usable as plain strings', () => {
  for (const [key, value] of Object.entries(QUERY_ALIASES)) {
    assert.ok(key.length > 0);
    assert.ok(Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.length > 0));
  }
});

// ------------------------------------------------------------------ destinations

test('every target produces an absolute https url with the term encoded', () => {
  const targets = targetsFor('机械 动力', { type: 'mod', gameVersion: '1.20.1' });
  assert.equal(targets.length, COMMUNITY_TARGETS.length);
  for (const target of targets) {
    assert.match(target.url, /^https:\/\//, `${target.id} is not https`);
    assert.ok(!target.url.includes('{q}'), `${target.id} left an unsubstituted placeholder`);
    assert.ok(!/[\u4e00-\u9fa5]/.test(target.url), `${target.id} did not encode the query`);
  }
});

test('bilibili targets offer a mirror and tieba does not', () => {
  const targets = targetsFor('jei', {});
  const bilibili = targets.find((target) => target.id === 'bilibili-search');
  const tieba = targets.find((target) => target.id === 'tieba-search');
  assert.equal(bilibili.hosts.length, 2);
  assert.equal(tieba.hosts.length, 1);

  // choosing the mirror swaps the host, and only for the target it belongs to
  const mirrored = targetsFor('jei', { mirror: { 'bilibili-search': 'tw' } });
  const mirroredBilibili = mirrored.find((target) => target.id === 'bilibili-search');
  const untouchedTieba = mirrored.find((target) => target.id === 'tieba-search');
  assert.equal(mirroredBilibili.hostId, 'tw');
  assert.match(mirroredBilibili.url, /area=tw/);
  assert.equal(untouchedTieba.url, tieba.url);
});

test('the tieba forum target addresses the bar, not a full-text search', () => {
  const forum = targetsFor('我的世界', {}).find((target) => target.id === 'tieba-forum');
  assert.equal(forum.kind, 'forum');
  assert.match(forum.url, /tieba\.baidu\.com\/f\?/);
  assert.match(forum.url, /kw=/);
});

test('a visiting query cannot escape the URL it is placed in', () => {
  const targets = targetsFor('"><script>alert(1)</script>', {});
  for (const target of targets) {
    assert.ok(!target.url.includes('<script>'), `${target.id} let markup through`);
    assert.ok(!target.url.includes('">'), `${target.id} let a quote through`);
  }
});

test('the bilibili upload draft carries a prefilled title and never submits itself', () => {
  const url = buildBilibiliUploadUrl(['JEI', 'Create']);
  assert.match(url, /^https:\/\/member\.bilibili\.com\/platform\/upload\/video\/frame\?/);
  const parsed = new URL(url);
  assert.match(parsed.searchParams.get('title'), /JEI/);
  assert.match(parsed.searchParams.get('title'), /Create/);
  assert.equal(parsed.searchParams.get('copyright'), '2');
  assert.equal(buildBilibiliUploadUrl([]), null);
  assert.equal(buildBilibiliUploadUrl(['  ']), null);
});

test('a long mod list is truncated in the draft title', () => {
  const url = buildBilibiliUploadUrl(['a', 'b', 'c', 'd', 'e', 'f']);
  assert.match(new URL(url).searchParams.get('title'), /等/);
});

// ------------------------------------------------------------------ relay

test('relayUrl supports base-URL, prefix-proxy and {url} templace forms', () => {
  setRelay({ enabled: true, base: 'http://127.0.0.1:1200', bilibiliUid: '' });
  assert.equal(relayUrl('/bilibili/vsearch/jei'), 'http://127.0.0.1:1200/bilibili/vsearch/jei');

  setRelay({ enabled: true, base: 'https://proxy.example/?url=', bilibiliUid: '' });
  assert.equal(
    relayUrl('/bilibili/vsearch/jei'),
    `https://proxy.example/?url=${encodeURIComponent('https://rsshub.app/bilibili/vsearch/jei')}`,
  );

  setRelay({ enabled: true, base: 'https://proxy.example/fetch?target={url}', bilibiliUid: '' });
  assert.equal(
    relayUrl('/bilibili/vsearch/jei'),
    `https://proxy.example/fetch?target=${encodeURIComponent('https://rsshub.app/bilibili/vsearch/jei')}`,
  );

  setRelay({ enabled: true, base: 'https://proxy.example/', bilibiliUid: '' });
  assert.equal(getRelay().base, 'https://proxy.example', 'trailing slashes are normalized away');
});

test('relay configuration refuses to be enabled without an address', () => {
  setRelay({ enabled: true, base: '   ', bilibiliUid: '123' });
  const config = getRelay();
  assert.equal(config.enabled, false);
  assert.equal(config.base, '');
  setRelay({ enabled: false, base: '', bilibiliUid: '' });
});

test('parseFeed reads an RSS 2.0 feed', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
    <title>B站搜索：JEI</title>
    <item><title>【我的世界】JEI 使用教程</title><link>https://www.bilibili.com/video/BV1xx</link>
      <description>配方查看模组</description><pubDate>Wed, 02 Oct 2024 10:00:00 GMT</pubDate>
      <author>某UP主</author></item>
    <item><title><![CDATA[整合包推荐 &amp; 安装]]></title><link>https://www.bilibili.com/video/BV2yy</link>
      <pubDate>2024-10-01T09:00:00Z</pubDate></item>
  </channel></rss>`;

  const entries = parseFeed(xml);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, '【我的世界】JEI 使用教程');
  assert.equal(entries[0].link, 'https://www.bilibili.com/video/BV1xx');
  assert.equal(entries[0].author, '某UP主');
  assert.equal(entries[0].publishedAt, '2024-10-02T10:00:00.000Z');
  assert.equal(entries[1].title, '整合包推荐 & 安装', 'CDATA and entities are decoded');
});

test('parseFeed reads an Atom feed and tolerates missing dates', () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>JEI 更新</title><link href="https://www.bilibili.com/read/cv123"/>
      <updated>2024-09-30T08:00:00Z</updated>
      <summary>版本 15.62</summary></entry>
  </feed>`;
  const entries = parseFeed(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].link, 'https://www.bilibili.com/read/cv123');
  assert.equal(entries[0].publishedAt, '2024-09-30T08:00:00.000Z');
  assert.equal(entries[0].summary, '版本 15.62');
});

test('parseFeed drops entries without a link and rejects non-feeds', () => {
  assert.deepEqual(parseFeed('<rss><channel><item><title>没有链接</title></item></channel></rss>'), []);
  assert.throws(() => parseFeed('<html><body>503 Service Unavailable</body></html>'), /不是 RSS/);
  assert.throws(() => parseFeed(''), /不是 RSS/);
});

test('parseFeed strips markup out of titles so nothing can be injected', () => {
  const xml = '<rss><channel><item><title>a &lt;img src=x onerror=alert(1)&gt; b</title><link>https://e.com/1</link></item></channel></rss>';
  const [entry] = parseFeed(xml);
  assert.equal(entry.title, 'a b', 'tags are removed, not passed through');
  assert.ok(!entry.title.includes('<'));
});
