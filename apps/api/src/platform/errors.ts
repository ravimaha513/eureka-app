import {
  type ArgumentsHost, Catch, type ExceptionFilter, HttpException, ServiceUnavailableException, UnprocessableEntityException,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { apiLog, errorFields } from "./logger.js";
import { requestLogFields } from "./request-context.js";

/** A 422 whose title and detail are the coded error `c` (module error maps: `placement_not_joined` and so on). */
export const unprocessable = (c: string) => new UnprocessableEntityException(c);

/** A 503 the client may retry: the problem response carries `Retry-After: <seconds>` (overload, pool exhaustion). */
export class RetryableUnavailable extends ServiceUnavailableException {
  constructor(detail: string, readonly retryAfterSeconds: number) {
    super(detail);
  }
}

/**
 * pg's errors when no connection is available within `connectionTimeoutMillis`:
 * pg-pool's wait for a free slot, or pg's own connect timeout for a new connection.
 */
export function isConnectTimeout(err: unknown): boolean {
  const m = err instanceof Error ? err.message : "";
  return m === "timeout exceeded when trying to connect" || m === "Connection terminated due to connection timeout";
}

/** The database cannot take the request right now; the client should retry shortly. */
export const databaseBusy = () => new RetryableUnavailable("database_busy", 1);

/**
 * Maps errors to RFC 9457 problem details. Database errors are mapped to
 * generic messages that never name another team's record (design B3).
 * Every problem carries `instance`: the request id, also sent as `x-request-id`
 * (audit R-11), so a user-reported error can be found in the logs.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const req = http.getRequest<FastifyRequest | undefined>();
    const { status, title, detail, errors, retryAfter } = toProblem(err);
    const ctx = req ? requestLogFields(req) : {};
    if (status >= 500) {
      apiLog.error("request failed", { ...ctx, status, pgCode: pgCodeOf(err), ...errorFields(err) });
    } else if (status === 401 || status === 403) {
      // Denials (no session, bad CSRF, missing permission): the reason is the fixed problem detail, never request data.
      apiLog.warn("request denied", { ...ctx, status, reason: detail });
    }
    if (retryAfter !== undefined) void reply.header("retry-after", String(retryAfter));
    void reply
      .status(status)
      .header("content-type", "application/problem+json")
      .send({
        type: "about:blank", title, status, ...(detail ? { detail } : {}), ...(errors ? { errors } : {}),
        ...(req?.id ? { instance: req.id } : {}),
      });
  }
}

export interface Problem { status: number; title: string; detail?: string; errors?: unknown; retryAfter?: number }

/** The SQLSTATE of a database error (5 characters), for logs. */
export function pgCodeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/** 409 detail for serialization failures, deadlocks and lock timeouts: the transaction rolled back, so a retry is safe. */
export const RETRY_SAFE_CONFLICT = "Conflicting concurrent update; the request was not applied and can be retried";

export function toProblem(err: unknown): Problem {
  if (err instanceof ZodError) {
    return { status: 422, title: "Validation failed", errors: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }
  if (err instanceof RetryableUnavailable) {
    return { status: 503, title: "Service Unavailable", detail: httpDetail(err), retryAfter: err.retryAfterSeconds };
  }
  if (err instanceof HttpException) {
    return { status: err.getStatus(), title: err.name.replace(/Exception$/, ""), detail: httpDetail(err) };
  }
  if (isConnectTimeout(err)) return toProblem(databaseBusy());
  switch (pgCodeOf(err)) {
    case "42501": // insufficient_privilege, including RLS WITH CHECK violations
      return { status: 403, title: "Forbidden", detail: "Not permitted" };
    case "P0002": // no_data_found
      return { status: 404, title: "Not Found" };
    case "23505":
      return { status: 409, title: "Conflict", detail: "A conflicting record exists" };
    case "40001": // serialization_failure
    case "40P01": // deadlock_detected
    case "55P03": // lock_not_available
      return { status: 409, title: "Conflict", detail: RETRY_SAFE_CONFLICT };
    case "23503":
    case "23514":
    case "22P02":
      return { status: 422, title: "Unprocessable", detail: "Request violates a data rule" };
    case "57014": // query_canceled: the statement timeout fired
      return { status: 503, title: "Service Unavailable", detail: "query_timeout", retryAfter: 1 };
    case "53300": // too_many_connections
    case "57P01": // admin_shutdown: backend terminated (failover, pg_terminate_backend)
    case "57P03": // cannot_connect_now: the database is starting up
      return { status: 503, title: "Service Unavailable", detail: "database_busy", retryAfter: 1 };
    default:
      return { status: 500, title: "Internal Server Error" };
  }
}

function httpDetail(err: HttpException): string | undefined {
  const res = err.getResponse();
  return typeof res === "string" ? res : (res as { message?: string }).message;
}

/**
 * Mapper for the coded errors that definer functions and triggers raise (`RAISE EXCEPTION 'stale'`):
 * a database error whose message is a key of `codes` becomes that problem; anything else is rethrown.
 */
export function dbErrorMapper(codes: Record<string, () => Error>): (err: unknown) => never {
  return (err) => {
    const e = err as { message?: string; code?: string };
    if (e.message !== undefined && e.code !== undefined && Object.hasOwn(codes, e.message)) throw codes[e.message]!();
    throw err;
  };
}
