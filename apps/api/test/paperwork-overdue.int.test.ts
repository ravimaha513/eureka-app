import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAPERWORK_OVERDUE_JOB, paperworkOverdueJob } from "../src/worker/jobs/paperwork-overdue.js";
import { silentLogger } from "../src/worker/log.js";
import { JobRunner } from "../src/worker/runner.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures } from "./fixtures.js";
import { createPlacement, newCandidate, selectedSubmission, transitionPlacement } from "./placement-seed.js";
import { emitEvent } from "./notification-seed.js";

/**
 * paperwork-overdue (migration 0052, docs/notifications.md `checklist.item_overdue`):
 * schedule on a fixed clock, exactly once per item and due date, re-arm on a
 * new due date, outstanding items on non-backed-out placements only, payload
 * shape, and the worker's narrow privilege.
 */
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type, items) VALUES ('paperwork', 'w2', $1::jsonb)`,
    [JSON.stringify([{ doc_type: "sample_overdue_a", owner_role: "hr" }, { doc_type: "sample_overdue_b", owner_role: "documents_team" }])]);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const err = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

async function placementWithItems() {
  const c = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
  const sub = await selectedSubmission(db, U.r1a, c.id);
  const p = await createPlacement(db, U.r1a, sub, { type: "w2" });
  const items = (await db.admin.query<{ id: string; doc_type: string }>(
    "SELECT id, doc_type FROM eureka.checklist_item WHERE placement_id = $1 ORDER BY position", [p.id])).rows;
  return { placementId: p.id, a: items[0]!.id, b: items[1]!.id };
}
const setItem = (id: string, changes: Record<string, unknown>) => asUser(db.app, U.hr,
  (c) => c.query("SELECT authz.update_checklist_item($1, $2::jsonb, NULL)", [id, JSON.stringify(changes)]), true);
const events = async (itemIds: string[]) => (await db.admin.query<{ aggregate_id: string; payload: Record<string, unknown> }>(
  "SELECT aggregate_id, payload FROM eureka.outbox_event WHERE type = 'checklist.item_overdue' AND aggregate_id = ANY ($1) ORDER BY created_at, id",
  [itemIds])).rows;

describe("paperwork-overdue on a fixed clock", () => {
  const due = (iso: string) => paperworkOverdueJob().dueKeys(new Date(iso), { pool: db.worker, log: silentLogger });

  it("runs for the New York day once 07:30 local has passed (EDT and EST)", async () => {
    expect(await due("2026-06-15T11:29:00Z")).toEqual(["2026-06-14"]);   // 07:29 EDT
    expect(await due("2026-06-15T11:30:00Z")).toEqual(["2026-06-15"]);
    expect(await due("2026-06-16T03:00:00Z")).toEqual(["2026-06-15"]);   // 23:00 EDT, still the 15th in New York
    expect(await due("2026-12-15T12:29:00Z")).toEqual(["2026-12-14"]);   // 07:29 EST
    expect(await due("2026-12-15T12:30:00Z")).toEqual(["2026-12-15"]);
  });

  it("emits once per item and due date, re-arms on a new due date, skips done items and backed-out placements", async () => {
    const job = paperworkOverdueJob();
    const runner = new JobRunner(db.worker, [job], silentLogger);
    const p = await placementWithItems();
    const backed = await placementWithItems();
    await setItem(p.a, { dueOn: "2026-06-10" });
    await setItem(p.b, { dueOn: "2026-06-10", status: "received" });
    await setItem(backed.a, { dueOn: "2026-06-01" });
    await transitionPlacement(db, U.r1a, backed.placementId, "backout", "Fictional: declined");
    const all = [p.a, p.b, backed.a, backed.b];

    expect(await runner.runOnce(job, "2026-06-10")).toBe("ran");      // due today: not overdue yet
    expect(await events(all)).toEqual([]);
    expect(await runner.runOnce(job, "2026-06-11")).toBe("ran");      // 1 day overdue; received still counts
    let ev = await events(all);
    expect(ev.map((e) => [e.aggregate_id, e.payload])).toEqual(expect.arrayContaining([
      [p.a, { checklistItemId: p.a, placementId: p.placementId, daysOverdue: 1 }],
      [p.b, { checklistItemId: p.b, placementId: p.placementId, daysOverdue: 1 }],
    ]));
    expect(ev).toHaveLength(2);
    expect(await runner.runOnce(job, "2026-06-11")).toBe("done-before");
    expect(await runner.runOnce(job, "2026-06-20")).toBe("ran");      // same due date: no repeat
    expect(await events(all)).toHaveLength(2);
    const detail = (await db.admin.query("SELECT detail FROM eureka.job_run WHERE job_name = $1 AND run_key = '2026-06-20'",
      [PAPERWORK_OVERDUE_JOB])).rows[0]!.detail;
    expect(detail).toEqual({ emitted: 0 });

    // A new due date re-arms; a verified (or waived) item never reminds.
    await setItem(p.a, { dueOn: "2026-06-25", assigneeId: U.hr });
    await setItem(p.b, { status: "verified", dueOn: "2026-06-25" });
    expect(await runner.runOnce(job, "2026-06-24")).toBe("ran");
    expect(await events(all)).toHaveLength(2);
    expect(await runner.runOnce(job, "2026-06-28")).toBe("ran");
    ev = await events(all);
    expect(ev).toHaveLength(3);
    expect(ev[2]).toEqual({ aggregate_id: p.a, payload: { checklistItemId: p.a, placementId: p.placementId, daysOverdue: 3, assigneeId: U.hr } });
  });

  it("the resolver adds a documents_team assignee only when the payload names the item's current assignee", async () => {
    const addDocs = async (key: string) => {
      const id = (await db.admin.query<{ id: string }>(
        "INSERT INTO eureka.app_user (email, display_name) VALUES ($1, $2) RETURNING id", [`${key}@eureka.example`, key])).rows[0]!.id;
      await db.admin.query("INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'documents_team')", [id]);
      return id;
    };
    const real = await addDocs("pw_docs_real");
    const other = await addDocs("pw_docs_other");
    const p = await placementWithItems();
    await setItem(p.b, { assigneeId: real, dueOn: "2026-05-01" });   // owner role documents_team
    const recipients = async (assigneeId: string, itemId = p.b) => {
      const ev = await emitEvent(db, "checklist.item_overdue", "checklist_item", itemId,
        { checklistItemId: itemId, placementId: p.placementId, daysOverdue: 3, assigneeId });
      return (await db.worker.query<{ recipient_id: string; reason: string }>(
        "SELECT recipient_id, reason FROM authz.notification_recipients($1) ORDER BY reason, recipient_id", [ev])).rows;
    };
    const base = [{ recipient_id: U.l1, reason: "lead" }, { recipient_id: U.m1, reason: "manager" }, { recipient_id: U.r1a, reason: "recruiter" }];
    expect(await recipients(real)).toEqual([{ recipient_id: real, reason: "documents_team" }, ...base]);
    // A forged payload naming another documents_team user, or the real assignee on another item, adds nobody.
    expect(await recipients(other)).toEqual(base);
    expect(await recipients(real, p.a)).toEqual(base);
    // Unassigning stops it too.
    await setItem(p.b, { assigneeId: null });
    expect(await recipients(real)).toEqual(base);
    // The replaced resolver keeps its owner, search_path and grants.
    const { rows } = await db.admin.query(`
      SELECT pg_get_userbyid(p.proowner) AS owner, p.proconfig, p.prosecdef,
             coalesce(p.proacl::text, '') ~ '(^|[{,])=X' AS public,
             has_function_privilege('eureka_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('eureka_worker', p.oid, 'EXECUTE') AS worker
        FROM pg_proc p WHERE p.proname = 'notification_recipients'`);
    expect(rows).toEqual([{ owner: "authz_definer", proconfig: ["search_path=pg_catalog, pg_temp"], prosecdef: true, public: false, app: false, worker: true }]);
  });

  it("the database refuses a future or missing day; the worker may call only this function", async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect(await err(db.worker.query("SELECT authz.emit_paperwork_overdue($1::date)", [tomorrow]))).toMatch(/invalid paperwork-overdue run/);
    expect(await err(db.worker.query("SELECT authz.emit_paperwork_overdue(NULL)"))).toMatch(/invalid paperwork-overdue run/);
    expect(await err(db.app.query("SELECT authz.emit_paperwork_overdue('2026-06-01')"))).toMatch(/permission denied/);
    expect(await err(db.worker.query(
      "SELECT authz.notification_emit_once('paperwork-overdue', 'k', 'checklist.item_overdue', 'checklist_item', gen_random_uuid(), '{}')")))
      .toMatch(/permission denied/);
    for (const t of ["checklist_item", "notification_ledger", "placement"]) {
      expect(await err(db.worker.query(`SELECT 1 FROM eureka.${t}`)), t).toMatch(/permission denied/);
    }
    const { rows } = await db.admin.query<{ proconfig: string[]; prosecdef: boolean; public: boolean; app: boolean; worker: boolean }>(`
      SELECT p.proconfig, p.prosecdef, coalesce(p.proacl::text, '') ~ '(^|[{,])=X' AS public,
             has_function_privilege('eureka_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('eureka_worker', p.oid, 'EXECUTE') AS worker
        FROM pg_proc p WHERE p.proname = 'emit_paperwork_overdue'`);
    expect(rows).toEqual([{ proconfig: ["search_path=pg_catalog, pg_temp"], prosecdef: true, public: false, app: false, worker: true }]);
  });
});

