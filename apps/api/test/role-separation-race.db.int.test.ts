import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

/**
 * "Admin is only admin" under concurrency (security gate, wave 3): granting an admin role to a user
 * while another session gives a business permission to a custom role that user already holds must
 * not let both pass. authz.role_separation share-locks every role the user holds, so it waits for
 * role_set_grants (FOR UPDATE on the role) and classifies with the committed grants; in the other
 * order role_set_grants waits for the grant and its role_held_by_admin check sees the new admin.
 */
let db: TestDb;
const Z = "00000000-0000-0000-0000-0000000004a0";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO eureka.app_user (id, email, display_name) VALUES ('${Z}', 'race@eureka.example', 'Race')`);
  // A custom admin-compatible role Z holds, and a custom admin-trait role that applies without approval.
  await db.admin.query(`INSERT INTO eureka.role (key, label) VALUES ('c_race', 'Race chat')`);
  await db.admin.query(`INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ('c_race', 'chat:use', 'own')`);
  await db.admin.query(`INSERT INTO eureka.role (key, label, is_admin) VALUES ('c_race_admin', 'Race admin', true)`);
  await db.admin.query(`INSERT INTO eureka.role_permission (role_key, permission, scope) VALUES ('c_race_admin', 'access:manage', 'org')`);
}, 90_000);

afterAll(async () => {
  await db?.drop();
});

async function session(actor: string = U.admin): Promise<pg.PoolClient> {
  const c = await db.app.connect();
  await c.query("BEGIN");
  await c.query("SET LOCAL lock_timeout = '10s'");
  await c.query("SELECT set_config('eureka.user_id', $1, true)", [actor]);
  return c;
}

async function reset() {
  await db.admin.query(`DELETE FROM eureka.role_request WHERE user_id = '${Z}'`);
  await db.admin.query(`DELETE FROM eureka.user_role WHERE user_id = '${Z}'`);
  await db.admin.query(`DELETE FROM eureka.role_permission WHERE role_key = 'c_race' AND permission <> 'chat:use'`);
  await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ('${Z}', 'c_race')`);
}

/** Resolves to "pending" if p has not settled within ms. */
const settledWithin = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => "settled", () => "settled"), new Promise((r) => setTimeout(() => r("pending"), ms))]);

describe("admin/data separation under concurrent grant and grant edit", () => {
  it("grant edit first: the admin grant waits, then refuses (separation_of_duties)", async () => {
    await reset();
    const a = await session();
    const b = await session();
    try {
      await a.query(`SELECT authz.role_set_grants('c_race', '{"chat:use":"own","candidate:read":"own"}'::jsonb, NULL)`);
      const grant = b.query(`SELECT * FROM authz.request_role($1, 'c_race_admin', NULL)`, [Z]);
      grant.catch(() => undefined);
      expect(await settledWithin(grant, 400)).toBe("pending");
      await a.query("COMMIT");
      await expect(grant).rejects.toThrow(/separation_of_duties/);
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      await b.query("ROLLBACK").catch(() => undefined);
      a.release();
      b.release();
    }
    expect((await db.admin.query(`SELECT * FROM eureka.user_role WHERE user_id = $1 AND role_key = 'c_race_admin'`, [Z])).rows).toEqual([]);
  });

  it("admin grant first: the grant edit waits, then refuses (role_held_by_admin)", async () => {
    await reset();
    // Admin-trait roles are restricted: request as admin, approve as admin2 (the approval writes user_role).
    const req = (await db.admin.query<{ id: string }>(
      `INSERT INTO eureka.role_request (user_id, role_key, requested_by, status) VALUES ($1, 'c_race_admin', $2, 'pending') RETURNING id`,
      [Z, U.admin])).rows[0]!.id;
    const a = await session();
    const b = await session(U.admin2);
    try {
      expect((await b.query(`SELECT authz.approve_role_request($1) AS s`, [req])).rows[0]).toEqual({ s: "approved" });
      const edit = a.query(`SELECT authz.role_set_grants('c_race', '{"chat:use":"own","candidate:read":"own"}'::jsonb, NULL)`);
      edit.catch(() => undefined);
      expect(await settledWithin(edit, 400)).toBe("pending");
      await b.query("COMMIT");
      await expect(edit).rejects.toThrow(/role_held_by_admin/);
    } finally {
      await a.query("ROLLBACK").catch(() => undefined);
      await b.query("ROLLBACK").catch(() => undefined);
      a.release();
      b.release();
    }
    expect((await db.admin.query(`SELECT * FROM authz.user_admin_violations()`).catch(() => ({ rows: [] }))).rows
      .filter((r: { user_id: string }) => r.user_id === Z)).toEqual([]);
  });
});
