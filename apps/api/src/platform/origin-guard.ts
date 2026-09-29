import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const digest = (v: string) => createHash("sha256").update(v).digest();

/**
 * Rejects requests that did not come through CloudFront (and therefore skipped
 * the WAF): CloudFront adds X-Origin-Verify with a shared secret. /api/health
 * stays open for the container health check, which calls the task directly.
 */
export function originGuard(secret: string) {
  const expected = digest(secret);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url === "/api/health" || req.url.startsWith("/api/health?")) return;
    const got = req.headers["x-origin-verify"];
    if (typeof got === "string" && timingSafeEqual(digest(got), expected)) return;
    return reply
      .code(403)
      .type("application/problem+json")
      .send({ type: "about:blank", title: "Forbidden", status: 403, detail: "Direct access is not allowed" });
  };
}
