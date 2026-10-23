import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CANDIDATE_STATUSES, CHECKLIST_ITEM_STATUSES, PERMISSIONS, PLACEMENT_STATUSES, SUBMISSION_STATUSES,
} from "@eureka/shared";
import { createTestDb, type TestDb } from "./db-harness.js";

/**
 * Rules that exist both in @eureka/shared and in SQL must agree. role_permission.permission is free
 * text, so a permission misspelt in a policy or function would never match a grant and fail closed
 * without anyone noticing; a status list that drifts from the state machine fails only at runtime.
 */
describe("SQL agrees with the shared catalog", () => {
  let db: TestDb;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => db?.drop());

  it("every permission literal in an authz/eureka function or a policy is in PERMISSIONS", async () => {
    const { rows } = await db.admin.query<{ p: string }>(
      `SELECT DISTINCT m[1] AS p FROM (
         SELECT p.prosrc AS s FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('authz', 'eureka')
         UNION ALL SELECT coalesce(qual, '') || ' ' || coalesce(with_check, '') FROM pg_policies
       ) x, regexp_matches(x.s, '''([a-z_]+:[a-z_]+)''', 'g') m`);
    // 'system:bootstrap' is the audit actor of the bootstrap function (0039), not a permission.
    const known = new Set<string>([...PERMISSIONS, "system:bootstrap"]);
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.map((r) => r.p).filter((p) => !known.has(p)).sort()).toEqual([]);
  });

  it.each([
    ["candidate_marketing_status_check", CANDIDATE_STATUSES],
    ["submission_status_check", SUBMISSION_STATUSES],
    ["placement_status_check", PLACEMENT_STATUSES],
    ["checklist_item_status", CHECKLIST_ITEM_STATUSES],
  ] as const)("%s allows exactly the shared state machine's statuses", async (name, statuses) => {
    const { rows } = await db.admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [name]);
    expect(rows).toHaveLength(1);
    const allowed = [...rows[0]!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    expect(allowed.sort()).toEqual([...statuses].sort());
  });
});
