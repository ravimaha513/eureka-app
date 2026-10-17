import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The OIDC round-trip cookies (sign-in and step-up): JSON, base64url, then `.` and an HMAC-SHA256 under
 * SESSION_SECRET. `bind` is mixed into the MAC so a cookie only opens in the context it was issued for
 * (step-up binds the session). The value is signed, not encrypted: it must hold nothing secret beyond
 * the one sign-in it belongs to.
 */
const mac = (secret: string, payload: string, bind?: string) =>
  createHmac("sha256", secret).update(bind === undefined ? payload : `${bind}|${payload}`).digest("base64url");

export function sealCookie(secret: string, value: unknown, bind?: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${mac(secret, payload, bind)}`;
}

/** The sealed value, or null when the cookie is missing, malformed or its MAC does not match. */
export function openCookie<T>(secret: string, raw: string | undefined, bind?: string): T | null {
  const [payload, sig, extra] = (raw ?? "").split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const expected = Buffer.from(mac(secret, payload, bind));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as T;
  } catch {
    return null;
  }
}
