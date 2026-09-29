/** Structured JSON logging for the worker (one line per event, CloudWatch-friendly). */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { err: err.message, errName: err.name, stack: err.stack };
  return { err: String(err) };
}

export function createLogger(
  base: Record<string, unknown> = {},
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const log = (level: LogLevel, msg: string, fields: Record<string, unknown> = {}) => {
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...fields }));
  };
  return {
    log,
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
  };
}

/** Logger that discards everything (tests). */
export const silentLogger: Logger = createLogger({}, () => undefined);
