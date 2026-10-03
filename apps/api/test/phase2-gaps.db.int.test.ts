import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityVisible, resolveScope, type ActivityRef } from "@eureka/shared";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures, toUserAccess } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission } from "./placement-seed.js";

/**
 * Database-only checks for migration 0035 (paperwork checklist created with
 * the placement): every rule holds with the API removed (design B8).
 */
let db: TestDb;

const W2 = [
  { doc_type: "offer_letter", owner_role: "hr", required: true },
  { doc_type: "i9", owner_role: "hr" },
  { doc_type: "direct_deposit", owner_role: "accounts", required: false },
];
const C2C = [{ doc_type: "msa", owner_role: "accounts", required: true }];

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type, items) VALUES
    ('paperwork', 'w2', $1::jsonb), ('paperwork', 'c2c', $2::jsonb), ('onboarding', 'w2', $3::jsonb)`,
  [JSON.stringify(W2), JSON.stringify(C2C), JSON.stringify([{ doc_type: "laptop", owner_role: "hr" }])]);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const users = Object.keys(U) as (keyof typeof U)[];
const items = async (placementId: string) => (await db.admin.query(
  `SELECT kind, position, doc_type, owner_role, required, status FROM eureka.checklist_item
   WHERE placement_id = $1 ORDER BY position`, [placementId])).rows;

async function placed(type = "w2", actor = U.r1a, cand: Parameters<typeof newCandidate>[1] = { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas }) {
  const c = await newCandidate(db, cand);
  const sub = await selectedSubmission(db, actor, c.id);
  return { ...(await createPlacement(db, actor, sub, { type })), cand: c };
}

describe("checklist created with the placement", () => {
  it("copies the paperwork template of the placement type, in order, all pending", async () => {
    const { id } = await placed("w2");
    expect(await items(id)).toEqual([
      { kind: "paperwork", position: 1, doc_type: "offer_letter", owner_role: "hr", required: true, status: "pending" },
      { kind: "paperwork", position: 2, doc_type: "i9", owner_role: "hr", required: true, status: "pending" },
      { kind: "paperwork", position: 3, doc_type: "direct_deposit", owner_role: "accounts", required: false, status: "pending" },
    ]);
  });

  it("uses the template of its own type and none when the type has no template", async () => {
    expect((await items((await placed("c2c")).id)).map((i) => i.doc_type)).toEqual(["msa"]);
    expect(await items((await placed("1099")).id)).toEqual([]);
  });

  it("a later template version does not rewrite existing placements (versions are immutable, 0044)", async () => {
    const { id } = await placed("c2c");
    await db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type, items)
                          VALUES ('paperwork', 'c2c', '[{"doc_type":"w9","owner_role":"accounts"}]')`);
    expect((await items(id)).map((i) => i.doc_type)).toEqual(["msa"]);
    expect((await items((await placed("c2c")).id)).map((i) => i.doc_type)).toEqual(["w9"]);
    await db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type, items) VALUES ('paperwork', 'c2c', $1::jsonb)`,
      [JSON.stringify(C2C)]);
  });

  it("a refused placement leaves no checklist behind", async () => {
    const c = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
    const sub = await selectedSubmission(db, U.r1a, c.id);
    await expect(createPlacement(db, U.r1a, sub, { type: "w2", contacts: [{ kind: "bogus", name: "x" }] })).rejects.toThrow();
    const n = await db.admin.query(`SELECT count(*)::int AS n FROM eureka.checklist_item i
      JOIN eureka.placement p ON p.id = i.placement_id WHERE p.submission_id = $1`, [sub]);
    expect(n.rows[0].n).toBe(0);
  });
});

describe("template validation", () => {
  it.each([
    ["not an object", ["offer_letter"]],
    ["missing doc_type", [{ owner_role: "hr" }]],
    ["doc_type not snake_case", [{ doc_type: "Offer Letter", owner_role: "hr" }]],
    ["unknown role", [{ doc_type: "offer_letter", owner_role: "nobody" }]],
    ["required not boolean", [{ doc_type: "offer_letter", owner_role: "hr", required: "yes" }]],
    ["extra key (free text)", [{ doc_type: "offer_letter", owner_role: "hr", note: "call Bob" }]],
    ["duplicate doc_type", [{ doc_type: "i9", owner_role: "hr" }, { doc_type: "i9", owner_role: "accounts" }]],
  ])("refuses %s", async (_name, value) => {
    await expect(db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type, items)
      VALUES ('paperwork', 'w2', $1::jsonb)`, [JSON.stringify(value)])).rejects.toThrow(/invalid_checklist_template/);
  });

  it("refuses a non-array or an unknown kind or type", async () => {
    await expect(db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type, items) VALUES ('paperwork','1099','{}')`))
      .rejects.toThrow(/invalid_checklist_template/);
    await expect(db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type, items) VALUES ('paperwork','1099',NULL)`))
      .rejects.toThrow(/invalid_checklist_template/);
    await expect(db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type) VALUES ('bgc','1099')`))
      .rejects.toThrow(/check/);
    await expect(db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type) VALUES ('paperwork','h1b')`))
      .rejects.toThrow(/check/);
  });
});

describe("write paths are closed", () => {
  it("the app and the worker cannot read templates or write items", async () => {
    const { id } = await placed("w2");
    await expect(asUser(db.app, U.r1a, (c) => c.query(`SELECT * FROM authz.checklist_template`))).rejects.toThrow(/permission denied/);
    await expect(db.worker.query(`SELECT * FROM authz.checklist_template`)).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(
      `INSERT INTO eureka.checklist_item (placement_id, kind, position, doc_type, owner_role, required)
       VALUES ($1, 'paperwork', 9, 'extra', 'hr', true)`, [id]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.checklist_item SET required = false WHERE placement_id = $1`, [id])))
      .rejects.toThrow(/permission denied/);
    await expect(asUser(db.app, U.r1a, (c) => c.query(`DELETE FROM eureka.checklist_item WHERE placement_id = $1`, [id])))
      .rejects.toThrow(/permission denied/);
    await expect(db.worker.query(`SELECT * FROM eureka.checklist_item`)).rejects.toThrow(/permission denied/);
  });

  it("the guard refuses every writer but the definer, even the owner, and items are append-only", async () => {
    const { id } = await placed("w2");
    await expect(db.admin.query(
      `INSERT INTO eureka.checklist_item (placement_id, kind, position, doc_type, owner_role, required)
       VALUES ($1, 'paperwork', 9, 'extra', 'hr', true)`, [id])).rejects.toThrow(/only by placement functions/);
    await expect(db.admin.query(`UPDATE eureka.checklist_item SET required = false WHERE placement_id = $1`, [id]))
      .rejects.toThrow(/only by placement functions/);
    await expect(db.admin.query(`DELETE FROM eureka.checklist_item WHERE placement_id = $1`, [id]))
      .rejects.toThrow(/only by placement functions/);
  });

  it("the internal functions are not executable by the app", async () => {
    const { rows } = await db.admin.query(`
      SELECT p.proname, has_function_privilege('eureka_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('eureka_worker', p.oid, 'EXECUTE') AS worker,
             p.prosecdef, p.proconfig
      FROM pg_proc p WHERE p.proname IN ('checklist_on_placement', 'checklist_template_check', 'checklist_item_write_guard')
      ORDER BY p.proname`);
    expect(rows.map((r) => [r.proname, r.app, r.worker])).toEqual([
      ["checklist_item_write_guard", false, false], ["checklist_on_placement", false, false], ["checklist_template_check", false, false]]);
    for (const r of rows) expect(r.proconfig).toContain("search_path=pg_catalog, pg_temp");
  });
});

describe("RLS differential: checklist items are visible where the placement is, or under document:read (0044)", () => {
  const made: (ActivityRef & { id: string })[] = [];

  beforeAll(async () => {
    const plan: { actor: string; cand: Parameters<typeof newCandidate>[1] }[] = [
      { actor: U.r1a, cand: { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas } },
      { actor: U.r1b, cand: { teamId: T.t1, recruiterId: U.r1b, locationId: LOC.austin } },
      { actor: U.l1, cand: { teamId: T.t1, recruiterId: null, locationId: LOC.dallas } },
      { actor: U.r2a, cand: { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.austin } },
      { actor: U.r2a, cand: { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.dallas, visibility: "all_teams" } },
      { actor: U.r3a, cand: { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.austin } },
    ];
    for (const { actor, cand } of plan) {
      const { id, cand: c } = await placed("w2", actor, cand);
      const p = (await db.admin.query(`SELECT * FROM eureka.placement WHERE id = $1`, [id])).rows[0];
      const cs = (await db.admin.query(`SELECT marketing_status FROM eureka.candidate WHERE id = $1`, [c.id])).rows[0];
      made.push({ id, recruiterId: p.recruiter_id, teamId: p.team_id, locationId: p.location_id,
        candidate: { ...c, marketingStatus: cs.marketing_status } });
    }
  }, 60_000);

  it.each(users)("%s", async (key) => {
    const scope = resolveScope(toUserAccess(key), "placement:read");
    const docs = resolveScope(toUserAccess(key), "document:read");
    const ids = new Set(made.map((m) => m.id));
    const seen = await asUser(db.app, U[key], async (c) => ({
      // With RLS alone (no application predicate).
      items: (await c.query<{ placement_id: string }>(`SELECT DISTINCT placement_id FROM eureka.checklist_item`)).rows
        .map((r) => r.placement_id).filter((i) => ids.has(i)).sort(),
      placements: (await c.query<{ id: string }>(`SELECT id FROM eureka.placement`)).rows
        .map((r) => r.id).filter((i) => ids.has(i)).sort(),
    }));
    const expected = made.filter((m) => activityVisible(scope, m) || activityVisible(docs, m)).map((m) => m.id).sort();
    expect(seen.items).toEqual(expected);
    expect(seen.placements).toEqual(made.filter((m) => activityVisible(scope, m)).map((m) => m.id).sort());
  });

  it("the read policy probes the placement by key, with no per-row definer calls", async () => {
    const { rows } = await db.admin.query(`
      SELECT pg_get_expr(polqual, polrelid) AS def FROM pg_policy WHERE polname = 'checklist_item_read'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toMatch(/EXISTS/);
    // Scope functions appear only as InitPlans (rule 3), never called per row.
    expect(rows[0].def).not.toMatch(/(?<!SELECT )authz\./);
  });
});
