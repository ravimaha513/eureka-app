import { z } from "zod";

/** Idempotency-Key header: printable ASCII, as the idempotency_key CHECK (0022). */
export const IdempotencyKey = z.string().regex(/^[\x21-\x7e]{1,200}$/);

/** Key order does not change the hash: the same body always hashes the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
