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

/**
 * The rate-limit key of an address: IPv4 as is, IPv4-mapped IPv6 as IPv4, other IPv6 by its /64
 * (one customer holds a /64, so rotating addresses inside it must not earn new allowances).
 */
export function ipKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (isIP(ip) !== 6) return ip;
  const zone = ip.indexOf("%");
  const addr = zone >= 0 ? ip.slice(0, zone) : ip;
  const [head = "", tail] = addr.split("::");
  const a = head === "" ? [] : head.split(":");
  const b = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = tail === undefined ? a : [...a, ...Array<string>(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
