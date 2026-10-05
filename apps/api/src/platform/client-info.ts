import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";

/**
 * Client facts kept for Login activity (interviews-settings ST-6): only the
 * device class, the browser family and a masked IP. The full user agent and
 * the full IP address are never stored.
 */
export type DeviceClass = "desktop" | "mobile" | "tablet" | "unknown";
export type BrowserFamily = "Chrome" | "Edge" | "Firefox" | "Safari" | "Opera" | "Other";
export interface ClientInfo { deviceClass: DeviceClass; browser: BrowserFamily; ipMasked: string | null }

/**
 * The viewer's IP. Behind CloudFront (ORIGIN_VERIFY_SECRET set, so the origin
 * guard admitted only CloudFront) the edge function's x-eureka-viewer-ip;
 * otherwise the socket address (trustProxy stays off, X-Forwarded-For is
 * client-controlled).
 */
export function clientIp(req: FastifyRequest, config: Pick<AppConfig, "ORIGIN_VERIFY_SECRET">): string {
  const viewer = req.headers["x-eureka-viewer-ip"];
  return config.ORIGIN_VERIFY_SECRET && typeof viewer === "string" && isIP(viewer) ? viewer : req.ip;
}

/** IPv4: first two octets ("23.127.xx.xx"); IPv6: first two groups ("2001:db8:x:x"). Null if not an IP. */
export function maskIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  let v = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped) v = mapped[1]!;
  const kind = isIP(v);
  if (kind === 4) {
    const [a, b] = v.split(".");
    return `${a}.${b}.xx.xx`;
  }
  if (kind === 6) {
    const [head] = v.split("::");
    const groups = (head ?? "").split(":").filter(Boolean);
    return `${groups[0] ?? "0"}:${groups[1] ?? "0"}:x:x`;
  }
  return null;
}

/** Device class and browser family from a user agent (coarse; good enough to recognise one's own sessions). */
export function parseUserAgent(ua: string | undefined | null): Omit<ClientInfo, "ipMasked"> {
  const s = (ua ?? "").slice(0, 512);
  const deviceClass: DeviceClass =
    /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(s) ? "tablet"
      : /Mobi|iPhone|iPod|Android|Windows Phone/i.test(s) ? "mobile"
        : /Windows NT|Macintosh|Mac OS X|X11|Linux|CrOS/i.test(s) ? "desktop"
          : "unknown";
  const browser: BrowserFamily =
    /Edg(e|A|iOS)?\//.test(s) ? "Edge"
      : /OPR\/|Opera/.test(s) ? "Opera"
        : /Firefox\/|FxiOS\//.test(s) ? "Firefox"
          : /Chrome\/|CriOS\/|Chromium\//.test(s) ? "Chrome"
            : /Safari\//.test(s) ? "Safari"
              : "Other";
  return { deviceClass, browser };
}

export function clientInfo(req: FastifyRequest, config: Pick<AppConfig, "ORIGIN_VERIFY_SECRET">): ClientInfo {
  const ua = req.headers["user-agent"];
  return { ...parseUserAgent(typeof ua === "string" ? ua : null), ipMasked: maskIp(clientIp(req, config)) };
}
