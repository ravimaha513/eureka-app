import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, TECH_ID, U, seedFixtures } from "./fixtures.js";
import { at, seedPipeline } from "./pipeline-seed.js";
import { createPlacement, newCandidate, selectedSubmission } from "./placement-seed.js";

/** Submissions, Interviews and Placements: `candidate` (name contains) and `batchId` (the candidate's batch). */
let db: TestDb;
let app: NestFastifyApplication;
let batchId: string;
const SECRET = "test-secret-test-secret-test-secret-123";

beforeAll(async () => {
  db = await createTestDb();
  // The seeded rows are the noise each filter has to exclude.
  await seedPipeline(db, await seedFixtures(db.admin));
  const cand = await newCandidate(db, { teamId: T.t1, recruiterId: U.r1a, locationId: LOC.dallas });
  await db.admin.query(`UPDATE eureka.person SET first_name = 'Zelda', last_name = 'Quorum'
    WHERE id = (SELECT person_id FROM eureka.candidate WHERE id = $1)`, [cand.id]);
  batchId = await asUser(db.app, U.locD, async (c) => (await c.query<{ id: string }>(
    `SELECT authz.create_batch($1, $2, '2030-01-01', 10) AS id`, [LOC.dallas, TECH_ID])).rows[0]!.id, true);
  await asUser(db.app, U.r1a, (c) => c.query(`UPDATE eureka.candidate SET batch_id = $1 WHERE id = $2`, [batchId, cand.id]), true);
  // One submission placed, another still open with an interview.
  await createPlacement(db, U.r1a, await selectedSubmission(db, U.r1a, cand.id));
  const open = await selectedSubmission(db, U.r1a, cand.id, "under_review");
  await asUser(db.app, U.r1a, (c) => c.query(
    `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at) VALUES ($1,'L2',$2,$3)`,
    [open, at(5000), at(5001)]), true);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

async function get(key: keyof typeof U, url: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  return app.inject({ method: "GET", url, headers: { cookie } });
}

const LISTS: [string, (row: never) => string | null][] = [
  ["/api/v1/submissions", (r: { candidateName: string | null }) => r.candidateName],
  ["/api/v1/interviews", (r: { candidate: { name: string | null } }) => r.candidate.name],
  ["/api/v1/placements", (r: { candidate: { name: string | null } }) => r.candidate.name],
] as never;

describe.each(LISTS)("%s", (path, nameOf) => {
  const names = async (key: keyof typeof U, qs: string) => {
    const res = await get(key, `${path}?${qs}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().items.map(nameOf) as (string | null)[];
  };

  it("finds a candidate by part of the name, ignoring case, spanning first and last", async () => {
    expect(new Set(await names("m1", "candidate=zelda%20quo"))).toEqual(new Set(["Zelda Quorum"]));
    expect(await names("m1", "candidate=zzz-none")).toEqual([]);
    expect(await names("m1", "candidate=%25")).toEqual([]); // % is literal
  });

  it("narrows to the candidate's batch", async () => {
    expect(new Set(await names("m1", `batchId=${batchId}`))).toEqual(new Set(["Zelda Quorum"]));
    expect(await names("m1", "batchId=00000000-0000-4000-8000-000000000001")).toEqual([]);
  });

  it("stays inside the caller's scope", async () => {
    expect(await names("r2a", "candidate=zelda")).toEqual([]);
    expect(await names("r2a", `batchId=${batchId}`)).toEqual([]);
  });

  it("rejects a malformed batch id and a blank name", async () => {
    expect((await get("m1", `${path}?batchId=nope`)).statusCode).toBe(422);
    expect((await get("m1", `${path}?candidate=%20`)).statusCode).toBe(422);
  });
});

describe("submission summary", () => {
  it("counts the same filtered set", async () => {
    const byName = await get("m1", "/api/v1/submissions/summary?candidate=zelda");
    expect(byName.statusCode, byName.body).toBe(200);
    expect(byName.json().total).toBe(2);
    expect((await get("m1", `/api/v1/submissions/summary?batchId=${batchId}`)).json().total).toBe(2);
  });
});
