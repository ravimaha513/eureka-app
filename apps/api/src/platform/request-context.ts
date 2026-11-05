import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** Root of an AWS X-Ray trace header (`Root=1-<8 hex>-<24 hex>`), the only part we trust and reuse. */
const TRACE_ROOT = /(?:^|;)\s*Root=(1-[0-9a-f]{8}-[0-9a-f]{24})(?:;|$)/i;

/**
 * Request id (audit R-11): the X-Ray root of the incoming `x-amzn-trace-id`
 * (API Gateway / CloudFront add it, so API and gateway logs correlate), else a
 * random UUID. The header is client-influenced, so only the strict Root
 * format is accepted; anything else gets a fresh UUID.
 */
export function requestIdFrom(traceHeader: string | string[] | undefined): string {
  const h = Array.isArray(traceHeader) ? traceHeader[0] : traceHeader;
  const m = typeof h === "string" && h.length <= 512 ? TRACE_ROOT.exec(h) : null;
  return m ? m[1]!.toLowerCase() : randomUUID();
}

/** Fastify `genReqId` (used with `requestIdHeader: false`, so a client `request-id` header is ignored). */
export const genReqId = (raw: { headers: IncomingHttpHeaders }): string => requestIdFrom(raw.headers["x-amzn-trace-id"]);

/** Echo the request id on every response as `x-request-id` (also on errors and hook-level rejections). */
export function registerRequestId(fastify: FastifyInstance): void {
  fastify.addHook("onRequest", async (req, reply) => {
    void reply.header("x-request-id", req.id);
  });
}

/** Route template (`/api/v1/candidates/:id`), never the raw URL: ids and query strings stay out of logs and metric dimensions. */
export function routeOf(req: FastifyRequest): string {
  return req.routeOptions?.url ?? "unmatched";
}

/** Correlation fields for a log line about this request (no PII: the user id is an opaque UUID). */
export function requestLogFields(req: FastifyRequest): Record<string, unknown> {
  return { reqId: req.id, method: req.method, route: routeOf(req), userId: req.user?.id };
}
