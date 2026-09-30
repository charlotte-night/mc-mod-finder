import { clamp, freshnessScore, popularityScore, formatCount, formatBytes, daysSince } from './normalize.js';

/**
 * Default mix. The original goal was a recommendation driven by download speed and
 * whether the resource is free, so those two carry real weight by default - but every
 * weight is adjustable in the UI and the breakdown is always shown.
 */
export const DEFAULT_WEIGHTS = {
  relevance: 0.30,
  popularity: 0.20,
  speed: 0.20,
  free: 0.15,
  freshness: 0.10,
  followers: 0.05,
};

/** Anything that cannot be measured gets a neutral value, so it is neither buried nor boosted. */
export const NEUTRAL_SPEED_SCORE = 0.55;

const SPEED_FLOOR_KBPS = 50;
const SPEED_CEIL_KBPS = 5000;

export function normalizeWeights(weights = {}) {
  const merged = { ...DEFAULT_WEIGHTS, ...weights };
  const cleaned = {};
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const value = Number(merged[key]);
    cleaned[key] = Number.isFinite(value) && value >= 0 ? value : DEFAULT_WEIGHTS[key];
  }
  const sum = Object.values(cleaned).reduce((a, b) => a + b, 0);
  if (sum <= 0) return { ...DEFAULT_WEIGHTS };
  for (const key of Object.keys(cleaned)) cleaned[key] = cleaned[key] / sum;
  return cleaned;
}

export function relevanceScore(item, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return 0.5;
  const title = String(item.title ?? '').toLowerCase();
  const slug = String(item.slug ?? '').toLowerCase();
  const desc = String(item.description ?? '').toLowerCase();
  const author = String(item.author ?? '').toLowerCase();

  if (title === q) return 1;
  let score = 0;
  if (title.startsWith(q)) score = Math.max(score, 0.95);
  if (title.includes(q)) score = Math.max(score, 0.85);
  if (slug.includes(q.replace(/\s+/g, '-'))) score = Math.max(score, 0.8);
  if (author.includes(q)) score = Math.max(score, 0.68);
  // A multi-word query should still reward an author whose name only carries one of the
  // words ("create rails" -> author "create"). Single-word queries keep exact behaviour.
  const queryTokens = q.split(/\s+/).filter(Boolean);
  if (queryTokens.length > 1 && queryTokens.some((token) => token.length > 1 && author.includes(token))) {
    score = Math.max(score, 0.62);
  }
  if (desc.includes(q)) score = Math.max(score, 0.55);

  const tokens = q.split(/\s+/).filter((token) => token.length > 1);
  if (tokens.length > 1) {
    const inTitle = tokens.filter((token) => title.includes(token)).length / tokens.length;
    score = Math.max(score, 0.4 + 0.5 * inTitle);
  }
  return score > 0 ? clamp(score, 0, 1) : 0.3;
}

export function speedScore(kbps) {
  if (!Number.isFinite(kbps) || kbps <= 0) return null;
  const value = Math.log10(kbps / SPEED_FLOOR_KBPS) / Math.log10(SPEED_CEIL_KBPS / SPEED_FLOOR_KBPS);
  return clamp(value, 0, 1);
}

export function speedLabel(kbps) {
  if (!Number.isFinite(kbps) || kbps <= 0) return '未测速';
  if (kbps < 200) return '较慢';
  if (kbps < 800) return '一般';
  if (kbps < 3000) return '较快';
  return '很快';
}

/**
 * Free-ness as a score. Direct download + open licence is the best case; an
 * ad-walled web download is usable but penalised; a paywalled resource scores 0.
 */
export function freeScore(free) {
  if (!free) return 0.5;
  if (free.isFree === false) return 0;
  if (free.directDownload) return free.openSource ? 1 : 0.85;
  return 0.45;
}

export function followersScore(followers) {
  const value = Number(followers) || 0;
  if (value <= 0) return 0;
  const min = Math.log10(5);
  const max = Math.log10(20000);
  return clamp((Math.log10(value) - min) / (max - min), 0, 1);
}

export function scoreItem(item, { query = '', weights = DEFAULT_WEIGHTS, speed = null } = {}) {
  const effectiveWeights = normalizeWeights(weights);
  const measured = Boolean(speed?.ok && speed.kbps > 0);
  const measuredScore = speedScore(speed?.kbps);

  const raw = {
    relevance: relevanceScore(item, query),
    popularity: popularityScore(item.downloads),
    speed: measuredScore === null ? NEUTRAL_SPEED_SCORE : measuredScore,
    free: freeScore(item.free),
    freshness: freshnessScore(item.updatedAt),
    followers: followersScore(item.followers),
  };

  const parts = {};
  let total = 0;
  for (const [key, value] of Object.entries(raw)) {
    const contribution = value * effectiveWeights[key] * 100;
    total += contribution;
    parts[key] = {
      score: Number(value.toFixed(4)),
      weight: Number(effectiveWeights[key].toFixed(4)),
      contribution: Number(contribution.toFixed(2)),
      measured: key !== 'speed' || measured,
    };
  }

  return {
    total: Number(total.toFixed(1)),
    parts,
    weights: effectiveWeights,
    speedMeasured: measured,
    speedScore: measuredScore,
    explanation: explain({ item, raw, speed, measured, query }),
  };
}

function explain({ item, raw, speed, measured, query }) {
  const notes = [];

  if (query) {
    if (raw.relevance >= 0.95) notes.push('名称高度匹配搜索词');
    else if (raw.relevance >= 0.8) notes.push('名称包含搜索词');
    else if (raw.relevance >= 0.55) notes.push('简介命中搜索词');
    else notes.push('名称与简介匹配度一般');
  }

  notes.push(`下载量 ${formatCount(item.downloads)}`);
  if (item.followers) notes.push(`${formatCount(item.followers)} 人关注`);

  if (measured) {
    notes.push(`实测下载 ${speed.kbps} KB/s（${speedLabel(speed.kbps)}）`);
    if (speed.cached) notes.push('速度取自同一 CDN 主机的近期实测');
    if (speed.lowConfidence) notes.push('样本较短，速度值仅供参考');
    if (speed.ttfbMs) notes.push(`首字节 ${speed.ttfbMs} ms`);
  } else if (speed && speed.unsupported) {
    // Being unable to sample a source is a different verdict from trying and failing, and
    // the difference matters on CurseForge, whose CDN forbids cross-origin reads.
    notes.push('该下载源不允许浏览器读取文件内容，速度项按中性值计分');
  } else if (speed && speed.error) {
    notes.push(`测速未完成（${speed.error}），速度项按中性值计分`);
  } else {
    notes.push('尚未测速，速度项按中性值计分');
  }

  if (item.free?.directDownload) {
    notes.push(item.free.openSource ? `免费直链 + 开源许可 ${item.license?.id ?? ''}`.trim() : '免费直链（许可受限）');
  } else if (item.free?.isFree) {
    notes.push('免费但只能在网页下载（含广告）');
  } else {
    notes.push('需要付费或无法直接获取');
  }

  const days = daysSince(item.updatedAt);
  if (Number.isFinite(days)) {
    notes.push(
      days < 1 ? '今天刚更新'
        : days < 30 ? `${Math.round(days)} 天前更新`
          : days < 365 ? `${Math.round(days / 30)} 个月前更新`
            : `${(days / 365).toFixed(1)} 年前更新`,
    );
  }

  return notes;
}

export function formatScoreSummary(score) {
  return Object.entries(score.parts)
    .map(([key, part]) => `${key} ${(part.score * 100).toFixed(0)}×${(part.weight * 100).toFixed(0)}%=${part.contribution}`)
    .join(' ');
}

/** Sort comparators, lifted from the old server so ranking behaves identically. */
export function compareBy(sort) {
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

export { formatBytes, formatCount, popularityScore, freshnessScore };
