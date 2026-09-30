/**
 * Source registry and the client-side replacement for the old `/api/search` fan-out.
 *
 * Everything the server used to do per request happens here instead: query each enabled
 * platform in parallel, keep a failing platform's error as a report rather than failing
 * the whole search, and de-duplicate projects that exist on both platforms.
 */

import { modrinth } from './modrinth.js';
import { curseforge } from './curseforge.js';
import { describeFetchError } from '../lib/net.js';

export const sources = [modrinth, curseforge];

export function getSource(id) {
  return sources.find((source) => source.id === id) ?? null;
}

export function enabledSources() {
  return sources.filter((source) => source.status().enabled);
}

export function sourceStatuses() {
  return sources.map((source) => source.status());
}

/**
 * Query every enabled source in parallel. A failing source never fails the whole
 * search - it is reported alongside the results instead.
 */
export async function searchAll({
  query,
  projectTypes,
  gameVersion,
  loaders,
  limitPerSource = 20,
  offset = 0,
  sort = 'relevance',
  only = null,
}) {
  const targets = enabledSources().filter((source) => !only || only.includes(source.id));
  const settled = await Promise.all(
    targets.map(async (source) => {
      try {
        const result = await source.search({ query, projectTypes, gameVersion, loaders, limit: limitPerSource, offset, sort });
        return { source: source.id, label: source.label, ok: true, ...result };
      } catch (error) {
        // Sources that can explain *why* they failed get to say so: a bare "403" is
        // useless to the visitor, "key valid but search not authorised" is not.
        let diagnosis = error.diagnosis ?? null;
        if (!diagnosis && typeof source.diagnose === 'function') {
          try {
            diagnosis = await source.diagnose();
          } catch { /* diagnosis is best effort */ }
        }
        const friendly = error.code === 'NO_API_KEY'
          ? '未配置 API key'
          : describeFetchError(error, { source: source.label });
        return {
          source: source.id,
          label: source.label,
          ok: false,
          items: [],
          total: 0,
          error: friendly,
          errorCode: error.code ?? null,
          diagnosis,
        };
      }
    }),
  );

  const items = settled.flatMap((entry) => entry.items ?? []);
  // A project can be listed on both platforms; keep the one with more downloads.
  const deduped = new Map();
  for (const item of items) {
    const key = `${item.projectType}:${(item.slug ?? item.title ?? '').toLowerCase()}`;
    const existing = deduped.get(key);
    if (!existing || (item.downloads ?? 0) > (existing.downloads ?? 0)) {
      deduped.set(key, item);
    }
  }

  return {
    items: [...deduped.values()],
    rawCount: items.length,
    reports: settled.map(({ items: _items, ...rest }) => rest),
  };
}

/**
 * Resolves the file a visitor would actually download, for the items that are about to
 * be speed tested. Returns `targets` (key + URL + size) and `failed` explanations.
 */
export async function resolveTargets(items, { gameVersion, loaders } = {}) {
  const targets = [];
  const failed = [];

  await Promise.all(items.map(async (entry) => {
    const source = getSource(entry.source);
    if (!source) {
      failed.push({ key: entry.key, title: entry.title, error: `未知数据源 ${entry.source}` });
      return;
    }
    if (entry.speedProbeable === false) {
      failed.push({ key: entry.key, title: entry.title, error: entry.speedNote ?? '该数据源不支持浏览器测速', unsupported: true });
      return;
    }
    try {
      const download = await source.resolveDownload(
        { id: entry.id, slug: entry.slug, title: entry.title, download: entry.download, loaders: entry.loaders },
        { gameVersion, loaders },
      );
      if (!download?.url) {
        failed.push({ key: entry.key, title: entry.title, error: '没有可直链下载的文件' });
        return;
      }
      targets.push({ key: entry.key, title: entry.title, url: download.url, size: download.size ?? null, download });
    } catch (error) {
      failed.push({ key: entry.key, title: entry.title, error: describeFetchError(error, { source: source.label }) });
    }
  }));

  return { targets, failed };
}
