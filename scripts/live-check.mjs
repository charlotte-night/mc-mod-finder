// Live smoke test against the real public APIs. Not part of `npm test`
// because it needs network access: run with `npm run test:live`.
import { modrinth } from '../server/sources/modrinth.js';
import { measureUrl } from '../server/speedtest.js';
import { scoreItem } from '../server/scoring.js';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

console.log('=== 实时检查 Modrinth ===\n');

const tags = await modrinth.tags();
check('读取游戏版本标签', tags.gameVersions.length > 5, `${tags.gameVersions.slice(0, 3).join(', ')} …`);
check('读取加载器标签', tags.loaders.includes('fabric') && tags.loaders.includes('forge'), tags.loaders.slice(0, 5).join(', '));

const version = tags.gameVersions[0];
const search = await modrinth.search({ query: 'jei', projectTypes: ['mod'], gameVersion: version, limit: 5 });
check(`搜索模组 (${version})`, search.items.length > 0, `命中 ${search.total} 条`);
const first = search.items[0];
check('归一化结果字段完整', Boolean(first.title && first.pageUrl && first.license && first.free));

const packs = await modrinth.search({ query: '', projectTypes: ['modpack'], gameVersion: '1.20.1', limit: 3 });
check('搜索整合包', packs.items.length > 0, `${packs.items.map((p) => p.slug).join(', ')}`);

const loaders = await modrinth.search({ query: 'create', projectTypes: ['mod'], gameVersion: '1.20.1', loaders: ['fabric'], limit: 3 });
check('按加载器过滤', loaders.items.length > 0 && loaders.items.every((i) => i.loaders.includes('fabric')), `${loaders.total} 条 fabric`);

const download = await modrinth.resolveDownload(first, { gameVersion: version });
check('解析下载直链', Boolean(download?.url), download ? `${download.filename} (${(download.size / 1048576).toFixed(2)} MB)` : '');

if (download?.url) {
  const speed = await measureUrl(download.url, { maxBytes: 512 * 1024, timeoutMs: 15000 });
  check('实测下载速度', speed.ok && speed.kbps > 0,
    `${speed.kbps} KB/s  ttfb ${speed.ttfbMs}ms  读取 ${speed.bytes} 字节  range=${speed.rangeSupported}  主机 ${speed.host}`);
  const scored = scoreItem(first, { query: 'jei', speed });
  check('测速后参与评分', scored.speedMeasured && scored.total > 0,
    `总分 ${scored.total}，速度项 ${(scored.parts.speed.score * 100).toFixed(0)} 分`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
