/**
 * Static-site checks for the GitHub Pages build.
 *
 * There is no browser in this environment, so instead of pretending to click through the
 * page these tests serve `web/` over real HTTP and check the things a browser would
 * silently fail on: a missing file, a module import that does not resolve, a wrong MIME
 * type (which makes Chrome refuse an ES module), an id the app looks up but the HTML never
 * defines, and absolute paths that would break on a project-page subdirectory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..', 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

/** Mirrors what GitHub Pages does: relative paths, index.html for "/". */
function requestHandler(root) {
  return (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const filePath = path.join(root, relative);
    if (!path.resolve(filePath).startsWith(path.resolve(root) + path.sep)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    fs.stat(filePath, (error, stats) => {
      if (error || !stats.isFile()) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': stats.size,
      });
      fs.createReadStream(filePath).pipe(response);
    });
  };
}

const server = http.createServer(requestHandler(webDir));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

test.after(() => server.close());

const read = (relative) => fs.readFileSync(path.join(webDir, relative), 'utf8');

const indexHtml = read('index.html');
const appJs = read('app.js');

// ------------------------------------------------------------------ assets

/** Every file a browser fetches for the page: stylesheets, scripts, icons, manifest. */
function pageAssets() {
  const found = new Set();
  for (const match of indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const value = match[1];
    if (/^(?:https?:|data:|#|mailto:)/.test(value)) continue;
    found.add(value);
  }
  return [...found];
}

test('the page references only relative asset paths', () => {
  const assets = pageAssets();
  // stylesheet + favicon + manifest + app.js
  assert.ok(assets.length >= 4, `only found ${assets.length} assets: ${assets.join(', ')}`);
  for (const asset of assets) {
    assert.ok(!asset.startsWith('/'), `${asset} is absolute and would break on a project page`);
  }
  assert.ok(assets.includes('./app.js'));
  assert.ok(assets.includes('./styles.css'));
});

for (const asset of pageAssets()) {
  test(`serves ${asset} with a browser-safe content type`, async () => {
    const response = await fetch(`${origin}/${asset.replace(/^\.\//, '')}`);
    assert.equal(response.status, 200, `${asset} returned ${response.status}`);
    const type = response.headers.get('content-type') ?? '';
    const expected = MIME[path.extname(asset).toLowerCase()];
    if (expected) assert.ok(type.startsWith(expected.split(';')[0]), `${asset} served as ${type}`);
    // ES modules are only executed when the type is exactly right
    if (asset.endsWith('.js')) assert.match(type, /^text\/javascript/);
  });
}

test('the manifest is reachable and valid JSON', async () => {
  const response = await fetch(`${origin}/manifest.webmanifest`);
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.equal(manifest.start_url.startsWith('/'), false, 'start_url must stay relative');
  assert.ok(manifest.icons.length > 0);
  for (const icon of manifest.icons) {
    const iconResponse = await fetch(`${origin}/${icon.src.replace(/^\.\//, '')}`);
    assert.equal(iconResponse.status, 200, `missing icon ${icon.src}`);
  }
});

test('the favicon exists and every manifest icon resolves', async () => {
  const response = await fetch(`${origin}/assets/icon.svg`);
  assert.equal(response.status, 200, 'assets/icon.svg is missing');
  assert.match(await response.text(), /<svg/);
});

// ------------------------------------------------------------------ modules

/** Follows every static import from an entry file and returns the resolved files. */
function importGraph(entry) {
  const seen = new Set();
  const missing = [];
  const queue = [entry];
  while (queue.length) {
    const relative = queue.shift();
    if (seen.has(relative)) continue;
    seen.add(relative);
    const absolute = path.join(webDir, relative);
    if (!fs.existsSync(absolute)) {
      missing.push(relative);
      continue;
    }
    const source = fs.readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue; // no bare specifiers: this is a no-build site
      queue.push(path.normalize(path.join(path.dirname(relative), specifier)).replace(/\\/g, '/'));
    }
  }
  return { files: [...seen], missing };
}

test('app.js and every module it imports resolve over HTTP', async () => {
  const { files, missing } = importGraph('app.js');
  assert.deepEqual(missing, [], `missing modules: ${missing.join(', ')}`);
  assert.ok(files.length >= 10, `only traced ${files.length} modules`);

  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    const response = await fetch(`${origin}/${file}`);
    assert.equal(response.status, 200, `${file} returned ${response.status}`);
    assert.match(response.headers.get('content-type') ?? '', /javascript/, `${file} served with the wrong type`);
  }
});

test('no module uses a bare import specifier', () => {
  const { files } = importGraph('app.js');
  for (const file of files) {
    if (!file.endsWith('.js')) continue;
    const source = fs.readFileSync(path.join(webDir, file), 'utf8');
    // Only real declaration heads: "import x from '...'", "export { x } from '...'",
    // and bare "import '...'" - prose inside comments must not be mistaken for an import.
    for (const match of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)) {
      const specifier = match[1];
      const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
      assert.ok(isRelative, `${file} imports "${specifier}" - there is no bundler to resolve it`);
    }
    for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
      assert.ok(match[1].startsWith('.'), `${file} side-effect imports "${match[1]}"`);
    }
  }
});

// ------------------------------------------------------------------ DOM contract

/** Ids the HTML actually defines, read without a DOM implementation. */
function definedIds() {
  const ids = new Set();
  for (const match of indexHtml.matchAll(/\sid="([^"]+)"/g)) ids.add(match[1]);
  return ids;
}

test('every element app.js looks up by id exists in the HTML', () => {
  const defined = definedIds();
  const looked = new Set();
  for (const match of appJs.matchAll(/\$\('([^']+)'\)/g)) looked.add(match[1]);
  assert.ok(looked.size >= 30, `only found ${looked.size} lookups`);

  const missing = [...looked].filter((id) => !defined.has(id));
  assert.deepEqual(missing, [], `app.js queries ids that do not exist: ${missing.join(', ')}`);
});

test('every id looked up is bound in the dom map', () => {
  // Read the `const dom = { ... }` literal: it is the single place where looked-up
  // elements become named handles, so every $() must feed one of its entries.
  const block = appJs.match(/const dom = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'could not find the dom map in app.js');
  const body = block[1];

  const bound = new Set();
  for (const match of body.matchAll(/(?:^|\n)\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:/g)) bound.add(match[1]);

  const handlesById = new Map();
  for (const match of body.matchAll(/(?:^|\n)\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*\$\(\s*'([^']+)'\s*\)/g)) {
    handlesById.set(match[2], match[1]);
  }

  const looked = [...new Set([...appJs.matchAll(/\$\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]))];
  assert.ok(looked.length >= 30, `only found ${looked.length} lookups`);

  for (const id of looked) {
    const handle = handlesById.get(id);
    assert.ok(handle, `${id} is looked up but never assigned inside the dom map`);
    assert.ok(bound.has(handle), `dom.${handle} (id ${id}) is missing its key in the dom map`);
  }
  assert.equal(handlesById.get('searchForm'), 'searchForm');
});

test('interactive controls the app wires up are real elements', () => {
  const defined = definedIds();
  for (const id of [
    'searchForm', 'query', 'type', 'version', 'loader', 'sort', 'freeOnly', 'measuredOnly',
    'speedBtn', 'speedLimit', 'cfPanel', 'cfId', 'cfBtn', 'cfHint', 'cfResult',
    'sourceStatus', 'extLinks', 'footerNote', 'envNotice', 'settingsPanel', 'cfKeyInput',
    'cfKeySave', 'cfKeyClear', 'speedBytes', 'clearCache', 'cacheState', 'reports',
    'status', 'results', 'empty', 'toolbar', 'resultCount', 'tookMs', 'weightsGrid', 'resetWeights',
  ]) {
    assert.ok(defined.has(id), `index.html is missing #${id}`);
  }
});

test('the HTML escapes nothing into innerHTML and the app builds nodes instead', () => {
  // h() sets textContent, never innerHTML: third-party titles and descriptions cannot inject markup.
  assert.ok(!/\.innerHTML\s*=/.test(appJs), 'app.js assigns innerHTML');
  assert.ok(!/\beval\s*\(/.test(appJs), 'app.js uses eval');
  assert.ok(!/new Function\s*\(/.test(appJs), 'app.js builds functions from strings');
});

test('the page never points at a backend that no longer exists', () => {
  const source = `${indexHtml}\n${appJs}`;
  const apiCalls = [...source.matchAll(/fetch\(\s*[`'"]([^`'"]+)/g)].map((match) => match[1]);
  for (const call of apiCalls) {
    assert.ok(!call.startsWith('/api/'), `leftover backend call: ${call}`);
    assert.ok(/^https?:/.test(call) || call.startsWith('./'), `suspicious fetch target: ${call}`);
  }
});

// ------------------------------------------------------------------ deployment extras

test('ships the files GitHub Pages needs for a project site', () => {
  assert.ok(fs.existsSync(path.join(webDir, '.nojekyll')), 'missing .nojekyll (stops Jekyll from eating _-prefixed files)');
  assert.ok(fs.existsSync(path.join(webDir, '404.html')), 'missing 404.html (Pages serves it for unknown paths)');
});

test('a single-page refresh on an unknown path still resolves to the app', async () => {
  const response = await fetch(`${origin}/some/deep/path`);
  assert.equal(response.status, 404, 'the dev server itself should 404');
  // GitHub Pages serves 404.html instead, which must bring the visitor back to the app
  const fallback = read('404.html');
  assert.match(fallback, /href="\.\/"/, '404.html should link home with a relative path');
});
