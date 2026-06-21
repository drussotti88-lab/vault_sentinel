/**
 * Minimal structured logger. Emits one JSON object per line so logs are easy
 * to grep/ship, while staying dependency-free. PRD §19 wants structured logging
 * tagged with adapter / watch id / latency / outcome — callers pass those as
 * the `fields` object and they land as top-level keys.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(
  threshold: LogLevel,
  level: LogLevel,
  bindings: Record<string, unknown>,
  msg: string,
  fields?: Record<string, unknown>,
): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...bindings,
    ...fields,
  };
  const line = JSON.stringify(record, replacer);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

/** Keep Error objects readable instead of serializing to `{}`. */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export function createLogger(
  level: LogLevel = 'info',
  bindings: Record<string, unknown> = {},
): Logger {
  return {
    debug: (m, f) => emit(level, 'debug', bindings, m, f),
    info: (m, f) => emit(level, 'info', bindings, m, f),
    warn: (m, f) => emit(level, 'warn', bindings, m, f),
    error: (m, f) => emit(level, 'error', bindings, m, f),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}
