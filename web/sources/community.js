/**
 * Community search (Bilibili, Baidu Tieba) - and the honest boundary around it.
 *
 * Both platforms are impossible to *query* from a foreign-origin browser. This was
 * verified against the live services, not assumed:
 *
 *   api.bilibili.com/x/web-interface/search/type   -> HTTP 412 (anti-bot) and no CORS
 *   api.bilibili.com/x/web-interface/wbi/search/... -> HTTP 403
 *   s.search.bilibili.com/main/suggest             -> 200 JSON, but no CORS header
 *   tieba.baidu.com/mo/q/search/thread             -> 200 JSON, but no CORS header
 *   tieba.baidu.com/f/search/res                   -> HTTP 403
 *
 * Without `Access-Control-Allow-Origin` the browser discards the body before any script
 * can see it, and neither site may be framed (X-Frame-Options/CSP), so a static GitHub
 * Pages site has no legitimate way in. What this module therefore provides:
 *
 * 1. Query translation: each platform has its own search habits. Bilibili search is
 *    space-separated and benefits from the resource type; Tieba wants the bare subject
 *    (a pack name, not "modpack"). We build the right string per platform, plus aliases.
 * 2. One-click fan-out: open several searches at once, including a region mirror for
 *    Bilibili (`bilibili.com` is unreachable from some networks).
 * 3. An OPTIONAL relay: if the visitor configures their own RSSHub instance or CORS
 *    proxy, real community entries appear inline - labelled as community content and
 *    kept out of the download-speed scoring, because a forum post has no file to sample.
 *
 * Nothing here pretends a blocked request succeeded.
 */

import { ApiError } from '../lib/net.js';

// ------------------------------------------------------------------ query building

/**
 * Modpack and mod names are commonly romanised or abbreviated in Chinese communities, so
 * an alias table converts the common shorthands in both directions. Values are extra
 * search terms, not replacements.
 */
export const QUERY_ALIASES = {
  整合包: ['整合', 'modpack'],
  模组: ['mod', 'MOD'],
  模组包: ['整合包'],
  光影: ['shader', '光影包'],
  材质包: ['资源包', 'resourcepack'],
  资源包: ['材质包'],
  服务器: ['联机', '服务端'],
  数据包: ['datapack'],
  等价交换: ['ProjectE'],
  暮色森林: ['Twilight Forest'],
  虚无世界: ['Advent of Ascension'],
  匠魂: ['Tinkers Construct', '匠魂3'],
  机械动力: ['Create'],
  拔刀剑: ['SlashBlade'],
  生活大冒险: ['生活大冒险整合包'],
};

/** Search terms that mean "give me a downloadable pack" rather than "show me a video". */
const PACK_HINTS = /整合包|整合|模组包|服务端|pack/i;

/**
 * Builds the search string a platform's own users would type.
 *
 * @param {string} rawQuery  what the visitor typed
 * @param {{platform: string, type?: string, gameVersion?: string, loader?: string, loaderNames?: Set<string>}} context
 * @returns {{primary: string, variants: string[]}}
 */
export function buildSearchTerms(rawQuery, { platform, type = 'mod', gameVersion = '', loader = '', loaderNames = null } = {}) {
  const base = String(rawQuery ?? '').trim();
  const tokens = [base];
  const known = loaderNames instanceof Set ? loaderNames : null;
  const isLoader = loader && (!known || known.has(String(loader).toLowerCase()));
  // The query itself may already carry the community noun ("生活大冒险整合包"); adding it
  // again would just narrow the search for no reason.
  const mentions = (...words) => words.some((word) => base.includes(word));

  if (type === 'modpack' || PACK_HINTS.test(base)) {
    // "我的世界整合包" is the phrase people actually search with
    if (!mentions('我的世界', 'Minecraft', 'mc')) tokens.push('我的世界');
    if (!mentions('整合', 'pack')) tokens.push('整合包');
  } else if (type === 'mod') {
    if (!mentions('我的世界', 'Minecraft', 'mc')) tokens.push('我的世界');
    if (!mentions('模组', 'mod')) tokens.push('模组');
  } else if (type === 'shader') {
    if (!mentions('我的世界', 'Minecraft', 'mc')) tokens.push('我的世界');
    if (!mentions('光影', 'shader')) tokens.push('光影');
  } else if (type === 'resourcepack') {
    if (!mentions('我的世界', 'Minecraft', 'mc')) tokens.push('我的世界');
    if (!mentions('材质包', '资源包', 'resourcepack')) tokens.push('材质包');
  } else if (type === 'datapack') {
    if (!mentions('我的世界', 'Minecraft', 'mc')) tokens.push('我的世界');
    if (!mentions('数据包', 'datapack')) tokens.push('数据包');
  }

  if (gameVersion) tokens.push(gameVersion);
  // Only real loader names help: "java" or an author name would just add noise.
  if (isLoader) tokens.push(loader);

  const primary = [...new Set(tokens.filter(Boolean))].join(' ');
  const variants = new Set([primary, base]);

  // Alias expansion: add the most useful alias as its own alternative query.
  for (const [term, aliasList] of Object.entries(QUERY_ALIASES)) {
    if (base.includes(term)) variants.add(`${base.replace(term, aliasList[0])}${gameVersion ? ` ${gameVersion}` : ''}`);
  }
  if (platform === 'bilibili') {
    // Bilibili search favours a compact string; a trailing version alone matches too little.
    variants.add([base, type === 'modpack' ? '整合包' : '模组', gameVersion].filter(Boolean).join(' '));
  } else if (platform === 'tieba') {
    // Forums are organised by subject; the bare name finds the bar, the annotated phrase finds threads.
    variants.add(base);
    if (PACK_HINTS.test(base) && gameVersion) variants.add(`${base} ${gameVersion}`);
  }

  return { primary, variants: [...variants].filter(Boolean) };
}

// ------------------------------------------------------------------ destinations

/**
 * Every place we send the visitor. `kind` drives how the UI presents it:
 *   search  - a real search result page for the term
 *   forum   - a Tieba bar ("吧"), which is where a community actually lives
 *   home    - a site's own front door
 *
 * `mirrors` exists because `bilibili.com` and `tieba.baidu.com` are unreachable or
 * geo-restricted on some networks; the visitor picks a reachable host and we remember it.
 */
export const COMMUNITY_TARGETS = [
  {
    id: 'bilibili-search',
    label: 'B 站搜索',
    kind: 'search',
    note: '视频、专栏与合集；搜索接口有风控，浏览器无法直接取数据',
    hosts: [
      { id: 'main', label: 'bilibili.com', value: 'https://search.bilibili.com/all?keyword={q}&order=totalrank' },
      { id: 'tw', label: 'bilibili.com（港澳台）', value: 'https://search.bilibili.com/all?keyword={q}&order=totalrank&area=tw' },
    ],
  },
  {
    id: 'bilibili-dynamic',
    label: 'B 站专栏/动态',
    kind: 'search',
    note: '图文教程与整合包发布动态',
    hosts: [
      { id: 'main', label: 'bilibili.com', value: 'https://search.bilibili.com/article?keyword={q}&order=totalrank' },
      { id: 'tw', label: 'bilibili.com（港澳台）', value: 'https://search.bilibili.com/article?keyword={q}&order=totalrank&area=tw' },
    ],
  },
  {
    id: 'tieba-search',
    label: '贴吧全站搜索',
    kind: 'search',
    note: '帖子搜索；接口返回 JSON 但不允许跨域，只能跳转',
    hosts: [{ id: 'main', label: 'tieba.baidu.com', value: 'https://tieba.baidu.com/f/search/res?ie=utf-8&qw={q}' }],
  },
  {
    id: 'tieba-forum',
    label: '贴吧进吧',
    kind: 'forum',
    note: '直接进入对应「吧」，看最新帖',
    hosts: [
      { id: 'main', label: 'tieba.baidu.com', value: 'https://tieba.baidu.com/f?ie=utf-8&kw={q}' },
      { id: 'mo', label: '移动版', value: 'https://tieba.baidu.com/mo/q/m?kw={q}' },
    ],
  },
  {
    id: 'mcmod',
    label: 'MC 百科',
    kind: 'search',
    note: '中文模组资料最全的百科',
    hosts: [{ id: 'main', label: 'mcmod.cn', value: 'https://search.mcmod.cn/s?key={q}' }],
  },
  {
    id: 'minecraft-wiki-cn',
    label: '中文 Minecraft Wiki',
    kind: 'search',
    note: '机制、物品与版本说明',
    hosts: [{ id: 'main', label: 'zh.minecraft.wiki', value: 'https://zh.minecraft.wiki/index.php?search={q}' }],
  },
  {
    id: '9minecraft',
    label: '9Minecraft',
    kind: 'search',
    note: '英文站的模组搬运',
    hosts: [{ id: 'main', label: '9minecraft.net', value: 'https://www.9minecraft.net/?s={q}' }],
  },
  {
    id: 'curseforge-web',
    label: 'CurseForge 网页搜索',
    kind: 'search',
    note: '不需要 key 的网页搜索',
    hosts: [{ id: 'main', label: 'curseforge.com', value: 'https://www.curseforge.com/minecraft/search?search={q}' }],
  },
  {
    id: 'modrinth-web',
    label: 'Modrinth 网页搜索',
    kind: 'search',
    note: '不想配 key 时用它查 CurseForge 之外的来源',
    hosts: [{ id: 'main', label: 'modrinth.com', value: 'https://modrinth.com/mods?q={q}' }],
  },
  {
    id: 'planetminecraft',
    label: 'Planet Minecraft',
    kind: 'search',
    note: '英文社区，地图与整合包为主',
    hosts: [{ id: 'main', label: 'planetminecraft.com', value: 'https://www.planetminecraft.com/mods/?keywords={q}' }],
  },
  {
    id: 'mcbbs-archive',
    label: 'MCBBS 存档站',
    kind: 'search',
    note: '原 MCBBS 已关闭，这里是社区存档镜像',
    hosts: [{ id: 'main', label: 'archives.mcbbs.co', value: 'https://archives.mcbbs.co/search?q={q}' }],
  },
];

export function targetsFor(query, context = {}) {
  return COMMUNITY_TARGETS.map((target) => {
    const terms = buildSearchTerms(query, { ...context, platform: target.id.split('-')[0] });
    const host = target.hosts.find((entry) => entry.id === (context.mirror?.[target.id] ?? 'main')) ?? target.hosts[0];
    return {
      id: target.id,
      label: target.label,
      kind: target.kind,
      note: target.note,
      term: terms.primary,
      variants: terms.variants,
      hostId: host.id,
      hosts: target.hosts,
      url: host.value.replace('{q}', encodeURIComponent(terms.primary)),
    };
  });
}

/** Builds one editor-authenticated Bilibili upload-page URL for a whole batch of mods. */
export function buildBilibiliUploadUrl(names) {
  const list = names.map((name) => String(name).trim()).filter(Boolean);
  if (list.length === 0) return null;
  const title = list.length === 1 ? `${list[0]} 模组介绍与下载指路` : `我的世界整合包分享：${list.slice(0, 4).join(' / ')}${list.length > 4 ? ' 等' : ''}`;
  const params = new URLSearchParams({ title, copyright: '2' });
  return `https://member.bilibili.com/platform/upload/video/frame?${params}`;
}

// ------------------------------------------------------------------ optional relay

/** Relay targets a visitor may paste in. Presets are only hints - none are required. */
export const RELAY_PRESETS = [
  { id: 'rsshub', label: '自建 RSSHub', placeholder: 'http://127.0.0.1:1200', hint: 'docker run -d -p 1200:1200 diygod/rsshub' },
  { id: 'worker', label: '自建 CORS 代理', placeholder: 'https://your-worker.workers.dev/?url=', hint: 'Cloudflare Worker / cors-anywhere 形式的转发前缀' },
];

const RELAY_KEY = 'mmf:community-relay';

let relay = { enabled: false, base: '', bilibiliUid: '' };
let relayLoaded = false;

function loadRelay() {
  if (relayLoaded) return relay;
  relayLoaded = true;
  try {
    const stored = JSON.parse(localStorage.getItem(RELAY_KEY) ?? 'null');
    if (stored && typeof stored === 'object') {
      relay = {
        enabled: Boolean(stored.enabled),
        base: String(stored.base ?? '').trim(),
        bilibiliUid: String(stored.bilibiliUid ?? '').trim(),
      };
    }
  } catch { /* malformed storage: stay disabled */ }
  return relay;
}

export function getRelay() {
  return { ...loadRelay() };
}

export function setRelay(next) {
  const merged = { ...loadRelay(), ...next };
  merged.base = String(merged.base ?? '').trim().replace(/\/+$/, '');
  merged.bilibiliUid = String(merged.bilibiliUid ?? '').trim();
  merged.enabled = Boolean(merged.enabled) && Boolean(merged.base);
  relay = merged;
  relayLoaded = true;
  try {
    localStorage.setItem(RELAY_KEY, JSON.stringify(merged));
  } catch { /* private mode: keep it for this session only */ }
  return getRelay();
}

/** Joins a relay base with a path, honouring both prefix-proxy and base-URL forms. */
export function relayUrl(path) {
  const { base } = getRelay();
  if (!base) return null;
  const target = path.startsWith('http') ? path : `https://rsshub.app${path.startsWith('/') ? '' : '/'}${path}`;
  if (base.includes('{url}')) return base.replace('{url}', encodeURIComponent(target));
  if (base.includes('?url=')) return `${base}${encodeURIComponent(target)}`;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Minimal RSS/Atom reader - enough for the two feeds we consume, and nothing more. */
export function parseFeed(xml) {
  const text = String(xml ?? '');
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(text)) throw new ApiError('中继返回的内容不是 RSS/Atom');

  const pick = (block, tag) => {
    const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    if (!match) return '';
    const unwrapped = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    // Decode entities BEFORE stripping tags: an escaped tag ("&lt;img …&gt;") only becomes
    // something to strip after decoding, and a feed is untrusted input.
    return decodeEntities(unwrapped).replace(/<[^>]*>/g, ' ').replace(/\s{2,}/g, ' ').trim();
  };

  const blocks = text.match(/<(item|entry)[\s>][\s\S]*?<\/(item|entry)>/gi) ?? [];
  return blocks.map((block) => {
    const link = block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1] ?? pick(block, 'link');
    return {
      title: pick(block, 'title'),
      link,
      author: pick(block, 'author') || pick(block, 'dc:creator'),
      publishedAt: toIso(pick(block, 'pubDate') || pick(block, 'published') || pick(block, 'updated') || pick(block, 'dc:date')),
      summary: pick(block, 'description') || pick(block, 'summary') || pick(block, 'content'),
    };
  }).filter((entry) => entry.title && entry.link);
}

function toIso(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    // &amp; last, so an escaped entity ("&amp;lt;") does not become a real tag
    .replace(/&amp;/g, '&');
}

/**
 * Searches Bilibili through the configured relay.
 *
 * The route is RSSHub's `/bilibili/vsearch/:kw/:order?` (verified against the upstream
 * repository - `/bilibili/search/...` does not exist). RSSHub has NO Tieba route at all
 * (`lib/routes/` contains no tieba directory), so Tieba cannot be relayed and stays a
 * jump-out only. That asymmetry is stated in the UI rather than hidden.
 */
export async function relaySearch(query, { timeoutMs = 12000, fetchImpl = fetch } = {}) {
  const config = getRelay();
  if (!config.enabled || !config.base) return { enabled: false, entries: [], error: null };

  // Order 0 = 综合排序; the route's default is totalrank, which is what we want.
  const url = relayUrl(`/bilibili/vsearch/${encodeURIComponent(query)}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      credentials: 'omit',
      headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    const text = await response.text();
    if (!response.ok) {
      const hint = response.status >= 500 ? '（上游被限流，换实例或自建）' : '';
      return { enabled: true, entries: [], error: `中继返回 HTTP ${response.status}${hint}`, url };
    }
    const entries = parseFeed(text).slice(0, 12);
    return {
      enabled: true,
      entries,
      error: entries.length ? null : '中继响应里没有条目（可能是关键词无结果，或实例未启用该路由）',
      url,
    };
  } catch (error) {
    const message = error?.name === 'AbortError' ? '中继超时' : `中继不可达：${error?.message ?? error}`;
    return { enabled: true, entries: [], error: message, url };
  } finally {
    clearTimeout(timer);
  }
}

/** Health check for the settings panel: says plainly whether the relay answers. */
export async function relayHealth({ fetchImpl = fetch } = {}) {
  const config = getRelay();
  if (!config.base) return { ok: false, message: '未填写中继地址' };
  // /bilibili/hot-search is a real RSSHub route and needs no account, which makes it the
  // cheapest possible liveness probe for a candidate instance.
  const probePath = config.bilibiliUid ? `/bilibili/user/video/${encodeURIComponent(config.bilibiliUid)}` : '/bilibili/hot-search';
  const url = relayUrl(probePath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, credentials: 'omit' });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, message: `中继返回 HTTP ${response.status}${/50\d/.test(String(response.status)) ? '（实例上游被限流，换一个或自建）' : ''}` };
    }
    const entries = parseFeed(text);
    return {
      ok: entries.length > 0,
      entries: entries.length,
      message: entries.length ? `中继可用，读到 ${entries.length} 条` : '中继有响应但没有条目',
    };
  } catch (error) {
    return { ok: false, message: error?.name === 'AbortError' ? '中继超时' : `中继不可达：${error?.message ?? error}` };
  } finally {
    clearTimeout(timer);
  }
}
