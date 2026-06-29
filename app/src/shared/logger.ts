/**
 * src/shared/logger.ts
 * OWNER: foundation
 *
 * Structured logging utility that emits JSON lines to console, indexed by
 * Cloudflare's log aggregation. Replaces raw console.log/warn/error with
 * timestamped, leveled, context-rich entries.
 */

type LogLevel = 'info' | 'warn' | 'error';
type LogContext = Record<string, unknown>;

function log(level: LogLevel, message: string, context?: LogContext): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  };
  const json = JSON.stringify(entry);
  if (level === 'error') console.error(json);
  else if (level === 'warn') console.warn(json);
  else console.log(json);
}

export const logger = {
  info: (msg: string, ctx?: LogContext) => log('info', msg, ctx),
  warn: (msg: string, ctx?: LogContext) => log('warn', msg, ctx),
  error: (msg: string, ctx?: LogContext) => log('error', msg, ctx),
};
