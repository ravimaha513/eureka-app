import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, TECH_ID, U, seedFixtures, type FixtureCandidate } from "./fixtures.js";

/**
 * Database least privilege for the API and worker roles (migration 0502, security review G-01, G-02,
 * G-03; roadmap R-07). A lint over the grants, plus the behaviour that follows from them.
 */
let db: TestDb;
let candidates: FixtureCandidate[];

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
}, 90_000);

afterAll(async () => {
  await db?.drop();
});

const priv = async (sql: string, params: unknown[] = []) => (await db.admin.query<{ ok: boolean }>(`SELECT ${sql} AS ok`, params)).rows[0]!.ok;

describe("grant lint", () => {
  it.each([
    ["eureka.candidate", "UPDATE"], ["eureka.person", "UPDATE"],
    ["eureka.candidate", "INSERT"], ["eureka.person", "INSERT"], ["eureka.job", "INSERT"],
  ])("eureka_app holds no table-wide privilege on %s: %s", async (table, p) => {
    expect(await priv(`has_table_privilege('eureka_app', $1, $2)`, [table, p])).toBe(false);
  });

  it("server-managed and unused columns are not writable by eureka_app", async () => {
    for (const col of ["created_at", "dob_enc", "dob_bidx", "dob_year", "personal_email", "first_name"]) {
      expect(await priv(`has_column_privilege('eureka_app', 'eureka.person', $1, 'UPDATE')`, [col]), col).toBe(false);
    }
    for (const col of ["created_at", "dob_enc", "dob_bidx", "dob_year"]) {
      expect(await priv(`has_column_privilege('eureka_app', 'eureka.person', $1, 'INSERT')`, [col]), col).toBe(false);
    }
    for (const col of ["id", "person_id", "created_at", "updated_at", "row_version", "bench_since", "offer_letter_company_id", "form1099_company_id"]) {
      expect(await priv(`has_column_privilege('eureka_app', 'eureka.candidate', $1, 'UPDATE')`, [col]), col).toBe(false);
    }
    for (const col of ["id", "owner_id", "team_id", "row_version", "created_at", "updated_at", "posted_at"]) {
      expect(await priv(`has_column_privilege('eureka_app', 'eureka.job', $1, 'INSERT')`, [col]), col).toBe(false);
    }
  });

  it("a column added later is not writable by eureka_app until a migration grants it (fail closed)", async () => {
    const c = await db.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("ALTER TABLE eureka.candidate ADD COLUMN lint_probe text");
      await c.query("ALTER TABLE eureka.person ADD COLUMN lint_probe text");
      for (const t of ["eureka.candidate", "eureka.person"]) {
        for (const p of ["INSERT", "UPDATE"]) {
          expect((await c.query(`SELECT has_column_privilege('eureka_app', $1, 'lint_probe', $2) AS ok`, [t, p])).rows[0].ok, `${t} ${p}`).toBe(false);
        }
      }
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("the worker cannot execute authz.transition_candidate (G-02)", async () => {
    expect(await priv(`has_function_privilege('eureka_worker', 'authz.transition_candidate(uuid, text)', 'EXECUTE')`)).toBe(false);
    expect(await priv(`has_function_privilege('eureka_app', 'authz.transition_candidate(uuid, text)', 'EXECUTE')`)).toBe(true);
  });
});

describe("behaviour", () => {
  const own = () => candidates.find((c) => c.recruiterId === U.r1a && c.marketingStatus === "active")!;

  it("the worker cannot act as an admin through transition_candidate", async () => {
    await expect(asUser(db.worker, U.admin, (c) => c.query(`SELECT authz.transition_candidate($1, 'on_hold')`, [own().id])))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("the API role cannot rewrite a person's contacts or server-managed columns, even as the owner", async () => {
    for (const set of [`personal_email = 'x@example.com'`, `created_at = now() - interval '1 year'`, `dob_year = 1990`]) {
      await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.person SET ${set} WHERE id = (SELECT person_id FROM eureka.candidate WHERE id = $1)`, [own().id])), set)
        .rejects.toMatchObject({ code: "42501" });
    }
    await expect(asUser(db.app, U.l1, (c) => c.query(`INSERT INTO eureka.person (first_name, last_name, created_at) VALUES ('A', 'B', '2020-01-01')`)))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asUser(db.app, U.l1, (c) => c.query(`INSERT INTO eureka.person (first_name, last_name, dob_year) VALUES ('A', 'B', 1990)`)))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("the API role cannot set candidate columns outside its allow-list, even with org scope", async () => {
    for (const set of [`created_at = now() - interval '1 year'`, `row_version = 99`, `bench_since = current_date`, `form1099_company_id = NULL`]) {
      await expect(asUser(db.app, U.ceo, (c) => c.query(`UPDATE eureka.candidate SET ${set} WHERE id = $1`, [own().id])), set)
        .rejects.toMatchObject({ code: "42501" });
    }
  });

  it("the API's own writes still work: candidate create columns and a profile edit", async () => {
    const id = await asUser(db.app, U.l1, async (c) => {
      const pid = (await c.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0]!.id;
      await c.query(`INSERT INTO eureka.person (id, first_name, last_name, phone_e164, personal_email) VALUES ($1, 'Least', 'Priv', '+14695550777', 'least.priv@example.com')`, [pid]);
      const cid = (await c.query<{ id: string }>(`INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id, batch_id)
        VALUES ($1, $2, $3, $4, $5, NULL) RETURNING id`, [pid, TECH_ID, T.t1, U.r1a, LOC.dallas])).rows[0]!.id;
      expect((await c.query(`UPDATE eureka.candidate SET priority = 'P1', marketing_email = 'mkt.lp@example.com' WHERE id = $1`, [cid])).rowCount).toBe(1);
      return cid;
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
