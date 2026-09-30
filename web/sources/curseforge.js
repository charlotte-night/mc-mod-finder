/**
 * CurseForge source, running in the visitor's browser with the visitor's own API key.
 *
 * Two facts decided this design (both verified against the live API):
 *
 * 1. `api.curseforge.com` answers CORS preflight/GET with the caller's origin and
 *    `Access-Control-Allow-Credentials: true`, so with a key the browser can call it.
 * 2. `mediafilez.forgecdn.net` - where CurseForge files actually live after a redirect -
 *    sends NO `Access-Control-Allow-Origin`, so the browser is not allowed to read the
 *    file bytes. That means CurseForge downloads can be *found* here but not
 *    byte-sampled. We say so instead of inventing a speed number.
 *
 * The key is never bundled: the old server read CURSEFORGE_API_KEY from `.env`, which
 * cannot exist in a static GitHub Pages build. A visitor may paste their own key, kept
 * in localStorage on their machine and sent only to api.curseforge.com.
 */

import { ApiError, fetchJson, curseforgeLimiter, apiLimiters } from '../lib/net.js';
import { projectCache, searchCache } from '../lib/cache.js';
import { classifyLicense } from '../lib/normalize.js';

const API = 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;

/** A stable, long-lived project used as a canary when checking key permissions. */
const CANARY_PROJECT_ID = 238222; // Just Enough Items

const KEY_STORAGE = 'mmf:curseforge-key';

export const CLASS_IDS = {
  mod: 6,
  modpack: 4471,
  resourcepack: 12,
  shader: 6552,
  datapack: 6945,
  world: 17,
};

const SORT_FIELDS = {
  relevance: 1,
  downloads: 6,
  updated: 3,
  newest: 11,
  popularity: 2,
};

/** CurseForge modLoaderType enum: 1=Forge 2=Cauldron 3=LiteLoader 4=Fabric 5=Quilt 6=NeoForge. */
const LOADER_TYPE_IDS = {
  forge: 1,
  cauldron: 2,
  liteloader: 3,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
};

/**
 * CurseForge mixes three different things into `gameVersions`: real Minecraft
 * versions, loader names ("Fabric", "NeoForge") and side tags ("Client"/"Server").
 * Only the first kind belongs in a version list.
 */
const LOADER_TAG_NAMES = new Set(Object.keys(LOADER_TYPE_IDS));
const SIDE_TAGS = new Set(['client', 'server']);

function isVersionTag(value) {
  const tag = String(value).toLowerCase();
  return !SIDE_TAGS.has(tag) && !LOADER_TAG_NAMES.has(tag);
}

export class CurseForgeError extends ApiError {
  constructor(message, code, detail) {
    super(message, { code });
    this.name = 'CurseForgeError';
    this.detail = detail;
  }
}

// ------------------------------------------------------------------ the API key

let apiKey = '';
let keyLoaded = false;

function loadKey() {
  if (keyLoaded) return apiKey;
  keyLoaded = true;
  try {
    apiKey = (localStorage.getItem(KEY_STORAGE) ?? '').trim();
  } catch {
    apiKey = '';
  }
  return apiKey;
}

export function getApiKey() {
  return loadKey();
}

/** Stores the visitor's key locally. Returns the normalized key. */
export function setApiKey(value) {
  const next = String(value ?? '').trim();
  keyLoaded = true;
  const changed = next !== apiKey;
  apiKey = next;
  try {
    if (next) localStorage.setItem(KEY_STORAGE, next);
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* private mode: keep it in memory for this session */ }
  if (changed) {
    // A different key means every cached CurseForge answer is suspect.
    for (const key of [...projectCache.entries.keys()]) {
      if (key.startsWith('curseforge:')) projectCache.delete(key);
    }
    for (const key of [...searchCache.entries.keys()]) {
      if (key.startsWith('curseforge:')) searchCache.delete(key);
    }
    resetDiagnosis();
  }
  return next;
}

export function hasApiKey() {
  return Boolean(getApiKey());
}

function requireKey() {
  if (!getApiKey()) {
    throw new CurseForgeError('未配置 CurseForge API key', 'NO_API_KEY');
  }
  return getApiKey();
}

async function cfFetch(path) {
  return fetchJson(`${API}${path}`, {
    headers: { 'x-api-key': requireKey() },
    limiter: curseforgeLimiter,
    rateLimiter: apiLimiters.curseforge,
    retries: 1,
  });
}

function loaderTypeId(name) {
  return LOADER_TYPE_IDS[String(name).toLowerCase()] ?? 0;
}

// ------------------------------------------------------------------ diagnosis

let diagnosis = null;
let diagnosedAt = 0;
const DIAGNOSIS_TTL_MS = 10 * 60 * 1000;

export function resetDiagnosis() {
  diagnosis = null;
  diagnosedAt = 0;
}

async function probeEndpoint(path) {
  try {
    await cfFetch(path);
    return { ok: true, status: 200 };
  } catch (error) {
    return { ok: false, status: error.status ?? 0, message: error.message };
  }
}

export const curseforge = {
  id: 'curseforge',
  label: 'CurseForge',
  homepage: 'https://www.curseforge.com/minecraft',

  status() {
    const enabled = hasApiKey();
    return {
      id: this.id,
      label: this.label,
      homepage: this.homepage,
      enabled,
      needsKey: true,
      reason: enabled
        ? null
        : '需要你自己的 CurseForge API key（免费申请：console.curseforge.com）。key 只保存在本机浏览器，不会上传到任何地方。',
      browserNote: '接口允许浏览器跨域访问，但文件所在的 mediafilez.forgecdn.net 不允许，因此 CurseForge 的文件无法在浏览器里采样测速。',
    };
  },

  /** @returns {Promise<{state, message, hint, checkedAt, endpoints}>} */
  async diagnose({ force = false } = {}) {
    if (!hasApiKey()) {
      return {
        state: 'no-key',
        message: '未配置 API key',
        hint: '到 https://console.curseforge.com/ 免费申请一个，粘贴到「数据源设置」里。',
        checkedAt: new Date().toISOString(),
        endpoints: {},
      };
    }
    if (!force && diagnosis && Date.now() - diagnosedAt < DIAGNOSIS_TTL_MS) return diagnosis;

    const [detail, search] = await Promise.all([
      probeEndpoint(`/mods/${CANARY_PROJECT_ID}`),
      probeEndpoint('/mods/search?gameId=432&classId=6&pageSize=1'),
    ]);

    let result;
    if (!detail.ok && (detail.status === 401 || detail.status === 403)) {
      result = {
        state: 'invalid-key',
        message: `key 被 CurseForge 拒绝（HTTP ${detail.status}）`,
        hint: 'key 无效或已失效。到 console.curseforge.com 重新生成一个再试。',
      };
    } else if (!detail.ok && detail.status === 0) {
      result = {
        state: 'unreachable',
        message: '浏览器无法访问 CurseForge 接口',
        hint: `请求被网络或浏览器拦截：${detail.message ?? '未知原因'}。若你使用广告拦截插件或公司代理，请放行 api.curseforge.com。`,
      };
    } else if (!detail.ok) {
      result = {
        state: 'unreachable',
        message: `无法连接 CurseForge（HTTP ${detail.status || '网络错误'}）`,
        hint: '检查网络或代理设置后重试。',
      };
    } else if (!search.ok && (search.status === 401 || search.status === 403)) {
      result = {
        state: 'search-blocked',
        message: 'key 有效，但未被授权访问搜索接口',
        hint: '详情 / 文件接口都正常，只有 /mods/search 返回 403 —— 这是 CurseForge 侧的授权问题。'
          + '解决办法：到 console.curseforge.com 重新生成 key（多位用户反馈重新生成后即恢复）。'
          + '在那之前可以用「按数字 ID 查询」，照样能拿到文件列表和网页地址。',
      };
    } else if (!search.ok) {
      result = {
        state: 'search-error',
        message: `搜索接口异常（HTTP ${search.status || '网络错误'}）`,
        hint: '稍后重试。',
      };
    } else {
      result = { state: 'ok', message: 'key 有效，搜索与详情接口都可用', hint: null };
    }

    diagnosis = {
      ...result,
      checkedAt: new Date().toISOString(),
      endpoints: {
        detail: detail.status || 'network-error',
        search: search.status || 'network-error',
      },
    };
    diagnosedAt = Date.now();
    return diagnosis;
  },

  async search({ query, projectTypes, gameVersion, loaders, limit = 20, offset = 0, sort = 'relevance' }) {
    requireKey();

    const classId = CLASS_IDS[projectTypes?.[0]] ?? CLASS_IDS.mod;
    const params = new URLSearchParams();
    params.set('gameId', String(MINECRAFT_GAME_ID));
    params.set('classId', String(classId));
    params.set('searchFilter', query ?? '');
    params.set('pageSize', String(Math.min(Math.max(limit, 1), 50)));
    params.set('index', String(Math.max(offset, 0)));
    params.set('sortField', String(SORT_FIELDS[sort] ?? SORT_FIELDS.relevance));
    params.set('sortOrder', 'desc');
    if (gameVersion) params.set('gameVersion', gameVersion);
    if (loaders?.length) params.set('modLoaderType', String(loaderTypeId(loaders[0])));

    try {
      const payload = await searchCache.wrap(
        `curseforge:search:${params.toString()}`,
        () => cfFetch(`/mods/search?${params}`),
      );
      const items = (payload.data ?? []).map((mod) => normalizeMod(mod, { gameVersion }));
      return { items, total: payload.pagination?.totalCount ?? items.length, offset };
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        const info = await this.diagnose({ force: true });
        const blocked = info.state === 'search-blocked';
        throw new CurseForgeError(
          blocked
            ? 'CurseForge 拒绝了搜索：key 有效但未被授权访问 /mods/search（可改用「按 ID 查询」）'
            : 'CurseForge 拒绝了请求：API key 无效或已失效',
          blocked ? 'SEARCH_BLOCKED' : 'INVALID_KEY',
          info,
        );
      }
      throw error;
    }
  },

  /**
   * Detail lookup by numeric project id. Works even when the key may not search,
   * and it yields the file metadata behind each version.
   */
  async lookupById(input, { gameVersion, loaders } = {}) {
    requireKey();
    const projectId = parseProjectId(input);
    if (!projectId) {
      throw new CurseForgeError(
        '需要一个数字项目 ID。CurseForge 没有提供按名称查询的接口，网页 URL 里也不含 ID。',
        'BAD_ID',
      );
    }

    const payload = await projectCache.wrap(
      `curseforge:project:${projectId}`,
      () => cfFetch(`/mods/${projectId}`),
    );
    const mod = payload.data;
    if (!mod) throw new CurseForgeError(`找不到项目 ${projectId}`, 'NOT_FOUND');

    const files = await this.files(projectId, { gameVersion, loaders });
    return normalizeMod(mod, { gameVersion, files });
  },

  /** Filtered file listing, newest first. */
  async files(projectId, { gameVersion, loaders, pageSize = 20 } = {}) {
    const params = new URLSearchParams();
    params.set('pageSize', String(Math.min(Math.max(pageSize, 1), 50)));
    if (gameVersion) params.set('gameVersion', gameVersion);
    if (loaders?.length) params.set('modLoaderType', String(loaderTypeId(loaders[0])));
    const payload = await projectCache.wrap(
      `curseforge:files:${projectId}:${params.toString()}`,
      () => cfFetch(`/mods/${projectId}/files?${params}`),
    );
    return (payload.data ?? []).filter((file) => file.isAvailable !== false);
  },

  /** Official endpoint that hands over a download URL when the file object hides it. */
  async downloadUrl(projectId, fileId) {
    const payload = await projectCache.wrap(
      `curseforge:url:${projectId}:${fileId}`,
      () => cfFetch(`/mods/${projectId}/files/${fileId}/download-url`),
    );
    return typeof payload.data === 'string' ? payload.data : null;
  },

  async resolveDownload(item, { gameVersion, loaders } = {}) {
    if (!hasApiKey()) return null;

    let download = item.download ?? null;
    if (!download && item.id) {
      const files = await this.files(item.id, { gameVersion, loaders });
      const chosen = files.find((file) => file.downloadUrl) ?? files[0];
      if (chosen) download = toDownload(chosen, item.loaders ?? []);
    }
    if (!download) return null;

    if (!download.url && download.versionId && item.id) {
      try {
        download.url = await this.downloadUrl(item.id, download.versionId);
      } catch { /* the caller reports "no direct link" */ }
    }
    return download.url ? download : null;
  },

  async tags() {
    if (!hasApiKey()) return null;
    return projectCache.wrap('curseforge:gameversions', async () => {
      const payload = await cfFetch('/minecraft/version');
      return { gameVersions: (payload.data ?? []).map((entry) => entry.versionString) };
    });
  },
};

/**
 * Accepts "238222", an object with .id, or a URL that carries the id as a query
 * parameter. CurseForge project pages are slug based and contain no id, so those
 * simply cannot be resolved - the caller reports that clearly.
 */
export function parseProjectId(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'object' && input.id) return parseProjectId(input.id);
  const text = String(input).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/[?&](?:projectid|projectId|modId)=(\d+)/i) ?? text.match(/\/(\d{4,})(?:[/?]|$)/);
  return match ? Number(match[1]) : null;
}

function toDownload(file, loaders) {
  return {
    url: file.downloadUrl ?? null,
    filename: file.fileName,
    size: file.fileLength ?? 0,
    versionId: String(file.id),
    versionNumber: file.displayName ?? file.fileName,
    gameVersions: (file.gameVersions ?? []).filter(isVersionTag),
    loaders,
    publishedAt: file.fileDate ? new Date(file.fileDate).toISOString() : null,
  };
}

function normalizeLoaders(mod, file) {
  const known = new Set(Object.keys(LOADER_TYPE_IDS));
  const fromMod = (mod.modLoaders ?? []).map((l) => String(l.id ?? '').split('-')[0].toLowerCase()).filter(Boolean);
  const fromFile = (file?.gameVersions ?? [])
    .map((v) => String(v).toLowerCase())
    .filter((v) => known.has(v));
  return [...new Set([...fromMod, ...fromFile])];
}

function normalizeMod(mod, { gameVersion, files } = {}) {
  const pool = files ?? (mod.latestFiles ?? []).filter((file) => file.isAvailable !== false);
  const matching = gameVersion ? pool.filter((file) => (file.gameVersions ?? []).includes(gameVersion)) : pool;
  const preferred = matching.length ? matching : pool;
  const withUrl = preferred.filter((file) => file.downloadUrl);
  const chosen = (withUrl.length ? withUrl : preferred)[0] ?? null;

  const authors = (mod.authors ?? []).map((a) => a.name).filter(Boolean);
  const distributionBlocked = mod.allowModDistribution === false;
  const downloadUrl = chosen?.downloadUrl ?? null;
  const loaders = normalizeLoaders(mod, chosen);
  const license = classifyLicense(null, null);

  const reasons = [];
  if (distributionBlocked) {
    reasons.push('作者禁止第三方直链分发 → 只能在 CurseForge 网页下载（含广告）');
  } else if (downloadUrl) {
    reasons.push('CurseForge 给出 forgecdn 直链，无需付费（但浏览器无权读取文件字节，无法测速）');
  } else {
    reasons.push('该文件在当前 key 权限下没有直链，需在网页下载');
  }
  reasons.push('CurseForge 免费，但站点含广告，且部分作者提供付费提前体验');

  return {
    key: `curseforge:${mod.id}`,
    source: 'curseforge',
    sourceLabel: 'CurseForge',
    id: String(mod.id),
    slug: mod.slug,
    title: mod.name,
    description: mod.summary,
    author: authors.join(', ') || '未知',
    iconUrl: mod.logo?.thumbnailUrl ?? mod.logo?.url ?? null,
    pageUrl: mod.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/mc-mods/${mod.slug}`,
    projectType: Object.entries(CLASS_IDS).find(([, id]) => id === mod.classId)?.[0] ?? 'mod',
    downloads: mod.downloadCount ?? 0,
    followers: mod.thumbsUpCount ?? 0,
    updatedAt: mod.dateModified ? new Date(mod.dateModified).toISOString() : null,
    createdAt: mod.dateCreated ? new Date(mod.dateCreated).toISOString() : null,
    license,
    gameVersions: (chosen?.gameVersions ?? []).filter(isVersionTag),
    supportsRequestedVersion: gameVersion ? Boolean((chosen?.gameVersions ?? []).includes(gameVersion)) : null,
    categories: (mod.categories ?? []).map((c) => c.name).filter(Boolean),
    loaders,
    latestVersionId: chosen ? String(chosen.id) : null,
    latestVersionNumber: chosen?.displayName ?? null,
    download: chosen ? toDownload(chosen, loaders) : null,
    /** CurseForge's CDN refuses cross-origin reads, so this source cannot be sampled. */
    speedProbeable: false,
    speedNote: distributionBlocked
      ? '作者禁止第三方直链分发'
      : '文件所在 CDN 不允许浏览器读取字节',
    free: {
      isFree: true,
      directDownload: Boolean(downloadUrl),
      openSource: false,
      adSupported: true,
      reasons,
    },
  };
}
