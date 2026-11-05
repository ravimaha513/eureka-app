import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";
import { seedPipeline, type PipelineSeed } from "./pipeline-seed.js";

/** Interview board search: part of the candidate's or the coach's name, within the caller's scope. */
let db: TestDb;
let app: NestFastifyApplication;
let seed: PipelineSeed;
let target: PipelineSeed["interviews"][number];
const SECRET = "test-secret-test-secret-test-secret-123";
const COORD = "00000000-0000-4000-8000-0000000000c1";

beforeAll(async () => {
  db = await createTestDb();
  const candidates = await seedFixtures(db.admin);
  seed = await seedPipeline(db, candidates);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET, GOOGLE_HOSTED_DOMAIN: "eureka.example",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
  target = seed.interviews.find((i) => i.recruiterId === U.r1a)!;
  // Shape the data directly (triggers off), as interview-reports does.
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(
      `UPDATE eureka.person SET first_name = 'Zelda', last_name = 'Quixote_100%'
        WHERE id = (SELECT person_id FROM eureka.candidate WHERE id = $1)`, [target.candidate.id]);
    await c.query(`UPDATE eureka.app_user SET display_name = 'Wanda Coachwell' WHERE id = $1`, [U.coach]);
    await c.query(`UPDATE eureka.interview SET coach_id = $1 WHERE id = $2`, [U.coach, target.id]);
    // An interview coordinator: interview:read at org scope, no candidate:read (0141, E-09).
    await c.query(`INSERT INTO eureka.app_user (id, email, display_name) VALUES ($1, 'coord@eureka.example', 'Coord')`, [COORD]);
    await c.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'interview_coordinator')`, [COORD]);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

async function search(key: keyof typeof U | "coord", term: string, param: "search" | "candidate" = "search") {
  const login = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  expect(login.statusCode).toBe(204);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const res = await app.inject({ method: "GET", url: "/api/v1/interviews", query: { [param]: term }, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().items as { id: string }[]).map((i) => i.id);
}

describe("interview search", () => {
  it("matches part of the candidate's name, ignoring case", async () => {
    expect(await search("r1a", "zelda qui")).toContain(target.id);
  });

  it("matches part of the coach's name", async () => {
    expect(await search("r1a", "coachwell")).toEqual([target.id]);
  });

  it("treats LIKE wildcards as literal text", async () => {
    expect(await search("r1a", "e_100%")).toContain(target.id);
    expect(await search("r1a", "x%z")).toEqual([]);
  });

  it("finds nothing outside the caller's scope", async () => {
    expect(await search("r2a", "zelda")).not.toContain(target.id);
    expect(await search("r2a", "coachwell")).not.toContain(target.id);
  });

  it("the candidate filter matches part of the name, inside the caller's scope only", async () => {
    expect(await search("r1a", "zelda qui", "candidate")).toEqual([target.id]);
    expect(await search("r1a", "e_100%", "candidate")).toEqual([target.id]);
    expect(await search("r2a", "zelda", "candidate")).toEqual([]);
  });

  it("an interview coordinator (no candidate read) finds interviews by candidate name (E-09, InitPlan set)", async () => {
    for (const param of ["search", "candidate"] as const) {
      expect(await search("coord", "zelda qui", param), param).toEqual([target.id]);
      expect(await search("coord", "ze", param), param).toContain(target.id); // short term: no trigram, same rows
      expect(await search("coord", "zzqx", param), param).toEqual([]);
    }
    expect(await search("coord", "coachwell")).toEqual([target.id]);
  });
});
