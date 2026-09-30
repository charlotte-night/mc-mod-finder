const DIMENSIONS = [
  { key: 'relevance', label: '名称相关度', cls: 'seg-relevance' },
  { key: 'popularity', label: '下载量', cls: 'seg-popularity' },
  { key: 'speed', label: '下载速度', cls: 'seg-speed' },
  { key: 'free', label: '免费程度', cls: 'seg-free' },
  { key: 'freshness', label: '更新活跃度', cls: 'seg-freshness' },
  { key: 'followers', label: '关注人数', cls: 'seg-followers' },
];

const DEFAULT_WEIGHTS = { relevance: 30, popularity: 20, speed: 20, free: 15, freshness: 10, followers: 5 };

const TYPE_LABELS = {
  mod: '模组',
  modpack: '整合包',
  resourcepack: '资源包',
  shader: '光影',
  datapack: '数据包',
  plugin: '插件',
};

const state = {
  weights: { ...DEFAULT_WEIGHTS },
  items: [],
  reports: [],
  query: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);
const dom = {
  form: $('searchForm'),
  query: $('query'),
  type: $('type'),
  version: $('version'),
  loader: $('loader'),
  sort: $('sort'),
  freeOnly: $('freeOnly'),
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
};

/**
 * Sites we cannot query over an API (no public endpoint, or an API key is
 * required). Rather than pretending to search them, we hand the query over.
 */
const EXTERNAL_SEARCHES = [
  { label: 'MC百科', url: (q) => `https://search.mcmod.cn/s?key=${encodeURIComponent(q)}` },
  { label: 'CurseForge 网页', url: (q) => `https://www.curseforge.com/minecraft/search?search=${encodeURIComponent(q)}` },
  { label: 'Modrinth 网页', url: (q) => `https://modrinth.com/mods?q=${encodeURIComponent(q)}` },
  { label: '9Minecraft', url: (q) => `https://www.9minecraft.net/?s=${encodeURIComponent(q)}` },
  { label: 'Planet Minecraft', url: (q) => `https://www.planetminecraft.com/mods/?keywords=${encodeURIComponent(q)}` },
];

function renderExternalLinks() {
  const query = dom.query.value.trim();
  dom.extLinks.replaceChildren();
  if (!query) {
    dom.extLinks.append(h('span', { class: 'muted', text: '输入关键词后可直接跳转' }));
    return;
  }
  for (const site of EXTERNAL_SEARCHES) {
    dom.extLinks.append(h('a', { href: site.url(query), target: '_blank', rel: 'noreferrer', text: site.label }));
  }
}

/** Minimal element builder - avoids innerHTML so platform text can never inject markup. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value;
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
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#262b36"/><rect x="12" y="12" width="10" height="10" fill="#3a4150"/><rect x="26" y="12" width="10" height="10" fill="#3a4150"/><rect x="12" y="26" width="10" height="10" fill="#3a4150"/><rect x="26" y="26" width="10" height="10" fill="#3a4150"/></svg>`,
);

function formatCount(value) {
  const n = Number(value) || 0;
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return null;
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MB`;
  return `${(value / 1073741824).toFixed(2)} GB`;
}

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

function showStatus(message, kind = 'busy') {
  dom.status.hidden = !message;
  dom.status.className = `status ${kind}`;
  dom.status.replaceChildren();
  if (!message) return;
  if (kind === 'busy') dom.status.append(h('span', { class: 'spinner' }));
  dom.status.append(h('span', { text: message }));
}

// ---------------------------------------------------------------- weights UI

function loadWeights() {
  try {
    const stored = JSON.parse(localStorage.getItem('mc-mod-finder:weights') ?? 'null');
    if (stored && typeof stored === 'object') {
      for (const dim of DIMENSIONS) {
        const value = Number(stored[dim.key]);
        if (Number.isFinite(value) && value >= 0) state.weights[dim.key] = value;
      }
    }
  } catch { /* ignore malformed storage */ }
}

function saveWeights() {
  localStorage.setItem('mc-mod-finder:weights', JSON.stringify(state.weights));
}

function renderWeights() {
  dom.weightsGrid.replaceChildren();
  for (const dim of DIMENSIONS) {
    const valueEl = h('span', { class: 'value', text: `${state.weights[dim.key]}%` });
    const slider = h('input', {
      type: 'range', min: '0', max: '60', step: '1',
      value: String(state.weights[dim.key]),
      oninput: (event) => {
        state.weights[dim.key] = Number(event.target.value);
        valueEl.textContent = `${state.weights[dim.key]}%`;
        saveWeights();
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
  const speed = state.weights.speed;
  const free = state.weights.free;
  summary.textContent = `推荐权重（速度 ${speed}% · 免费 ${free}%）— 点击调整`;
}

let rescoreTimer = null;
function scheduleRescore() {
  if (!state.query) return;
  clearTimeout(rescoreTimer);
  rescoreTimer = setTimeout(() => runSearch({ keepScroll: true }), 350);
}

// ---------------------------------------------------------------- api

async function loadSources() {
  try {
    const res = await fetch('/api/sources');
    const data = await res.json();
    dom.sourceStatus.replaceChildren();
    for (const source of data.sources) {
      const chip = h('span', { class: `chip ${source.enabled ? 'ok' : 'off'}`, title: source.reason ?? source.homepage },
        h('span', { class: 'dot' }), `${source.label}${source.enabled ? '' : '（未启用）'}`);
      dom.sourceStatus.append(chip);
    }
    const disabled = data.sources.filter((s) => !s.enabled);
    if (disabled.length) {
      dom.reports.hidden = false;
      dom.reports.replaceChildren(...disabled.map((s) => h('div', { class: 'report bad', text: `${s.label}：${s.reason}` })));
    }
  } catch (error) {
    dom.sourceStatus.replaceChildren(h('span', { class: 'chip off', text: '无法连接后端' }));
  }
}

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
 * Asks the backend to probe each platform. A platform can be reachable and hold a
 * valid key yet still refuse a specific endpoint, so this reports the actual state
 * instead of a bare on/off.
 */
async function loadDiagnosis({ force = false } = {}) {
  try {
    const data = await (await fetch(`/api/diagnose${force ? '?force=1' : ''}`)).json();
    dom.sourceStatus.replaceChildren();
    let curseforgeEntry = null;

    for (const source of data.sources) {
      const diagnosis = source.diagnosis;
      const state = diagnosis?.state ?? (source.enabled ? 'ok' : 'no-key');
      const label = DIAGNOSIS_LABEL[state] ?? state;
      const healthy = state === 'ok';
      const chip = h('span', {
        class: `chip ${healthy ? 'ok' : source.enabled ? 'by-id' : 'off'}`,
        title: diagnosis?.message ?? source.reason ?? source.homepage,
        style: 'cursor:help',
        onclick: () => loadDiagnosis({ force: true }),
      }, h('span', { class: 'dot' }), `${source.label}${label ? `（${label}）` : ''}`);
      dom.sourceStatus.append(chip);
      if (source.id === 'curseforge') curseforgeEntry = { source, state };
    }

    renderCurseforgePanel(curseforgeEntry);
    if (data.sources.some((s) => !s.enabled)) {
      dom.reports.hidden = false;
      dom.reports.replaceChildren(
        ...data.sources.filter((s) => !s.enabled)
          .map((s) => h('div', { class: 'report bad', text: `${s.label}：${s.reason}` })),
      );
    }
  } catch {
    dom.sourceStatus.replaceChildren(h('span', { class: 'chip off', text: '无法连接后端' }));
  }
}

function renderCurseforgePanel(entry) {
  if (!entry) return;
  const { source, state } = entry;
  if (!source.enabled) {
    dom.cfPanel.hidden = true;
    return;
  }
  const diagnosis = source.diagnosis;
  dom.cfPanel.hidden = false;

  if (state === 'ok') {
    dom.cfSummary.textContent = 'CurseForge 按数字 ID 查询';
    dom.cfHint.textContent = '搜索接口可用，也可以直接用上面的搜索框。这里适合精确查某个项目及其全部版本文件。';
    return;
  }

  dom.cfSummary.textContent = 'CurseForge 按数字 ID 查询 —— 搜索接口不可用，但这里照常能用';
  dom.cfHint.replaceChildren(
    h('b', { text: `诊断：${diagnosis?.message ?? state}` }),
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

async function lookupCurseforge() {
  const id = dom.cfId.value.trim();
  if (!id) {
    dom.cfResult.replaceChildren(h('div', { class: 'status error', text: '请输入数字项目 ID。' }));
    return;
  }
  dom.cfBtn.disabled = true;
  dom.cfResult.replaceChildren(h('div', { class: 'status busy' }, h('span', { class: 'spinner' }), '正在查询 CurseForge…'));
  try {
    const params = new URLSearchParams({ id });
    if (dom.version.value) params.set('version', dom.version.value);
    if (dom.loader.value) params.set('loader', dom.loader.value);
    params.set('weights', JSON.stringify(state.weights));

    const res = await fetch(`/api/curseforge/lookup?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

    const item = data.item;
    const scope = `${dom.version.value || '不限版本'}${dom.loader.value ? ` / ${dom.loader.value}` : ''}`;
    dom.cfResult.replaceChildren(
      h('p', {
        class: 'hint',
        text: item.download
          ? `按 ${scope} 匹配到 ${item.download.filename}（${(item.download.size / 1048576).toFixed(2)} MB，来自 forgecdn）`
          : `按 ${scope} 没有可直链下载的文件 —— 作者可能禁止第三方分发，这种情况下无法测速。`,
      }),
      renderCard(item, 0),
    );
  } catch (error) {
    dom.cfResult.replaceChildren(h('div', { class: 'status error', text: `查询失败：${error.message}` }));
  } finally {
    dom.cfBtn.disabled = false;
  }
}

async function loadTags() {
  try {
    const data = await (await fetch('/api/tags')).json();
    for (const version of data.gameVersions ?? []) {
      dom.version.append(h('option', { value: version, text: version }));
    }
    for (const loader of data.loaders ?? []) {
      dom.loader.append(h('option', { value: loader, text: loader }));
    }
    // default to the most recent release so results are immediately useful
    if (data.gameVersions?.length) dom.version.value = data.gameVersions[0];
  } catch { /* dropdowns stay at 不限 */ }
}

function buildSearchParams({ forSpeedtest = false } = {}) {
  const params = new URLSearchParams();
  params.set('q', dom.query.value.trim());
  params.set('type', dom.type.value);
  if (dom.version.value) params.set('version', dom.version.value);
  if (dom.loader.value) params.set('loader', dom.loader.value);
  params.set('sort', dom.sort.value);
  params.set('limit', forSpeedtest ? '12' : '20');
  if (dom.freeOnly.checked) params.set('freeOnly', '1');
  params.set('weights', JSON.stringify(state.weights));
  return params;
}

function syncUrl(params) {
  const url = new URL(window.location.href);
  url.search = '';
  for (const [key, value] of params) {
    if (key === 'weights' || key === 'limit') continue;
    if (value) url.searchParams.set(key, value);
  }
  history.replaceState(null, '', url);
}

async function runSearch({ keepScroll = false } = {}) {
  if (state.busy) return;
  const scrollY = window.scrollY;
  state.busy = true;
  dom.speedBtn.disabled = true;
  showStatus('正在检索各平台…');

  const params = buildSearchParams();
  syncUrl(params);

  try {
    const data = await (await fetch(`/api/search?${params}`)).json();
    if (data.error) throw new Error(data.error);
    state.items = data.items ?? [];
    state.reports = data.reports ?? [];
    state.query = data.query;
    renderReports();
    renderResults(data);
    dom.toolbar.hidden = false;
    dom.resultCount.textContent = `共 ${data.count} 条结果`;
    dom.tookMs.textContent = `（${data.tookMs} ms${data.rawCount !== data.count ? `，去重前 ${data.rawCount} 条` : ''}）`;
    showStatus('');
  } catch (error) {
    showStatus(`搜索失败：${error.message}`, 'error');
  } finally {
    state.busy = false;
    dom.speedBtn.disabled = false;
    if (keepScroll) window.scrollTo({ top: scrollY });
  }
}

function renderReports() {
  dom.reports.replaceChildren();
  const problems = state.reports.filter((report) => !report.ok);
  dom.reports.hidden = problems.length === 0;
  for (const report of problems) {
    const box = h('div', { class: 'report bad' });
    box.append(h('b', { text: `${report.label}：` }), report.error);
    if (report.diagnosis?.hint) {
      box.append(h('div', { style: 'margin-top:5px;opacity:.88;line-height:1.6', text: report.diagnosis.hint }));
    }
    dom.reports.append(box);
  }
}

// ---------------------------------------------------------------- speed test

async function runSpeedtest(items) {
  const targets = items
    .filter((item) => item.free?.directDownload || item.download)
    .slice(0, Number(dom.speedLimit.value) || 8)
    .map((item) => ({ key: item.key, source: item.source, id: item.id, slug: item.slug, title: item.title }));

  if (targets.length === 0) {
    showStatus('没有可直链下载的条目，无法测速（需先在对应平台网页下载的资源不计入）', 'error');
    return;
  }

  showStatus(`正在对 ${targets.length} 个条目做真实分块下载测速（同一 CDN 主机只测一次）…`);
  dom.speedBtn.disabled = true;
  try {
    const response = await fetch('/api/speedtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: targets,
        limit: targets.length,
        version: dom.version.value || null,
        loaders: dom.loader.value ? [dom.loader.value] : [],
      }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    const ok = Object.values(data.results ?? {}).filter((entry) => entry.ok).length;
    showStatus('');
    await runSearch({ keepScroll: true });
    const note = data.failed?.length ? `，${data.failed.length} 个没有可直链的文件` : '';
    showStatus(`测速完成：${ok} 个有结果${note}，已按新速度重新排序。`, ok ? 'info' : 'error');
  } catch (error) {
    showStatus(`测速失败：${error.message}`, 'error');
  } finally {
    dom.speedBtn.disabled = false;
  }
}

// ---------------------------------------------------------------- rendering

function renderResults(data) {
  dom.results.replaceChildren();
  dom.empty.hidden = state.items.length > 0;
  if (state.items.length === 0) {
    dom.empty.replaceChildren(h('p', { text: '没有找到结果。试试换个关键词，或把游戏版本/加载器放宽。' }));
    return;
  }
  state.items.forEach((item, index) => dom.results.append(renderCard(item, index)));
}

function renderCard(item, index) {
  const score = item.score ?? { total: 0, parts: {}, explanation: [] };
  const card = h('article', { class: 'card', style: `--rank-color:${rankColor(score.total)}` });

  const icon = h('img', {
    class: 'card-icon',
    src: item.iconUrl || PLACEHOLDER_ICON,
    alt: '',
    loading: 'lazy',
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
    h('button', {
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
      title: `TTFB ${speed.ttfbMs ?? '?'} ms，采样 ${speed.bytes} 字节，主机 ${speed.host}`,
    }));
  } else if (speed?.error) {
    badges.push(h('span', { class: 'badge speed-bad', text: `测速失败：${speed.error}` }));
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
      h('span', { class: 'score-label', text: `推荐分 · 第 ${index + 1} 位` }),
      h('span', { class: 'muted', text: score.speedMeasured ? '' : '（含未测速中性值）' })),
    bar,
    h('details', { class: 'score-details' },
      h('summary', { text: '推荐依据' }),
      legend,
      h('ul', { class: 'reasons' }, (score.explanation ?? []).map((line) => h('li', { text: line })))));
}

// ---------------------------------------------------------------- bootstrap

dom.form.addEventListener('submit', (event) => {
  event.preventDefault();
  renderExternalLinks();
  runSearch();
});
dom.query.addEventListener('input', renderExternalLinks);
dom.type.addEventListener('change', () => state.query && runSearch());
dom.version.addEventListener('change', () => state.query && runSearch());
dom.loader.addEventListener('change', () => state.query && runSearch());
dom.sort.addEventListener('change', () => state.query && runSearch());
dom.freeOnly.addEventListener('change', () => state.query && runSearch());
dom.resetWeights.addEventListener('click', () => {
  state.weights = { ...DEFAULT_WEIGHTS };
  saveWeights();
  renderWeights();
  scheduleRescore();
});
dom.speedBtn.addEventListener('click', () => runSpeedtest(state.items));
dom.cfBtn.addEventListener('click', lookupCurseforge);
dom.cfId.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    lookupCurseforge();
  }
});

async function boot() {
  loadWeights();
  renderWeights();
  renderExternalLinks();
  await Promise.all([loadDiagnosis(), loadTags()]);

  try {
    const health = await (await fetch('/api/health')).json();
    dom.footerNote.textContent = `后端 ${health.url ?? ''}`;
  } catch { /* non-fatal */ }

  const params = new URLSearchParams(window.location.search);
  if (params.get('q')) dom.query.value = params.get('q');
  if (params.get('type')) dom.type.value = params.get('type');
  if (params.get('version')) dom.version.value = params.get('version');
  if (params.get('loader')) dom.loader.value = params.get('loader');
  if (params.get('sort')) dom.sort.value = params.get('sort');
  if (params.get('freeOnly') === '1') dom.freeOnly.checked = true;

  if (dom.query.value.trim()) runSearch();
  else dom.query.focus();
}

boot();
