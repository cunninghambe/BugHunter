import pc from 'picocolors';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function emit(level: LogLevel, msg: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const ts = new Date().toISOString();
  const prefix = {
    debug: pc.gray('[debug]'),
    info: pc.blue('[info]'),
    warn: pc.yellow('[warn]'),
    error: pc.red('[error]'),
  }[level];
  const line = data !== undefined ? `${msg} ${JSON.stringify(data)}` : msg;
  if (level === 'error') {
    process.stderr.write(`${ts} ${prefix} ${line}\n`);
  } else {
    process.stdout.write(`${ts} ${prefix} ${line}\n`);
  }
}

export const log = {
  debug: (msg: string, data?: unknown) => emit('debug', msg, data),
  info: (msg: string, data?: unknown) => emit('info', msg, data),
  warn: (msg: string, data?: unknown) => emit('warn', msg, data),
  error: (msg: string, data?: unknown) => emit('error', msg, data),
};
