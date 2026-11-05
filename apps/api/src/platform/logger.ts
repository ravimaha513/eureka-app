import type { LoggerService } from "@nestjs/common";
import { createLogger, errorFields, type LogLevel, type Logger } from "../worker/log.js";

/**
 * Structured JSON logging for the API: one line per event, the same shape as
 * the worker's logger (worker/log.ts), CloudWatch-Insights friendly.
 *
 * Only allow-listed fields are written (audit R-11: no PII in logs). A field
 * that is not on the list is dropped, so a caller cannot log an email, phone,
 * name or request body by accident. Messages are fixed strings chosen by the
 * code; never interpolate user input into them.
 */
export const LOG_FIELDS: ReadonlySet<string> = new Set([
  "service", "context", "reqId", "method", "route", "status", "userId", "pgCode", "reason",
  "durationMs", "err", "errName", "stack", "pool", "waiting", "total", "idle",
]);

export function allowedFields(fields: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (LOG_FIELDS.has(k) && v !== undefined) out[k] = v;
  return out;
}

const stdout = (line: string) => process.stdout.write(`${line}\n`);
let writer: (line: string) => void = stdout;

/** Replaces where log and metric lines go (tests: capture or silence); returns the previous writer. */
export function setLogWriter(next: ((line: string) => void) | "stdout" | "silent"): (line: string) => void {
  const prev = writer;
  writer = next === "stdout" ? stdout : next === "silent" ? () => undefined : next;
  return prev;
}

/** Writes one raw line (EMF metric lines, platform/metrics.ts) through the current writer. */
export function writeLine(line: string): void {
  writer(line);
}

const inner = createLogger({ service: "api" }, (line) => writer(line));

/** The API's structured logger; fields pass the allow-list. */
export const apiLog: Logger = {
  log: (level, msg, fields) => inner.log(level, msg, allowedFields(fields)),
  info: (msg, fields) => inner.info(msg, allowedFields(fields)),
  warn: (msg, fields) => inner.warn(msg, allowedFields(fields)),
  error: (msg, fields) => inner.error(msg, allowedFields(fields)),
};

const looksLikeStack = (v: unknown): v is string => typeof v === "string" && /\n\s+at /.test(v);

/**
 * Nest LoggerService over apiLog, so `new Logger("X").warn(...)` in any module
 * and Nest's own bootstrap messages come out as JSON lines.
 */
export class JsonLoggerService implements LoggerService {
  log(message: unknown, ...params: unknown[]): void { this.emit("info", message, params); }
  error(message: unknown, ...params: unknown[]): void { this.emit("error", message, params); }
  warn(message: unknown, ...params: unknown[]): void { this.emit("warn", message, params); }
  // Same levels as before (error, warn, log): debug and verbose are dropped.
  debug(): void { /* off */ }
  verbose(): void { /* off */ }
  fatal(message: unknown, ...params: unknown[]): void { this.emit("error", message, params); }

  private emit(level: LogLevel, message: unknown, params: unknown[]): void {
    const rest = [...params];
    const context = rest.length > 0 && typeof rest[rest.length - 1] === "string" && !looksLikeStack(rest[rest.length - 1])
      ? (rest.pop() as string) : undefined;
    const stack = rest.find(looksLikeStack);
    if (message instanceof Error) {
      apiLog.log(level, message.message, { context, ...errorFields(message) });
    } else if (typeof message === "string") {
      apiLog.log(level, message, { context, stack });
    } else {
      // Objects: only allow-listed keys survive.
      const obj = typeof message === "object" && message !== null ? (message as Record<string, unknown>) : {};
      apiLog.log(level, "log", { context, ...obj });
    }
  }
}

export { errorFields };
