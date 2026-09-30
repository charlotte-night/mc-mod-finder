import { config } from '../config.js';
import { fetchJson, limiters } from '../http.js';
import { projectCache, searchCache } from '../cache.js';
import { classifyLicense } from '../normalize.js';
import { createLogger } from '../logger.js';

const log = createLogger('curseforge');
const API = 'https://api.curseforge.com/v1';
const MINECRAFT_GAME_ID = 432;

/** A stable, long-lived project used as a canary when checking key permissions. */
const CANARY_PROJECT_ID = 238222; // Just Enough Items

const CLASS_IDS = {
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

export class CurseForgeError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'CurseForgeError';
    this.code = code;
    this.detail = detail;
  }
}

function apiKey() {
  return config.curseforgeApiKey;
}

async function cfFetch(path) {
  return fetchJson(`${API}${path}`, {
    headers: { 'x-api-key': apiKey() },
    limiter: limiters.curseforge,
    retries: 1,
  });
}

function loaderTypeId(name) {
  return LOADER_TYPE_IDS[String(name).toLowerCase()] ?? 0;
}

/**
 * A key can be perfectly valid and still be refused on /mods/search - CurseForge
 * decides access per endpoint. Telling "bad key" apart from "key not allowed to
 * search" is the difference between a useless error and an actionable one, so we
 * probe both and report which one actually failed.
 */
let diagnosis = null;
let diagnosedAt = 0;
const DIAGNOSIS_TTL_MS = 10 * 60 * 1000;

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
    const enabled = Boolean(apiKey());
    return {
      id: this.id,
      label: this.label,
      homepage: this.homepage,
      enabled,
      reason: enabled ? null : '未配置 CURSEFORGE_API_KEY（免费申请：console.curseforge.com）。未配置时不会伪造它的数据。',
    };
  },

  /** @returns {Promise<{state, message, hint, checkedAt, endpoints}>} */
  async diagnose({ force = false } = {}) {
    if (!apiKey()) {
      return {
        state: 'no-key',
        message: '未配置 API key',
        hint: '到 https://console.curseforge.com/ 免费申请一个，填进 .env 的 CURSEFORGE_API_KEY。',
        checkedAt: new Date().toISOString(),
        endpoints: {},
      };
    }
    if (!force && diagnosis && Date.now() - diagnosedAt < DIAGNOSIS_TTL_MS) {
      return diagnosis;
    }

    const [detail, search] = await Promise.all([
      probeEndpoint(`/mods/${CANARY_PROJECT_ID}`),
      probeEndpoint('/mods/search?gameId=432&classId=6&pageSize=1'),
    ]);

    let result;
    if (!detail.ok && (detail.status === 401 || detail.status === 403)) {
      result = {
        state: 'invalid-key',
        message: `key 被 CurseForge 拒绝（HTTP ${detail.status}）`,
        hint: 'key 无效或已失效。到 console.curseforge.com 重新生成一个再试 —— 社区里大量同类 403 都是这样解决的。',
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
        hint: '详情 / 文件 / 官方直链接口都正常，只有 /mods/search 返回 403，且响应里没有任何限流头 —— 这是 CurseForge 侧的授权问题，不是限流。'
          + '解决办法：到 console.curseforge.com 重新生成 key（多位用户反馈重新生成后即恢复）。'
          + '在那之前可以用「按数字 ID 查询」，照样能拿到 forgecdn 直链并测速。',
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
    log.info(`诊断: ${diagnosis.state} (detail=${diagnosis.endpoints.detail}, search=${diagnosis.endpoints.search})`);
    return diagnosis;
  },

  async search({ query, projectTypes, gameVersion, loaders, limit = 20, offset = 0, sort = 'relevance' }) {
    if (!apiKey()) throw new CurseForgeError('未配置 API key', 'NO_API_KEY');

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
      log.debug(`search "${query}" -> ${items.length}/${payload.pagination?.totalCount ?? 0}`);
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
   * and it yields a real forgecdn download URL for speed testing.
   */
  async lookupById(input, { gameVersion, loaders } = {}) {
    if (!apiKey()) throw new CurseForgeError('未配置 API key', 'NO_API_KEY');
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
    if (!apiKey()) return null;

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
      } catch (error) {
        log.debug(`download-url 查询失败 ${item.id}/${download.versionId}: ${error.message}`);
      }
    }
    return download.url ? download : null;
  },

  async tags() {
    if (!apiKey()) return null;
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
    reasons.push('CurseForge 提供 forgecdn 直链，无需付费');
  } else {
    reasons.push('该文件在当前 API 权限下没有直链，需在网页下载');
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
    free: {
      isFree: true,
      directDownload: Boolean(downloadUrl),
      openSource: false,
      adSupported: true,
      reasons,
    },
  };
}
