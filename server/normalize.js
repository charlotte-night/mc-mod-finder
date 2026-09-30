/** Shared helpers for turning platform payloads into one common result shape. */

/** Modrinth/CurseForge licence strings that mean "you may not freely reuse this". */
const RESTRICTIVE_LICENSES = new Set(['arr', 'all-rights-reserved', 'all rights reserved', 'custom', 'proprietary']);

const OPEN_SOURCE_HINTS = /(mit|apache|gpl|lgpl|agpl|mpl|bsd|isc|cc0|cc-by|unlicense|zlib|wtfpl|epl|cddl)/i;

export function classifyLicense(rawId, rawName) {
  const id = String(rawId ?? '').trim();
  const name = String(rawName ?? id).trim();
  const lower = id.toLowerCase();
  if (!id) {
    return { id: null, name: '未标注', openSource: false, restrictive: true };
  }
  const restrictive = RESTRICTIVE_LICENSES.has(lower);
  const openSource = !restrictive && (OPEN_SOURCE_HINTS.test(id) || OPEN_SOURCE_HINTS.test(name));
  return {
    id,
    name: name || id,
    openSource,
    restrictive,
  };
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function daysSince(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return Number.POSITIVE_INFINITY;
  return (Date.now() - time) / 86400000;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Maps a byte count to a 0..1 quality value on a log scale (1 MB .. 50 GB). */
export function popularityScore(downloads) {
  const value = Number(downloads) || 0;
  if (value <= 0) return 0;
  const min = Math.log10(1_000);
  const max = Math.log10(50_000_000);
  return clamp((Math.log10(value) - min) / (max - min), 0, 1);
}

/** Freshness on a log-ish scale: today = 1, ~3 years old = 0. */
export function freshnessScore(iso) {
  const days = daysSince(iso);
  if (!Number.isFinite(days)) return 0;
  if (days <= 0) return 1;
  const min = Math.log10(1);
  const max = Math.log10(1100);
  return clamp(1 - (Math.log10(Math.max(days, 1)) - min) / (max - min), 0, 1);
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatCount(value) {
  const n = Number(value) || 0;
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return String(n);
}
