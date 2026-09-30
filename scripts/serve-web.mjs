#!/usr/bin/env node
/**
 * Serves `web/` the way GitHub Pages does, so the static build can be checked locally.
 *
 * GitHub Pages specifics reproduced here:
 *   - `/` maps to `index.html`
 *   - an unknown path serves `404.html` with status 404 (not a redirect)
 *   - relative paths only, so the site works from a project subdirectory
 *
 * Usage: node scripts/serve-web.mjs [port]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(rootDir, 'web');
const port = Number(process.argv[2] ?? process.env.PORT ?? 8788);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendFile(response, filePath, status = 200) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    // no-cache: this is a development preview, stale modules waste more time than they save
    response.writeHead(status, {
      'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer((request, response) => {
  let url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch {
    response.writeHead(400).end('bad request');
    return;
  }

  const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.join(webDir, relative);
  if (!path.resolve(filePath).startsWith(path.resolve(webDir) + path.sep)) {
    response.writeHead(403).end('forbidden');
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (!error && stats.isFile()) {
      sendFile(response, filePath);
      return;
    }
    // Unknown path: mimic Pages by serving the 404 page with a 404 status.
    sendFile(response, path.join(webDir, '404.html'), 404);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`MC Mod Finder（纯前端版）预览： http://127.0.0.1:${port}/`);
  console.log(`静态根目录： ${webDir}`);
  console.log('按 Ctrl+C 停止。');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') console.error(`端口 ${port} 已被占用，请换一个：node scripts/serve-web.mjs 8899`);
  else console.error('服务器错误', error);
  process.exit(1);
});
