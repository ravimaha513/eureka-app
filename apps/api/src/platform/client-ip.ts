import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";

/**
 * The client address for rate limiting. Behind CloudFront (ORIGIN_VERIFY_SECRET
 * set, so the origin guard has already checked the request came through it) the
 * viewer address CloudFront writes into x-eureka-viewer-ip (edge function
 * api_viewer_ip, which overrides any client value); otherwise the socket address.
 * Same rule as the public feedback form.
 */
export function clientIp(req: FastifyRequest, config: Pick<AppConfig, "ORIGIN_VERIFY_SECRET">): string {
  const viewer = req.headers["x-eureka-viewer-ip"];
  return config.ORIGIN_VERIFY_SECRET && typeof viewer === "string" && isIP(viewer) ? viewer : req.ip;
}
