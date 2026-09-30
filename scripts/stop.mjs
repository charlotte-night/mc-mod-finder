// Stops the background instance started by scripts/launch.mjs.
//
//   node scripts/stop.mjs
//
// Only kills a process when the port is confirmed to be serving this app, so a
// recycled or stale PID can never take down something unrelated.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const port = Number(process.env.PORT || 8765);
const base = `http://127.0.0.1:${port}`;
const pidFile = path.join(dataDir, 'server.pid');
const stopLog = path.join(dataDir, 'stop.log');

fs.mkdirSync(dataDir, { recursive: true });

function note(message) {
  console.log(message);
  try {
    fs.appendFileSync(stopLog, `${new Date().toISOString().slice(11, 19)} ${message}\n`);
  } catch { /* ignore */ }
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

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function main() {
  const running = await health();
  if (!running && !(await tcpOpen())) {
    note(`端口 ${port} 上没有服务在运行。`);
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
      note('已清理残留的 PID 文件。');
    }
    process.exitCode = 3;
    return;
  }

  if (!running) {
    note(`端口 ${port} 被占用，但响应的不是 MC Mod Finder，出于安全不会去结束它。`);
    process.exitCode = 2;
    return;
  }

  if (!fs.existsSync(pidFile)) {
    note('服务在运行，但不是由快捷方式启动的（没有 PID 文件）。');
    note('如果是你自己在终端里 npm start 起来的，按 Ctrl+C 停止即可。');
    process.exitCode = 2;
    return;
  }

  const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  if (!Number.isFinite(pid)) {
    note('PID 文件内容异常，已清理。');
    fs.unlinkSync(pidFile);
    process.exitCode = 2;
    return;
  }

  if (!alive(pid)) {
    note(`进程 ${pid} 已不存在，清理 PID 文件。`);
    fs.unlinkSync(pidFile);
    process.exitCode = 3;
    return;
  }

  process.kill(pid);
  note(`已发送停止信号给进程 ${pid}。`);

  for (let i = 0; i < 40; i++) {
    if (!(await tcpOpen(300))) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (await tcpOpen(300)) {
    note('进程似乎没有退出，请到任务管理器结束它。');
    process.exitCode = 4;
    return;
  }
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  note('服务已停止。');
}

await main();
