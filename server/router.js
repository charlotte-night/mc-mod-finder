/** Tiny router: exact/parameterised paths, JSON bodies, no dependencies. */

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

function matchPath(pattern, pathname) {
  if (pattern === pathname) return {};
  if (!pattern.includes(':')) return null;
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    const expected = patternParts[i];
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (expected !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

export async function readJsonBody(req, { limitBytes = 512 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method: method.toUpperCase(), pattern, handler });
    return this;
  }

  get(pattern, handler) {
    return this.add('GET', pattern, handler);
  }

  post(pattern, handler) {
    return this.add('POST', pattern, handler);
  }

  find(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchPath(route.pattern, pathname);
      if (params === null) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }

  async handle(req, res, { fallback }) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const found = this.find(req.method, url.pathname);

    if (!found) {
      if (fallback) return fallback(req, res, url);
      return sendJson(res, 404, { error: 'not found', path: url.pathname });
    }
    if (found.methodNotAllowed) {
      return sendJson(res, 405, { error: 'method not allowed', method: req.method, path: url.pathname });
    }

    try {
      await found.route.handler(req, res, { params: found.params, url });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) console.error('[api]', error);
      if (!res.headersSent) {
        sendJson(res, status, { error: error.message ?? 'internal error', details: error.details });
      } else {
        res.end();
      }
    }
  }
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
