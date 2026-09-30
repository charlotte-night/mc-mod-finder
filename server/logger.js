import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

const MAX_LOG_BYTES = 2 * 1024 * 1024;
let logStream = null;

/**
 * When LOG_FILE is set the same lines also go to that file. The desktop shortcut
 * starts the server detached with its stdio discarded, so this is the only way to
 * find out what a background instance did.
 */
if (process.env.LOG_FILE) {
  try {
    const file = path.resolve(process.env.LOG_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
    const isNew = !fs.existsSync(file) || fs.statSync(file).size === 0;
    logStream = fs.createWriteStream(file, { flags: 'a' });
    // BOM so editors that guess the system codepage still show the Chinese text correctly.
    if (isNew) logStream.write('\uFEFF');
    logStream.on('error', () => {
      logStream = null;
    });
  } catch {
    logStream = null;
  }
}

function describeExtra(extra) {
  if (extra === undefined) return '';
  if (extra instanceof Error) return `\n${extra.stack ?? extra.message}`;
  try {
    return ` ${JSON.stringify(extra)}`;
  } catch {
    return ` ${String(extra)}`;
  }
}

function emit(level, scope, message, extra) {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (extra === undefined) sink(line);
  else sink(line, extra);
  logStream?.write(line + describeExtra(extra) + '\n');
}

export function createLogger(scope) {
  return {
    debug: (msg, extra) => emit('debug', scope, msg, extra),
    info: (msg, extra) => emit('info', scope, msg, extra),
    warn: (msg, extra) => emit('warn', scope, msg, extra),
    error: (msg, extra) => emit('error', scope, msg, extra),
  };
}

export const logger = createLogger('app');
