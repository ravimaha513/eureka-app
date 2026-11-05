import { createHash } from "node:crypto";
import { BadRequestException, ConflictException } from "@nestjs/common";
import type pg from "pg";
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

/**
 * The one error vocabulary (400 / 409) for every endpoint that takes an Idempotency-Key:
 * - `idempotency_key_required` (400): the endpoint requires a key and none, or a malformed one, was sent;
 * - `invalid_idempotency_key` (400): the key is optional here, but the one sent is malformed;
 * - `idempotency_key_reused` (409): the key was used for another body, or its first request is still unanswered.
 */
export const IDEMPOTENCY_ERRORS = {
  required: "idempotency_key_required",
  invalid: "invalid_idempotency_key",
  reused: "idempotency_key_reused",
} as const;

export interface IdempotencyOptions {
  /** Refuse requests without a key (400 idempotency_key_required). */
  required: boolean;
  /** HTTP status of the first response, stored with its body (default 201). */
  status?: number;
}

/** Validates the raw header: the key, or null when it is optional and absent. Throws the 400s above. */
export function parseIdempotencyKey(raw: string | undefined, opts: Pick<IdempotencyOptions, "required">): string | null {
  if (raw === undefined && !opts.required) return null;
  const k = IdempotencyKey.safeParse(raw);
  if (!k.success) throw new BadRequestException(opts.required || raw === undefined ? IDEMPOTENCY_ERRORS.required : IDEMPOTENCY_ERRORS.invalid);
  return k.data;
}

/** sha256 of the canonical body (key order does not matter). */
export function requestHash(body: unknown): string {
  return createHash("sha256").update(canonical(body)).digest("hex");
}

/** What the table keeps: `{status, body}`; rows written before the helper hold the bare body. */
interface Stored { status: number; body: unknown }
function stored(v: unknown): Stored {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 2 && typeof o.status === "number" && "body" in o) return { status: o.status, body: o.body };
  }
  return { status: 201, body: v };
}

/**
 * Runs `fn` at most once per (user, endpoint, key), inside the caller's transaction `c`
 * (the same one as the write, so a failed request rolls the claim back and the key stays usable).
 *
 * - No key and `required: false`: just runs `fn`.
 * - First use: claims the key, runs `fn`, stores `{status, body}` of its result.
 * - Repeat with the same canonical body: returns the stored body without running `fn`.
 * - Repeat with another body, or while the first is unanswered: 409 `idempotency_key_reused`.
 *   A concurrent repeat blocks on the first request's uncommitted claim until it commits or rolls back.
 *
 * Checks placed before the call (visibility, permission) also gate replays; checks inside `fn` do not.
 */
export async function idempotent<T>(
  c: pg.PoolClient, user: { id: string }, endpoint: string, rawKey: string | undefined, body: unknown,
  opts: IdempotencyOptions, fn: () => Promise<T>,
): Promise<T> {
  const key = parseIdempotencyKey(rawKey, opts);
  if (key === null) return fn();
  const hash = requestHash(body);
  const claimed = await c.query(
    `INSERT INTO eureka.idempotency_key (key, user_id, endpoint, request_hash) VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING RETURNING key`, [key, user.id, endpoint, hash]);
  if (claimed.rowCount === 0) {
    const prior = (await c.query<{ request_hash: string; response: unknown }>(
      `SELECT request_hash, response FROM eureka.idempotency_key WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
      [user.id, endpoint, key])).rows[0];
    if (!prior || prior.request_hash !== hash || prior.response === null) throw new ConflictException(IDEMPOTENCY_ERRORS.reused);
    return stored(prior.response).body as T;
  }
  const result = await fn();
  const response: Stored = { status: opts.status ?? 201, body: result };
  await c.query(`UPDATE eureka.idempotency_key SET response = $4 WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
    [user.id, endpoint, key, JSON.stringify(response)]);
  return result;
}
