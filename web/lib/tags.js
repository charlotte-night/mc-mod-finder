/**
 * Filter dropdown data.
 *
 * The live lists come from api.modrinth.com. If that call fails - offline, blocked,
 * API outage - the visitor still gets a usable version picker instead of an empty one,
 * and the caller says so in the UI rather than silently showing stale values.
 */

import { modrinth } from '../sources/modrinth.js';

/** Fallback game versions, newest first. Only used when the live tag call fails. */
export const SEED_GAME_VERSIONS = [
  '1.21.8', '1.21.7', '1.21.6', '1.21.5', '1.21.4', '1.21.3', '1.21.1', '1.21',
  '1.20.6', '1.20.5', '1.20.4', '1.20.3', '1.20.2', '1.20.1', '1.20',
  '1.19.4', '1.19.3', '1.19.2', '1.19.1', '1.19',
  '1.18.2', '1.18.1', '1.18',
  '1.17.1', '1.17',
  '1.16.5', '1.16.4', '1.16.3', '1.16.2', '1.16.1', '1.16',
  '1.15.2', '1.15.1', '1.15',
  '1.14.4', '1.14.3', '1.14.2', '1.14.1', '1.14',
  '1.12.2', '1.12.1', '1.12',
  '1.11.2', '1.10.2', '1.9.4', '1.8.9', '1.7.10',
];

export const SEED_LOADERS = [
  'fabric', 'forge', 'neoforge', 'quilt', 'liteloader', 'rift', 'modloader',
  'bukkit', 'spigot', 'paper', 'purpur', 'sponge', 'bungeecord', 'velocity', 'waterfall',
];

/**
 * @returns {Promise<{gameVersions: string[], loaders: string[], source: 'live'|'seed', error: string|null}>}
 */
export async function loadTags() {
  try {
    const tags = await modrinth.tags();
    if (!tags.gameVersions?.length) throw new Error('Modrinth 返回了空的版本列表');
    return { gameVersions: tags.gameVersions, loaders: tags.loaders ?? SEED_LOADERS, source: 'live', error: null };
  } catch (error) {
    return {
      gameVersions: SEED_GAME_VERSIONS,
      loaders: SEED_LOADERS,
      source: 'seed',
      error: error?.message ?? String(error),
    };
  }
}
