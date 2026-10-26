import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

/**
 * Departments (migration 0220): admin-only writes through definer functions,
 * and descriptive only: nothing in authz or any policy reads a department.
 */
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
}, 90_000);

afterAll(async () => {
  await db?.drop();
});

const NIL = "00000000-0000-0000-0000-00000000beef";
const create = (actor: string, name: string, parent: string | null = null) =>
  asUser(db.app, actor, async (c) =>
    (await c.query<{ id: string }>(`SELECT authz.admin_create_department($1, $2) AS id`, [name, parent])).rows[0]!.id, true);

describe("department privileges", () => {
  it.each([
    [`INSERT INTO eureka.department (name) VALUES ('x')`],
    [`UPDATE eureka.department SET name = 'x'`],
    [`UPDATE eureka.app_user SET department_id = NULL WHERE id = '${U.r1a}'`],
  ])("even an admin cannot write directly: %s", async (sql) => {
    await expect(asUser(db.app, U.admin, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
  });

  it("the API role reads departments and app_user.department_id", async () => {
    const n = await asUser(db.app, U.r1a, async (c) =>
      (await c.query(`SELECT d.id FROM eureka.department d LEFT JOIN eureka.app_user u ON u.department_id = d.id`)).rowCount);
    expect(n).toBeGreaterThanOrEqual(0);
  });

  it.each([
    [`SELECT authz.admin_create_department('X', NULL)`, []],
    [`SELECT authz.admin_rename_department($1, 'X')`, [NIL]],
    [`SELECT authz.admin_set_user_department($1, NULL)`, [U.r1b]],
  ])("refuses callers without access:manage: %s", async (sql, params) => {
    for (const actor of [U.r1a, U.l1, U.m1, U.ad, U.ceo, U.hr, U.locD, "00000000-0000-0000-0000-00000000dead"]) {
      await expect(asUser(db.app, actor, (c) => c.query(sql, params)), actor).rejects.toThrow(/not_permitted/);
    }
    await expect(db.app.query(sql, params)).rejects.toThrow(/not_permitted/);
  });
});

describe("department functions", () => {
  let sales: string;
  let prep: string;

  it("creates a department and a sub-department; two levels only", async () => {
    sales = await create(U.admin, "  Sales ");
    prep = await create(U.admin, "Interview Prep", sales);
    const rows = (await db.admin.query(`SELECT name, parent_id FROM eureka.department WHERE id = ANY($1) ORDER BY name`, [[sales, prep]])).rows;
    expect(rows).toEqual([{ name: "Interview Prep", parent_id: sales }, { name: "Sales", parent_id: null }]);
    await expect(create(U.admin, "Too deep", prep)).rejects.toThrow(/invalid_parent/);
    await expect(create(U.admin, "Orphan", NIL)).rejects.toThrow(/department_not_found/);
  });

  it("rejects bad names and duplicate siblings (case-insensitive)", async () => {
    for (const bad of ["", "   ", "x".repeat(121), "a\u0007b"]) {
      await expect(create(U.admin, bad), JSON.stringify(bad)).rejects.toThrow(/invalid_name/);
    }
    await expect(create(U.admin, "sales")).rejects.toMatchObject({ code: "23505", constraint: "department_name_key" });
    await expect(create(U.admin, "INTERVIEW PREP", sales)).rejects.toMatchObject({ constraint: "department_name_key" });
    // The same name under another parent is fine.
    const other = await create(U.admin, "Bench Sales");
    await create(U.admin, "Interview Prep", other);
  });

  it("renames", async () => {
    await asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_rename_department($1, ' Sales US ')`, [sales]), true);
    expect((await db.admin.query(`SELECT name FROM eureka.department WHERE id = $1`, [sales])).rows[0].name).toBe("Sales US");
    await expect(asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_rename_department($1, 'X')`, [NIL]))).rejects.toThrow(/department_not_found/);
    await expect(asUser(db.app, U.admin, (c) => c.query(`SELECT authz.admin_rename_department($1, '')`, [sales]))).rejects.toThrow(/invalid_name/);
  });

  it("sets and clears a user's department, returning the previous one; admins may set their own", async () => {
    const set = (user: string, dept: string | null) => asUser(db.app, U.admin, async (c) =>
      (await c.query<{ p: string | null }>(`SELECT authz.admin_set_user_department($1, $2) AS p`, [user, dept])).rows[0]!.p, true);
    expect(await set(U.coach, prep)).toBeNull();
    expect(await set(U.coach, sales)).toBe(prep);
    expect(await set(U.coach, null)).toBe(sales);
    expect(await set(U.admin, sales)).toBeNull();
    await expect(set(NIL, sales)).rejects.toThrow(/user_not_found/);
    await expect(set(U.coach, NIL)).rejects.toThrow(/department_not_found/);
  });
});

describe("descriptive only", () => {
  it("no authz function other than the admin department writers, and no policy, reads a department", async () => {
    const fns = await db.admin.query<{ sig: string }>(`
      SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('authz', 'eureka') AND p.prosrc ILIKE '%department%'
        AND p.proname NOT IN ('admin_create_department', 'admin_rename_department', 'admin_set_user_department')`);
    expect(fns.rows).toEqual([]);
    const policies = await db.admin.query<{ policyname: string }>(`
      SELECT policyname FROM pg_policies WHERE coalesce(qual, '') ILIKE '%department%' OR coalesce(with_check, '') ILIKE '%department%'`);
    expect(policies.rows).toEqual([]);
  });
});
