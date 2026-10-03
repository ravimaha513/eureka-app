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
