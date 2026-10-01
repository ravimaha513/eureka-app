import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityVisible, candidateVisible, resolveScope, type CandidateRef } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { APPROVABLE_REASONS, DROPPABLE_FIELDS, makeHmac } from "../src/import/analyze.js";
import { run } from "../src/import/cli.js";
import { commitBatch } from "../src/import/commit.js";
import { reconcile, type Reconciliation } from "../src/import/report.js";
import { listReview } from "../src/import/review.js";
import { recompute, stage } from "../src/import/stage.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { TECH_ID, LOC, U, USERS, seedFixtures, toUserAccess } from "./fixtures.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/import");
const FILES = { sales: join(DIR, "sales.csv"), interviews: join(DIR, "interviews.csv"), placements: join(DIR, "placements.csv") };
const MAPPING = readFileSync(join(DIR, "mapping.json"), "utf8");
const ADMIN_BASE = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432";
const KEY = "test-import-hmac-key-test-import-hmac-key";
const ENV = { IMPORT_HMAC_KEY: KEY };
const hmac = makeHmac(KEY);
const TMP = mkdtempSync(join(tmpdir(), "eureka-import-"));

let db: TestDb;
let imp: pg.Pool;
let app: NestFastifyApplication;
let batchId: string;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  // The role is NOLOGIN by default; operations enable LOGIN only for the migration window.
  await db.admin.query(`ALTER ROLE eureka_import LOGIN PASSWORD 'eureka_import_test'`);
  // The membership checks below test what the migrations did. On a shared development
  // cluster, a database migrated by an old branch (whose 0028 still granted eureka_app)
  // would re-add it cluster-wide; 0033 removes it again whenever a database is migrated.
  const u = new URL(ADMIN_BASE);
  imp = new pg.Pool({ connectionString: `postgres://eureka_import:eureka_import_test@${u.host}/${db.name}`, max: 2 });
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    GOOGLE_HOSTED_DOMAIN: "eureka.example", DATABASE_URL: `postgres://eureka_app:eureka_app_test@${u.host}/${db.name}`,
  }));
}, 90_000);

afterAll(async () => {
  await app?.close();
  await imp?.end();
  await db?.admin.query(`ALTER ROLE eureka_import NOLOGIN PASSWORD NULL`).catch(() => undefined);
  await db?.drop();
});

// ---------- API helpers (signed-in users) ----------
const sessions = new Map<string, { cookie: string; csrf: string }>();
async function call(key: keyof typeof U, method: "GET" | "POST", url: string, payload?: unknown) {
  let s = sessions.get(key);
  if (!s) {
    const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
    expect(res.statusCode).toBe(204);
    const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    s = { cookie, csrf: me.json().csrfToken as string };
    sessions.set(key, s);
  }
  return app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}) } });
}
async function ticket(key: keyof typeof U = "admin"): Promise<string> {
  const r = await call(key, "POST", "/api/v1/imports/tickets");
  expect(r.statusCode, r.body).toBe(201);
  return r.json().ticket as string;
}
/** Sign-off as the API client does it: read the preview, approve quoting its digest. */
async function approve(key: keyof typeof U, id = batchId) {
  const p = await call(key, "GET", `/api/v1/imports/${id}/preview`);
  const digest = p.statusCode === 200 ? p.json().digest as string : "0".repeat(64);
  return call(key, "POST", `/api/v1/imports/${id}/approve`, { digest });
}
const decide = (key: keyof typeof U, body: Record<string, unknown>, id = batchId) => call(key, "POST", `/api/v1/imports/${id}/decisions`, body);

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
const ZERO = { candidates: 0, submissions: 0, interviews: 0, placements: 0, updated: 0 };
/** A copy of a fixture sheet with some lines replaced. */
function edited(file: string, name: string, edit: (lines: string[]) => string[]): string {
  const p = join(TMP, name);
  writeFileSync(p, edit(readFileSync(file, "utf8").split("\n")).join("\n"));
  return p;
}

describe("staging needs an authenticated operator", () => {
  it("a new batch needs a one-time ticket created by a signed-in org admin", async () => {
    await expect(stage(imp, FILES, MAPPING, { hmac })).rejects.toThrow(/needs --ticket/);
    await expect(stage(imp, FILES, MAPPING, { hmac, ticket: "forged" })).rejects.toThrow(/invalid_ticket/);
    expect((await call("r1a", "POST", "/api/v1/imports/tickets")).statusCode).toBe(403);
    // eureka_import cannot open a batch, mint a ticket or choose the operator itself.
    await expect(imp.query(`INSERT INTO eureka.import_batch (source_digest, files, operator_id) VALUES (repeat('a', 64), '{}', $1)`, [U.admin]))
      .rejects.toThrow(/permission denied/);
    await expect(imp.query(`SELECT authz.import_create_ticket(repeat('a', 64))`)).rejects.toThrow(/permission denied/);
  });

  it("stages the fictional sheets through the CLI and reconciles with hand counts", async () => {
    const before = await liveCount();
    const out: string[] = [];
    await run(["stage", "--sales", FILES.sales, "--interviews", FILES.interviews, "--placements", FILES.placements,
      "--mapping", join(DIR, "mapping.json"), "--ticket", await ticket("admin"), "--json"], imp, (s) => out.push(s), ENV);
    const res = JSON.parse(out[0]!) as { batchId: string; created: boolean; report: Reconciliation };
    batchId = res.batchId;
    expect(res.created).toBe(true);
    expect(await liveCount()).toEqual(before);
    const rep = res.report;
    expect(rep.operator).toBe("admin@eureka.example"); // from the ticket, not from a CLI argument
    // Hand counts from the fixture files (docs/import.md "fixtures").
    expect(totals(rep, "sales")).toEqual({ in: 19, clean: 8, held: 0, review: 10, rejected: 1, skipped: 0, committed: 0 });
    expect(totals(rep, "interviews")).toEqual({ in: 12, clean: 5, held: 1, review: 6, rejected: 0, skipped: 0, committed: 0 });
    expect(totals(rep, "placements")).toEqual({ in: 5, clean: 2, held: 0, review: 3, rejected: 0, skipped: 0, committed: 0 });
    expect(rep.balanced).toBe(true);
    expect(rep.sheets.sales.byStatus["active"]).toEqual({ in: 10, loadable: 2, committed: 0 });
    expect(rep.sheets.sales.byStatus["hot"]).toEqual({ in: 1, loadable: 0, committed: 0 });
    expect(rep.sheets.sales.reasons.rejected).toEqual({ duplicate_row: 1 });
  });

  it("a ticket works once", async () => {
    const t = await ticket("admin");
    const one = edited(FILES.sales, "sales_once.csv", (l) => [l[0]!, l[1]!]);
    await stage(imp, { sales: one }, MAPPING, { hmac, ticket: t });
    const two = edited(FILES.sales, "sales_twice.csv", (l) => [l[0]!, l[2]!]);
    await expect(stage(imp, { sales: two }, MAPPING, { hmac, ticket: t })).rejects.toThrow(/invalid_ticket/);
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
    expect(reasons("interviews 4")).toEqual(["name_dob_match"]); // name + DOB alone is not proof
    expect(reasons("interviews 5")).toEqual(["name_only_match"]);
    expect(reasons("interviews 6")).toEqual(["no_candidate_match"]);
    expect(reasons("interviews 7")).toEqual(["unmapped_status:callStatus"]);
    expect(reasons("interviews 8")).toEqual(["unknown_client:client"]);
    expect(r.get("interviews 11")).toMatchObject({ state: "held", reasons: ["candidate_not_loadable"] });
    expect(reasons("interviews 12")).toEqual(["invalid_time:startTime"]);
    expect(reasons("placements 4")).toEqual(["ambiguous_date:tentativeStart", "unconfirmed_status:status"]);
    expect(reasons("placements 5")).toEqual(["no_candidate_match"]);
    expect(reasons("placements 6")).toEqual(["invalid_rate:rate"]);
    const q = await listReview(imp, batchId);
    expect(q.find((i) => i.sheet === "interviews" && i.rowNo === 5)).toMatchObject({ salesRow: 4, approvable: true });
    expect(q.find((i) => i.sheet === "sales" && i.rowNo === 7)!.approvable).toBe(false);
  });

  it("keeps no date of birth: staged cells hold a keyed hash token, and row/identity keys are keyed", async () => {
    const r = (await imp.query(`SELECT raw, norm, row_key FROM eureka.import_row WHERE batch_id = $1 AND sheet = 'sales' AND row_no = 2`, [batchId])).rows[0];
    expect(r.raw.DOB).toMatch(/^#dob:[0-9a-f]{64}$/);
    expect(JSON.stringify([r.raw, r.norm])).not.toMatch(/1995|03\/15/);
    expect(r.norm.identities.length).toBe(4); // two emails, phone, name + DOB
    const unkeyed = makeHmac("another-key-another-key-another-key-123");
    expect(r.row_key).not.toBe(unkeyed("x"));
    const all = (await imp.query(`SELECT raw::text AS t FROM eureka.import_row WHERE batch_id = $1`, [batchId])).rows.map((x) => x.t).join("\n");
    expect(all).not.toMatch(/1993-07-21|21\/07\/1993|1994-11-02/);
  });

  it("re-staging the same files is idempotent (same batch, same counts)", async () => {
    const before = await reconcile(imp, batchId);
    const again = await stage(imp, FILES, MAPPING, { hmac });
    expect(again).toEqual({ batchId, created: false });
    expect(await reconcile(imp, batchId)).toEqual(before);
  });

  it("dry-run commit runs every real check through the definer and rolls back", async () => {
    const before = await liveCount();
    const r = await commitBatch(imp, batchId, { dryRun: true });
    expect(r.failures).toEqual([]);
    expect(r.loaded).toEqual({ candidates: 8, submissions: 5, interviews: 5, placements: 2, updated: 0 });
    expect(await liveCount()).toEqual(before);
    expect((await reconcile(imp, batchId)).status).toBe("staged");
  });

  it("an owner who is not an active Sales user loads nothing for that person", async () => {
    await db.admin.query(`UPDATE eureka.app_user SET status = 'inactive' WHERE id = $1`, [U.r1b]);
    try {
      const r = await commitBatch(imp, batchId, { dryRun: true });
      expect(r.failures).toHaveLength(1); // Priya (owner r1b): sales 14 and interviews 10
      expect(r.failures[0]!.rows).toEqual(["sales 14", "interviews 10"]);
      expect(r.failures[0]!.error).toMatch(/owner_not_permitted/);
      expect(r.loaded.candidates).toBe(7);
    } finally {
      await db.admin.query(`UPDATE eureka.app_user SET status = 'active' WHERE id = $1`, [U.r1b]);
    }
  });
});

describe("eureka_import cannot act as anyone (review PoC A)", () => {
  it("cannot become the API role", async () => {
    // A separate connection: a successful SET ROLE must never leak into the pool.
    const u = new URL(ADMIN_BASE);
    const c = new pg.Client({ connectionString: `postgres://eureka_import:eureka_import_test@${u.host}/${db.name}` });
    await c.connect();
    try {
      await expect(c.query("SET ROLE eureka_app")).rejects.toThrow(/permission denied/);
    } finally {
      await c.end();
    }
  });

  it("cannot drive authz functions, read live data or write audit rows with a chosen user id", async () => {
    const c = await imp.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('eureka.user_id', $1, true), set_config('eureka.import_load', 'on', true)`, [U.admin]);
      for (const sql of [
        `SELECT * FROM authz.request_role('${U.r1a}', 'ceo', NULL)`,
        `SELECT authz.current_user_id()`,
        `SELECT authz.import_approve_batch('${batchId}', repeat('a', 64))`,
        `INSERT INTO eureka.import_session (xact, pid) VALUES (pg_current_xact_id(), pg_backend_pid())`,
        `SELECT authz.import_decide('${batchId}', 'sales', 7, 'reject', NULL)`,
        `SELECT count(*) FROM eureka.person`,
        `SELECT count(*) FROM eureka.candidate`,
        `INSERT INTO eureka.audit_event (actor_id, action, entity_type) VALUES ('${U.ceo}', 'user.role_granted', 'user')`,
        `INSERT INTO eureka.import_link (sheet, row_key, entity_type, entity_id, owner_id, batch_id) VALUES ('sales', repeat('a', 64), 'candidate', gen_random_uuid(), '${U.r1a}', '${batchId}')`,
        `UPDATE eureka.import_row SET state = 'committed' WHERE batch_id = '${batchId}'`,
      ]) {
        await c.query("SAVEPOINT s");
        await expect(c.query(sql), sql).rejects.toThrow(/permission denied|server_managed_field/);
        await c.query("ROLLBACK TO SAVEPOINT s");
      }
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    const held = await db.admin.query(`SELECT 1 FROM eureka.user_role WHERE user_id = $1 AND role_key = 'ceo'`, [U.r1a]);
    expect(held.rows).toEqual([]);
  });

  it("the role has no superuser, BYPASSRLS or membership, owns nothing, and app/worker cannot read staging", async () => {
    const role = (await db.admin.query(`SELECT rolsuper, rolbypassrls,
      (SELECT count(*)::int FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS memberships
      FROM pg_roles r WHERE rolname = 'eureka_import'`)).rows[0];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, memberships: 0 });
    const owned = await db.admin.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'eureka_import'`);
    expect(owned.rows[0].n).toBe(0);
    await expect(db.app.query(`SELECT 1 FROM eureka.import_row LIMIT 1`)).rejects.toThrow(/permission denied/);
    await expect(db.worker.query(`SELECT 1 FROM eureka.import_batch LIMIT 1`)).rejects.toThrow(/permission denied/);
    await expect(db.app.query(`SELECT authz.import_load_person($1, $1, true)`, [batchId])).rejects.toThrow(/permission denied/);
    await expect(run(["report", "--batch", batchId], db.app, () => undefined, ENV)).rejects.toThrow(/Connect as eureka_import/);
  });
});

describe("sign-off is an authenticated API call (review PoC B)", () => {
  it("refuses --commit before approval", async () => {
    await expect(commitBatch(imp, batchId, { dryRun: false })).rejects.toThrow(/must be approved/);
    await expect(imp.query(`SELECT authz.import_load_person($1, (SELECT id FROM eureka.import_row WHERE batch_id = $1 AND sheet = 'sales' AND row_no = 2), false)`, [batchId]))
      .rejects.toThrow(/batch_not_approved/);
  });

  it("only a second signed-in org admin can approve", async () => {
    expect((await approve("admin")).json().detail).toBe("second_person_required");
    expect((await approve("admin")).statusCode).toBe(403);
    expect((await approve("r1a")).statusCode).toBe(403);
    expect((await call("admin2", "POST", `/api/v1/imports/00000000-0000-0000-0000-00000000beef/approve`, { digest: "0".repeat(64) })).statusCode).toBe(404);
    const ok = await approve("admin2");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().approvalExpiresAt).toBeTruthy();
    const rep = await reconcile(imp, batchId);
    expect([rep.status, rep.approvedBy]).toEqual(["approved", "admin2@eureka.example"]);
    const a = await db.admin.query(`SELECT actor_id FROM eureka.audit_event WHERE action = 'import.batch_approved' AND entity_id = $1`, [batchId]);
    expect(a.rows).toEqual([{ actor_id: U.admin2 }]);
    // Once submitted for approval, the analysis path cannot change the rows.
    await expect(imp.query(`UPDATE eureka.import_row SET reasons = '{}' WHERE batch_id = $1 AND sheet = 'sales' AND row_no = 7`, [batchId]))
      .rejects.toThrow(/batch_not_staged/);
    await expect(imp.query(`UPDATE eureka.import_batch SET analysed_at = now() WHERE id = $1`, [batchId])).rejects.toThrow(/batch_not_staged/);
  });

  it("the summary and review queue are readable by org admins only", async () => {
    const s = await call("admin2", "GET", `/api/v1/imports/${batchId}`);
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ status: "approved", operatorId: U.admin, approvedBy: U.admin2 });
    expect(s.json().counts.sales).toMatchObject({ clean: 8, review: 10, rejected: 1 });
    const q = await call("admin", "GET", `/api/v1/imports/${batchId}/review`);
    expect(q.statusCode).toBe(200);
    expect(q.json().items.find((i: { sheet: string; rowNo: number }) => i.sheet === "sales" && i.rowNo === 5))
      .toMatchObject({ reasons: ["ambiguous_date:dob"], approvable: true });
    expect(JSON.stringify(q.json())).not.toMatch(/@|Asha|Verma/);
    expect((await call("r1a", "GET", `/api/v1/imports/${batchId}`)).statusCode).toBe(403);
  });
});

describe("commit", () => {
  it("loads the clean rows through authz.import_load_person and marks the batch committed", async () => {
    const before = await liveCount();
    const out: string[] = [];
    await run(["commit", "--batch", batchId, "--commit", "--json"], imp, (s) => out.push(s), ENV);
    const { commit, report } = JSON.parse(out[0]!) as { commit: Awaited<ReturnType<typeof commitBatch>>; report: Reconciliation };
    expect(commit.failures).toEqual([]);
    expect(commit.loaded).toEqual({ candidates: 8, submissions: 5, interviews: 5, placements: 2, updated: 0 });
    expect(await liveCount()).toEqual({ c: before.c + 8, s: before.s + 5, i: before.i + 5, p: before.p + 2 });
    expect(report.status).toBe("committed");
    expect(totals(report, "sales")).toEqual({ in: 19, clean: 0, held: 0, review: 10, rejected: 1, skipped: 0, committed: 8 });
    expect(report.balanced).toBe(true);
  });

  it("produces the same live state the app would: statuses, owners, visibility, snapshots", async () => {
    const r = await db.admin.query<{ first_name: string; marketing_status: string; visibility: string; recruiter_id: string | null; phone_e164: string | null; priority: string; marketing_start_date: string | null; dob_enc: unknown }>(
      `SELECT p.first_name, c.marketing_status, c.visibility, c.recruiter_id, p.phone_e164, c.priority, c.marketing_start_date::text, p.dob_enc
       FROM eureka.import_link l JOIN eureka.candidate c ON c.id = l.entity_id JOIN eureka.person p ON p.id = c.person_id
       WHERE l.sheet = 'sales' ORDER BY p.first_name`);
    const by = Object.fromEntries(r.rows.map((x) => [x.first_name, x]));
    expect(Object.fromEntries(r.rows.map((x) => [x.first_name, x.marketing_status]))).toEqual({
      Anil: "confirmation", Asha: "active", Farah: "placed", Meera: "on_hold", Priya: "stopped", Rahul: "full_of_interviews", Ravi: "active", Tara: "active",
    });
    expect(by.Ravi).toMatchObject({ visibility: "all_teams", recruiter_id: U.r1a, phone_e164: "+12145550102", priority: "P2", marketing_start_date: "2026-08-04", dob_enc: null });
    expect(by.Meera).toMatchObject({ visibility: "team", recruiter_id: U.r2a, phone_e164: "+12145550103", marketing_start_date: "2026-08-25" });
    const iv = await db.admin.query(`SELECT i.round, i.starts_at, i.call_status, s.status AS sub_status
      FROM eureka.import_link l JOIN eureka.interview i ON i.id = l.entity_id JOIN eureka.submission s ON s.id = i.submission_id
      WHERE l.sheet = 'interviews' ORDER BY i.starts_at`);
    expect(iv.rows[0]).toMatchObject({ round: "L1", call_status: "completed", sub_status: "interview_completed" });
    expect(iv.rows[0].starts_at.toISOString()).toBe("2026-09-01T15:00:00.000Z"); // 10:00 CDT
    const pl = await db.admin.query(`SELECT p.status, p.placement_type, p.rate::text, p.project_state, p.recruiter_id
      FROM eureka.import_link l JOIN eureka.placement p ON p.id = l.entity_id WHERE l.sheet = 'placements' ORDER BY p.status`);
    expect(pl.rows).toEqual([
      { status: "confirmed", placement_type: "w2", rate: "65.00", project_state: "TX", recruiter_id: U.r1a },
      { status: "joined", placement_type: "c2c", rate: "70.00", project_state: null, recruiter_id: U.r2a },
    ]);
  });

  it("audits every write as the acting owner with the operator, and no phones, emails or rates (rule 5)", async () => {
    const a = await db.admin.query<{ action: string; actor_id: string; changes: Record<string, unknown> }>(
      `SELECT action, actor_id, changes FROM eureka.audit_event WHERE changes ->> 'source' = 'import'`);
    expect(a.rows.length).toBeGreaterThan(20);
    const actions = new Set(a.rows.map((x) => x.action));
    for (const k of ["candidate.created", "candidate.transition", "submission.created", "submission.status",
      "interview.created", "interview.updated", "placement.created", "placement.status"]) expect(actions, k).toContain(k);
    for (const x of a.rows) expect(x.changes.operator, x.action).toBe(U.admin);
    expect(new Set(a.rows.map((x) => x.actor_id))).toEqual(new Set([U.r1a, U.r1b, U.r2a, U.r3a])); // no lead or admin acted
    expect(JSON.stringify(a.rows.map((x) => x.changes))).not.toMatch(/@|\+1\d{10}|"rate"/);
    expect(a.rows.find((x) => x.action === "candidate.created" && x.changes.visibility === "all_teams")!.actor_id).toBe(U.r1a);
  });

  it("feedback emails skip interviews that had ended when imported, not other past interviews", async () => {
    const imported = (await db.admin.query(`SELECT entity_id FROM eureka.import_link WHERE sheet = 'interviews'`)).rows.map((r) => r.entity_id);
    const wouldBeDue = await db.admin.query(`SELECT i.id FROM eureka.interview i JOIN eureka.candidate c ON c.id = i.candidate_id
      JOIN eureka.person p ON p.id = c.person_id WHERE i.id = ANY($1::uuid[]) AND i.ends_at <= now() - interval '60 minutes'
      AND i.call_status NOT IN ('cancelled','rescheduled','no_invite') AND p.personal_email IS NOT NULL`, [imported]);
    expect(wouldBeDue.rows.length).toBeGreaterThan(0);
    // Control: an app-created past interview of a candidate with an email is due.
    const control = await asUser(db.app, U.r1a, async (c) => {
      const pid = (await c.query(`SELECT gen_random_uuid() AS id`)).rows[0].id;
      await c.query(`INSERT INTO eureka.person (id, first_name, last_name, personal_email) VALUES ($1,'Control','Person','control.p@example.com')`, [pid]);
      const cid = (await c.query(`INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id)
        VALUES ($1,$2,(SELECT authz.actor_team()),$3,$4) RETURNING id`, [pid, TECH_ID, U.r1a, LOC.dallas])).rows[0].id;
      const sid = (await c.query(`INSERT INTO eureka.submission (candidate_id, job_title, client_id) VALUES ($1,'Dev',(SELECT id FROM eureka.client LIMIT 1)) RETURNING id`, [cid])).rows[0].id;
      return (await c.query(`INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at)
        VALUES ($1,'L1', now() - interval '3 hours', now() - interval '2 hours') RETURNING id`, [sid])).rows[0].id as string;
    }, true);
    const due = (await db.worker.query(`SELECT id FROM eureka.feedback_due()`)).rows.map((r) => r.id);
    expect(due.filter((id) => imported.includes(id))).toEqual([]);
    expect(due).toContain(control);
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

  it("re-running is idempotent and a decision never reopens a committed batch (review PoC E)", async () => {
    const before = await liveCount();
    const dry = await commitBatch(imp, batchId, { dryRun: true });
    expect(dry.loaded).toEqual(ZERO);
    const closed = await decide("admin", { sheet: "sales", rowNo: 7, action: "reject" });
    expect([closed.statusCode, closed.json().detail]).toEqual([409, "batch_closed"]);
    expect((await reconcile(imp, batchId)).status).toBe("committed");
    // A fresh batch of the same sheets skips every loaded row and loads nothing.
    const second = await stage(imp, FILES, MAPPING, { hmac, ticket: await ticket("admin") });
    expect(second.created).toBe(true);
    const rep = await reconcile(imp, second.batchId);
    expect(totals(rep, "sales")).toEqual({ in: 19, clean: 0, held: 0, skipped: 9, review: 9, rejected: 1, committed: 0 });
    expect(rep.sheets.sales.reasons.skipped).toEqual({ already_imported: 8, person_already_imported: 1 });
    expect(totals(rep, "interviews")).toEqual({ in: 12, clean: 0, held: 1, skipped: 5, review: 6, rejected: 0, committed: 0 });
    expect(totals(rep, "placements")).toMatchObject({ clean: 0, skipped: 2 });
    expect((await approve("admin2", second.batchId)).statusCode).toBe(200);
    const c2 = await commitBatch(imp, second.batchId, { dryRun: false });
    expect(c2.loaded).toEqual(ZERO);
    expect(await liveCount()).toEqual(before);
  });
});

describe("edited sheet rows update by natural key (review PoC D)", () => {
  it("a changed interview time or placement status updates the earlier record instead of duplicating it", async () => {
    const ints = edited(FILES.interviews, "interviews_edited.csv", (l) => { l[1] = l[1]!.replace("10:00 AM", "4:00 PM"); return l; });
    const pls = edited(FILES.placements, "placements_edited.csv", (l) => { l[1] = l[1]!.replace("Confirmed", "Paperwork"); return l; });
    const before = await liveCount();
    const s = await stage(imp, { interviews: ints, placements: pls }, MAPPING, { hmac, ticket: await ticket("admin") });
    const r = await rows(s.batchId);
    expect(r.get("interviews 2")!.state).toBe("clean");
    expect(r.get("placements 2")!.state).toBe("clean");
    expect((await approve("admin2", s.batchId)).statusCode).toBe(200);
    const c = await commitBatch(imp, s.batchId, { dryRun: false });
    expect(c.failures).toEqual([]);
    expect(c.loaded).toEqual({ ...ZERO, updated: 2 });
    expect(await liveCount()).toEqual(before);
    const asha = (await db.admin.query(`SELECT i.starts_at FROM eureka.interview i JOIN eureka.candidate c ON c.id = i.candidate_id
      JOIN eureka.person p ON p.id = c.person_id WHERE p.first_name = 'Asha' AND i.round = 'L1'`)).rows;
    expect(asha.map((x) => x.starts_at.toISOString())).toEqual(["2026-09-01T21:00:00.000Z"]);
    const anil = (await db.admin.query(`SELECT pl.status FROM eureka.placement pl JOIN eureka.person p ON p.id = pl.person_id WHERE p.first_name = 'Anil'`)).rows;
    expect(anil).toEqual([{ status: "paperwork" }]);
  });
});

describe("review queue through the API", () => {
  it("approve records the accepted reasons, re-analysis applies them, and approval waits for it", async () => {
    // The open review rows of the earlier (committed) batches are picked up by a new batch.
    batchId = (await stage(imp, FILES, MAPPING, { hmac, ticket: await ticket("admin") })).batchId;
    const before = await liveCount();
    // Sanjay: ambiguous DOB -> load without it. Ravi's and Meera's interviews: accept the suggestion.
    // John Doe's interview: the reviewer knows it is Priya's (same team). Unknown placement: reject.
    for (const d of [
      { sheet: "sales", rowNo: 5, action: "approve" }, { sheet: "interviews", rowNo: 4, action: "approve" },
      { sheet: "interviews", rowNo: 5, action: "approve" }, { sheet: "interviews", rowNo: 6, action: "link", salesRowNo: 14 },
      { sheet: "placements", rowNo: 5, action: "reject" },
    ]) {
      const res = await decide("admin", d);
      expect(res.statusCode, `${d.sheet} ${d.rowNo}: ${res.body}`).toBe(200);
    }
    expect((await decide("admin", { sheet: "sales", rowNo: 7, action: "approve" })).json().detail).toBe("not_approvable");
    expect((await decide("admin", { sheet: "interviews", rowNo: 6, action: "link" })).statusCode).toBe(422);
    expect((await decide("r1a", { sheet: "sales", rowNo: 5, action: "reject" })).statusCode).toBe(403);
    const dec = (await imp.query(`SELECT approved_reasons, decided_by FROM eureka.import_decision WHERE sheet = 'sales'`)).rows;
    expect(dec).toEqual([{ approved_reasons: ["ambiguous_date:dob"], decided_by: U.admin }]);
    // The decisions are not analysed yet: sign-off waits.
    expect((await approve("admin2")).json().detail).toBe("needs_analysis");
    await recompute(imp, batchId, hmac);
    const r = await rows();
    expect(r.get("sales 5")).toMatchObject({ state: "clean", reasons: [] });
    expect(r.get("interviews 4")!.state).toBe("clean");
    expect(r.get("interviews 5")!.state).toBe("clean");
    expect(r.get("interviews 6")!.state).toBe("clean");
    expect(r.get("placements 5")).toMatchObject({ state: "rejected", reasons: ["rejected_by_reviewer"] });
    expect((await approve("admin2")).statusCode).toBe(200);
    const c = await commitBatch(imp, batchId, { dryRun: false });
    expect(c.failures).toEqual([]);
    // Ravi's interview gets a new submission; Meera's too; Priya's joins her imported submission.
    expect(c.loaded).toEqual({ candidates: 1, submissions: 2, interviews: 3, placements: 0, updated: 0 });
    expect(await liveCount()).toEqual({ c: before.c + 1, s: before.s + 2, i: before.i + 3, p: before.p });
    const sanjay = (await db.admin.query(`SELECT p.dob_enc, c.marketing_status FROM eureka.person p
      JOIN eureka.candidate c ON c.person_id = p.id WHERE p.first_name = 'Sanjay'`)).rows;
    expect(sanjay).toEqual([{ dob_enc: null, marketing_status: "active" }]);
    const rep = await reconcile(imp, batchId);
    expect(rep.status).toBe("committed");
    expect(rep.balanced).toBe(true);
  });

  it("a decision recorded after approval is never loaded (review PoC F)", async () => {
    const one = edited(FILES.sales, "sales_f.csv", (l) => [l[0]!, "Zed,Quinn,zed.q@example.com,,(214) 555-0198,,Java,Dallas,r1a@eureka.example,Active,,,"]);
    const s = await stage(imp, { sales: one }, MAPPING, { hmac, ticket: await ticket("admin") });
    expect((await approve("admin2", s.batchId)).statusCode).toBe(200);
    // Through the API a decision withdraws the approval ...
    expect((await decide("admin", { sheet: "sales", rowNo: 2, action: "reject" }, s.batchId)).statusCode).toBe(200);
    expect((await reconcile(imp, s.batchId)).status).toBe("staged");
    // ... and re-approval waits for the analysis, which rejects the row.
    expect((await approve("admin2", s.batchId)).json().detail).toBe("needs_analysis");
    await recompute(imp, s.batchId, hmac);
    expect((await approve("admin2", s.batchId)).statusCode).toBe(200);
    const c = await commitBatch(imp, s.batchId, { dryRun: false });
    expect(c.loaded.candidates).toBe(0);
    // Even a decision slipped in after approval (bypassing the trigger) is skipped by the loader.
    const two = edited(FILES.sales, "sales_f2.csv", (l) => [l[0]!, "Yara,Quinn,yara.q@example.com,,(214) 555-0197,,Java,Dallas,r1a@eureka.example,Active,,,"]);
    const s2 = await stage(imp, { sales: two }, MAPPING, { hmac, ticket: await ticket("admin") });
    expect((await approve("admin2", s2.batchId)).statusCode).toBe(200);
    const key = (await imp.query(`SELECT row_key FROM eureka.import_row WHERE batch_id = $1`, [s2.batchId])).rows[0].row_key;
    const raw = await db.admin.connect();
    try {
      await raw.query("SET session_replication_role = replica");
      await raw.query(`INSERT INTO eureka.import_decision (sheet, row_key, action, decided_by, decided_at) VALUES ('sales', $1, 'reject', $2, now() + interval '1 second')`, [key, U.admin]);
    } finally {
      await raw.query("RESET session_replication_role");
      raw.release();
    }
    const c2 = await commitBatch(imp, s2.batchId, { dryRun: false });
    expect([c2.loaded.candidates, c2.skippedByDecision]).toEqual([0, 1]);
  });

  it("an approval expires, and rows changed after approval are refused", async () => {
    const one = edited(FILES.sales, "sales_x.csv", (l) => [l[0]!, "Xena,Quill,xena.q@example.com,,(214) 555-0196,,Java,Dallas,r1a@eureka.example,Active,,,"]);
    const s = await stage(imp, { sales: one }, MAPPING, { hmac, ticket: await ticket("admin") });
    expect((await approve("admin2", s.batchId)).statusCode).toBe(200);
    const raw = await db.admin.connect();
    try {
      await raw.query("SET session_replication_role = replica");
      await raw.query(`UPDATE eureka.import_row SET norm = jsonb_set(norm, '{ownerId}', to_jsonb($2::text)) WHERE batch_id = $1`, [s.batchId, U.r2a]);
      expect((await commitBatch(imp, s.batchId, { dryRun: false })).failures[0]!.error).toMatch(/batch_changed/);
      await raw.query(`UPDATE eureka.import_row SET norm = jsonb_set(norm, '{ownerId}', to_jsonb($2::text)) WHERE batch_id = $1`, [s.batchId, U.r1a]);
      await raw.query(`UPDATE eureka.import_batch SET approved_at = now() - interval '8 days' WHERE id = $1`, [s.batchId]);
      expect((await commitBatch(imp, s.batchId, { dryRun: false })).failures[0]!.error).toMatch(/approval_expired/);
    } finally {
      await raw.query("RESET session_replication_role");
      raw.release();
    }
  });

  it("the approvable reasons in the code match the database", async () => {
    for (const r of [...APPROVABLE_REASONS, ...[...DROPPABLE_FIELDS].map((f) => `invalid:${f}`), "missing:name", "unmapped_status:status", "status_not_importable"]) {
      const db1 = (await db.admin.query(`SELECT authz.import_reason_approvable($1) AS a`, [r])).rows[0].a;
      expect(db1, r).toBe(APPROVABLE_REASONS.has(r) || DROPPABLE_FIELDS.has(r.split(":")[1] ?? ""));
    }
  });
});

describe("the database verifies what an approver signs (second review)", () => {
  it("the preview shows each row's person, owner, visibility and target status, counts per owner, and the digest", async () => {
    const s = await stage(imp, { sales: edited(FILES.sales, "sales_pv.csv", (l) => [l[0]!, "Pia,Ray,pia.r@example.com,,(214) 555-0181,,Java,Dallas,r1a@eureka.example,Active / All Teams,,,"]) },
      MAPPING, { hmac, ticket: await ticket("admin") });
    const p = await call("admin2", "GET", `/api/v1/imports/${s.batchId}/preview`);
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({
      placementsCommit: true, problems: [],
      rows: [{ sheet: "sales", rowNo: 2, person: "Pia Ray", owner: "r1a@eureka.example", visibility: "all_teams", targetStatus: "active" }],
      perOwner: [{ owner: "r1a@eureka.example", candidates: 1, interviews: 0, placements: 0, allTeams: 1 }],
    });
    expect(p.json().digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await call("r1a", "GET", `/api/v1/imports/${s.batchId}/preview`)).statusCode).toBe(403);
    // placements_commit is the batch's, fixed at staging (the default mapping keeps it off).
    const off = await stage(imp, { sales: edited(FILES.sales, "sales_off.csv", (l) => [l[0]!, "Oz,Ray,oz.r@example.com,,(214) 555-0182,,Java,Dallas,r1a@eureka.example,Active,,,"]) },
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/import/mapping.default.json"), "utf8"), { hmac, ticket: await ticket("admin") });
    expect((await call("admin2", "GET", `/api/v1/imports/${off.batchId}/preview`)).json().placementsCommit).toBe(false);
    await expect(imp.query(`UPDATE eureka.import_batch SET placements_commit = true WHERE id = $1`, [off.batchId])).rejects.toThrow(/permission denied/);
  });

  it("rows the CLI rewrote while staged are refused at approval (live duplicate flipped to clean, owner and visibility changed)", async () => {
    const live = edited(FILES.sales, "sales_live.csv", (l) => [l[0]!, l[18]!]); // "Live Match": phone of a live candidate
    const s = await stage(imp, { sales: live }, MAPPING, { hmac, ticket: await ticket("admin") });
    expect((await rows(s.batchId)).get("sales 2")!.reasons).toEqual(["matches_existing_candidate"]);
    await imp.query(`UPDATE eureka.import_row SET state = 'clean', reasons = '{}',
        norm = norm || jsonb_build_object('visibility', 'all_teams', 'ownerId', $2::text, 'status', 'stopped')
      WHERE batch_id = $1`, [s.batchId, U.r2a]);
    const p = (await call("admin2", "GET", `/api/v1/imports/${s.batchId}/preview`)).json();
    expect(p.problems.map((x: { problem: string }) => x.problem).sort())
      .toEqual(["owner_mismatch", "status_mismatch", "unapproved_live_match", "visibility_mismatch"]);
    const r = await call("admin2", "POST", `/api/v1/imports/${s.batchId}/approve`, { digest: p.digest });
    expect([r.statusCode, r.json().detail]).toEqual([422, "verification_failed"]);
    // A clean row that still carries reasons, and a review row without any, are refused too.
    await imp.query(`UPDATE eureka.import_row SET state = 'review', reasons = '{}' WHERE batch_id = $1`, [s.batchId]);
    expect((await call("admin2", "GET", `/api/v1/imports/${s.batchId}/preview`)).json().problems)
      .toEqual([{ sheet: "sales", rowNo: 2, problem: "state_without_reasons" }]);
  });

  it("approval binds to the digest the approver saw, and the digest covers keys as well as values", async () => {
    const s = await stage(imp, { sales: edited(FILES.sales, "sales_dg.csv", (l) => [l[0]!, "Dee,Gee,dee.g@example.com,,(214) 555-0183,,Java,Dallas,r1a@eureka.example,Active,,,"]) },
      MAPPING, { hmac, ticket: await ticket("admin") });
    const seen = (await call("admin2", "GET", `/api/v1/imports/${s.batchId}/preview`)).json().digest;
    await imp.query(`UPDATE eureka.import_row SET status_key = 'something else' WHERE batch_id = $1`, [s.batchId]);
    const r = await call("admin2", "POST", `/api/v1/imports/${s.batchId}/approve`, { digest: seen });
    expect([r.statusCode, r.json().detail]).toEqual([409, "batch_changed"]);
    expect((await call("admin2", "POST", `/api/v1/imports/${s.batchId}/approve`, {})).statusCode).toBe(422);
  });

  it("a row write racing an approval waits for it and is then refused (two connections)", async () => {
    const s = await stage(imp, { sales: edited(FILES.sales, "sales_race.csv", (l) => [l[0]!, "Rae,Sea,rae.s@example.com,,(214) 555-0184,,Java,Dallas,r1a@eureka.example,Active,,,"]) },
      MAPPING, { hmac, ticket: await ticket("admin") });
    const digest = (await call("admin2", "GET", `/api/v1/imports/${s.batchId}/preview`)).json().digest;
    const approver = await db.app.connect();
    const writer = await imp.connect();
    try {
      await approver.query("BEGIN");
      await approver.query(`SELECT set_config('eureka.user_id', $1, true)`, [U.admin2]);
      await approver.query(`SELECT authz.import_approve_batch($1, $2)`, [s.batchId, digest]); // holds the batch row
      let settled = false;
      const write = writer.query(`UPDATE eureka.import_row SET reasons = '{x}', state = 'review' WHERE batch_id = $1`, [s.batchId])
        .finally(() => { settled = true; });
      write.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // blocked behind the approval
      await approver.query("COMMIT");
      await expect(write).rejects.toThrow(/batch_not_staged/);
    } finally {
      await approver.query("ROLLBACK").catch(() => undefined);
      approver.release();
      writer.release();
    }
    expect((await reconcile(imp, s.batchId)).status).toBe("approved");
    // And the loader still requires the approver and the operator to be active org admins.
    await db.admin.query(`UPDATE eureka.app_user SET status = 'inactive' WHERE id = $1`, [U.admin2]);
    try {
      const c = await commitBatch(imp, s.batchId, { dryRun: false });
      expect(c.failures[0]!.error).toMatch(/approval_not_valid/);
    } finally {
      await db.admin.query(`UPDATE eureka.app_user SET status = 'active' WHERE id = $1`, [U.admin2]);
    }
    const ok = await commitBatch(imp, s.batchId, { dryRun: false });
    expect([ok.failures, ok.loaded.candidates]).toEqual([[], 1]);
  });
});

describe("purge (review PoC G)", () => {
  it("any batch can be purged, and batches past the retention are purged by --expired", async () => {
    const open = edited(FILES.sales, "sales_p.csv", (l) => [l[0]!, l[3]!]);
    const s = await stage(imp, { sales: open }, MAPPING, { hmac, ticket: await ticket("admin") });
    expect((await reconcile(imp, s.batchId)).status).toBe("staged");
    const out: string[] = [];
    await run(["purge", "--batch", s.batchId], imp, (x) => out.push(x), ENV);
    expect(out[0]).toMatch(/Cleared stored cells of 1 rows/);
    await expect(commitBatch(imp, s.batchId, { dryRun: true })).rejects.toThrow(/purged/);
    const before = await reconcile(imp, batchId);
    await db.admin.query(`UPDATE eureka.import_config SET purge_days = 1`);
    const raw = await db.admin.connect();
    try {
      await raw.query("SET session_replication_role = replica");
      await raw.query(`UPDATE eureka.import_batch SET created_at = now() - interval '2 days' WHERE id = $1`, [batchId]);
    } finally {
      await raw.query("RESET session_replication_role");
      raw.release();
    }
    const out2: string[] = [];
    await run(["purge", "--expired", "--json"], imp, (x) => out2.push(x), ENV);
    expect(JSON.parse(out2[0]!).batches).toBe(1);
    const left = await imp.query(`SELECT count(*)::int AS n FROM eureka.import_row WHERE batch_id = $1 AND (raw IS NOT NULL OR norm IS NOT NULL)`, [batchId]);
    expect(left.rows[0].n).toBe(0);
    expect(totals(await reconcile(imp, batchId), "sales")).toEqual(totals(before, "sales"));
  });
});
