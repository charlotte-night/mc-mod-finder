// Desktop-shortcut launcher.
//
//   node scripts/launch.mjs
//
// If the server is already up it just opens the browser. Otherwise it starts a
// detached instance (window hidden, log written to data/server.log), waits until
// it answers, then opens the browser. On failure it opens the log so there is
// always something to look at - the shortcut itself runs without a console.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const port = Number(process.env.PORT || 8765);
const host = process.env.HOST || '127.0.0.1';
const base = `http://127.0.0.1:${port}`;
const serverLog = path.join(dataDir, 'server.log');
const launchLog = path.join(dataDir, 'launch.log');
const pidFile = path.join(dataDir, 'server.pid');

fs.mkdirSync(dataDir, { recursive: true });

function note(message) {
  const stamp = new Date().toISOString().slice(11, 19);
  const line = `${stamp} ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(launchLog, `${line}\n`);
  } catch { /* logging must never break launching */ }
}

function tcpOpen(timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function health() {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.ok ? body : null;
  } catch {
    return null;
  }
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

function openLog() {
  try {
    spawn('notepad', [serverLog], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* nothing more we can do */ }
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await health();
    if (body) return body;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

async function main() {
  const existing = await health();
  if (existing) {
    note(`服务已在运行（${existing.url}），直接打开浏览器。`);
    openBrowser(base);
    return;
  }

  if (await tcpOpen()) {
    note(`端口 ${port} 已被其它程序占用，且它不是 MC Mod Finder。请改 PORT 或关掉占用者。`);
    openLog();
    process.exitCode = 1;
    return;
  }

  note(`正在后台启动服务…`);
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      LOG_FILE: serverLog,
    },
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));

  const body = await waitForHealth(30000);
  if (body) {
    note(`已启动 -> ${body.url}`);
    openBrowser(base);
    return;
  }

  note('启动超时，请查看 data\\server.log');
  openLog();
  process.exitCode = 1;
}

await main();
