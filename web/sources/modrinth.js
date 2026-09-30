/**
 * Modrinth source, running entirely in the visitor's browser.
 *
 * `api.modrinth.com` sends `Access-Control-Allow-Origin: *` for the search, tag,
 * project and version endpoints (verified), so no proxy or server is involved. The one
 * browser-specific wrinkle is downloads: cdn.modrinth.com answers with a redirect whose
 * response omits that header, so byte sampling retries the `cdn-alt.modrinth.com`
 * hostname - see lib/speedtest.js.
 */

import { fetchJson, modrinthLimiter, apiLimiters } from '../lib/net.js';
import { projectCache, searchCache, tagCache } from '../lib/cache.js';
import { classifyLicense } from '../lib/normalize.js';

const API = 'https://api.modrinth.com/v2';

const SORT_INDEX = {
  relevance: 'relevance',
  downloads: 'downloads',
  follows: 'follows',
  newest: 'newest',
  updated: 'updated',
};

/** Used when /tag/loader is unreachable, so loader classification still works. */
const FALLBACK_LOADERS = [
  'forge', 'neoforge', 'fabric', 'quilt', 'liteloader', 'rift', 'modloader',
  'bukkit', 'spigot', 'paper', 'purpur', 'sponge', 'bungeecord', 'velocity', 'waterfall', 'datapack',
];

/** Modrinth returns loaders mixed into `categories`; these are the known loader tag names. */
let loaderNames = null;

async function getLoaderNames() {
  if (loaderNames) return loaderNames;
  try {
    const tags = await tagCache.wrap('modrinth:loaders', () =>
      fetchJson(`${API}/tag/loader`, { limiter: modrinthLimiter, rateLimiter: apiLimiters.modrinth }));
    loaderNames = new Set(tags.map((entry) => entry.name));
  } catch {
    loaderNames = new Set(FALLBACK_LOADERS);
  }
  return loaderNames;
}

export function buildFacets({ projectTypes, gameVersion, loaders }) {
  const facets = [];
  if (projectTypes?.length) {
    facets.push(projectTypes.map((type) => `project_type:${type}`));
  }
  if (gameVersion) {
    facets.push([`versions:${gameVersion}`]);
  }
  if (loaders?.length) {
    facets.push(loaders.map((loader) => `categories:${loader}`));
  }
  return facets;
}

function pageUrl(projectType, slug) {
  const section = projectType === 'modpack' ? 'modpack' : projectType;
  return `https://modrinth.com/${section}/${slug}`;
}

/**
 * Modrinth search hits carry no file information, so the download URL is resolved
 * lazily - the caller asks for it right before a speed test.
 */
async function normalizeHit(hit, { gameVersion } = {}) {
  const loaders = await getLoaderNames();
  const license = classifyLicense(hit.license, hit.license);
  const categories = hit.categories ?? [];
  return {
    key: `modrinth:${hit.project_id}`,
    source: 'modrinth',
    sourceLabel: 'Modrinth',
    id: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    author: hit.author,
    iconUrl: hit.icon_url,
    pageUrl: pageUrl(hit.project_type, hit.slug),
    projectType: hit.project_type,
    downloads: hit.downloads ?? 0,
    followers: hit.follows ?? 0,
    updatedAt: hit.date_modified,
    createdAt: hit.date_created,
    license,
    gameVersions: hit.versions ?? [],
    supportsRequestedVersion: gameVersion ? (hit.versions ?? []).includes(gameVersion) : null,
    categories: categories.filter((name) => !loaders.has(name)),
    loaders: categories.filter((name) => loaders.has(name)),
    latestVersionId: hit.latest_version ?? null,
    latestVersionNumber: null,
    download: null,
    speedProbeable: true,
    free: {
      isFree: true,
      directDownload: true,
      openSource: license.openSource,
      adSupported: false,
      reasons: [
        'Modrinth 提供直链下载，无需付费',
        license.restrictive
          ? `许可：${license.name}（受限制，二次分发需授权）`
          : `许可：${license.name}${license.openSource ? '（开源）' : ''}`,
        '站点无强制广告墙',
      ],
    },
  };
}

export const modrinth = {
  id: 'modrinth',
  label: 'Modrinth',
  homepage: 'https://modrinth.com',

  status() {
    return {
      id: this.id,
      label: this.label,
      homepage: this.homepage,
      enabled: true,
      needsKey: false,
      reason: null,
      browserNote: '搜索、标签、版本接口均允许浏览器跨域访问',
    };
  },

  async search({ query, projectTypes, gameVersion, loaders, limit = 20, offset = 0, sort = 'relevance' }) {
    const params = new URLSearchParams();
    params.set('query', query ?? '');
    params.set('limit', String(Math.min(Math.max(limit, 1), 100)));
    params.set('offset', String(Math.max(offset, 0)));
    params.set('index', SORT_INDEX[sort] ?? 'relevance');
    const facets = buildFacets({ projectTypes, gameVersion, loaders });
    if (facets.length) params.set('facets', JSON.stringify(facets));

    const cacheKey = `modrinth:search:${params.toString()}`;
    const payload = await searchCache.wrap(cacheKey, () =>
      fetchJson(`${API}/search?${params}`, { limiter: modrinthLimiter, rateLimiter: apiLimiters.modrinth }));

    const items = await Promise.all((payload.hits ?? []).map((hit) => normalizeHit(hit, { gameVersion })));
    return { items, total: payload.total_hits ?? items.length, offset: payload.offset ?? offset };
  },

  /** Resolve the concrete file a user would download, preferring the requested version/loader. */
  async resolveDownload(item, { gameVersion, loaders } = {}) {
    const params = new URLSearchParams();
    if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]));
    if (loaders?.length) params.set('loaders', JSON.stringify(loaders));
    const cacheKey = `modrinth:versions:${item.id}:${gameVersion ?? 'any'}:${(loaders ?? []).join(',')}`;

    const versions = await projectCache.wrap(cacheKey, async () => {
      const filtered = await fetchJson(`${API}/project/${item.id}/version?${params}`, {
        limiter: modrinthLimiter,
        rateLimiter: apiLimiters.modrinth,
      });
      if (Array.isArray(filtered) && filtered.length) return filtered;
      // fall back to the newest version of any kind so the visitor still gets something to test
      return fetchJson(`${API}/project/${item.id}/version`, {
        limiter: modrinthLimiter,
        rateLimiter: apiLimiters.modrinth,
      });
    });

    if (!Array.isArray(versions) || versions.length === 0) return null;
    const version = versions[0];
    const file = (version.files ?? []).find((f) => f.primary) ?? (version.files ?? [])[0];
    if (!file?.url) return null;
    return {
      url: file.url,
      filename: file.filename,
      size: file.size ?? 0,
      versionId: version.id,
      versionNumber: version.version_number,
      gameVersions: version.game_versions ?? [],
      loaders: version.loaders ?? [],
      publishedAt: version.date_published,
    };
  },

  async tags() {
    const [gameVersions, loaders] = await Promise.all([
      tagCache.wrap('modrinth:game_versions', () =>
        fetchJson(`${API}/tag/game_version`, { limiter: modrinthLimiter, rateLimiter: apiLimiters.modrinth })),
      tagCache.wrap('modrinth:loaders', () =>
        fetchJson(`${API}/tag/loader`, { limiter: modrinthLimiter, rateLimiter: apiLimiters.modrinth })),
    ]);
    return {
      gameVersions: gameVersions
        .filter((entry) => entry.version_type === 'release')
        .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
        .slice(0, 40)
        .map((entry) => entry.version),
      loaders: loaders
        .filter((entry) => entry.supported_project_types?.includes('mod'))
        .map((entry) => entry.name)
        .sort(),
    };
  },
};

export { pageUrl as modrinthPageUrl };
