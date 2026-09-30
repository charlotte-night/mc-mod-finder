import { modrinth } from './modrinth.js';
import { curseforge } from './curseforge.js';
import { createLogger } from '../logger.js';

const log = createLogger('sources');

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
export async function searchAll({ query, projectTypes, gameVersion, loaders, limitPerSource = 20, offset = 0, sort = 'relevance', only = null }) {
  const targets = enabledSources().filter((source) => !only || only.includes(source.id));
  const settled = await Promise.all(
    targets.map(async (source) => {
      try {
        const result = await source.search({ query, projectTypes, gameVersion, loaders, limit: limitPerSource, offset, sort });
        return { source: source.id, label: source.label, ok: true, ...result };
      } catch (error) {
        log.warn(`${source.id} search failed: ${error.message}`);
        // Sources that can explain *why* they failed get to say so: a bare "403"
        // is useless to the user, "key valid but search not authorised" is not.
        let diagnosis = null;
        if (typeof source.diagnose === 'function') {
          try {
            diagnosis = await source.diagnose();
          } catch { /* diagnosis is best effort */ }
        }
        return {
          source: source.id,
          label: source.label,
          ok: false,
          items: [],
          total: 0,
          error: error.code === 'NO_API_KEY' ? '未配置 API key' : error.message,
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
