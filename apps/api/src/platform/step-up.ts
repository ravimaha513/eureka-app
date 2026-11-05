import { ForbiddenException } from "@nestjs/common";
import type pg from "pg";
import type { AuthedUser } from "./auth.guard.js";

/**
 * Step-up gate for restricted actions (design A6.1): the caller's session must
 * hold a live step-up grant (authz.step_up_current, migration 0043; obtained
 * through /api/auth/step-up). Returns the grant id for the audit row (an id
 * only); otherwise 403 `step_up_required`, which the web app answers with
 * "Confirm it's you". Run inside the caller's withUser transaction.
 */
export async function requireStepUp(c: pg.PoolClient, user: Pick<AuthedUser, "sessionHash">): Promise<string> {
  const g = (await c.query<{ grant_id: string }>(`SELECT grant_id FROM authz.step_up_current($1)`, [user.sessionHash])).rows[0];
  if (!g) throw new ForbiddenException("step_up_required");
  return g.grant_id;
}

/**
 * GET /api/auth/step-up in one statement (audit F-03): the session's live grant
 * (authz.step_up_current) and, when password sign-in is on, whether the caller
 * has a password (authz.password_has_credential). Run inside the caller's withUser.
 */
export async function stepUpStatus(
  c: pg.PoolClient, user: Pick<AuthedUser, "sessionHash">, passwordLogin: boolean,
): Promise<{ grant: { method: string; expires_at: Date } | undefined; hasPassword: boolean }> {
  const r = (await c.query<{ method: string | null; expires_at: Date | null; has_password: boolean }>(
    `SELECT g.method, g.expires_at, CASE WHEN $2::boolean THEN authz.password_has_credential() ELSE false END AS has_password
     FROM (SELECT 1) one LEFT JOIN LATERAL (SELECT method, expires_at FROM authz.step_up_current($1) LIMIT 1) g ON true`,
    [user.sessionHash, passwordLogin])).rows[0]!;
  return {
    grant: r.method !== null && r.expires_at !== null ? { method: r.method, expires_at: r.expires_at } : undefined,
    hasPassword: r.has_password === true,
  };
}
