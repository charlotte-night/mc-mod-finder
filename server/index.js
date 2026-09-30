import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { HttpError, Router, readJsonBody, sendJson, sendText } from './router.js';
import { searchAll, getSource, sources, sourceStatuses } from './sources/index.js';
import { cacheStats, searchCache, projectCache, tagCache } from './cache.js';
import { speedRegistry, itemSpeedCache } from './speedtest.js';
import { DEFAULT_WEIGHTS, scoreItem, normalizeWeights } from './scoring.js';
import { clamp } from './normalize.js';
import { RateLimiter, clientKey } from './ratelimit.js';

const log = createLogger('server');
const startedAt = Date.now();
let boundUrl = null;

const generalLimiter = new RateLimiter({
  name: 'api',
  capacity: config.rateLimit.burst,
  perMinute: config.rateLimit.perMinute,
  maxClients: config.rateLimit.maxTrackedClients,
});

const speedtestLimiter = new RateLimiter({
  name: 'speedtest',
  capacity: config.rateLimit.speedtestBurst,
  perMinute: config.rateLimit.speedtestPerMinute,
  maxClients: config.rateLimit.maxTrackedClients,
});

/** Speed tests make this server pull real bytes, so they are also capped globally. */
let speedtestsInFlight = 0;

/**
 * Returns false when the request was rejected. Public deployments live or die by
 * this: without it anyone could use the speed test as a free bandwidth sink.
 */
function rateLimitGuard(req, res, url) {
  if (!config.rateLimit.enabled) return true;
  if (!url.pathname.startsWith('/api/')) return true; // static assets are cheap

  const key = clientKey(req, { trustProxy: config.trustProxy });
  const isSpeedtest = url.pathname === '/api/speedtest' && req.method === 'POST';

  if (isSpeedtest) {
    const perClient = speedtestLimiter.check(key);
    if (!perClient.allowed) {
      res.setHeader('Retry-After', String(perClient.retryAfterSeconds));
      sendJson(res, 429, { error: '测速请求过于频繁，请稍后再试', retryAfterSeconds: perClient.retryAfterSeconds });
      return false;
    }
    if (speedtestsInFlight >= config.rateLimit.speedtestConcurrent) {
      res.setHeader('Retry-After', '3');
      sendJson(res, 429, { error: '服务器正在处理其它测速请求，请稍后再试', retryAfterSeconds: 3 });
      return false;
    }
  }

  const general = generalLimiter.check(key);
  if (!general.allowed) {
    res.setHeader('Retry-After', String(general.retryAfterSeconds));
    sendJson(res, 429, { error: '请求过于频繁', retryAfterSeconds: general.retryAfterSeconds });
    return false;
  }
  return true;
}

const TYPE_ALIASES = {
  all: ['mod', 'modpack', 'resourcepack', 'shader', 'datapack'],
  mod: ['mod'], mods: ['mod'], 模组: ['mod'],
  modpack: ['modpack'], modpacks: ['modpack'], 整合包: ['modpack'],
  resourcepack: ['resourcepack'], resourcepacks: ['resourcepack'], 资源包: ['resourcepack'],
  shader: ['shader'], shaders: ['shader'], 光影: ['shader'],
  datapack: ['datapack'], datapacks: ['datapack'], 数据包: ['datapack'],
  plugin: ['plugin'], 插件: ['plugin'],
};

const API_SORT = {
  score: 'relevance',
  relevance: 'relevance',
  downloads: 'downloads',
  updated: 'updated',
  newest: 'newest',
  speed: 'relevance',
  free: 'relevance',
  followers: 'follows',
  newestRelease: 'newest',
};

const SORTABLE = new Set(['score', 'downloads', 'speed', 'updated', 'relevance', 'free', 'followers', 'newest']);

function parseList(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveTypes(raw) {
  if (!raw || raw === 'all') return TYPE_ALIASES.all;
  const out = new Set();
  for (const token of parseList(raw)) {
    const mapped = TYPE_ALIASES[token.toLowerCase()];
    if (mapped) mapped.forEach((type) => out.add(type));
    else out.add(token);
  }
  return out.size ? [...out] : TYPE_ALIASES.all;
}

function parseWeights(searchParams) {
  const weights = { ...DEFAULT_WEIGHTS };
  const raw = searchParams.get('weights');
  if (raw) {
    try {
      Object.assign(weights, JSON.parse(raw));
    } catch {
      throw new HttpError(400, 'weights 参数不是合法 JSON');
    }
  }
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const value = searchParams.get(`w_${key}`);
    if (value !== null && value !== '') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) throw new HttpError(400, `权重 ${key} 必须是非负数`);
      weights[key] = parsed;
    }
  }
  return normalizeWeights(weights);
}

function parseIntParam(searchParams, name, fallback, min, max) {
  const raw = searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new HttpError(400, `参数 ${name} 必须是整数`);
  return clamp(parsed, min, max);
}

function compareBy(sort) {
  switch (sort) {
    case 'downloads':
      return (a, b) => (b.downloads ?? 0) - (a.downloads ?? 0);
    case 'followers':
      return (a, b) => (b.followers ?? 0) - (a.followers ?? 0);
    case 'updated':
    case 'newest':
      return (a, b) => (Date.parse(b.updatedAt ?? 0) || 0) - (Date.parse(a.updatedAt ?? 0) || 0);
    case 'speed':
      return (a, b) => ((b.speed?.kbps ?? -1) - (a.speed?.kbps ?? -1)) || (b.score.total - a.score.total);
    case 'relevance':
      return (a, b) => (b.score.parts.relevance.score - a.score.parts.relevance.score) || (b.score.total - a.score.total);
    case 'free':
      return (a, b) => (b.score.parts.free.score - a.score.parts.free.score) || (b.score.total - a.score.total);
    case 'score':
    default:
      return (a, b) => b.score.total - a.score.total;
  }
}

const router = new Router();

router.get('/api/health', (req, res) => {
  sendJson(res, 200, {
    ok: true,
    version: '1.0.0',
    url: boundUrl,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    sources: sourceStatuses(),
    caches: cacheStats(),
    speed: speedRegistry.stats(),
    rateLimit: {
      enabled: config.rateLimit.enabled,
      trustProxy: config.trustProxy,
      speedtestsInFlight,
      limiters: [generalLimiter.stats(), speedtestLimiter.stats()],
    },
    defaults: { weights: DEFAULT_WEIGHTS },
  });
});

router.get('/api/sources', (req, res) => {
  sendJson(res, 200, { sources: sourceStatuses() });
});

/**
 * Runs each source's own permission/health probe. CurseForge in particular can
 * accept a key on some endpoints and refuse it on others, which a plain
 * "enabled: true" cannot express.
 */
router.get('/api/diagnose', async (req, res, { url }) => {
  const force = url.searchParams.get('force') === '1';
  const results = await Promise.all(
    sources.map(async (source) => {
      const status = source.status();
      let diagnosis = null;
      if (typeof source.diagnose === 'function') {
        try {
          diagnosis = await source.diagnose({ force });
        } catch (error) {
          diagnosis = { state: 'error', message: error.message, hint: null };
        }
      } else if (status.enabled) {
        diagnosis = { state: 'ok', message: '该数据源无需鉴权', hint: null };
      }
      return { ...status, diagnosis };
    }),
  );
  sendJson(res, 200, { checkedAt: new Date().toISOString(), sources: results });
});

/**
 * CurseForge detail lookup by numeric project id. Works even when the key is not
 * allowed to use /mods/search, and yields a forgecdn URL that can be speed tested
 * against Modrinth's CDN.
 */
router.get('/api/curseforge/lookup', async (req, res, { url }) => {
  const input = url.searchParams.get('id') ?? url.searchParams.get('q') ?? '';
  if (!input.trim()) throw new HttpError(400, '需要 ?id=<数字项目ID>');

  const curseforge = getSource('curseforge');
  if (!curseforge.status().enabled) {
    throw new HttpError(503, '未配置 CURSEFORGE_API_KEY');
  }

  const gameVersion = url.searchParams.get('version') || null;
  const loaders = parseList(url.searchParams.get('loader'));
  const weights = parseWeights(url.searchParams);

  const item = await curseforge.lookupById(input, { gameVersion, loaders });
  const speed = speedRegistry.known(item.key);
  const score = scoreItem(item, { query: item.title ?? '', weights, speed });

  sendJson(res, 200, {
    item: { ...item, speed, score },
    projectId: item.id,
    matchedVersion: gameVersion,
  });
});

router.get('/api/tags', async (req, res) => {
  const modrinth = getSource('modrinth');
  const tags = await modrinth.tags();
  const curseforge = getSource('curseforge');
  let curseforgeVersions = null;
  if (curseforge.status().enabled) {
    try {
      const extra = await curseforge.tags();
      curseforgeVersions = extra?.gameVersions ?? null;
    } catch (error) {
      log.warn(`curseforge tags failed: ${error.message}`);
    }
  }
  sendJson(res, 200, {
    gameVersions: tags.gameVersions,
    loaders: tags.loaders,
    curseforgeVersions,
  });
});

router.get('/api/search', async (req, res, { url }) => {
  const params = url.searchParams;
  const query = params.get('q') ?? '';
  const types = resolveTypes(params.get('type'));
  const gameVersion = params.get('version') || null;
  const loaders = parseList(params.get('loader'));
  const sort = SORTABLE.has(params.get('sort')) ? params.get('sort') : 'score';
  const limit = parseIntParam(params, 'limit', 20, 1, 60);
  const offset = parseIntParam(params, 'offset', 0, 0, 1000);
  const only = parseList(params.get('source'));
  const freeOnly = params.get('freeOnly') === '1';
  const measuredOnly = params.get('measuredOnly') === '1';
  const weights = parseWeights(params);

  const startedSearch = Date.now();
  const result = await searchAll({
    query,
    projectTypes: types,
    gameVersion,
    loaders,
    limitPerSource: limit,
    offset,
    sort: API_SORT[sort] ?? 'relevance',
    only: only.length ? only : null,
  });

  let items = result.items.map((item) => {
    const speed = speedRegistry.known(item.key);
    const score = scoreItem(item, { query, weights, speed });
    return { ...item, speed, score };
  });

  if (freeOnly) items = items.filter((item) => item.free?.directDownload);
  if (measuredOnly) items = items.filter((item) => item.speed?.ok);

  items.sort(compareBy(sort));

  sendJson(res, 200, {
    query: { q: query, types, gameVersion, loaders, sort, limit, offset, freeOnly, measuredOnly },
    weights,
    tookMs: Date.now() - startedSearch,
    count: items.length,
    rawCount: result.rawCount,
    /** How many results the platforms report in total, before our per-page slice. */
    totalAvailable: result.reports.reduce((sum, report) => sum + (report.total ?? 0), 0),
    items,
    reports: result.reports,
  });
});

router.post('/api/speedtest', async (req, res) => {
  speedtestsInFlight++;
  try {
    await handleSpeedtest(req, res);
  } finally {
    speedtestsInFlight--;
  }
});

async function handleSpeedtest(req, res) {
  const body = await readJsonBody(req);
  const requested = Array.isArray(body.items) ? body.items : [];
  if (requested.length === 0) throw new HttpError(400, '需要在 items 里给出要测速的条目');
  const limit = clamp(Number(body.limit) || 8, 1, 16);
  const gameVersion = body.version || null;
  const loaders = Array.isArray(body.loaders) ? body.loaders : [];

  const targets = [];
  const failed = [];
  const selection = requested.slice(0, limit);

  await Promise.all(
    selection.map(async (entry) => {
      const source = getSource(entry.source);
      if (!source) {
        failed.push({ key: entry.key, error: '未知数据源 ' + entry.source });
        return;
      }
      try {
        const download = await source.resolveDownload(
          { id: entry.id, slug: entry.slug, title: entry.title },
          { gameVersion, loaders },
        );
        if (!download?.url) {
          failed.push({ key: entry.key, error: '没有可直链下载的文件' });
          return;
        }
        targets.push({ key: entry.key, url: download.url, size: download.size, download });
      } catch (error) {
        failed.push({ key: entry.key, error: error.message });
      }
    }),
  );

  const results = await speedRegistry.measureTargets(targets);

  for (const target of targets) {
    const result = results[target.key];
    if (result && target.download) {
      result.filename = target.download.filename;
      result.versionNumber = target.download.versionNumber;
      result.size = target.download.size ?? result.size;
    }
  }

  const values = Object.values(results);
  sendJson(res, 200, {
    measured: values.filter((entry) => entry.ok).length,
    errored: values.filter((entry) => !entry.ok).length,
    requested: selection.length,
    resolved: targets.length,
    failed,
    results,
    stats: speedRegistry.stats(),
  });
}

router.post('/api/cache/clear', (req, res) => {
  searchCache.clear();
  projectCache.clear();
  tagCache.clear();
  itemSpeedCache.clear();
  speedRegistry.hosts.clear();
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- static files

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, url) {
  const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.join(config.publicDir, relative);
  const normalizedPublic = path.resolve(config.publicDir) + path.sep;
  if (!path.resolve(filePath).startsWith(normalizedPublic)) {
    sendText(res, 403, 'forbidden');
    return;
  }
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendText(res, 404, 'not found');
      return;
    }
    const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    sendJson(res, 400, { error: 'bad request' });
    return;
  }
  try {
    if (!rateLimitGuard(req, res, url)) return;
  } catch (error) {
    log.error('rate limit guard failed', error);
  }
  router.handle(req, res, { fallback: serveStatic }).catch((error) => {
    log.error('unhandled request error', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  });
});

server.listen(config.port, config.host, () => {
  const { port, address } = server.address();
  const displayHost = address === '::' || address === '0.0.0.0' ? '127.0.0.1' : address;
  boundUrl = config.publicUrl || `http://${displayHost}:${port}`;
  log.info(`MC Mod Finder 已启动 -> ${boundUrl}`);
  if (config.host === '0.0.0.0' || config.host === '::') {
    log.warn(`正在监听所有网卡（0.0.0.0:${port}）。局域网地址可直接访问；暴露到公网前请确认已开启限流并只通过反向代理/隧道转发。`);
  }
  log.info(`数据源: ${sourceStatuses().map((s) => `${s.label}${s.enabled ? '' : '(未启用)'}`).join(', ')}`);
  for (const status of sourceStatuses()) {
    if (!status.enabled) log.warn(`${status.label}: ${status.reason}`);
  }
  log.info(`限流: ${config.rateLimit.enabled ? `开启（普通 ${config.rateLimit.perMinute}/分钟，测速 ${config.rateLimit.speedtestPerMinute}/分钟，并发 ${config.rateLimit.speedtestConcurrent}）` : '已关闭'}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log.error(`端口 ${config.port} 已被占用，请设置 PORT 环境变量换一个端口`);
  } else {
    log.error('服务器错误', error);
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info(`收到 ${signal}，正在关闭`);
    searchCache.saveToDisk();
    projectCache.saveToDisk();
    tagCache.saveToDisk();
    itemSpeedCache.saveToDisk();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

export { server, router };
