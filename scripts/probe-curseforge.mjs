// CurseForge key capability check.
//
//   node scripts/probe-curseforge.mjs
//
// CurseForge grants access per endpoint, so a key can be valid and still be refused
// on some routes. This prints exactly which ones this key may use - run it after
// regenerating a key to see whether search came back.
//
// The key itself is never printed.
import { config } from '../server/config.js';
import { randomUUID } from 'node:crypto';

const API = 'https://api.curseforge.com/v1';
const key = config.curseforgeApiKey;

if (!key) {
  console.log('未读到 CURSEFORGE_API_KEY。把它填进 .env 后重试。');
  process.exit(1);
}
console.log(`key 长度 ${key.length}，前缀 ${key.slice(0, 4)}…（不回显）\n`);

/** Every request gets a unique cache-buster so a CDN cache can never fake a result. */
async function check(method, path, body) {
  const url = `${API}${path}${path.includes('?') ? '&' : '?'}_cb=${randomUUID()}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'x-api-key': key,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': config.userAgent,
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const text = await res.text();
    let detail = text.slice(0, 60).replace(/\s+/g, ' ');
    try {
      const json = JSON.parse(text);
      if (json.data !== undefined) {
        const count = Array.isArray(json.data) ? `${json.data.length} 条` : '1 个对象';
        detail = `有数据（${count}${json.pagination?.totalCount !== undefined ? `，总数 ${json.pagination.totalCount}` : ''}）`;
      }
    } catch { /* keep raw text */ }
    return { ok: res.status === 200, status: res.status, detail, authChecked: true };
  } catch (error) {
    return { ok: false, status: 0, detail: 'ERR ' + error.message, authChecked: true };
  }
}

const endpoints = [
  ['GET', '/mods/238222', null, '项目详情', true],
  ['GET', '/mods/238222/files?gameVersion=1.20.1&modLoaderType=4&pageSize=1', null, '文件列表（按版本+加载器）', true],
  ['GET', '/mods/238222/files/8964934/download-url', null, '官方直链解析', true],
  ['POST', '/mods', { modIds: [238222] }, '批量按 ID 查询', true],
  ['GET', '/mods/search?gameId=432&classId=6&pageSize=1', null, '关键词搜索', true],
  ['GET', '/minecraft/version', null, '游戏版本列表', false],
  ['GET', '/categories?gameId=432', null, '分类列表', false],
];

console.log('端点权限矩阵：\n');
const results = [];
for (const [method, path, body, label, authChecked] of endpoints) {
  const r = await check(method, path, body);
  results.push({ label, ...r });
  const mark = r.ok ? '✅' : '❌';
  const note = authChecked ? '' : '  ← 该端点不校验 key，200 不代表 key 有效';
  console.log(`${mark} ${label.padEnd(26)} ${method.padEnd(5)} -> ${String(r.status).padEnd(4)} ${r.detail}${note}`);
}

const detail = results.find((r) => r.label === '项目详情');
const search = results.find((r) => r.label === '关键词搜索');
console.log('\n结论：');
if (!detail?.ok) {
  console.log('  key 无效或已失效。到 https://console.curseforge.com/ 重新生成。');
} else if (!search?.ok) {
  console.log('  key 有效，但未被授权访问搜索接口 —— 这与本站的诊断结果一致。');
  console.log('  「按数字 ID 查询」不受影响，照常可用（含 forgecdn 直链与测速）。');
  console.log('  想恢复搜索，到 console.curseforge.com 重新生成 key 后再跑一次本脚本。');
} else {
  console.log('  key 完全可用，搜索与详情接口都正常。');
}
