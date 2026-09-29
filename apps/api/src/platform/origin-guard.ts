import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { parseSecretList } from "./config.js";

const digest = (v: string) => createHash("sha256").update(v).digest();

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const isHealthPath = (url: string) => url === "/api/health" || url.startsWith("/api/health?");

/**
 * Rejects requests that did not come through CloudFront (and therefore skipped
 * the WAF): CloudFront adds X-Origin-Verify with a shared secret.
 *
 * `secrets` is one secret or a comma-separated list for rotation (deploy
 * "new,old", switch CloudFront to "new", then drop "old"). The header is
 * compared with every entry via constant-time SHA-256 digest comparison,
 * without exiting early on a match.
 *
 * The only exemption is /api/health from loopback: the ECS container health
 * check runs inside the task and calls 127.0.0.1. Health requests arriving
 * through the VPC link come from another address and need the secret too.
 */
export function originGuard(secrets: string) {
  const expected = parseSecretList(secrets).map(digest);
  if (expected.length === 0) throw new Error("originGuard needs at least one secret");
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (isHealthPath(req.url) && LOOPBACK.has(req.socket?.remoteAddress ?? "")) return;
    const got = req.headers["x-origin-verify"];
    if (typeof got === "string") {
      const gotDigest = digest(got);
      let ok = false;
      for (const e of expected) ok = timingSafeEqual(gotDigest, e) || ok;
      if (ok) return;
    }
    return reply
      .code(403)
      .type("application/problem+json")
      .send({ type: "about:blank", title: "Forbidden", status: 403, detail: "Direct access is not allowed" });
  };
}
