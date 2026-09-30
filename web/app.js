/**
 * MC Mod Finder - browser edition.
 *
 * This file replaces what used to be `server/index.js` + `public/app.js`. Every route
 * the old server exposed (search, tags, diagnose, CurseForge lookup, speedtest, cache
 * clearing, health) is now a function call against the visitor's own browser:
 *
 *   /api/search           -> runSearch()
 *   /api/tags             -> loadTags()
 *   /api/diagnose         -> loadDiagnosis()
 *   /api/curseforge/...   -> lookupCurseforge()
 *   /api/speedtest        -> runSpeedtest()
 *   /api/cache/clear      -> clearCache()
 *   /api/health           -> loadDiagnosis() + cacheStats()
 *
 * The scoring maths is imported from lib/scoring.js, unchanged from the server version.
 */

import { DEFAULT_WEIGHTS, normalizeWeights, scoreItem, compareBy, formatCount, formatBytes } from './lib/scoring.js';
import { cacheStats, clearAllCaches, hydrateCaches } from './lib/cache.js';
import { apiLimiters, describeFetchError } from './lib/net.js';
import { speedRegistry } from './lib/speedtest.js';
import { loadTags } from './lib/tags.js';
import { searchAll, resolveTargets, sourceStatuses } from './sources/index.js';
import { curseforge, hasApiKey, setApiKey } from './sources/curseforge.js';
import {
  COMMUNITY_TARGETS, buildBilibiliUploadUrl, getRelay, relayHealth, relaySearch,
  setRelay, targetsFor, buildSearchTerms,
} from './sources/community.js';

// ---------------------------------------------------------------- configuration

const DIMENSIONS = [
  { key: 'relevance', label: '名称相关度', cls: 'seg-relevance' },
  { key: 'popularity', label: '下载量', cls: 'seg-popularity' },
  { key: 'speed', label: '下载速度', cls: 'seg-speed' },
  { key: 'free', label: '免费程度', cls: 'seg-free' },
  { key: 'freshness', label: '更新活跃度', cls: 'seg-freshness' },
  { key: 'followers', label: '关注人数', cls: 'seg-followers' },
];

/** The UI works in whole percent; scoring.js normalizes and re-weights from these. */
const WEIGHT_PERCENT = { relevance: 30, popularity: 20, speed: 20, free: 15, freshness: 10, followers: 5 };

const TYPE_ALIASES = {
  all: ['mod', 'modpack', 'resourcepack', 'shader', 'datapack'],
  mod: ['mod'],
  modpack: ['modpack'],
  resourcepack: ['resourcepack'],
  shader: ['shader'],
  datapack: ['datapack'],
};

const API_SORT = {
  score: 'relevance',
  relevance: 'relevance',
  downloads: 'downloads',
  updated: 'updated',
  newest: 'newest',
  speed: 'relevance',
  free: 'relevance',
  followers: 'follows',
};

const TYPE_LABELS = {
  mod: '模组',
  modpack: '整合包',
  resourcepack: '资源包',
  shader: '光影',
  datapack: '数据包',
  plugin: '插件',
};

/** Sort orders that need nothing but the results we already hold. */
const CLIENT_SORTS = new Set(['score', 'speed', 'free', 'downloads', 'followers']);

/**
 * Sites whose front door is worth a quick link from the search box (Bilibili and Tieba
 * get the fuller treatment in the community panel below).
 */
const EXTERNAL_SEARCHES = [
  { label: 'MC百科', url: (q) => `https://search.mcmod.cn/s?key=${encodeURIComponent(q)}` },
  { label: 'B 站', url: (q) => `https://search.bilibili.com/all?keyword=${encodeURIComponent(q)}` },
  { label: '贴吧搜索', url: (q) => `https://tieba.baidu.com/f/search/res?ie=utf-8&qw=${encodeURIComponent(q)}` },
  { label: '中文 Wiki', url: (q) => `https://zh.minecraft.wiki/index.php?search=${encodeURIComponent(q)}` },
  { label: 'Modrinth 网页', url: (q) => `https://modrinth.com/mods?q=${encodeURIComponent(q)}` },
];

const PREF_KEY = 'mmf:prefs';

const state = {
  weights: { ...WEIGHT_PERCENT },
  items: [],
  reports: [],
  query: null,
  busy: false,
  speedBusy: false,
  lastSearch: null,
  lastTags: null,
};

const prefs = {
  speedLimit: 8,
  speedBytes: 1048576,
  communityMirror: 'main',
  communityAll: false,
};

// ---------------------------------------------------------------- dom helpers

const $ = (id) => document.getElementById(id);
const dom = {
  searchForm: $('searchForm'),
  query: $('query'),
  type: $('type'),
  version: $('version'),
  loader: $('loader'),
  sort: $('sort'),
  freeOnly: $('freeOnly'),
  measuredOnly: $('measuredOnly'),
  weightsBox: $('weightsBox'),
  weightsGrid: $('weightsGrid'),
  resetWeights: $('resetWeights'),
  toolbar: $('toolbar'),
  resultCount: $('resultCount'),
  tookMs: $('tookMs'),
  speedBtn: $('speedBtn'),
  speedLimit: $('speedLimit'),
  reports: $('reports'),
  status: $('status'),
  results: $('results'),
  empty: $('empty'),
  cfPanel: $('cfPanel'),
  cfSummary: $('cfSummary'),
  cfId: $('cfId'),
  cfBtn: $('cfBtn'),
  cfHint: $('cfHint'),
  cfResult: $('cfResult'),
  sourceStatus: $('sourceStatus'),
  extLinks: $('extLinks'),
  footerNote: $('footerNote'),
  envNotice: $('envNotice'),
  settingsToggle: $('settingsToggle'),
  settingsPanel: $('settingsPanel'),
  cfKeyInput: $('cfKeyInput'),
  cfKeySave: $('cfKeySave'),
  cfKeyClear: $('cfKeyClear'),
  cfKeyState: $('cfKeyState'),
  speedBytes: $('speedBytes'),
  clearCache: $('clearCache'),
  cacheState: $('cacheState'),
  communityPanel: $('communityPanel'),
  communitySummary: $('communitySummary'),
  communityTerm: $('communityTerm'),
  copyTerm: $('copyTerm'),
  openAll: $('openAll'),
  communityMirror: $('communityMirror'),
  communityAll: $('communityAll'),
  communityTargets: $('communityTargets'),
  communityRelay: $('communityRelay'),
  relayBase: $('relayBase'),
  relayUid: $('relayUid'),
  relaySave: $('relaySave'),
  relayClear: $('relayClear'),
  relayState: $('relayState'),
};

/** Minimal element builder - avoids innerHTML so platform text can never inject markup. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const PLACEHOLDER_ICON = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#262b36"/>`
  + `<rect x="12" y="12" width="10" height="10" fill="#3a4150"/><rect x="26" y="12" width="10" height="10" fill="#3a4150"/>`
  + `<rect x="12" y="26" width="10" height="10" fill="#3a4150"/><rect x="26" y="26" width="10" height="10" fill="#3a4150"/></svg>`,
);

// ---------------------------------------------------------------- formatting

function relativeTime(iso) {
  if (!iso) return null;
  const days = (Date.now() - Date.parse(iso)) / 86400000;
  if (!Number.isFinite(days)) return null;
  if (days < 1) return '今天';
  if (days < 30) return `${Math.round(days)} 天前`;
  if (days < 365) return `${Math.round(days / 30)} 个月前`;
  return `${(days / 365).toFixed(1)} 年前`;
}

function speedLabel(kbps) {
  if (!Number.isFinite(kbps) || kbps <= 0) return '未测速';
  if (kbps < 200) return '较慢';
  if (kbps < 800) return '一般';
  if (kbps < 3000) return '较快';
  return '很快';
}

function speedClass(kbps) {
  if (!Number.isFinite(kbps) || kbps <= 0) return 'speed-none';
  if (kbps < 200) return 'speed-bad';
  if (kbps < 800) return 'speed-mid';
  return 'speed-good';
}

function rankColor(score) {
  if (score >= 78) return 'var(--accent)';
  if (score >= 62) return 'var(--gold)';
  if (score >= 45) return 'var(--cyan)';
  return 'var(--border)';
}

function showStatus(message, kind = 'busy', extra = null) {
  dom.status.hidden = !message;
  dom.status.className = `status ${kind}`;
  dom.status.replaceChildren();
  if (!message) return;
  if (kind === 'busy') dom.status.append(h('span', { class: 'spinner' }));
  dom.status.append(h('span', { text: message }));
  if (extra) dom.status.append(extra);
}

function progressBar(fraction) {
  const bar = h('span', { class: 'status-progress' }, h('span', { style: `width:${Math.round(Math.min(Math.max(fraction, 0), 1) * 100)}%` }));
  return bar;
}

// ---------------------------------------------------------------- preferences

function loadPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(PREF_KEY) ?? 'null');
    if (stored && typeof stored === 'object') {
      for (const dim of DIMENSIONS) {
        const value = Number(stored.weights?.[dim.key]);
        if (Number.isFinite(value) && value >= 0) state.weights[dim.key] = value;
      }
      const limit = Number(stored.speedLimit);
      if (Number.isFinite(limit) && limit >= 1 && limit <= 16) prefs.speedLimit = Math.round(limit);
      const bytes = Number(stored.speedBytes);
      if (Number.isFinite(bytes) && bytes >= 65536 && bytes <= 4194304) prefs.speedBytes = bytes;
      if (stored.communityMirror === 'main' || stored.communityMirror === 'tw') prefs.communityMirror = stored.communityMirror;
      prefs.communityAll = Boolean(stored.communityAll);
    }
  } catch { /* malformed storage is not worth reporting */ }
}

function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({
      weights: state.weights,
      speedLimit: prefs.speedLimit,
      speedBytes: prefs.speedBytes,
      communityMirror: prefs.communityMirror,
      communityAll: prefs.communityAll,
    }));
  } catch { /* quota/private mode: preferences just will not persist */ }
}

// ---------------------------------------------------------------- weights UI

function renderWeights() {
  dom.weightsGrid.replaceChildren();
  for (const dim of DIMENSIONS) {
    const valueEl = h('span', { class: 'value', text: `${state.weights[dim.key]}%` });
    const slider = h('input', {
      type: 'range', min: '0', max: '60', step: '1',
      value: String(state.weights[dim.key]),
      'aria-label': dim.label,
      oninput: (event) => {
        state.weights[dim.key] = Number(event.target.value);
        valueEl.textContent = `${state.weights[dim.key]}%`;
        savePrefs();
        updateWeightsSummary();
        scheduleRescore();
      },
    });
    dom.weightsGrid.append(h('label', { class: 'weight-row' }, h('span', { text: dim.label }), slider, valueEl));
  }
  updateWeightsSummary();
}

function updateWeightsSummary() {
  const summary = dom.weightsBox.querySelector('summary');
  summary.textContent = `推荐权重（速度 ${state.weights.speed}% · 免费 ${state.weights.free}%）— 点击调整`;
}

let rescoreTimer = null;
function scheduleRescore() {
  if (!state.query) return;
  clearTimeout(rescoreTimer);
  // Re-scoring is pure arithmetic on results we already hold: no reason to re-hit the API.
  rescoreTimer = setTimeout(() => applyResults(), 150);
}

/** Weights are stored as whole percent and normalized by scoring.js. */
function scoringWeights() {
  return normalizeWeights(state.weights);
}

// ---------------------------------------------------------------- external links

function renderExternalLinks() {
  const query = dom.query.value.trim();
  dom.extLinks.replaceChildren();
  if (!query) {
    // The community panel covers the fan-out case properly; this row stays quiet until asked.
    dom.extLinks.append(h('span', { class: 'muted', text: '展开下面的「社区检索」，或输入关键词' }));
    return;
  }
  for (const site of EXTERNAL_SEARCHES) {
    dom.extLinks.append(h('a', { href: site.url(query), target: '_blank', rel: 'noreferrer', text: site.label }));
  }
}

// ---------------------------------------------------------------- community search

/**
 * Bilibili and Baidu Tieba cannot be queried from a foreign-origin browser (verified: no
 * CORS header on either, plus 412 anti-bot on Bilibili's search), so this panel does the
 * two things that actually work: it builds the search string each community's own users
 * would type, and it fans the search out in one click - including a Bilibili mirror for
 * networks where bilibili.com is unreachable.
 */
function currentCommunityContext() {
  const typeKey = dom.type.value;
  return {
    type: typeKey === 'all' ? 'mod' : typeKey,
    gameVersion: dom.version.value || '',
    loader: dom.loader.value || '',
    loaderNames: state.lastTags?.loaders ? new Set(state.lastTags.loaders) : null,
    mirror: Object.fromEntries(COMMUNITY_TARGETS.map((target) => [target.id, prefs.communityMirror])),
  };
}

function renderCommunity() {
  const raw = dom.query.value.trim();
  const context = currentCommunityContext();
  const terms = buildSearchTerms(raw, { ...context, platform: 'bilibili' });

  dom.communityTerm.className = raw ? '' : 'empty';
  dom.communityTerm.textContent = raw ? terms.primary : '（先在上面输入关键词）';
  dom.openAll.hidden = !raw;
  dom.communityMirror.value = prefs.communityMirror;
  dom.communityAll.checked = prefs.communityAll;

  const all = targetsFor(raw || '我的世界', context);
  const defaults = new Set(['bilibili-search', 'tieba-search', 'tieba-forum', 'mcmod']);
  const shown = prefs.communityAll ? all : all.filter((target) => defaults.has(target.id));

  dom.communityTargets.replaceChildren(...shown.map((target) => renderCommunityCard(target, raw)));

  if (!raw) {
    dom.communitySummary.textContent = '社区检索 · B 站 / 贴吧（浏览器抓不到它们的接口，这里生成对的搜索串并一键开搜）';
    dom.communityRelay.replaceChildren();
    return;
  }
  dom.communitySummary.textContent = `社区检索 · 「${terms.primary}」→ B 站 / 贴吧 / MC 百科（一键开搜）`;
}

function renderCommunityCard(target, raw) {
  const card = h('div', { class: 'community-card' });

  const openUrl = raw ? target.url : null;
  const openButton = h('button', {
    class: 'tiny primary', type: 'button', text: target.kind === 'forum' ? '进入吧' : '去搜索',
    disabled: !raw,
    onclick: () => { if (openUrl) window.open(openUrl, '_blank', 'noopener'); },
  });
  const copyButton = h('button', {
    class: 'tiny ghost', type: 'button', text: '复制链接',
    disabled: !raw,
    onclick: () => copyText(openUrl, `${target.label} 的搜索链接已复制`),
  });

  card.append(
    h('div', { class: 'community-card-head' },
      h('span', { class: 'community-card-title', text: target.label }),
      h('span', { class: `badge ${target.kind === 'forum' ? 'type' : ''}`, text: target.kind === 'forum' ? '吧' : '搜索' })),
    h('span', { class: 'community-term', text: raw ? target.term : '—' }),
    h('p', { class: 'hint', text: target.note }),
  );

  if (target.hosts.length > 1) {
    const select = h('select', {
      'aria-label': `${target.label} 线路`,
      onchange: (event) => {
        prefs.communityMirror = event.target.value;
        savePrefs();
        renderCommunity();
      },
    });
    for (const host of target.hosts) {
      select.append(h('option', { value: host.id, text: host.label, selected: host.id === target.hostId }));
    }
    card.append(select);
  }

  const actions = h('div', { class: 'community-card-actions' }, openButton, copyButton);
  // Publishing a walkthrough is the other half of "share with the community"; the title is
  // pre-filled from the search, and nothing is ever auto-submitted anywhere.
  if (target.id === 'bilibili-search' && raw) {
    const uploadUrl = buildBilibiliUploadUrl([raw]);
    if (uploadUrl) {
      actions.append(h('a', { href: uploadUrl, target: '_blank', rel: 'noreferrer', class: 'button-like' },
        h('button', { class: 'tiny', type: 'button', text: '投稿（预填标题）' })));
    }
  }
  card.append(actions);
  return card;
}

async function copyText(value, okMessage) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showStatus(okMessage, 'info');
    return;
  } catch { /* clipboard API needs a secure context and permission */ }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    showStatus(okMessage, 'info');
  } catch {
    showStatus(`复制失败，请手动选择复制：${value}`, 'error');
  }
}

/** Opens several searches at once. Browsers allow this from a user gesture; if a popup
 *  blocker still interferes we say so instead of silently dropping the rest. */
function openCommunityBatch() {
  const raw = dom.query.value.trim();
  if (!raw) {
    showStatus('先输入关键词，再一键开搜。', 'error');
    return;
  }
  const targets = targetsFor(raw, currentCommunityContext())
    .filter((target) => ['bilibili-search', 'tieba-search', 'tieba-forum', 'mcmod'].includes(target.id));
  let blocked = 0;
  targets.forEach((target, index) => {
    window.setTimeout(() => {
      const opened = window.open(target.url, '_blank', 'noopener');
      if (!opened) blocked++;
    }, index * 120);
  });
  window.setTimeout(() => {
    showStatus(
      blocked
        ? `浏览器拦截了 ${blocked} 个新标签页，请允许本站弹窗后重试，或逐个点卡片上的「去搜索」。`
        : `已在新标签页打开 ${targets.length} 个站点的搜索：${targets.map((t) => t.label).join('、')}。`,
      blocked ? 'error' : 'info',
    );
  }, targets.length * 120 + 200);
}

// ---------------------------------------------------------------- optional relay

function renderRelayState(message, kind = '') {
  dom.relayState.className = `hint ${kind}`;
  dom.relayState.textContent = message;
}

/**
 * The relay is the only way to actually *list* community entries, and it only exists if
 * the visitor brings one. It is presented as optional and its failures are stated plainly.
 */
async function renderCommunityRelay({ refresh = false } = {}) {
  const config = getRelay();
  if (!config.enabled || !config.base) {
    dom.communityRelay.replaceChildren();
    return;
  }
  const raw = dom.query.value.trim();
  dom.communityRelay.replaceChildren(h('div', { class: 'relay-note' }, h('span', { class: 'spinner' }), '正在通过中继读取 B 站搜索结果…'));
  const result = await relaySearch(raw || '我的世界');

  if (!result.enabled) {
    dom.communityRelay.replaceChildren();
    return;
  }
  if (result.error) {
    dom.communityRelay.replaceChildren(h('div', { class: 'relay-note' },
      `中继不可用：${result.error}。可以点上方卡片直接去 B 站搜索，或在「数据源设置」里换一个中继。`));
    return;
  }

  const list = h('div', { class: 'relay-list' }, result.entries.map((entry) => h('div', { class: 'relay-item' },
    h('a', { href: entry.link, target: '_blank', rel: 'noreferrer', text: entry.title }),
    h('span', {
      class: 'muted',
      text: [entry.author, entry.publishedAt ? relativeTime(entry.publishedAt) : null, '社区内容·不参与下载速度评分']
        .filter(Boolean).join(' · '),
    }),
  )));
  dom.communityRelay.replaceChildren(
    h('p', { class: 'hint', text: `以下 ${result.entries.length} 条来自你配置的中继（B 站）。社区帖子没有可下载文件，因此不计入推荐分的速度与免费程度。` }),
    list,
  );
  if (refresh) showStatus(`中继返回 ${result.entries.length} 条 B 站结果。`, 'info');
}

async function saveRelayConfig() {
  const base = dom.relayBase.value.trim();
  const bilibiliUid = dom.relayUid.value.trim();
  if (!base) {
    setRelay({ enabled: false, base: '', bilibiliUid });
    renderRelayState('已关闭中继。', 'key-state-warn');
    renderCommunity();
    return;
  }
  setRelay({ enabled: true, base, bilibiliUid });
  renderRelayState('正在检测中继…');
  const health = await relayHealth();
  renderRelayState(health.message, health.ok ? 'key-state-ok' : 'key-state-bad');
  renderCommunity();
  if (health.ok) await renderCommunityRelay();
}

// ---------------------------------------------------------------- sources & diagnosis

const DIAGNOSIS_LABEL = {
  ok: '',
  'no-key': '未配置 key',
  'invalid-key': 'key 无效',
  'search-blocked': '搜索未授权',
  'search-error': '搜索异常',
  unreachable: '不可达',
  error: '诊断失败',
};

/**
 * Probes each platform from the browser and renders the result as chips. A platform can
 * be reachable and hold a valid key yet still refuse a specific endpoint, so this reports
 * the actual state instead of a bare on/off.
 */
async function loadDiagnosis({ force = false } = {}) {
  const statuses = sourceStatuses();
  const results = await Promise.all(statuses.map(async (status) => {
    const source = status.id === 'curseforge' ? curseforge : null;
    let diagnosis = null;
    if (source?.diagnose) {
      try {
        diagnosis = await source.diagnose({ force });
      } catch (error) {
        diagnosis = { state: 'error', message: error.message, hint: null };
      }
    } else {
      diagnosis = { state: 'ok', message: '该数据源无需鉴权', hint: null };
    }
    return { ...status, diagnosis };
  }));

  renderSourceChips(results);
  renderCurseforgePanel(results.find((entry) => entry.id === 'curseforge'));
  renderKeyState(results.find((entry) => entry.id === 'curseforge'));
  return results;
}

function renderSourceChips(results) {
  dom.sourceStatus.replaceChildren();
  for (const source of results) {
    const diagnosis = source.diagnosis;
    const chipState = diagnosis?.state ?? (source.enabled ? 'ok' : 'no-key');
    const label = DIAGNOSIS_LABEL[chipState] ?? chipState;
    const healthy = chipState === 'ok';
    dom.sourceStatus.append(h('span', {
      class: `chip ${healthy ? 'ok' : source.enabled ? 'by-id' : 'off'}`,
      title: [diagnosis?.message ?? source.reason ?? source.browserNote ?? '', diagnosis?.hint ?? '', '点击重新检测']
        .filter(Boolean).join('\n'),
      style: 'cursor:help',
      onclick: () => loadDiagnosis({ force: true }),
    }, h('span', { class: 'dot' }), `${source.label}${label ? `（${label}）` : ''}`));
  }
  const problems = results.filter((source) => !source.enabled || (source.diagnosis && source.diagnosis.state !== 'ok'));
  if (problems.length) {
    dom.reports.hidden = false;
    dom.reports.replaceChildren(...problems.map((source) => h('div', { class: 'report bad' },
      h('b', { text: `${source.label}：` }),
      source.enabled ? (source.diagnosis?.message ?? '诊断失败') : (source.reason ?? '未启用'),
      source.diagnosis?.hint ? h('div', { style: 'margin-top:5px;opacity:.88;line-height:1.6', text: source.diagnosis.hint }) : null)));
  }
}

function renderKeyState(entry) {
  if (!entry) return;
  if (!hasApiKey()) {
    dom.cfKeyState.className = 'hint';
    dom.cfKeyState.textContent = '当前未配置 key：搜索结果只来自 Modrinth。';
    return;
  }
  const state_ = entry.diagnosis?.state;
  const ok = state_ === 'ok';
  dom.cfKeyState.className = `hint ${ok ? 'key-state-ok' : state_ === 'search-blocked' ? 'key-state-warn' : 'key-state-bad'}`;
  dom.cfKeyState.textContent = `${entry.diagnosis?.message ?? '已保存'}${entry.diagnosis?.hint ? ` —— ${entry.diagnosis.hint}` : ''}`;
}

function renderCurseforgePanel(entry) {
  if (!entry) return;
  if (!entry.enabled) {
    dom.cfPanel.hidden = true;
    return;
  }
  const diagnosis = entry.diagnosis;
  dom.cfPanel.hidden = false;

  if (diagnosis?.state === 'ok') {
    dom.cfSummary.textContent = 'CurseForge 按数字 ID 查询';
    dom.cfHint.textContent = '搜索接口可用，也可以直接用上面的搜索框。这里适合精确查某个项目及其文件列表。'
      + '注意：forgecdn 不允许浏览器读取文件字节，所以 CurseForge 的条目无法测速。';
    return;
  }

  dom.cfSummary.textContent = 'CurseForge 按数字 ID 查询 —— 搜索接口不可用，但这里照常能用';
  dom.cfHint.replaceChildren(
    h('b', { text: `诊断：${diagnosis?.message ?? '未知'}` }),
    h('br'),
    h('span', { text: diagnosis?.hint ?? '' }),
    h('br'),
    h('span', {
      class: 'muted',
      text: `接口探针：详情 ${diagnosis?.endpoints?.detail ?? '?'} / 搜索 ${diagnosis?.endpoints?.search ?? '?'}`
        + `　检查于 ${diagnosis?.checkedAt ? new Date(diagnosis.checkedAt).toLocaleTimeString() : '-'}（点右上角数据源标签可重新探测）`,
    }),
  );
}

// ---------------------------------------------------------------- tags

async function populateTags() {
  const tags = await loadTags();
  state.lastTags = tags;
  dom.version.replaceChildren(h('option', { value: '', text: '不限' }));
  dom.loader.replaceChildren(h('option', { value: '', text: '不限' }));
  for (const version of tags.gameVersions) dom.version.append(h('option', { value: version, text: version }));
  for (const loader of tags.loaders) dom.loader.append(h('option', { value: loader, text: loader }));
  // default to the most recent release so results are immediately useful
  if (tags.gameVersions.length) dom.version.value = tags.gameVersions[0];
  if (tags.source === 'seed') {
    appendNotice('versions', '版本列表来自内置兜底数据（Modrinth 标签接口暂时不可用），功能正常但可能缺少最新版本。', 'warn');
  }
}

// ---------------------------------------------------------------- notices

const notices = new Map();

function appendNotice(key, text, kind = 'warn') {
  notices.set(key, { text, kind });
  dom.envNotice.hidden = false;
  dom.envNotice.className = `notice${kind === 'error' ? ' error' : ''}`;
  dom.envNotice.replaceChildren(...[...notices.values()].map((entry) => h('div', { text: entry.text })));
}

function clearNotice(key) {
  if (!notices.delete(key)) return;
  dom.envNotice.hidden = notices.size === 0;
  dom.envNotice.replaceChildren(...[...notices.values()].map((entry) => h('div', { text: entry.text })));
}

// ---------------------------------------------------------------- search

function buildQuery() {
  const typeKey = dom.type.value;
  return {
    q: dom.query.value.trim(),
    types: TYPE_ALIASES[typeKey] ?? TYPE_ALIASES.mod,
    typeKey,
    gameVersion: dom.version.value || null,
    loaders: dom.loader.value ? [dom.loader.value] : [],
    sort: dom.sort.value,
    freeOnly: dom.freeOnly.checked,
    measuredOnly: dom.measuredOnly.checked,
  };
}

function syncUrl(query) {
  const url = new URL(window.location.href);
  url.search = '';
  if (query.q) url.searchParams.set('q', query.q);
  if (query.typeKey && query.typeKey !== 'mod') url.searchParams.set('type', query.typeKey);
  if (query.gameVersion) url.searchParams.set('version', query.gameVersion);
  if (query.loaders[0]) url.searchParams.set('loader', query.loaders[0]);
  if (query.sort && query.sort !== 'score') url.searchParams.set('sort', query.sort);
  if (query.freeOnly) url.searchParams.set('freeOnly', '1');
  if (query.measuredOnly) url.searchParams.set('measuredOnly', '1');
  url.hash = '';
  history.replaceState(null, '', url);
}

async function runSearch({ keepScroll = false } = {}) {
  if (state.busy) return;
  const scrollY = window.scrollY;
  state.busy = true;
  dom.speedBtn.disabled = true;
  const query = buildQuery();
  syncUrl(query);
  showStatus('正在检索各平台…');

  const startedSearch = Date.now();
  try {
    const result = await searchAll({
      query: query.q,
      projectTypes: query.types,
      gameVersion: query.gameVersion,
      loaders: query.loaders,
      limitPerSource: 20,
      offset: 0,
      sort: API_SORT[query.sort] ?? 'relevance',
    });
    state.lastSearch = {
      ...result,
      tookMs: Date.now() - startedSearch,
      query,
    };
    state.query = query;
    // If a server-side sort was requested, the platforms already ranked for it; if a
    // client-only sort was requested, applyResults() reorders.
    applyResults();
    showStatus('');
  } catch (error) {
    showStatus(`搜索失败：${describeFetchError(error)}`, 'error');
  } finally {
    state.busy = false;
    dom.speedBtn.disabled = false;
    if (keepScroll) window.scrollTo({ top: scrollY });
  }
}

/** Scores, filters, sorts and renders whatever the last fetch produced. */
function applyResults() {
  if (!state.lastSearch) return;
  const { query } = state.lastSearch;
  const weights = scoringWeights();

  let items = state.lastSearch.items.map((item) => {
    const speed = speedRegistry.known(item.key);
    return { ...item, speed, score: scoreItem(item, { query: query.q, weights, speed }) };
  });

  if (query.freeOnly) items = items.filter((item) => item.free?.directDownload);
  if (query.measuredOnly) items = items.filter((item) => item.speed?.ok);
  items.sort(compareBy(query.sort));

  state.items = items;
  state.reports = state.lastSearch.reports ?? [];

  renderReports();
  renderResults();

  dom.toolbar.hidden = false;
  const filtered = items.length !== state.lastSearch.items.length;
  dom.resultCount.textContent = `共 ${items.length} 条结果${filtered ? `（筛选前 ${state.lastSearch.items.length} 条）` : ''}`;
  dom.tookMs.textContent = `（${state.lastSearch.tookMs} ms${state.lastSearch.rawCount !== items.length ? `，去重/筛选前 ${state.lastSearch.rawCount} 条` : ''}）`;
  updateSpeedButton();
  updateFooterStats();
}

function renderReports() {
  dom.reports.replaceChildren();
  const problems = state.reports.filter((report) => !report.ok);
  const sourceProblems = sourceStatuses().filter((source) => !source.enabled);
  dom.reports.hidden = problems.length === 0 && sourceProblems.length === 0;
  for (const report of problems) {
    const box = h('div', { class: 'report bad' });
    box.append(h('b', { text: `${report.label}：` }), report.error);
    if (report.diagnosis?.hint) {
      box.append(h('div', { style: 'margin-top:5px;opacity:.88;line-height:1.6', text: report.diagnosis.hint }));
    }
    dom.reports.append(box);
  }
  for (const source of sourceProblems) {
    dom.reports.append(h('div', { class: 'report bad' }, h('b', { text: `${source.label}：` }), source.reason));
  }
}

// ---------------------------------------------------------------- rendering

function renderResults() {
  dom.results.replaceChildren();
  dom.empty.hidden = state.items.length > 0;
  if (state.items.length === 0) {
    dom.empty.replaceChildren(h('p', { text: '没有找到结果。试试换个关键词，或把游戏版本/加载器放宽。' }));
    return;
  }
  state.items.forEach((item, index) => dom.results.append(renderCard(item, index)));
}

/** Removes one card, re-scores, and puts the new card back where it now belongs. */
function refreshCard(item) {
  const card = dom.results.querySelector(`[data-key="${CSS.escape(item.key)}"]`);
  if (!card) return;
  const query = state.query ?? state.lastSearch?.query;
  item.speed = speedRegistry.known(item.key);
  item.score = scoreItem(item, { query: query?.q ?? '', weights: scoringWeights(), speed: item.speed });
  const index = state.items.indexOf(item);
  const replacement = renderCard(item, index < 0 ? 0 : index);
  card.replaceWith(replacement);
}

function renderCard(item, index) {
  const score = item.score ?? { total: 0, parts: {}, explanation: [] };
  const card = h('article', {
    class: 'card',
    dataset: { key: item.key },
    style: `--rank-color:${rankColor(score.total)}`,
  });

  const icon = h('img', {
    class: 'card-icon',
    src: item.iconUrl || PLACEHOLDER_ICON,
    alt: '',
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
    onerror: (event) => { event.target.src = PLACEHOLDER_ICON; },
  });

  const subtitle = h('div', { class: 'card-sub' },
    h('span', { class: `badge source-${item.source}`, text: item.sourceLabel }),
    h('span', { class: 'badge type', text: TYPE_LABELS[item.projectType] ?? item.projectType }),
    h('span', { text: item.author || '未知作者' }),
  );

  card.append(h('div', { class: 'card-head' }, icon,
    h('div', { style: 'min-width:0' },
      h('h3', { class: 'card-title' }, h('a', { href: item.pageUrl, target: '_blank', rel: 'noreferrer', text: item.title })),
      subtitle)));

  card.append(h('p', { class: 'card-desc', text: item.description || '（无简介）' }));
  card.append(renderBadges(item));
  card.append(renderStats(item));
  card.append(renderScore(score, index));
  card.append(h('div', { class: 'card-actions' },
    h('a', { href: item.pageUrl, target: '_blank', rel: 'noreferrer', class: 'button-like' },
      h('button', { class: 'tiny', type: 'button', text: '打开主页' })),
    item.speedProbeable === false
      ? h('span', { class: 'badge speed-none', text: item.speedNote ?? '无法在浏览器测速' })
      : h('button', {
        class: 'tiny', type: 'button', text: item.speed?.ok ? '重新测速' : '测速',
        onclick: () => runSpeedtest([item]),
      })));

  return card;
}

function renderBadges(item) {
  const badges = [];
  const free = item.free ?? {};
  if (free.directDownload && free.openSource) badges.push(h('span', { class: 'badge free-oss', text: `免费直链 · 开源 ${item.license?.id ?? ''}`.trim() }));
  else if (free.directDownload) badges.push(h('span', { class: 'badge free-yes', text: '免费直链' }));
  else if (free.isFree) badges.push(h('span', { class: 'badge free-web', text: '免费（需网页下载）' }));
  else badges.push(h('span', { class: 'badge speed-bad', text: '非免费' }));

  const speed = item.speed;
  if (speed?.ok) {
    badges.push(h('span', {
      class: `badge ${speedClass(speed.kbps)}`,
      text: `${speed.kbps} KB/s · ${speedLabel(speed.kbps)}${speed.cached ? '（同主机复用）' : ''}`,
      title: `TTFB ${speed.ttfbMs ?? '?'} ms，采样 ${speed.bytes ?? 0} 字节，主机 ${speed.host}`,
    }));
  } else if (speed?.unsupported) {
    badges.push(h('span', { class: 'badge speed-none', text: '此源无法测速', title: speed.error }));
  } else if (speed?.error) {
    badges.push(h('span', { class: 'badge speed-bad', text: `测速失败：${speed.error}`, title: speed.error }));
  } else {
    badges.push(h('span', { class: 'badge speed-none', text: '未测速' }));
  }

  if (state.query?.gameVersion) {
    if (item.supportsRequestedVersion === false) badges.push(h('span', { class: 'badge speed-mid', text: `可能不支持 ${state.query.gameVersion}` }));
    else badges.push(h('span', { class: 'badge', text: `支持 ${state.query.gameVersion}` }));
  }
  for (const loader of (item.loaders ?? []).slice(0, 3)) badges.push(h('span', { class: 'badge', text: loader }));

  return h('div', { class: 'badges' }, badges);
}

function renderStats(item) {
  const size = formatBytes(item.speed?.size ?? item.download?.size);
  const stats = [
    ['下载量', formatCount(item.downloads)],
    item.followers ? ['关注', formatCount(item.followers)] : null,
    relativeTime(item.updatedAt) ? ['更新', relativeTime(item.updatedAt)] : null,
    size ? ['文件大小', size] : null,
  ].filter(Boolean);

  return h('div', { class: 'stat-row' },
    stats.map(([label, value]) => h('span', { class: 'stat' }, `${label} `, h('b', { text: value }))));
}

function renderScore(score, index) {
  const parts = score.parts ?? {};
  const bar = h('div', { class: 'score-bar' },
    DIMENSIONS.map((dim) => {
      const part = parts[dim.key];
      const width = part ? Math.max(part.contribution, 0) : 0;
      return width > 0 ? h('span', {
        class: dim.cls,
        style: `width:${width}%`,
        title: `${dim.label} ${(part.score * 100).toFixed(0)} 分 × 权重 ${(part.weight * 100).toFixed(0)}%`,
      }) : null;
    }));

  const legend = h('div', { class: 'score-legend' },
    DIMENSIONS.map((dim) => {
      const part = parts[dim.key];
      if (!part) return null;
      return h('span', {},
        h('span', { class: `swatch ${dim.cls}` }),
        `${dim.label}`,
        h('span', { class: 'num', text: `${(part.score * 100).toFixed(0)}×${(part.weight * 100).toFixed(0)}%` }));
    }));

  return h('div', { class: 'score-block' },
    h('div', { class: 'score-top' },
      h('span', { class: 'score-value', text: score.total?.toFixed?.(1) ?? String(score.total ?? 0) }),
      h('span', { class: 'score-label', text: index >= 0 ? `推荐分 · 第 ${index + 1} 位` : '推荐分' }),
      h('span', { class: 'muted', text: score.speedMeasured ? '' : '（含未测速中性值）' })),
    bar,
    h('details', { class: 'score-details' },
      h('summary', { text: '推荐依据' }),
      legend,
      h('ul', { class: 'reasons' }, (score.explanation ?? []).map((line) => h('li', { text: line })))));
}

// ---------------------------------------------------------------- speed test

function speedTargets(items, limit) {
  return items
    .filter((item) => item.speedProbeable !== false)
    .filter((item) => item.free?.directDownload || item.download || item.source === 'modrinth')
    .slice(0, limit);
}

function updateSpeedButton() {
  const eligible = speedTargets(state.items, Number.MAX_SAFE_INTEGER).length;
  dom.speedBtn.disabled = state.busy || state.speedBusy || eligible === 0;
  dom.speedBtn.textContent = eligible ? `为推荐测速（${Math.min(eligible, prefs.speedLimit)} 个）` : '无可测速条目';
}

async function runSpeedtest(items) {
  if (state.speedBusy || state.busy) return;

  const limit = Math.min(Math.max(Number(dom.speedLimit.value) || prefs.speedLimit, 1), 16);
  const selection = speedTargets(items, limit);
  if (selection.length === 0) {
    showStatus('没有可直链下载的条目，无法测速（CurseForge 的文件在浏览器里读不到字节，需在平台网页下载的资源也不计入）', 'error');
    return;
  }
  const skipped = items.filter((item) => item.speedProbeable === false).length;

  state.speedBusy = true;
  dom.speedBtn.disabled = true;
  const startedAt = Date.now();
  try {
    showStatus(`正在解析 ${selection.length} 个条目的下载地址…`);
    const { targets, failed } = await resolveTargets(selection, {
      gameVersion: state.query?.gameVersion ?? null,
      loaders: state.query?.loaders ?? [],
    });

    if (targets.length === 0) {
      showStatus(`没有拿到可测速的直链：${failed.slice(0, 3).map((entry) => `${entry.title}（${entry.error}）`).join('；')}`, 'error');
      return;
    }

    const hosts = new Set(targets.map((target) => {
      try { return new URL(target.url).host; } catch { return null; }
    }).filter(Boolean));
    const budgetMb = (hosts.size * prefs.speedBytes / 1048576).toFixed(1);
    showStatus(
      `正在用你自己的网络实测 ${targets.length} 个条目（${hosts.size} 个 CDN 主机，每个采样最多 ${(prefs.speedBytes / 1048576).toFixed(1)} MB，合计约 ${budgetMb} MB）…`,
      'busy',
      progressBar(0),
    );

    const bar = dom.status.querySelector('.status-progress > span');
    const { results } = await speedRegistry.measureTargets(targets, {
      onProgress: ({ done, total }) => {
        if (bar) bar.style.width = `${Math.round((done / total) * 100)}%`;
      },
    });

    applyResults();
    for (const target of targets) {
      const item = state.items.find((entry) => entry.key === target.key);
      if (item && results[target.key]) refreshCard(item);
    }

    const measured = Object.values(results).filter((entry) => entry.ok).length;
    const unsupported = Object.values(results).filter((entry) => entry.unsupported).length;
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const notes = [];
    if (unsupported) notes.push(`${unsupported} 个源不允许浏览器取样`);
    if (failed.length) notes.push(`${failed.length} 个没有可直链的文件`);
    if (skipped) notes.push(`${skipped} 个数据源本身无法测速`);
    showStatus(
      `测速完成：${measured}/${targets.length} 个有结果，用时 ${seconds} 秒，已按新速度重新排序。`
      + (notes.length ? `（${notes.join('，')}）` : ''),
      measured ? 'info' : 'error',
    );
  } catch (error) {
    showStatus(`测速失败：${describeFetchError(error)}`, 'error');
  } finally {
    state.speedBusy = false;
    dom.speedBtn.disabled = false;
    updateSpeedButton();
    updateFooterStats();
  }
}

// ---------------------------------------------------------------- curseforge by id

async function lookupCurseforge() {
  const input = dom.cfId.value.trim();
  if (!input) {
    dom.cfResult.replaceChildren(h('div', { class: 'status error', text: '请输入数字项目 ID。' }));
    return;
  }
  if (!hasApiKey()) {
    dom.cfResult.replaceChildren(h('div', { class: 'status error', text: '这个功能需要 CurseForge API key，请先在上方「数据源设置」里填入。' }));
    return;
  }
  dom.cfBtn.disabled = true;
  dom.cfResult.replaceChildren(h('div', { class: 'status busy' }, h('span', { class: 'spinner' }), '正在查询 CurseForge…'));
  try {
    const item = await curseforge.lookupById(input, {
      gameVersion: dom.version.value || null,
      loaders: dom.loader.value ? [dom.loader.value] : [],
    });
    item.speed = speedRegistry.known(item.key);
    item.score = scoreItem(item, { query: item.title ?? '', weights: scoringWeights(), speed: item.speed });

    const scope = `${dom.version.value || '不限版本'}${dom.loader.value ? ` / ${dom.loader.value}` : ''}`;
    dom.cfResult.replaceChildren(
      h('p', {
        class: 'hint',
        text: item.download
          ? `按 ${scope} 匹配到 ${item.download.filename}（${(item.download.size / 1048576).toFixed(2)} MB，来自 forgecdn）——浏览器无权读取该 CDN 的字节，因此无法测速。`
          : `按 ${scope} 没有可直链下载的文件 —— 作者可能禁止第三方分发，或该 key 无权读取直链。`,
      }),
      h('div', { class: 'results' }, renderCard(item, -1)),
    );
  } catch (error) {
    const hint = error.detail?.hint ?? error.diagnosis?.hint ?? null;
    dom.cfResult.replaceChildren(
      h('div', { class: 'status error', text: `查询失败：${describeFetchError(error, { source: 'CurseForge' })}` }),
      hint ? h('p', { class: 'hint', text: hint }) : null,
    );
  } finally {
    dom.cfBtn.disabled = false;
  }
}

// ---------------------------------------------------------------- cache / health

function updateFooterStats() {
  const parts = [
    '纯前端 · 无后端',
    `已测速主机缓存 ${speedRegistry.stats().hosts} 个`,
  ];
  const cache = cacheStats();
  const entries = cache.reduce((sum, entry) => sum + entry.size, 0);
  const bytes = cache.reduce((sum, entry) => sum + entry.approxBytes, 0);
  parts.push(`本地缓存 ${entries} 项（约 ${(bytes / 1024).toFixed(0)} KB）`);
  const persistent = cache.filter((entry) => entry.persistent).length;
  parts.push(persistent === cache.length ? '缓存已落盘' : '部分缓存仅在内存（浏览器不允许本地存储）');
  const stats = speedRegistry.stats();
  if (stats.probes) parts.push(`本次会话真实下载采样 ${stats.probes} 次 / ${(stats.bytesRead / 1048576).toFixed(1)} MB`);
  dom.footerNote.textContent = parts.join(' · ');
  dom.cacheState.textContent = `本地缓存：${entries} 项，约 ${(bytes / 1024).toFixed(0)} KB。`;
}

function clearCache() {
  clearAllCaches();
  speedRegistry.clear();
  state.items = state.items.map((item) => ({ ...item, speed: null }));
  applyResults();
  updateFooterStats();
  showStatus('已清除本地缓存与测速结果。', 'info');
}

// ---------------------------------------------------------------- api key wiring

async function saveKey() {
  const value = dom.cfKeyInput.value.trim();
  setApiKey(value);
  dom.cfKeyInput.value = '';
  if (!value) {
    showStatus('已清除 CurseForge key。', 'info');
    await loadDiagnosis({ force: true });
    renderReports();
    return;
  }
  showStatus('正在用你的 key 探测 CurseForge 接口…');
  await loadDiagnosis({ force: true });
  applyResults();
  showStatus('');
}

// ---------------------------------------------------------------- bootstrap

function wireEvents() {
  dom.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    renderExternalLinks();
    renderCommunity();
    runSearch();
  });
  dom.query.addEventListener('input', () => {
    renderExternalLinks();
    renderCommunity();
  });
  dom.type.addEventListener('change', () => state.query && runSearch());
  dom.version.addEventListener('change', () => state.query && runSearch());
  dom.loader.addEventListener('change', () => state.query && runSearch());
  dom.sort.addEventListener('change', () => {
    // Server-side sorts need a refetch; client-side sorts just reorder what we hold.
    if (!state.query) return;
    if (CLIENT_SORTS.has(dom.sort.value) && state.lastSearch) {
      state.query.sort = dom.sort.value;
      syncUrl(state.query);
      applyResults();
    } else {
      runSearch();
    }
  });
  dom.freeOnly.addEventListener('change', () => state.query && applyResults());
  dom.measuredOnly.addEventListener('change', () => state.query && applyResults());
  dom.resetWeights.addEventListener('click', () => {
    state.weights = { ...WEIGHT_PERCENT };
    savePrefs();
    renderWeights();
    applyResults();
  });
  dom.speedBtn.addEventListener('click', () => runSpeedtest(state.items));
  dom.speedLimit.addEventListener('change', () => {
    const value = Math.min(Math.max(Number(dom.speedLimit.value) || 8, 1), 16);
    dom.speedLimit.value = String(value);
    prefs.speedLimit = value;
    savePrefs();
    updateSpeedButton();
  });
  dom.speedBytes.addEventListener('change', () => {
    prefs.speedBytes = Number(dom.speedBytes.value) || 1048576;
    savePrefs();
    updateFooterStats();
  });
  dom.cfBtn.addEventListener('click', lookupCurseforge);
  dom.cfId.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      lookupCurseforge();
    }
  });
  dom.cfKeySave.addEventListener('click', saveKey);
  dom.cfKeyClear.addEventListener('click', () => {
    setApiKey('');
    dom.cfKeyInput.value = '';
    loadDiagnosis({ force: true }).then(() => showStatus('已清除 CurseForge key。', 'info'));
  });
  dom.settingsToggle.addEventListener('click', () => {
    dom.settingsPanel.hidden = !dom.settingsPanel.hidden;
    dom.settingsToggle.setAttribute('aria-expanded', String(!dom.settingsPanel.hidden));
    if (!dom.settingsPanel.hidden) dom.settingsPanel.open = true;
  });
  dom.clearCache.addEventListener('click', clearCache);

  // ---- community panel
  dom.communityPanel.addEventListener('toggle', () => {
    if (dom.communityPanel.open) renderCommunityRelay();
  });
  dom.copyTerm.addEventListener('click', () => {
    const terms = buildSearchTerms(dom.query.value.trim(), currentCommunityContext());
    copyText(terms.primary, `已复制搜索串：${terms.primary}`);
  });
  dom.openAll.addEventListener('click', (event) => {
    event.preventDefault();
    openCommunityBatch();
  });
  dom.communityMirror.addEventListener('change', () => {
    prefs.communityMirror = dom.communityMirror.value;
    savePrefs();
    renderCommunity();
  });
  dom.communityAll.addEventListener('change', () => {
    prefs.communityAll = dom.communityAll.checked;
    savePrefs();
    renderCommunity();
  });

  // ---- optional community relay
  dom.relaySave.addEventListener('click', saveRelayConfig);
  dom.relayClear.addEventListener('click', () => {
    setRelay({ enabled: false, base: '', bilibiliUid: '' });
    dom.relayBase.value = '';
    dom.relayUid.value = '';
    renderRelayState('已关闭中继。', 'key-state-warn');
    renderCommunity();
  });
}

function detectEnvironment() {
  if (window.location.protocol === 'file:') {
    appendNotice(
      'file',
      '你正在用 file:// 直接打开这个页面。Chrome / Edge 会拦截本地文件的 ES module，导致页面空白 —— 请改用本地静态服务器（例如在 web 目录执行 python -m http.server 8080），或直接使用 GitHub Pages 上的地址。',
      'error',
    );
  }
  if (!window.isSecureContext && window.location.protocol !== 'file:') {
    appendNotice('insecure', '当前不是安全上下文（https），部分浏览器会限制跨域请求，建议通过 HTTPS 访问。');
  }
  if (!('fetch' in window) || !('AbortController' in window)) {
    appendNotice('old-browser', '当前浏览器过旧，缺少 fetch / AbortController，本站无法运行。请升级到较新的 Chrome、Edge、Firefox 或 Safari。', 'error');
  }
}

async function boot() {
  loadPrefs();
  hydrateCaches();
  dom.speedLimit.value = String(prefs.speedLimit);
  dom.speedBytes.value = String(prefs.speedBytes);
  dom.cfKeyInput.value = '';
  const relayConfig = getRelay();
  dom.relayBase.value = relayConfig.base;
  dom.relayUid.value = relayConfig.bilibiliUid;
  renderRelayState(
    relayConfig.enabled && relayConfig.base ? '中继已开启（展开「社区检索」查看结果）。' : '未配置中继，B 站只提供跳转搜索。',
    relayConfig.enabled && relayConfig.base ? 'key-state-ok' : '',
  );
  renderWeights();
  renderExternalLinks();
  renderCommunity();
  wireEvents();
  detectEnvironment();

  // Restore the search from the URL so a shared link reproduces the same query.
  const params = new URLSearchParams(window.location.search);
  if (params.get('q')) dom.query.value = params.get('q');
  if (params.get('type') && TYPE_ALIASES[params.get('type')]) dom.type.value = params.get('type');
  if (params.get('version')) dom.version.value = params.get('version');
  if (params.get('loader')) dom.loader.value = params.get('loader');
  if (params.get('sort')) dom.sort.value = params.get('sort');
  if (params.get('freeOnly') === '1') dom.freeOnly.checked = true;
  if (params.get('measuredOnly') === '1') dom.measuredOnly.checked = true;

  await populateTags();
  // Re-apply URL params: the dropdowns were rebuilt when the tag lists arrived.
  if (params.get('version')) dom.version.value = params.get('version');
  if (params.get('loader')) dom.loader.value = params.get('loader');

  updateFooterStats();
  await loadDiagnosis();

  if (dom.query.value.trim()) runSearch();
  else dom.query.focus();
}

boot();
