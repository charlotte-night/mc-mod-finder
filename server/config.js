import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env reader so the project stays dependency-free. */
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = readEnvFile(path.join(rootDir, '.env'));
const env = { ...fileEnv, ...process.env };

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const flag = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
};

const contact = env.CONTACT || 'https://github.com/example/mc-mod-finder';

export const config = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  dataDir: path.join(rootDir, 'data'),

  host: env.HOST || '127.0.0.1',
  port: int(env.PORT, 8765),

  /** Shown in the UI/health output. Set this when serving through a tunnel or domain. */
  publicUrl: (env.PUBLIC_URL || '').trim(),

  /**
   * Trust X-Forwarded-For. Only enable behind a reverse proxy / tunnel you control -
   * when clients can reach the port directly they can forge that header.
   */
  trustProxy: flag(env.TRUST_PROXY, false),

  contact,
  userAgent: `mc-mod-finder/1.0.0 (+${contact})`,

  /** CurseForge needs an official API key; without one the source is disabled, not faked. */
  curseforgeApiKey: (env.CURSEFORGE_API_KEY || '').trim(),

  speedTest: {
    maxBytes: int(env.SPEEDTEST_MAX_BYTES, 1024 * 1024),
    timeoutMs: int(env.SPEEDTEST_TIMEOUT_MS, 6000),
    /** Speeds are cached per CDN host: every Modrinth file lives on the same one. */
    hostTtlMs: int(env.SPEEDTEST_HOST_TTL, 600) * 1000,
    concurrency: 3,
  },

  cache: {
    searchTtlMs: int(env.SEARCH_CACHE_TTL, 300) * 1000,
    projectTtlMs: int(env.PROJECT_CACHE_TTL, 1800) * 1000,
    tagTtlMs: 24 * 3600 * 1000,
    /** Set DISABLE_DISK_CACHE=1 to keep everything in memory only. */
    diskEnabled: !flag(env.DISABLE_DISK_CACHE, false),
  },

  rateLimit: {
    enabled: flag(env.RATE_LIMIT, true),
    /** General /api traffic per client. */
    perMinute: int(env.RATE_LIMIT_PER_MINUTE, 120),
    burst: int(env.RATE_LIMIT_BURST, 40),
    /** Speed tests make the server pull real bytes, so they are capped much harder. */
    speedtestPerMinute: int(env.RATE_LIMIT_SPEEDTEST_PER_MINUTE, 8),
    speedtestBurst: int(env.RATE_LIMIT_SPEEDTEST_BURST, 3),
    /** Refuse rather than queue once this many speed tests are in flight. */
    speedtestConcurrent: int(env.SPEEDTEST_CONCURRENT, 3),
    maxTrackedClients: 5000,
  },
};

export function describeConfig() {
  return {
    port: config.port,
    host: config.host,
    curseforge: config.curseforgeApiKey ? 'configured' : 'missing-key',
    diskCache: config.cache.diskEnabled,
  };
}
