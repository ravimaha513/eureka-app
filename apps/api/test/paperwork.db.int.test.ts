import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BGC_STATUSES,
  CHECKLIST_ITEM_STATUSES,
  activityVisible,
  bgcTransitionAllowed,
  checklistItemActions,
  checklistItemTransitionAllowed,
  resolveScope,
  type ActivityRef,
} from "@eureka/shared";
import { asUser, createTestDb, ownedCandidateCalls, type TestDb } from "./db-harness.js";
import { LOC, T, U, seedFixtures, toUserAccess } from "./fixtures.js";
import { createPlacement, extraUser, newCandidate, selectedSubmission, transitionPlacement } from "./placement-seed.js";

/**
 * Database-only checks for migration 0044 (paperwork progress, BGC records,
 * versioned templates; docs/paperwork-api.md): every rule holds with the API
 * removed (design B8).
 */
let db: TestDb;

const W2 = [
  { doc_type: "sample_doc_a", owner_role: "hr", required: true },
  { doc_type: "sample_doc_b", owner_role: "immigration" },
  { doc_type: "sample_doc_c", owner_role: "accounts", required: false },
];

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  await db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type, items) VALUES ('paperwork', 'w2', $1::jsonb)`,
    [JSON.stringify(W2)]);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

type Key = keyof typeof U;
const users = Object.keys(U) as Key[];
type Cand = Parameters<typeof newCandidate>[1];
const R1A: Cand = { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas };

async function placed(actor = U.r1a, cand: Cand = R1A, type = "w2") {
  const c = await newCandidate(db, cand);
  const sub = await selectedSubmission(db, actor, c.id);
  return { ...(await createPlacement(db, actor, sub, { type })), cand: c };
}
const itemsOf = async (placementId: string) => (await db.admin.query(
  `SELECT * FROM eureka.checklist_item WHERE placement_id = $1 ORDER BY position`, [placementId])).rows;
/** A document row (0043, file pending) on a candidate or a placement, created through authz.create_document_upload. */
async function documentFor(actor: string, owner: { candidate?: string; placement?: string }, docType = "offer_letter") {
  return asUser(db.app, actor, async (c) => (await c.query<{ document_id: string }>(
    `SELECT * FROM authz.create_document_upload($1, $2, $3, 'application/pdf', 1000)`,
    [owner.candidate ?? null, owner.placement ?? null, docType])).rows[0]!.document_id, true);
}
const itemId = async (placementId: string, docType = "sample_doc_a") =>
  (await itemsOf(placementId)).find((i) => i.doc_type === docType)!.id as string;

type ItemRow = { from_status: string; to_status: string; new_version: number; changed: string[] };
const updateItem = (actor: string, id: string | null, changes: unknown, expected: number | null = null, commit = true) =>
  asUser(db.app, actor, async (c) => (await c.query<ItemRow>(
    `SELECT * FROM authz.update_checklist_item($1, $2::jsonb, $3)`, [id, changes === null ? null : JSON.stringify(changes), expected])).rows[0]!, commit);

type BgcRow = ItemRow & { placement_from: string | null; placement_to: string | null; candidate_from: string | null; candidate_to: string | null };
const updateBgc = (actor: string, placementId: string | null, changes: unknown, expected: number | null = null, commit = true) =>
  asUser(db.app, actor, async (c) => (await c.query<BgcRow>(
    `SELECT * FROM authz.update_bgc($1, $2::jsonb, $3)`, [placementId, changes === null ? null : JSON.stringify(changes), expected])).rows[0]!, commit);
const bgcOf = async (placementId: string) =>
  (await db.admin.query(`SELECT * FROM eureka.bgc WHERE placement_id = $1`, [placementId])).rows[0];

/** As eureka_app for `userId` with extra role rows that exist only inside this (rolled back) transaction. */
async function withExtraRole<T>(userId: string, role: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, $2)`, [userId, role]);
    await c.query("SET LOCAL ROLE eureka_app");
    await c.query("SELECT set_config('eureka.user_id', $1, true)", [userId]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
}

// ---------------------------------------------------------------------------------------------

describe("versioned templates", () => {
  it("every insert is a new version stamped by the server; versions never change", async () => {
    await db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type, items, version, published_at)
                          VALUES ('paperwork', '1099', '[]', 42, '2001-01-01')`);
    await db.admin.query(`INSERT INTO authz.checklist_template (kind, placement_type, items) VALUES ('paperwork', '1099', '[]')`);
    const rows = (await db.admin.query(`SELECT version, published_at > now() - interval '1 minute' AS fresh
      FROM authz.checklist_template WHERE kind = 'paperwork' AND placement_type = '1099' ORDER BY version`)).rows;
    expect(rows).toEqual([{ version: 1, fresh: true }, { version: 2, fresh: true }]);
    await expect(db.admin.query(`UPDATE authz.checklist_template SET items = '[]' WHERE placement_type = '1099'`))
      .rejects.toThrow(/immutable/);
    await expect(db.admin.query(`DELETE FROM authz.checklist_template WHERE placement_type = '1099'`)).rejects.toThrow(/immutable/);
    await expect(db.admin.query(`TRUNCATE authz.checklist_template`)).rejects.toThrow(/not truncated/);
  });

  it("placements copy the latest version and keep their snapshot when a new version is published", async () => {
    const first = await placed();
    expect((await itemsOf(first.id)).map((i) => [i.doc_type, i.template_version, i.status]))
      .toEqual([["sample_doc_a", 1, "pending"], ["sample_doc_b", 1, "pending"], ["sample_doc_c", 1, "pending"]]);
    const v = await asUser(db.app, U.hr, async (c) => (await c.query<{ v: number }>(
      `SELECT authz.publish_checklist_template('paperwork', 'w2', $1::jsonb, 1) AS v`,
      [JSON.stringify([...W2, { doc_type: "sample_doc_d", owner_role: "documents_team" }])])).rows[0]!.v, true);
    expect(v).toBe(2);
    const second = await placed();
    expect((await itemsOf(first.id)).map((i) => i.doc_type)).toEqual(["sample_doc_a", "sample_doc_b", "sample_doc_c"]);
    expect((await itemsOf(second.id)).map((i) => [i.doc_type, i.template_version])).toEqual([
      ["sample_doc_a", 2], ["sample_doc_b", 2], ["sample_doc_c", 2], ["sample_doc_d", 2]]);
    // Back to the three-item list for the rest of the file.
    await asUser(db.app, U.hr, (c) => c.query(`SELECT authz.publish_checklist_template('paperwork', 'w2', $1::jsonb, 2)`, [JSON.stringify(W2)]), true);
    expect((await db.admin.query(`SELECT published_by FROM authz.checklist_template WHERE placement_type = 'w2' AND version = 3`)).rows[0].published_by)
      .toBe(U.hr);
  });

  it("publishing needs document:verify at org scope and the current version", async () => {
    const publish = (actor: string, expected: number | null, kind = "onboarding", items = "[]") =>
      asUser(db.app, actor, (c) => c.query(`SELECT authz.publish_checklist_template($1, 'c2c', $2::jsonb, $3)`, [kind, items, expected]));
    for (const k of users) {
      const allowed = ["hr", "imm"].includes(k);
      if (allowed) await expect(publish(U[k], 0)).resolves.toBeTruthy();
      else await expect(publish(U[k], 0), k).rejects.toThrow(/not_permitted/);
    }
    await expect(db.app.query(`SELECT authz.publish_checklist_template('onboarding', 'c2c', '[]', 0)`)).rejects.toThrow(/not_permitted/);
    await expect(publish(U.hr, 5)).rejects.toThrow(/version_mismatch/);
    await expect(publish(U.hr, null)).rejects.toThrow(/invalid_checklist_template/);
    await expect(publish(U.hr, 0, "bgc")).rejects.toThrow(/invalid_checklist_template/);
    await expect(publish(U.hr, 0, "onboarding", '[{"doc_type":"x","owner_role":"nobody"}]')).rejects.toThrow(/invalid_checklist_template/);
    await expect(publish(U.hr, 0, "onboarding", '{}')).rejects.toThrow(/invalid_checklist_template/);
  });

  it("template versions are readable with document:read at org scope only", async () => {
    for (const k of users) {
      const read = asUser(db.app, U[k], (c) => c.query(`SELECT * FROM authz.checklist_templates()`));
      if (["hr", "acct", "imm"].includes(k)) expect((await read).rowCount, k).toBeGreaterThan(0);
      else await expect(read, k).rejects.toThrow(/not_permitted/);
    }
  });
});

describe("checklist item progress", () => {
  it("follows the shared state machine for every pair (as HR), with reasons where required", async () => {
    const { id } = await placed();
    const item = await itemId(id);
    // Walk every status and try every target in a rolled-back transaction.
    const reach: Record<string, unknown[]> = {
      pending: [], received: [{ status: "received" }], verified: [{ status: "received" }, { status: "verified" }],
      waived: [{ status: "waived", reason: "Not applicable (fictional)" }],
    };
    for (const from of CHECKLIST_ITEM_STATUSES) {
      for (const to of CHECKLIST_ITEM_STATUSES) {
        const c = await db.app.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT set_config('eureka.user_id', $1, true)", [U.hr]);
          for (const step of reach[from]!) await c.query(`SELECT authz.update_checklist_item($1, $2::jsonb, NULL)`, [item, JSON.stringify(step)]);
          await c.query("SAVEPOINT s");
          const ok = await c.query(`SELECT * FROM authz.update_checklist_item($1, $2::jsonb, NULL)`,
            [item, JSON.stringify({ status: to, reason: "fictional reason" })]).then(() => true, () => false);
          expect(ok, `${from} -> ${to}`).toBe(checklistItemTransitionAllowed(from, to));
        } finally {
          await c.query("ROLLBACK");
          c.release();
        }
      }
    }
    await expect(updateItem(U.hr, item, { status: "waived" })).rejects.toThrow(/reason_required/);
    await expect(updateItem(U.hr, item, { status: "waived", reason: "   " })).rejects.toThrow(/reason_required/);
    await expect(updateItem(U.hr, item, { reason: "orphan reason" })).rejects.toThrow(/invalid_change/);
    await expect(updateItem(U.hr, item, { status: null })).rejects.toThrow(/invalid_change/);
    await expect(updateItem(U.hr, item, {})).rejects.toThrow(/invalid_change/);
    await expect(updateItem(U.hr, item, null)).rejects.toThrow(/invalid_change/);
    await expect(updateItem(U.hr, item, { status: "received", required: false })).rejects.toThrow(/invalid_change/);
  });

  it("records who/when, bumps the version, keeps a history without the notes text, and checks the expected version", async () => {
    const { id } = await placed();
    const item = await itemId(id);
    const r1 = await updateItem(U.r1a, item, { status: "received", notes: "Fictional note: scanned copy" }, 1);
    expect(r1).toEqual({ from_status: "pending", to_status: "received", new_version: 2, changed: ["status", "notes"] });
    await expect(updateItem(U.hr, item, { status: "verified" }, 1)).rejects.toThrow(/version_mismatch/);
    await updateItem(U.hr, item, { status: "pending", reason: "Fictional: wrong page" }, 2);
    await updateItem(U.hr, item, { dueOn: "2031-02-01", ownerRole: "documents_team" });
    const row = (await db.admin.query(`SELECT * FROM eureka.checklist_item WHERE id = $1`, [item])).rows[0];
    expect([row.status, row.status_reason, row.status_changed_by, row.updated_by, row.version, row.owner_role, row.notes])
      .toEqual(["pending", "Fictional: wrong page", U.hr, U.hr, 4, "documents_team", "Fictional note: scanned copy"]);
    const hist = (await db.admin.query(`SELECT actor_id, from_status, to_status, changed, details, reason
      FROM eureka.checklist_item_event WHERE item_id = $1 ORDER BY at, id`, [item])).rows;
    expect(hist).toEqual([
      { actor_id: U.r1a, from_status: "pending", to_status: "received", changed: ["status", "notes"], details: {}, reason: null },
      { actor_id: U.hr, from_status: "received", to_status: "pending", changed: ["status"], details: {}, reason: "Fictional: wrong page" },
      { actor_id: U.hr, from_status: null, to_status: null, changed: ["owner_role", "due_on"],
        details: { ownerRole: { from: "hr", to: "documents_team" }, dueOn: { from: null, to: "2031-02-01" } }, reason: null },
    ]);
    expect(JSON.stringify(hist)).not.toContain("scanned copy");
  });

  it("validates the assignee (active, holding the owner role), the due date and the document link", async () => {
    const { id } = await placed();
    const item = await itemId(id); // owner role hr
    await expect(updateItem(U.hr, item, { assigneeId: U.acct })).rejects.toThrow(/invalid_assignee/);
    await expect(updateItem(U.hr, item, { assigneeId: "not-a-uuid" })).rejects.toThrow(/invalid_assignee/);
    await updateItem(U.hr, item, { assigneeId: U.hr });
    // Changing the owner role re-checks the current assignee.
    await expect(updateItem(U.hr, item, { ownerRole: "accounts" })).rejects.toThrow(/invalid_assignee/);
    await updateItem(U.hr, item, { ownerRole: "accounts", assigneeId: U.acct });
    await expect(updateItem(U.hr, item, { ownerRole: "nobody" })).rejects.toThrow(/invalid_owner_role/);
    await db.admin.query(`UPDATE eureka.app_user SET status = 'inactive' WHERE id = $1`, [U.acct]);
    try {
      await expect(updateItem(U.hr, item, { assigneeId: U.acct, notes: "x" })).rejects.toThrow(/invalid_assignee/);
    } finally {
      await db.admin.query(`UPDATE eureka.app_user SET status = 'active' WHERE id = $1`, [U.acct]);
    }
    for (const bad of ["2031-02-30", "1999-12-31", "2101-01-01", "tomorrow", 20310101]) {
      await expect(updateItem(U.hr, item, { dueOn: bad }), String(bad)).rejects.toThrow(/invalid_due_date/);
    }
    await expect(updateItem(U.hr, item, { documentId: "x" })).rejects.toThrow(/invalid_change/);
    await expect(updateItem(U.hr, item, { notes: "x".repeat(1001) })).rejects.toThrow(/invalid_change/);
    await expect(updateItem(U.hr, item, { notes: 5 })).rejects.toThrow(/invalid_change/);
    const doc = await documentFor(U.hr, { placement: id });
    await updateItem(U.hr, item, { documentId: doc, dueOn: null, notes: "" });
    const row = (await db.admin.query(`SELECT document_id, due_on, notes, assignee_id FROM eureka.checklist_item WHERE id = $1`, [item])).rows[0];
    expect(row).toEqual({ document_id: doc, due_on: null, notes: null, assignee_id: U.acct });
  });

  it("links only a document of the item's candidate, on no placement or this one, that is not blocked (PW-5)", async () => {
    const a = await placed();
    const b = await placed();
    const item = await itemId(a.id);
    // The column has a real foreign key now (0043).
    await expect(updateItem(U.hr, item, { documentId: "00000000-0000-4000-8000-00000000d0c1" })).rejects.toThrow(/invalid_document/);
    // Another candidate's document (candidate-level or on their placement) is refused.
    await expect(updateItem(U.hr, item, { documentId: await documentFor(U.hr, { candidate: b.cand.id }) })).rejects.toThrow(/invalid_document/);
    await expect(updateItem(U.hr, item, { documentId: await documentFor(U.hr, { placement: b.id }) })).rejects.toThrow(/invalid_document/);
    // The same candidate's document filed on another of their placements is refused too.
    await transitionPlacement(db, U.r1a, a.id, "backout", "Fictional: declined");
    const sub2 = await selectedSubmission(db, U.r1a, a.cand.id);
    const a2 = await createPlacement(db, U.r1a, sub2, { type: "w2" });
    const item2 = await itemId(a2.id);
    await expect(updateItem(U.hr, item2, { documentId: await documentFor(U.hr, { placement: a.id }) })).rejects.toThrow(/invalid_document/);
    // Candidate-level and this placement's documents are accepted.
    await expect(updateItem(U.hr, item2, { documentId: await documentFor(U.hr, { candidate: a.cand.id }) })).resolves.toBeTruthy();
    const onThis = await documentFor(U.hr, { placement: a2.id });
    await expect(updateItem(U.hr, item2, { documentId: onThis })).resolves.toBeTruthy();
    // A file the scan blocked cannot be linked.
    const blocked = await documentFor(U.hr, { placement: a2.id });
    const c = await db.admin.connect();
    try {
      await c.query("SET session_replication_role = replica");
      await c.query(`UPDATE eureka.file_object SET status = 'infected', scanned_at = now()
                      WHERE id = (SELECT file_id FROM eureka.document WHERE id = $1)`, [blocked]);
    } finally {
      await c.query("RESET session_replication_role");
      c.release();
    }
    await expect(updateItem(U.hr, item2, { documentId: blocked })).rejects.toThrow(/invalid_document/);
    // Unlinking is always possible.
    await expect(updateItem(U.hr, item2, { documentId: null })).resolves.toMatchObject({ changed: ["document"] });
  });

  it("restricted documents can be linked only by roles that can read them", async () => {
    const { id, cand } = await placed();
    const item = await itemId(id);
    const restricted = await documentFor(U.hr, { candidate: cand.id }, "i9");
    const internal = await documentFor(U.hr, { candidate: cand.id }, "offer_letter");
    // r1a may edit the item's document link (document:upload own) but holds no document.restricted:read.
    await expect(updateItem(U.r1a, item, { documentId: restricted })).rejects.toThrow(/invalid_document/);
    await expect(updateItem(U.r1a, item, { documentId: internal })).resolves.toBeTruthy();
    // HR and Immigration read restricted documents.
    await expect(updateItem(U.hr, item, { documentId: restricted }, null, false)).resolves.toBeTruthy();
    await expect(updateItem(U.imm, item, { documentId: restricted }, null, false)).resolves.toBeTruthy();
    // Associate HR uploads but cannot read restricted documents.
    const ahr = await extraUser(db, "pw_ahr", "associate_hr");
    await expect(updateItem(ahr.id, item, { documentId: restricted })).rejects.toThrow(/invalid_document/);
    await expect(updateItem(ahr.id, item, { documentId: internal })).resolves.toBeTruthy();
  });

  it("refuses changes on a backed-out placement; a placement in bgc_failed can still be closed out", async () => {
    const a = await placed();
    await transitionPlacement(db, U.r1a, a.id, "backout", "Fictional: declined");
    await expect(updateItem(U.hr, await itemId(a.id), { status: "received" })).rejects.toThrow(/placement_closed/);
    const b = await placed();
    await transitionPlacement(db, U.m1, b.id, "bgc_failed", "Fictional: check failed");
    await expect(updateItem(U.hr, await itemId(b.id), { status: "waived", reason: "Fictional: not needed" })).resolves.toBeTruthy();
  });

  it("refuses a missing item, NULL arguments and a missing user context as not found", async () => {
    const { id } = await placed();
    await expect(updateItem(U.hr, "00000000-0000-4000-8000-000000000999", { status: "received" })).rejects.toThrow(/item_not_found/);
    await expect(updateItem(U.hr, null, { status: "received" })).rejects.toThrow(/item_not_found/);
    await expect(db.app.query(`SELECT authz.update_checklist_item($1, '{"status":"received"}', NULL)`, [await itemId(id)]))
      .rejects.toThrow(/item_not_found/);
  });
});

describe("permission matrix: item writes per fixture user (404 / 403 / ok, as the engine predicts)", () => {
  const OPS = {
    receive: { status: "received" },
    waive: { status: "waived", reason: "Fictional reason" },
    notes: { notes: "Fictional note" },
    document: { documentId: "" }, // filled per placement with an internal document of its candidate
    due: { dueOn: "2031-03-01" },
    owner: { ownerRole: "documents_team" },
  } as const;
  const made: { id: string; ref: ActivityRef; doc: string }[] = [];

  beforeAll(async () => {
    for (const [actor, cand] of [[U.r1a, R1A], [U.r3a, { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.austin }]] as const) {
      const p = await placed(actor, cand);
      const pl = (await db.admin.query(`SELECT * FROM eureka.placement WHERE id = $1`, [p.id])).rows[0];
      const cs = (await db.admin.query(`SELECT marketing_status FROM eureka.candidate WHERE id = $1`, [p.cand.id])).rows[0];
      made.push({ id: p.id, ref: { recruiterId: pl.recruiter_id, teamId: pl.team_id, locationId: pl.location_id,
        candidate: { ...p.cand, marketingStatus: cs.marketing_status } }, doc: await documentFor(U.hr, { candidate: p.cand.id }) });
    }
  }, 60_000);

  it.each(users)("%s", async (key) => {
    const access = toUserAccess(key);
    for (const m of made) {
      const item = await itemId(m.id);
      const visible = activityVisible(resolveScope(access, "placement:read"), m.ref) || activityVisible(resolveScope(access, "document:read"), m.ref);
      const acts = checklistItemActions(access, m.ref, "pending", "confirmed");
      for (const [op, changes] of Object.entries(OPS)) {
        const allowed = op === "receive" ? acts.transition.includes("received")
          : op === "waive" ? acts.transition.includes("waived")
            : op === "notes" || op === "document" ? acts.editNotes : acts.assign;
        const run = updateItem(U[key], item, op === "document" ? { documentId: m.doc } : changes, null, false);
        if (!visible) await expect(run, `${key} ${op}`).rejects.toThrow(/item_not_found/);
        else if (!allowed) await expect(run, `${key} ${op}`).rejects.toThrow(/not_permitted/);
        else await expect(run, `${key} ${op}`).resolves.toBeTruthy();
      }
    }
  });
});

describe("background checks", () => {
  it("follow the shared state machine for every pair, created on first write", async () => {
    const reach: Record<string, unknown[]> = {
      not_started: [], initiated: [{ status: "initiated" }], in_progress: [{ status: "initiated" }, { status: "in_progress" }],
      cleared: [{ status: "initiated" }, { status: "cleared" }],
      failed: [{ status: "initiated" }, { status: "failed", reason: "Fictional finding" }],
    };
    const { id } = await placed();
    for (const from of BGC_STATUSES) {
      for (const to of BGC_STATUSES) {
        const c = await db.app.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT set_config('eureka.user_id', $1, true)", [U.hr]);
          for (const step of reach[from]!) await c.query(`SELECT authz.update_bgc($1, $2::jsonb, NULL)`, [id, JSON.stringify(step)]);
          if (from === "not_started") await c.query(`SELECT authz.update_bgc($1, '{"notes":"Fictional"}', NULL)`, [id]);
          await c.query("SAVEPOINT s");
          const ok = await c.query(`SELECT * FROM authz.update_bgc($1, $2::jsonb, NULL)`,
            [id, JSON.stringify({ status: to, reason: "Fictional reason" })]).then(() => true, () => false);
          expect(ok, `${from} -> ${to}`).toBe(bgcTransitionAllowed(from, to));
        } finally {
          await c.query("ROLLBACK");
          c.release();
        }
      }
    }
    expect(await bgcOf(id)).toBeUndefined();
  });

  it("stores the record, defaults the dates the status implies, keeps a history, and validates values", async () => {
    const { id } = await placed();
    const r = await updateBgc(U.hr, id, { status: "initiated", bgcCompany: "Fictional Checks LLC", employmentYears: 7, addressYears: 7,
      educationLevel: "Highest degree", helpedBy: U.r1a, notes: "Fictional note" });
    expect(r).toMatchObject({ from_status: "not_started", to_status: "initiated", new_version: 2, placement_from: null });
    let b = await bgcOf(id);
    expect([b.status, b.bgc_company, b.employment_years, b.address_years, b.helped_by, b.created_by, b.updated_by, b.candidate_id, b.recruiter_id])
      .toEqual(["initiated", "Fictional Checks LLC", 7, 7, U.r1a, U.hr, U.hr, (await db.admin.query(`SELECT candidate_id FROM eureka.placement WHERE id = $1`, [id])).rows[0].candidate_id, U.r1a]);
    expect(b.initiated_on).not.toBeNull();
    await expect(updateBgc(U.hr, id, { status: "failed" })).rejects.toThrow(/reason_required/);
    await expect(updateBgc(U.hr, id, { employmentYears: 51 })).rejects.toThrow(/invalid_change/);
    await expect(updateBgc(U.hr, id, { employmentYears: "7" })).rejects.toThrow(/invalid_change/);
    await expect(updateBgc(U.hr, id, { initiatedOn: "2031-02-30" })).rejects.toThrow(/invalid_change/);
    await expect(updateBgc(U.hr, id, { completedOn: "2001-01-01" })).rejects.toThrow(/invalid_change/); // before initiated
    await expect(updateBgc(U.hr, id, { bgcCompany: "x\u0007" })).rejects.toThrow(/invalid_change/);
    await expect(updateBgc(U.hr, id, { helpedBy: "00000000-0000-4000-8000-000000000999" })).rejects.toThrow(/invalid_helper/);
    await expect(updateBgc(U.hr, id, { status: "cleared", failPlacement: true })).rejects.toThrow(/invalid_change/);
    await expect(updateBgc(U.hr, id, { status: "cleared", placementId: id })).rejects.toThrow(/invalid_change/);
    await expect(updateBgc(U.hr, id, { status: "cleared" }, 1)).rejects.toThrow(/version_mismatch/);
    await updateBgc(U.hr, id, { status: "cleared" }, 2);
    b = await bgcOf(id);
    expect([b.status, b.completed_on !== null, b.version]).toEqual(["cleared", true, 3]);
    const hist = (await db.admin.query(`SELECT actor_id, from_status, to_status, changed, reason FROM eureka.bgc_event
      WHERE placement_id = $1 ORDER BY at, id`, [id])).rows;
    expect(hist).toEqual([
      { actor_id: U.hr, from_status: "not_started", to_status: "initiated",
        changed: ["status", "bgc_company", "initiated_on", "helped_by", "education_level", "employment_years", "address_years", "notes"], reason: null },
      { actor_id: U.hr, from_status: "initiated", to_status: "cleared", changed: ["status", "completed_on"], reason: null },
    ]);
  });

  it("only bgc:update over the placement writes (HR); 404 without document:read coverage", async () => {
    const { id } = await placed();
    for (const k of users) {
      const docs = ["r1a", "l1", "m1", "ad", "hr", "acct", "imm"].includes(k);
      const run = updateBgc(U[k], id, { status: "initiated" }, null, false);
      if (k === "hr") await expect(run).resolves.toBeTruthy();
      else if (docs) await expect(run, k).rejects.toThrow(/not_permitted/);
      else await expect(run, k).rejects.toThrow(/placement_not_found/);
    }
    await expect(db.app.query(`SELECT authz.update_bgc($1, '{"status":"initiated"}', NULL)`, [id])).rejects.toThrow(/placement_not_found/);
    await expect(updateBgc(U.hr, null, { status: "initiated" })).rejects.toThrow(/placement_not_found/);
  });

  it("refuses writes on a backed-out placement", async () => {
    const { id } = await placed();
    await transitionPlacement(db, U.r1a, id, "backout", "Fictional: declined");
    await expect(updateBgc(U.hr, id, { status: "initiated" })).rejects.toThrow(/placement_closed/);
  });
});

describe("BGC and the placement state machine (FR-PLC-06): one set of rules in authz.transition_placement", () => {
  it("HR alone cannot fail the placement: the placement rules refuse and nothing is written", async () => {
    const { id } = await placed();
    await updateBgc(U.hr, id, { status: "initiated" });
    await expect(updateBgc(U.hr, id, { status: "failed", reason: "Fictional finding", failPlacement: true })).rejects.toThrow(/not_permitted/);
    expect((await bgcOf(id)).status).toBe("initiated");
    expect((await db.admin.query(`SELECT status FROM eureka.placement WHERE id = $1`, [id])).rows[0].status).toBe("confirmed");
  });

  it("a caller with bgc:update and the placement rights fails both in one transaction, with the placement side effects", async () => {
    const { id, cand } = await placed();
    await updateBgc(U.hr, id, { status: "initiated" });
    const r = await withExtraRole(U.m1, "hr", async (c) => {
      const row = (await c.query<BgcRow>(`SELECT * FROM authz.update_bgc($1, $2::jsonb, NULL)`,
        [id, JSON.stringify({ status: "failed", reason: "Fictional finding", failPlacement: true })])).rows[0]!;
      const state = (await c.query(`SELECT (SELECT status FROM eureka.placement WHERE id = $1) AS placement,
          (SELECT status_reason FROM eureka.placement WHERE id = $1) AS reason,
          (SELECT status FROM eureka.bgc WHERE placement_id = $1) AS bgc`, [id])).rows[0];
      return { row, state };
    });
    expect(r.row).toMatchObject({ to_status: "failed", placement_from: "confirmed", placement_to: "bgc_failed",
      candidate_from: "confirmation", candidate_to: "active" });
    // The free-text BGC reason stays on the BGC record (document:read); the placement,
    // readable by every placement:read holder, gets a fixed reason (0053).
    expect(r.state).toEqual({ placement: "bgc_failed", reason: "Background check failed (see the BGC record)", bgc: "failed" });
    void cand;
  });

  it("failed after joining: a cleared check that fails ends the assignment and benches the candidate", async () => {
    const { id, cand } = await placed();
    for (const to of ["paperwork", "bgc", "ready", "joined"]) await transitionPlacement(db, U.r1a, id, to);
    await updateBgc(U.hr, id, { status: "initiated" });
    await updateBgc(U.hr, id, { status: "cleared" });
    const r = await withExtraRole(U.m1, "hr", async (c) => {
      await c.query(`SELECT * FROM authz.update_bgc($1, '{"status":"failed","reason":"Fictional later finding","failPlacement":true}', NULL)`, [id]);
      await c.query("RESET ROLE"); // read the result as the superuser, inside the same transaction
      return (await c.query(`SELECT (SELECT status FROM eureka.placement WHERE id = $1) AS placement,
          (SELECT end_reason FROM eureka.assignment WHERE placement_id = $1) AS end_reason,
          (SELECT marketing_status FROM eureka.candidate WHERE id = $2) AS candidate,
          (SELECT count(*)::int FROM eureka.outbox_event WHERE aggregate_id = $1 AND payload ->> 'to' = 'bgc_failed') AS outbox`,
        [id, cand.id])).rows[0];
    });
    expect(r).toEqual({ placement: "bgc_failed", end_reason: "bgc_failed", candidate: "bench", outbox: 1 });
  });

  it("an already failed check can fail the placement later; a placement already in bgc_failed is refused", async () => {
    const { id } = await placed();
    await updateBgc(U.hr, id, { status: "initiated" });
    await updateBgc(U.hr, id, { status: "failed", reason: "Fictional finding" });
    const status = await withExtraRole(U.m1, "hr", async (c) => {
      await c.query(`SELECT * FROM authz.update_bgc($1, '{"failPlacement":true}', NULL)`, [id]);
      const s = (await c.query(`SELECT status, status_reason FROM eureka.placement WHERE id = $1`, [id])).rows[0];
      await c.query("SAVEPOINT s");
      const again = await c.query(`SELECT * FROM authz.update_bgc($1, '{"failPlacement":true}', NULL)`, [id]).then(() => "ok", (e: Error) => e.message);
      return { s, again };
    });
    expect(status).toEqual({ s: { status: "bgc_failed", status_reason: "Background check failed (see the BGC record)" }, again: "invalid_transition" });
  });

  it("the placement transitions themselves are unchanged: no BGC record is required (no gating, open question)", async () => {
    const { id } = await placed();
    for (const to of ["paperwork", "bgc", "ready"]) await transitionPlacement(db, U.r1a, id, to);
    expect(await bgcOf(id)).toBeUndefined();
    await transitionPlacement(db, U.m1, id, "bgc_failed", "Fictional: decided by the manager");
    expect(await bgcOf(id)).toBeUndefined();
  });
});

describe("closed write paths and hardening", () => {
  it("the app and the worker cannot write paperwork tables; the worker cannot read them", async () => {
    const { id } = await placed();
    await updateBgc(U.hr, id, { status: "initiated" });
    const item = await itemId(id);
    for (const sql of [
      `UPDATE eureka.checklist_item SET status = 'verified' WHERE id = '${item}'`,
      `UPDATE eureka.bgc SET status = 'cleared' WHERE placement_id = '${id}'`,
      `INSERT INTO eureka.bgc (placement_id) VALUES ('${id}')`,
      `INSERT INTO eureka.checklist_item_event (item_id, placement_id, changed) VALUES ('${item}', '${id}', '{status}')`,
      `INSERT INTO eureka.bgc_event (bgc_id, placement_id, changed) SELECT id, placement_id, '{status}' FROM eureka.bgc`,
      `DELETE FROM eureka.checklist_item_event`,
      `DELETE FROM eureka.bgc`,
    ]) {
      await expect(asUser(db.app, U.hr, (c) => c.query(sql)), sql).rejects.toThrow(/permission denied/);
    }
    for (const t of ["checklist_item", "checklist_item_event", "bgc", "bgc_event"]) {
      await expect(db.worker.query(`SELECT * FROM eureka.${t}`)).rejects.toThrow(/permission denied/);
    }
    await expect(db.worker.query(`SELECT authz.update_bgc($1, '{}', NULL)`, [id])).rejects.toThrow(/permission denied/);
  });

  it("guards refuse every writer but the definer (even the owner) and keep snapshots and server columns", async () => {
    const { id } = await placed();
    await updateBgc(U.hr, id, { status: "initiated" });
    const item = await itemId(id);
    await expect(db.admin.query(`UPDATE eureka.checklist_item SET status = 'verified' WHERE id = $1`, [item])).rejects.toThrow(/only by placement functions/);
    await expect(db.admin.query(`UPDATE eureka.bgc SET status = 'cleared' WHERE placement_id = $1`, [id])).rejects.toThrow(/only by definer functions/);
    await expect(db.admin.query(`DELETE FROM eureka.bgc_event`)).rejects.toThrow(/append-only/);
    await expect(db.admin.query(`TRUNCATE eureka.checklist_item_event`)).rejects.toThrow(/not truncated/);
    // Even the definer cannot move snapshots or delete.
    const c = await db.admin.connect();
    try {
      for (const sql of [
        `UPDATE eureka.checklist_item SET candidate_id = (SELECT id FROM eureka.candidate LIMIT 1) WHERE id = '${item}'`,
        `UPDATE eureka.checklist_item SET required = false WHERE id = '${item}'`,
        `UPDATE eureka.bgc SET recruiter_id = '${U.r2a}' WHERE placement_id = '${id}'`,
        `DELETE FROM eureka.checklist_item WHERE id = '${item}'`,
        `DELETE FROM eureka.bgc WHERE placement_id = '${id}'`,
        `UPDATE eureka.checklist_item_event SET reason = 'x'`,
      ]) {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE authz_definer");
        await expect(c.query(sql), sql).rejects.toThrow(/immutable|never deleted|append-only|permission denied/);
        await c.query("ROLLBACK");
      }
    } finally {
      c.release();
    }
  });

  it("functions pin search_path, are not executable by PUBLIC, and only the API entry points are executable by the app", async () => {
    const { rows } = await db.admin.query(`
      SELECT p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('eureka_app', p.oid, 'EXECUTE') AS app,
             has_function_privilege('eureka_worker', p.oid, 'EXECUTE') AS worker,
             coalesce(p.proacl::text, '') ~ '(^|[{,])=X' AS public
        FROM pg_proc p
       WHERE p.proname IN ('update_checklist_item', 'update_bgc', 'checklist_templates', 'publish_checklist_template',
                           'placement_covered', 'checklist_item_history', 'bgc_history', 'checklist_on_placement',
                           'checklist_template_check', 'checklist_item_write_guard', 'bgc_write_guard', 'paperwork_event_guard',
                           'paperwork_no_truncate', 'checklist_template_no_truncate', 'checklist_item_texts')
       ORDER BY p.proname`);
    expect(rows).toHaveLength(15);
    const app = new Set(["update_checklist_item", "update_bgc", "checklist_templates", "publish_checklist_template", "checklist_item_texts"]);
    for (const r of rows) {
      expect(r.proconfig, r.proname).toContain("search_path=pg_catalog, pg_temp");
      expect(r.public, r.proname).toBe(false);
      expect(r.app, r.proname).toBe(app.has(r.proname));
      expect(r.worker, r.proname).toBe(false);
    }
  });

  it("item notes and reasons are readable only under document:read, through authz.checklist_item_texts", async () => {
    const { id } = await placed();
    const item = await itemId(id);
    await updateItem(U.hr, item, { status: "waived", reason: "Fictional reason text", notes: "Fictional note text" });
    // locD reads the placement (location scope) and its items, but holds no document:read.
    for (const k of ["locD", "ceo", "r1a", "hr", "imm"] as const) {
      await expect(asUser(db.app, U[k], (c) => c.query(`SELECT notes FROM eureka.checklist_item`)), k).rejects.toThrow(/permission denied/);
      await expect(asUser(db.app, U[k], (c) => c.query(`SELECT status_reason FROM eureka.checklist_item`)), k).rejects.toThrow(/permission denied/);
      const texts = (await asUser(db.app, U[k], (c) => c.query(`SELECT * FROM authz.checklist_item_texts($1) WHERE item_id = $2`, [id, item]))).rows;
      const docs = ["r1a", "hr", "imm"].includes(k);
      expect(texts, k).toEqual(docs ? [{ item_id: item, notes: "Fictional note text", status_reason: "Fictional reason text" }] : []);
    }
    expect((await asUser(db.app, U.locD, (c) => c.query(`SELECT status FROM eureka.checklist_item WHERE id = $1`, [item]))).rows)
      .toEqual([{ status: "waived" }]);
    expect((await db.app.query(`SELECT * FROM authz.checklist_item_texts($1)`, [id])).rows).toEqual([]);
  });

  it("RLS is enabled and forced on the new tables", async () => {
    const { rows } = await db.admin.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relnamespace = 'eureka'::regnamespace AND relname IN ('checklist_item', 'checklist_item_event', 'bgc', 'bgc_event') ORDER BY relname`);
    expect(rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
    expect(rows).toHaveLength(4);
  });
});

describe("RLS differential: BGC, item history and items across fixture users", () => {
  const made: (ActivityRef & { id: string })[] = [];

  beforeAll(async () => {
    const plan: { actor: string; cand: Cand }[] = [
      { actor: U.r1a, cand: R1A },
      { actor: U.r1b, cand: { teamId: T.t1, recruiterId: U.r1b, locationId: LOC.austin } },
      { actor: U.l1, cand: { teamId: T.t1, recruiterId: null, locationId: LOC.dallas } },
      { actor: U.r2a, cand: { teamId: T.t2, recruiterId: U.r2a, locationId: LOC.austin } },
      // r2a places an Open-to-all-teams candidate owned by team 3.
      { actor: U.r2a, cand: { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.dallas, visibility: "all_teams" } },
      { actor: U.r3a, cand: { teamId: T.t3, recruiterId: U.r3a, locationId: LOC.austin } },
    ];
    for (const { actor, cand } of plan) {
      const { id, cand: c } = await placed(actor, cand);
      await updateBgc(U.hr, id, { status: "initiated" });
      await updateItem(U.hr, await itemId(id), { status: "received" });
      const p = (await db.admin.query(`SELECT * FROM eureka.placement WHERE id = $1`, [id])).rows[0];
      const cs = (await db.admin.query(`SELECT marketing_status FROM eureka.candidate WHERE id = $1`, [c.id])).rows[0];
      made.push({ id, recruiterId: p.recruiter_id, teamId: p.team_id, locationId: p.location_id,
        candidate: { ...c, marketingStatus: cs.marketing_status } });
    }
  }, 60_000);

  it.each(users)("%s", async (key) => {
    const access = toUserAccess(key);
    const docs = resolveScope(access, "document:read");
    const pls = resolveScope(access, "placement:read");
    const ids = new Set(made.map((m) => m.id));
    const pick = (rows: { placement_id: string }[]) => [...new Set(rows.map((r) => r.placement_id).filter((i) => ids.has(i)))].sort();
    const seen = await asUser(db.app, U[key], async (c) => ({
      bgc: pick((await c.query(`SELECT placement_id FROM eureka.bgc`)).rows),
      bgcEvents: pick((await c.query(`SELECT placement_id FROM eureka.bgc_event`)).rows),
      itemEvents: pick((await c.query(`SELECT placement_id FROM eureka.checklist_item_event`)).rows),
      items: pick((await c.query(`SELECT placement_id FROM eureka.checklist_item`)).rows),
    }));
    const byDocs = made.filter((m) => activityVisible(docs, m)).map((m) => m.id).sort();
    expect(seen.bgc).toEqual(byDocs);
    expect(seen.bgcEvents).toEqual(byDocs);
    expect(seen.itemEvents).toEqual(byDocs);
    expect(seen.items).toEqual(made.filter((m) => activityVisible(docs, m) || activityVisible(pls, m)).map((m) => m.id).sort());
  });

  it("read policies resolve candidate ownership once per statement (rule 3)", async () => {
    for (const t of ["bgc", "checklist_item", "checklist_item_event"]) {
      const r = await ownedCandidateCalls(db.admin, U.m1, `SELECT id FROM eureka.${t}`);
      expect(r.rows, t).toBeGreaterThan(0);
      expect(r.calls, t).toBeLessThanOrEqual(2);
    }
  });
});
