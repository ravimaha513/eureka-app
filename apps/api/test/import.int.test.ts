import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityVisible, candidateVisible, resolveScope, type CandidateRef } from "@eureka/shared";
import { run } from "../src/import/cli.js";
import { commitBatch } from "../src/import/commit.js";
import { reconcile, type Reconciliation } from "../src/import/report.js";
import { approveBatch, decide, listReview } from "../src/import/review.js";
import { stage } from "../src/import/stage.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { U, USERS, seedFixtures, toUserAccess } from "./fixtures.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/import");
const FILES = { sales: join(DIR, "sales.csv"), interviews: join(DIR, "interviews.csv"), placements: join(DIR, "placements.csv") };
const MAPPING = readFileSync(join(DIR, "mapping.json"), "utf8");
const ADMIN_BASE = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432";

let db: TestDb;
let imp: pg.Pool;
let batchId: string;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  // The role is NOLOGIN by default; operations enable LOGIN only for the migration window.
  await db.admin.query(`ALTER ROLE eureka_import LOGIN PASSWORD 'eureka_import_test'`);
  const u = new URL(ADMIN_BASE);
  imp = new pg.Pool({ connectionString: `postgres://eureka_import:eureka_import_test@${u.host}/${db.name}`, max: 2 });
}, 90_000);

afterAll(async () => {
  await imp?.end();
  await db?.admin.query(`ALTER ROLE eureka_import NOLOGIN PASSWORD NULL`).catch(() => undefined);
  await db?.drop();
});

type RowView = { sheet: string; row_no: number; state: string; reasons: string[] };
async function rows(id = batchId): Promise<Map<string, RowView>> {
  const r = await imp.query<RowView>(`SELECT sheet, row_no, state, reasons FROM eureka.import_row WHERE batch_id = $1`, [id]);
  return new Map(r.rows.map((x) => [`${x.sheet} ${x.row_no}`, x]));
}
const liveCount = async () => (await db.admin.query<{ c: number; s: number; i: number; p: number }>(
  `SELECT (SELECT count(*) FROM eureka.candidate)::int AS c, (SELECT count(*) FROM eureka.submission)::int AS s,
          (SELECT count(*) FROM eureka.interview)::int AS i, (SELECT count(*) FROM eureka.placement)::int AS p`)).rows[0]!;
const totals = (r: Reconciliation, sheet: "sales" | "interviews" | "placements") => {
  const t = r.sheets[sheet];
  return { in: t.in, clean: t.clean, held: t.held, review: t.review, rejected: t.rejected, skipped: t.skipped, committed: t.committed };
};

describe("staging (dry run: nothing touches live tables)", () => {
  it("stages the fictional sheets through the CLI and reconciles with hand counts", async () => {
    const before = await liveCount();
    const out: string[] = [];
    await run(["stage", "--sales", FILES.sales, "--interviews", FILES.interviews, "--placements", FILES.placements,
      "--mapping", join(DIR, "mapping.json"), "--operator", "admin@eureka.example", "--json"], imp, (s) => out.push(s));
    const res = JSON.parse(out[0]!) as { batchId: string; created: boolean; report: Reconciliation };
    batchId = res.batchId;
    expect(res.created).toBe(true);
    expect(await liveCount()).toEqual(before);

    // Hand counts from the fixture files (docs/import.md "fixtures").
    const rep = res.report;
    expect(totals(rep, "sales")).toEqual({ in: 19, clean: 8, held: 0, review: 10, rejected: 1, skipped: 0, committed: 0 });
    expect(totals(rep, "interviews")).toEqual({ in: 12, clean: 6, held: 1, review: 5, rejected: 0, skipped: 0, committed: 0 });
    expect(totals(rep, "placements")).toEqual({ in: 5, clean: 2, held: 0, review: 3, rejected: 0, skipped: 0, committed: 0 });
    expect(rep.balanced).toBe(true);
    expect(rep.sheets.sales.byStatus["active"]).toEqual({ in: 10, loadable: 2, committed: 0 });
    expect(rep.sheets.sales.byStatus["active/all teams"]).toEqual({ in: 1, loadable: 1, committed: 0 });
    expect(rep.sheets.sales.byStatus["hot"]).toEqual({ in: 1, loadable: 0, committed: 0 });
    expect(rep.sheets.sales.reasons.rejected).toEqual({ duplicate_row: 1 });
    expect(rep.sheets.interviews.byStatus["ghosted"]).toEqual({ in: 1, loadable: 0, committed: 0 });
  });

  it("sends each messy row to review with its reason, and never guesses a status", async () => {
    const r = await rows();
    const reasons = (k: string) => r.get(k)!.reasons;
    expect(r.get("sales 2")!.state).toBe("clean");
    expect(reasons("sales 5")).toEqual(["ambiguous_date:dob"]);
    expect(reasons("sales 6")).toEqual(["invalid_phone:phone"]);
    expect(reasons("sales 7")).toEqual(["unconfirmed_status:status"]); // SRS Q6 placeholder
    expect(reasons("sales 8")).toEqual(["unmapped_row_color:rowColor"]);
    expect(reasons("sales 9")).toEqual(["probable_duplicate"]);
    expect(r.get("sales 10")).toMatchObject({ state: "rejected", reasons: ["duplicate_row"] });
    expect(reasons("sales 11")).toEqual(["unknown_technology:technology"]);
    expect(reasons("sales 12")).toEqual(["unknown_owner:owner"]);
    expect(reasons("sales 17")).toEqual(["status_not_importable"]);
    expect(reasons("sales 18")).toEqual(["missing:name"]);
    expect(reasons("sales 19")).toEqual(["matches_existing_candidate"]);
    expect(r.get("sales 20")!.state).toBe("clean"); // text and confirmed colour agree
    expect(reasons("interviews 5")).toEqual(["name_only_match"]);
    expect(reasons("interviews 6")).toEqual(["no_candidate_match"]);
    expect(reasons("interviews 7")).toEqual(["unmapped_status:callStatus"]);
    expect(reasons("interviews 8")).toEqual(["unknown_client:client"]);
    expect(r.get("interviews 11")).toMatchObject({ state: "held", reasons: ["candidate_not_loadable"] });
    expect(reasons("interviews 12")).toEqual(["invalid_time:startTime"]);
    expect(reasons("placements 4")).toEqual(["ambiguous_date:tentativeStart", "unconfirmed_status:status"]);
    expect(reasons("placements 5")).toEqual(["no_candidate_match"]);
    expect(reasons("placements 6")).toEqual(["invalid_rate:rate"]);
    for (const k of ["interviews 2", "interviews 3", "interviews 4", "interviews 9", "interviews 10", "interviews 13", "placements 2", "placements 3"]) {
      expect(r.get(k)!.state, k).toBe("clean");
    }
    const q = await listReview(imp, batchId);
    expect(q.find((i) => i.sheet === "interviews" && i.rowNo === 5)).toMatchObject({ salesRow: 4, approvable: true });
    expect(q.find((i) => i.sheet === "sales" && i.rowNo === 7)!.approvable).toBe(false);
  });

  it("re-staging the same files is idempotent (same batch, same counts)", async () => {
    const before = await reconcile(imp, batchId);
    const again = await stage(imp, FILES, MAPPING, "admin@eureka.example");
    expect(again).toEqual({ batchId, created: false });
    expect(await reconcile(imp, batchId)).toEqual(before);
  });

  it("dry-run commit runs every real guard, reports what would load and rolls back", async () => {
    const before = await liveCount();
    const r = await commitBatch(imp, batchId, { dryRun: true });
    expect(r.failures).toEqual([]);
    expect(r.loaded).toEqual({ candidates: 8, submissions: 6, interviews: 6, placements: 2 });
    expect(await liveCount()).toEqual(before);
    expect((await reconcile(imp, batchId)).status).toBe("staged");
  });

  it("a guard failure is reported per person and loads nothing for that person", async () => {
    await db.admin.query(`UPDATE eureka.app_user SET status = 'inactive' WHERE id = $1`, [U.r1b]);
    try {
      const r = await commitBatch(imp, batchId, { dryRun: true });
      expect(r.failures).toHaveLength(1); // Priya (owner r1b): sales 14 and interviews 10
      expect(r.failures[0]!.rows).toEqual(["sales 14", "interviews 10"]);
      expect(r.loaded.candidates).toBe(7);
    } finally {
      await db.admin.query(`UPDATE eureka.app_user SET status = 'active' WHERE id = $1`, [U.r1b]);
    }
  });
});

describe("sign-off and least privilege", () => {
  it("refuses --commit before approval, and the ledger refuses unapproved batches", async () => {
    await expect(commitBatch(imp, batchId, { dryRun: false })).rejects.toThrow(/must be approved/);
    await expect(imp.query(`INSERT INTO eureka.import_link (sheet, row_key, entity_type, entity_id, owner_id, batch_id)
      VALUES ('sales', repeat('a', 64), 'candidate', gen_random_uuid(), $2, $1)`, [batchId, U.r1a])).rejects.toThrow(/batch_not_approved/);
  });

  it("only a second person holding access:manage can approve", async () => {
    await expect(approveBatch(imp, batchId, "admin@eureka.example")).rejects.toThrow(/second_person_required/);
    await expect(approveBatch(imp, batchId, "r1a@eureka.example")).rejects.toThrow(/not_permitted/);
    await expect(imp.query(`UPDATE eureka.import_batch SET status = 'approved' WHERE id = $1`, [batchId])).rejects.toThrow(/server_managed_field|violates/);
    await expect(imp.query(`SELECT authz.import_approve_batch($1)`, [batchId])).rejects.toThrow(/permission denied/);
    await approveBatch(imp, batchId, "admin2@eureka.example");
    const rep = await reconcile(imp, batchId);
    expect([rep.status, rep.approvedBy]).toEqual(["approved", "admin2@eureka.example"]);
    const a = await db.admin.query(`SELECT actor_id FROM eureka.audit_event WHERE action = 'import.batch_approved' AND entity_id = $1`, [batchId]);
    expect(a.rows).toEqual([{ actor_id: U.admin2 }]);
  });

  it("the import role reads no live personal data and the app and worker cannot read staging", async () => {
    await expect(imp.query(`SELECT 1 FROM eureka.person LIMIT 1`)).rejects.toThrow(/permission denied/);
    await expect(imp.query(`SELECT 1 FROM eureka.candidate LIMIT 1`)).rejects.toThrow(/permission denied/);
    await expect(db.app.query(`SELECT 1 FROM eureka.import_row LIMIT 1`)).rejects.toThrow(/permission denied/);
    await expect(db.worker.query(`SELECT 1 FROM eureka.import_batch LIMIT 1`)).rejects.toThrow(/permission denied/);
    await expect(db.app.query(`SELECT authz.import_live_match('a@b.example', NULL)`)).rejects.toThrow(/permission denied/);
    await expect(imp.query(`DELETE FROM eureka.import_row WHERE batch_id = $1`, [batchId])).rejects.toThrow(/permission denied|not deleted/);
    await expect(run(["report", "--batch", batchId], db.app, () => undefined)).rejects.toThrow(/Connect as eureka_import/);
    const role = (await db.admin.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'eureka_import'`)).rows[0];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await db.admin.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'eureka_import'`);
    expect(owned.rows[0].n).toBe(0);
  });
});

describe("commit", () => {
  it("loads the clean rows through the app's own guards and marks the batch committed", async () => {
    const before = await liveCount();
    const out: string[] = [];
    await run(["commit", "--batch", batchId, "--commit", "--json"], imp, (s) => out.push(s));
    const { commit, report } = JSON.parse(out[0]!) as { commit: Awaited<ReturnType<typeof commitBatch>>; report: Reconciliation };
    expect(commit.failures).toEqual([]);
    expect(commit.loaded).toEqual({ candidates: 8, submissions: 6, interviews: 6, placements: 2 });
    const after = await liveCount();
    expect(after).toEqual({ c: before.c + 8, s: before.s + 6, i: before.i + 6, p: before.p + 2 });
    expect(report.status).toBe("committed");
    expect(totals(report, "sales")).toEqual({ in: 19, clean: 0, held: 0, review: 10, rejected: 1, skipped: 0, committed: 8 });
    expect(report.sheets.sales.byStatus["active"]).toEqual({ in: 10, loadable: 2, committed: 2 });
    expect(report.balanced).toBe(true);
  });

  it("produces the same live state the app would: statuses, owners, visibility, snapshots", async () => {
    const r = await db.admin.query<{ first_name: string; marketing_status: string; visibility: string; recruiter_id: string | null; team_id: string; phone_e164: string | null; priority: string; marketing_start_date: string | null }>(
      `SELECT p.first_name, c.marketing_status, c.visibility, c.recruiter_id, c.team_id, p.phone_e164, c.priority, c.marketing_start_date::text
       FROM eureka.import_link l JOIN eureka.candidate c ON c.id = l.entity_id JOIN eureka.person p ON p.id = c.person_id
       WHERE l.sheet = 'sales' ORDER BY p.first_name`);
    const by = Object.fromEntries(r.rows.map((x) => [x.first_name, x]));
    expect(Object.fromEntries(r.rows.map((x) => [x.first_name, x.marketing_status]))).toEqual({
      Anil: "confirmation", Asha: "active", Farah: "placed", Meera: "on_hold", Priya: "stopped", Rahul: "full_of_interviews", Ravi: "active", Tara: "active",
    });
    expect(by.Ravi).toMatchObject({ visibility: "all_teams", recruiter_id: U.r1a, phone_e164: "+12145550102", priority: "P2", marketing_start_date: "2026-08-04" });
    expect(by.Meera).toMatchObject({ visibility: "team", recruiter_id: U.r2a, phone_e164: "+12145550103", marketing_start_date: "2026-08-25" });
    const iv = await db.admin.query(`SELECT i.round, i.starts_at, i.ends_at, i.call_status, s.status AS sub_status
      FROM eureka.import_link l JOIN eureka.interview i ON i.id = l.entity_id JOIN eureka.submission s ON s.id = i.submission_id
      WHERE l.sheet = 'interviews' ORDER BY i.starts_at`);
    expect(iv.rows[0]).toMatchObject({ round: "L1", call_status: "completed", sub_status: "interview_completed" });
    expect(iv.rows[0].starts_at.toISOString()).toBe("2026-09-01T15:00:00.000Z"); // 10:00 CDT
    expect(iv.rows[1].starts_at.toISOString()).toBe("2026-09-10T16:30:00.000Z"); // 11:30 CT, 45 min
    expect(iv.rows[1].ends_at.toISOString()).toBe("2026-09-10T17:15:00.000Z");
    const pl = await db.admin.query(`SELECT p.status, p.placement_type, p.rate::text, p.project_state, p.recruiter_id
      FROM eureka.import_link l JOIN eureka.placement p ON p.id = l.entity_id WHERE l.sheet = 'placements' ORDER BY p.status`);
    expect(pl.rows).toEqual([
      { status: "confirmed", placement_type: "w2", rate: "65.00", project_state: "TX", recruiter_id: U.r1a },
      { status: "joined", placement_type: "c2c", rate: "70.00", project_state: null, recruiter_id: U.r2a },
    ]);
  });

  it("audits every write as the acting user, with no phones, emails or rates (rule 5)", async () => {
    const a = await db.admin.query<{ action: string; actor_id: string; changes: Record<string, unknown> }>(
      `SELECT action, actor_id, changes FROM eureka.audit_event WHERE changes ->> 'source' = 'import'`);
    expect(a.rows.length).toBeGreaterThan(20);
    const actions = new Set(a.rows.map((x) => x.action));
    for (const k of ["candidate.created", "candidate.transition", "candidate.visibility", "submission.created", "submission.status",
      "interview.created", "interview.updated", "placement.created", "placement.status"]) expect(actions, k).toContain(k);
    const text = JSON.stringify(a.rows.map((x) => x.changes));
    expect(text).not.toMatch(/@|\+1\d{10}|"rate"/);
    expect(a.rows.find((x) => x.action === "candidate.visibility")!.actor_id).toBe(U.l1); // the lead, as in the app
  });

  it("imported rows are visible exactly per RLS, like app-created ones (differential vs the engine)", async () => {
    const cands = (await db.admin.query(`SELECT c.id, c.team_id, c.recruiter_id, c.location_id, c.visibility, c.marketing_status
      FROM eureka.import_link l JOIN eureka.candidate c ON c.id = l.entity_id WHERE l.sheet = 'sales'`)).rows;
    const refs = new Map<string, CandidateRef>(cands.map((c) => [c.id, {
      teamId: c.team_id, recruiterId: c.recruiter_id, locationId: c.location_id, visibility: c.visibility, marketingStatus: c.marketing_status,
    }]));
    const ids = [...refs.keys()];
    const subs = (await db.admin.query(`SELECT id, candidate_id, recruiter_id, team_id, location_id FROM eureka.submission
      WHERE candidate_id = ANY($1::uuid[])`, [ids])).rows;
    const ints = (await db.admin.query(`SELECT id, candidate_id, recruiter_id, team_id, location_id FROM eureka.interview
      WHERE candidate_id = ANY($1::uuid[])`, [ids])).rows;
    for (const key of Object.keys(USERS) as (keyof typeof USERS)[]) {
      const access = toUserAccess(key);
      const expected = ids.filter((id) => candidateVisible(resolveScope(access, "candidate:read"), refs.get(id)!)).sort();
      const actual = await asUser(db.app, access.userId, async (c) =>
        (await c.query(`SELECT id FROM eureka.candidate WHERE id = ANY($1::uuid[])`, [ids])).rows.map((r) => r.id).sort());
      expect(actual, key).toEqual(expected);
      for (const [table, list, perm] of [["submission", subs, "submission:read"], ["interview", ints, "interview:read"]] as const) {
        const exp = list.filter((s) => activityVisible(resolveScope(access, perm), {
          recruiterId: s.recruiter_id, teamId: s.team_id, locationId: s.location_id, candidate: refs.get(s.candidate_id)!,
        })).map((s) => s.id).sort();
        const act = await asUser(db.app, access.userId, async (c) =>
          (await c.query(`SELECT id FROM eureka.${table} WHERE candidate_id = ANY($1::uuid[])`, [ids])).rows.map((r) => r.id).sort());
        expect(act, `${key} ${table}`).toEqual(exp);
      }
    }
  });

  it("re-running is idempotent: nothing is loaded twice", async () => {
    const before = await liveCount();
    const dry = await commitBatch(imp, batchId, { dryRun: true });
    expect(dry.loaded).toEqual({ candidates: 0, submissions: 0, interviews: 0, placements: 0 });
    expect(await stage(imp, FILES, MAPPING, "admin@eureka.example")).toEqual({ batchId, created: false });
    // A fresh batch of the same sheets (another mapping revision) skips every loaded row.
    const second = await stage(imp, FILES, `${MAPPING}\n`, "admin@eureka.example");
    expect(second.created).toBe(true);
    const rep = await reconcile(imp, second.batchId);
    expect(totals(rep, "sales")).toEqual({ in: 19, clean: 0, held: 0, skipped: 9, review: 9, rejected: 1, committed: 0 });
    expect(rep.sheets.sales.reasons.skipped).toEqual({ already_imported: 8, person_already_imported: 1 });
    expect(totals(rep, "interviews")).toEqual({ in: 12, clean: 0, held: 1, skipped: 6, review: 5, rejected: 0, committed: 0 });
    expect(totals(rep, "placements")).toMatchObject({ clean: 0, skipped: 2 });
    await approveBatch(imp, second.batchId, "admin2@eureka.example");
    const c2 = await commitBatch(imp, second.batchId, { dryRun: false });
    expect(c2.loaded).toEqual({ candidates: 0, submissions: 0, interviews: 0, placements: 0 });
    expect(await liveCount()).toEqual(before);
  });
});

describe("review queue", () => {
  it("decisions withdraw the approval, re-analyse, and approved rows load after a new sign-off", async () => {
    // Sanjay: ambiguous DOB -> load without DOB. Meera's interview: accept the name-only match.
    // John Doe's interview: the reviewer knows it is Priya's (same team). Unknown placement: reject.
    await decide(imp, batchId, "sales", 5, { action: "approve" }, "l1@eureka.example");
    expect((await reconcile(imp, batchId)).status).toBe("staged");
    await decide(imp, batchId, "interviews", 5, { action: "approve" }, "l1@eureka.example");
    await decide(imp, batchId, "interviews", 6, { action: "link", salesRowNo: 14 }, "l1@eureka.example");
    await decide(imp, batchId, "placements", 5, { action: "reject" }, "l1@eureka.example");
    await expect(decide(imp, batchId, "sales", 7, { action: "approve" }, "l1@eureka.example")).rejects.toThrow(/Nothing a reviewer can approve/);
    const r = await rows();
    expect(r.get("sales 5")).toMatchObject({ state: "clean", reasons: [] });
    expect(r.get("interviews 5")).toMatchObject({ state: "clean" });
    expect(r.get("interviews 6")).toMatchObject({ state: "clean" });
    expect(r.get("placements 5")).toMatchObject({ state: "rejected", reasons: ["rejected_by_reviewer"] });
    expect(r.get("sales 2")!.state).toBe("committed");

    await expect(commitBatch(imp, batchId, { dryRun: false })).rejects.toThrow(/must be approved/);
    await approveBatch(imp, batchId, "admin2@eureka.example");
    const before = await liveCount();
    const c = await commitBatch(imp, batchId, { dryRun: false });
    expect(c.failures).toEqual([]);
    // Priya's interview joins her existing imported submission (acting as its submitter, r1b).
    expect(c.loaded).toEqual({ candidates: 1, submissions: 1, interviews: 2, placements: 0 });
    expect(await liveCount()).toEqual({ c: before.c + 1, s: before.s + 1, i: before.i + 2, p: before.p });
    const sanjay = (await db.admin.query(`SELECT p.dob_enc, p.dob_year, c.marketing_status FROM eureka.person p
      JOIN eureka.candidate c ON c.person_id = p.id WHERE p.first_name = 'Sanjay'`)).rows;
    expect(sanjay).toEqual([{ dob_enc: null, dob_year: null, marketing_status: "active" }]);
    const rep = await reconcile(imp, batchId);
    expect(rep.status).toBe("committed");
    // Asha's duplicate row now matches a loaded person: skipped, no longer in review.
    expect(totals(rep, "sales")).toEqual({ in: 19, clean: 0, held: 0, review: 8, rejected: 1, skipped: 1, committed: 9 });
    expect(rep.sheets.sales.reasons.skipped).toEqual({ person_already_imported: 1 });
    expect(totals(rep, "interviews")).toEqual({ in: 12, clean: 0, held: 1, review: 3, rejected: 0, skipped: 0, committed: 8 });
    expect(totals(rep, "placements")).toEqual({ in: 5, clean: 0, held: 0, review: 2, rejected: 1, skipped: 0, committed: 2 });
    expect(rep.balanced).toBe(true);
  });

  it("purge clears the stored cells of a committed batch but keeps the counts and the ledger", async () => {
    const before = await reconcile(imp, batchId);
    const out: string[] = [];
    await run(["purge", "--batch", batchId], imp, (s) => out.push(s));
    expect(out[0]).toMatch(/Cleared stored cells of 36 rows/);
    const left = await imp.query(`SELECT count(*)::int AS n FROM eureka.import_row WHERE batch_id = $1 AND (raw IS NOT NULL OR norm IS NOT NULL)`, [batchId]);
    expect(left.rows[0].n).toBe(0);
    expect({ ...(await reconcile(imp, batchId)), status: before.status }).toEqual(before);
    await expect(commitBatch(imp, batchId, { dryRun: true })).rejects.toThrow(/purged/);
  });
});
