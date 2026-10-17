import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityVisible, candidateVisible, ownsCandidate, resolveScope, type Permission, type UserAccess } from "@eureka/shared";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";

/**
 * Differential tests for the tables added after the first RLS differential (rls.int.test.ts covers
 * candidate, person, the Hot List and submissions): for every fixture user, the rows PostgreSQL's RLS
 * returns must be exactly the rows the TypeScript engine says are visible. The two are written
 * independently, so drift in either shows up here.
 *
 * Rows are written as the superuser with triggers off (session_replication_role = replica), so the
 * actor snapshots can be chosen freely; the write paths have their own tests.
 */
let db: TestDb;
let candidates: FixtureCandidate[];
const users = Object.keys(U) as (keyof typeof U)[];

/** Actors with their team and location snapshot (what the definer functions record). */
const ACTORS = [
  { recruiterId: U.r1a, teamId: T.t1, locationId: LOC.dallas },
  { recruiterId: U.r1b, teamId: T.t1, locationId: LOC.austin },
  { recruiterId: U.r2a, teamId: T.t2, locationId: LOC.dallas },
  { recruiterId: U.r3a, teamId: T.t3, locationId: LOC.austin },
];

interface Placement { id: string; recruiterId: string; teamId: string; locationId: string; candidate: FixtureCandidate }
interface Doc { id: string; classification: "internal" | "restricted"; candidate: FixtureCandidate }
const placements: Placement[] = [];
const invoices: { id: string; placement: Placement }[] = [];
const payments: { id: string; placement: Placement }[] = [];
const bgcs: { id: string; placement: Placement }[] = [];
const docs: Doc[] = [];
const workAuths: { id: string; candidate: FixtureCandidate }[] = [];
const employees: { id: string }[] = []; // employee is keyed by person_id

const scope = (access: UserAccess, p: Permission) => resolveScope(access, p);
const owns = (access: UserAccess, p: Permission, c: FixtureCandidate) => {
  const s = scope(access, p);
  return s !== null && ownsCandidate(s, c);
};
const placementVisible = (access: UserAccess, pl: Placement, p: Permission = "placement:read") =>
  activityVisible(scope(access, p), pl);

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    const person = async (id: string) =>
      (await c.query<{ person_id: string }>(`SELECT person_id FROM eureka.candidate WHERE id = $1`, [id])).rows[0]!.person_id;
    for (const [i, cand] of candidates.entries()) {
      const personId = await person(cand.id);
      // Every candidate: one internal and one restricted document, one work authorization.
      for (const classification of ["internal", "restricted"] as const) {
        const d = await c.query<{ id: string }>(
          `INSERT INTO eureka.document (candidate_id, doc_type, classification, file_id, created_by)
           VALUES ($1, 'other', $2, gen_random_uuid(), $3) RETURNING id`, [cand.id, classification, U.admin]);
        docs.push({ id: d.rows[0]!.id, classification, candidate: cand });
      }
      const wa = await c.query<{ id: string }>(
        `INSERT INTO eureka.work_authorization (id, person_id, auth_type, status, created_by, updated_by)
         VALUES (gen_random_uuid(), $1, 'h1b', 'valid', $2, $2) RETURNING id`, [personId, U.imm]);
      workAuths.push({ id: wa.rows[0]!.id, candidate: cand });
      // Every other candidate is placed, by an actor that rotates across teams and locations, so some
      // placements are another team's activity on the owner's candidate.
      if (i % 2) continue;
      const actor = ACTORS[(i / 2) % ACTORS.length]!;
      const sub = await c.query<{ id: string }>(
        `INSERT INTO eureka.submission (candidate_id, recruiter_id, team_id, job_title, client_id)
         VALUES ($1, $2, $3, 'Java Dev', $4) RETURNING id`, [cand.id, actor.recruiterId, actor.teamId, CLIENT_ID]);
      const pl = await c.query<{ id: string }>(
        `INSERT INTO eureka.placement (submission_id, candidate_id, person_id, recruiter_id, team_id, location_id, client_id,
           placement_type, work_mode, tentative_start, is_first_placement, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'w2', 'onsite', '2031-01-01', true, $4) RETURNING id`,
        [sub.rows[0]!.id, cand.id, personId, actor.recruiterId, actor.teamId, actor.locationId, CLIENT_ID]);
      const placement: Placement = { id: pl.rows[0]!.id, ...actor, candidate: cand };
      placements.push(placement);
      const inv = await c.query<{ id: string }>(
        `INSERT INTO eureka.invoice (placement_id, invoice_date, terms_days, amount, created_by)
         VALUES ($1, '2031-02-01', 30, 1000, $2) RETURNING id`, [placement.id, U.acct]);
      invoices.push({ id: inv.rows[0]!.id, placement });
      const pay = await c.query<{ id: string }>(
        `INSERT INTO eureka.payment (invoice_id, received_on, amount, created_by) VALUES ($1, '2031-03-01', 100, $2) RETURNING id`,
        [inv.rows[0]!.id, U.acct]);
      payments.push({ id: pay.rows[0]!.id, placement });
      const bgc = await c.query<{ id: string }>(
        `INSERT INTO eureka.bgc (placement_id, candidate_id, recruiter_id, team_id, location_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [placement.id, cand.id, actor.recruiterId, actor.teamId, actor.locationId]);
      bgcs.push({ id: bgc.rows[0]!.id, placement });
      if (i % 4 === 0) {
        const e = await c.query<{ id: string }>(
          `INSERT INTO eureka.employee (person_id, candidate_id, status, employee_since, status_since)
           VALUES ($1, $2, 'bench', '2031-01-01', '2031-01-01') RETURNING person_id AS id`, [personId, cand.id]);
        employees.push({ id: e.rows[0]!.id });
      }
    }
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}, 90_000);

afterAll(async () => db?.drop());

const visibleIds = (userId: string, table: string, key = "id") => asUser(db.app, userId, async (c) =>
  (await c.query<{ id: string }>(`SELECT ${key} AS id FROM eureka.${table}`)).rows.map((r) => r.id).sort());
const sorted = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

describe("differential: RLS alone matches the engine (placements, money, paperwork, documents, immigration, employees)", () => {
  it("the fixture covers each kind of row", () => {
    expect(placements.length).toBeGreaterThan(8);
    expect(employees.length).toBeGreaterThan(2);
    // some placements are made by a team other than the candidate's own
    expect(placements.some((p) => p.teamId !== p.candidate.teamId)).toBe(true);
  });

  it.each(users)("placement for %s = engine placement:read on the activity", async (key) => {
    const a = toUserAccess(key);
    expect(await visibleIds(a.userId, "placement")).toEqual(sorted(placements.filter((p) => placementVisible(a, p))));
  });

  it.each(users)("invoice and payment for %s = readable placement and invoice:read on it", async (key) => {
    const a = toUserAccess(key);
    const ok = (p: Placement) => placementVisible(a, p) && placementVisible(a, p, "invoice:read");
    expect(await visibleIds(a.userId, "invoice")).toEqual(sorted(invoices.filter((x) => ok(x.placement))));
    expect(await visibleIds(a.userId, "payment")).toEqual(sorted(payments.filter((x) => ok(x.placement))));
  });

  it.each(users)("bgc for %s = engine document:read on the placement's activity", async (key) => {
    const a = toUserAccess(key);
    expect(await visibleIds(a.userId, "bgc")).toEqual(sorted(bgcs.filter((x) => placementVisible(a, x.placement, "document:read"))));
  });

  it.each(users)("document for %s = readable candidate, document:read, and restricted:read for restricted files", async (key) => {
    const a = toUserAccess(key);
    const ok = (d: Doc) => candidateVisible(scope(a, "candidate:read"), d.candidate) && owns(a, "document:read", d.candidate)
      && (d.classification === "internal" || owns(a, "document.restricted:read", d.candidate));
    expect(await visibleIds(a.userId, "document")).toEqual(sorted(docs.filter(ok)));
  });

  it.each(users)("work_authorization for %s = readable candidate and visa:read", async (key) => {
    const a = toUserAccess(key);
    const ok = (c: FixtureCandidate) => candidateVisible(scope(a, "candidate:read"), c) && owns(a, "visa:read", c);
    expect(await visibleIds(a.userId, "work_authorization")).toEqual(sorted(workAuths.filter((x) => ok(x.candidate))));
  });

  it.each(users)("employee for %s = employee:read at org scope", async (key) => {
    const a = toUserAccess(key);
    expect(await visibleIds(a.userId, "employee", "person_id")).toEqual(scope(a, "employee:read")?.all ? sorted(employees) : []);
  });
});
