import type { FastifyInstance } from "fastify";
import { writeLine } from "./logger.js";
import { routeOf } from "./request-context.js";

/**
 * Minimal API metrics as CloudWatch Embedded Metric Format log lines (audit
 * R-11): CloudWatch Logs turns each line into metrics, no agent or SDK needed.
 *
 * - `Eureka/API` Latency (ms) and Errors5xx (count) per Route + Method, one line
 *   per response (also serves as an access log: reqId, status, no PII).
 * - `Eureka/API` PoolWaiting / PoolTotal / PoolIdle gauges, sampled on an interval.
 */
export const METRIC_NAMESPACE = "Eureka/API";

interface Metric { name: string; unit: "Milliseconds" | "Count"; value: number }

export function emfLine(
  dimensions: Record<string, string>, metrics: Metric[], properties: Record<string, unknown> = {}, now = Date.now(),
): string {
  return JSON.stringify({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [{
        Namespace: METRIC_NAMESPACE,
        Dimensions: [Object.keys(dimensions)],
        Metrics: metrics.map((m) => ({ Name: m.name, Unit: m.unit })),
      }],
    },
    ...properties,
    ...dimensions,
    ...Object.fromEntries(metrics.map((m) => [m.name, m.value])),
  });
}

export function requestMetricLine(r: { method: string; route: string; status: number; durationMs: number; reqId: string }, now?: number): string {
  return emfLine(
    { Route: r.route, Method: r.method },
    [{ name: "Latency", unit: "Milliseconds", value: Math.round(r.durationMs * 10) / 10 },
      { name: "Errors5xx", unit: "Count", value: r.status >= 500 ? 1 : 0 }],
    { metric: "request", reqId: r.reqId, status: r.status },
    now,
  );
}

export interface PoolStats { totalCount: number; idleCount: number; waitingCount: number }

export function poolMetricLine(p: PoolStats, now?: number): string {
  return emfLine(
    { Service: "api" },
    [{ name: "PoolWaiting", unit: "Count", value: p.waitingCount },
      { name: "PoolTotal", unit: "Count", value: p.totalCount },
      { name: "PoolIdle", unit: "Count", value: p.idleCount }],
    { metric: "db_pool" },
    now,
  );
}

/** Per-response latency/5xx lines, and pool gauges every `intervalMs` (stopped when the app closes). */
export function registerMetrics(fastify: FastifyInstance, pool: PoolStats, intervalMs = 60_000): void {
  fastify.addHook("onResponse", async (req, reply) => {
    writeLine(requestMetricLine({
      method: req.method, route: routeOf(req), status: reply.statusCode, durationMs: reply.elapsedTime, reqId: req.id,
    }));
  });
  const timer = setInterval(() => writeLine(poolMetricLine(pool)), intervalMs);
  timer.unref();
  fastify.addHook("onClose", async () => clearInterval(timer));
}
