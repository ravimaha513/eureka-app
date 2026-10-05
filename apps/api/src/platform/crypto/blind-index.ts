import { scrypt } from "node:crypto";
import type { MacProvider } from "./key-provider.js";

/** scrypt cost for secrets people choose (utility portal passwords): ~50 ms, 16 MiB. */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const scryptAsync = (secret: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(secret, salt, 32, SCRYPT_PARAMS, (err, key) => (err ? reject(err) : resolve(key))));

/**
 * Blind index for equality lookups on encrypted fields (design A6.3):
 * HMAC-SHA256 under a key separate from the field key, over a domain-separated,
 * normalized value. Deterministic: the same value of the same class always
 * gives the same 32 bytes; different classes never collide by construction.
 * The index reveals equality only, so it is stored only for fields where an
 * exact-match lookup is needed (DOB for the duplicate check, once OD-04 is
 * decided; nothing writes it yet).
 */
export const BLIND_INDEX_CLASSES = ["dob"] as const;
export type BlindIndexClass = (typeof BLIND_INDEX_CLASSES)[number];

export class BlindIndexer {
  constructor(readonly provider: MacProvider) {}

  async compute(cls: BlindIndexClass, normalized: string): Promise<Buffer> {
    if (!(BLIND_INDEX_CLASSES as readonly string[]).includes(cls)) throw new Error("unknown blind index class");
    return this.provider.mac(Buffer.from(`eureka-bidx:v1\0${cls}\0${normalized}`, "utf8"));
  }

  /**
   * Integrity tag of an encrypted value (review of 0042, R1b): a MAC over the
   * field class, the row id and the plaintext under the blind index key, which
   * the worker cannot use. Stored next to the ciphertext by the API and
   * checked on every reveal, so a value re-encrypted by anyone without this
   * key (a forged rotation) is detected. Domain-separated from blind indexes.
   */
  async integrityMac(cls: string, rowId: string, plaintext: string): Promise<Buffer> {
    return this.provider.mac(Buffer.from(`eureka-mac:v1\0${cls}\0${rowId.toLowerCase()}\0${plaintext}`, "utf8"));
  }

  /**
   * integrityMac for a secret a person chose (a utility portal password): the value is first
   * stretched with scrypt, salted by class and row id, and only the 32-byte result goes into the
   * keyed MAC. Someone holding the MAC key (or a KMS GenerateMac oracle) and a leaked tag still
   * cannot test guesses cheaply. Same purpose, binding and domain separation as integrityMac,
   * under its own version tag ("eureka-mac:v2s").
   */
  async stretchedIntegrityMac(cls: string, rowId: string, secret: string): Promise<Buffer> {
    const salt = Buffer.from(`eureka-mac:v2s:salt\0${cls}\0${rowId.toLowerCase()}`, "utf8");
    const stretched = await scryptAsync(secret, salt);
    return this.provider.mac(Buffer.concat([Buffer.from(`eureka-mac:v2s\0${cls}\0${rowId.toLowerCase()}\0`, "utf8"), stretched]));
  }
}

/**
 * A date of birth as "YYYY-MM-DD" (a real calendar date between 1900 and
 * today), or null. Only ISO input: the sheet import has its own day/month
 * detection (import/analyze.ts).
 */
export function normalizeDob(input: string, today: Date = new Date()): string | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(input);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  if (y < 1900 || date.getTime() > today.getTime()) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** person.dob_bidx for a date of birth (helper only; see the OD-04 note in docs/HANDOFF.md). */
export async function dobBlindIndex(indexer: BlindIndexer, dob: string, today?: Date): Promise<Buffer> {
  const n = normalizeDob(dob, today);
  if (!n) throw new Error("invalid date of birth");
  return indexer.compute("dob", n);
}
