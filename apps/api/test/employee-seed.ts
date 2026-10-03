import { asUser, type TestDb } from "./db-harness.js";
import { LOC, T, U } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission, transitionPlacement } from "./placement-seed.js";

/** Walks a placement from confirmed to joined as `actor` (opens the assignment and the employee record). */
export async function joinPlacement(db: TestDb, actor: string, placementId: string): Promise<void> {
  for (const to of ["paperwork", "bgc", "ready", "joined"]) await transitionPlacement(db, actor, placementId, to);
}

export interface Joined { candidateId: string; personId: string; placementId: string; assignmentId: string }

/**
 * A fresh candidate placed and joined by `actor` (default r1a, team t1, Dallas).
 * The candidate is owned by the actor so Sales scopes can reach it.
 */
export async function joinedEmployee(
  db: TestDb,
  o: { actor?: string; teamId?: string; locationId?: string; candidateId?: string } = {},
): Promise<Joined> {
  const actor = o.actor ?? U.r1a;
  const candidateId = o.candidateId ?? (await newCandidate(db, {
    teamId: o.teamId ?? T.t1, recruiterId: actor, locationId: o.locationId ?? LOC.dallas,
  })).id;
  const sub = await selectedSubmission(db, actor, candidateId);
  const p = await createPlacement(db, actor, sub);
  await joinPlacement(db, actor, p.id);
  const a = (await db.admin.query<{ id: string; person_id: string }>(
    `SELECT id, person_id FROM eureka.assignment WHERE placement_id = $1`, [p.id])).rows[0]!;
  return { candidateId, personId: a.person_id, placementId: p.id, assignmentId: a.id };
}

/** Superuser write with triggers off (test setup only: back-dating dates the app sets to today). */
export async function force(db: TestDb, sql: string, params: unknown[]): Promise<void> {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

/** Moves an assignment's start (and the employee's dates) into the past so end dates before today are valid. */
export async function backdate(db: TestDb, j: Joined, start: string): Promise<void> {
  await force(db, `UPDATE eureka.assignment SET start_date = $2 WHERE id = $1`, [j.assignmentId, start]);
  await force(db, `UPDATE eureka.employee SET employee_since = least(employee_since, $2::date), status_since = $2 WHERE person_id = $1`,
    [j.personId, start]);
}

/** Calls an employment definer function as `actor` (committed). */
export const asActor = <T>(db: TestDb, actor: string, sql: string, params: unknown[]) =>
  asUser(db.app, actor, async (c) => (await c.query<T & Record<string, unknown>>(sql, params)).rows, true);
