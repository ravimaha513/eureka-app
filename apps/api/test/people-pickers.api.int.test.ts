import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

/**
 * People pickers follow the reporting structure for sales roles (team/hierarchy
 * grants): interview panel, job hiring manager, DataHub members, My team addable.
 * Org and location grants keep the unscoped lists.
 */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";
// Active recruiters in no team: one reporting to l1, one to l3, one with no manager yet.
const NEW_L1 = "00000000-0000-0000-0000-0000000bc101";
const NEW_L3 = "00000000-0000-0000-0000-0000000bc102";
const NEW_NONE = "00000000-0000-0000-0000-0000000bc103";

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
  for (const [id, key, manager] of [[NEW_L1, "newl1", U.l1], [NEW_L3, "newl3", U.l3], [NEW_NONE, "newnone", null]] as const) {
    await db.admin.query(`INSERT INTO eureka.app_user (id, email, display_name) VALUES ($1, $2, $3)`, [id, `${key}@eureka.example`, key]);
    await db.admin.query(`INSERT INTO eureka.user_role (user_id, role_key) VALUES ($1, 'recruiter')`, [id]);
    if (manager) await db.admin.query(`INSERT INTO eureka.reporting_line (user_id, manager_id) VALUES ($1, $2)`, [id, manager]);
  }
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET,
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Key = keyof typeof U;
const cookies = new Map<string, string>();
async function get(key: Key, url: string) {
  let cookie = cookies.get(key);
  if (!cookie) {
    const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
    expect(res.statusCode).toBe(204);
    cookie = String(res.headers["set-cookie"]).split(";")[0]!;
    cookies.set(key, cookie);
  }
  const res = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(res.statusCode, `${key} ${url}: ${res.body}`).toBe(200);
  return res.json();
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("interview panel picker", () => {
  const panel = async (key: Key) => ids((await get(key, "/api/v1/interviews/panel-options")).items);

  it("a lead sees their team and all non-sales staff, not other teams", async () => {
    const p = await panel("l1");
    expect(p).toEqual(expect.arrayContaining([U.l1, U.r1a, U.r1b, U.coach, U.hr, U.locA]));
    for (const id of [U.r2a, U.l2, U.r3a, U.m1, U.ad, U.ceo]) expect(p).not.toContain(id);
  });

  it("a manager sees their reporting subtree, not a sibling manager's", async () => {
    const p = await panel("m1");
    expect(p).toEqual(expect.arrayContaining([U.m1, U.l1, U.l2, U.r1a, U.r2a, U.coach]));
    for (const id of [U.m2, U.l3, U.r3a, U.ad]) expect(p).not.toContain(id);
  });

  it("an associate director sees the whole subtree below them", async () => {
    expect(await panel("ad")).toEqual(expect.arrayContaining([U.m1, U.m2, U.l3, U.r3a, U.coach]));
  });

  it("a recruiter sees themself and non-sales staff only", async () => {
    const p = await panel("r1a");
    expect(p).toEqual(expect.arrayContaining([U.r1a, U.coach]));
    for (const id of [U.r1b, U.l1]) expect(p).not.toContain(id);
  });
});

describe("job hiring-manager picker", () => {
  const staff = async (key: Key) => ids((await get(key, "/api/v1/jobs/options")).staff);

  it("a lead sees their team and their reporting chain up", async () => {
    const s = await staff("l1");
    expect(s).toEqual(expect.arrayContaining([U.l1, U.r1a, U.r1b, U.m1, U.ad, U.ceo]));
    for (const id of [U.l2, U.r2a, U.m2, U.r3a, U.coach, U.hr]) expect(s).not.toContain(id);
  });

  it("a manager sees their subtree and chain up, not a sibling's subtree", async () => {
    const s = await staff("m1");
    expect(s).toEqual(expect.arrayContaining([U.m1, U.l2, U.r2a, U.ad, U.ceo]));
    for (const id of [U.m2, U.l3, U.r3a]) expect(s).not.toContain(id);
  });

  it("an org grant (HR) still sees every active user", async () => {
    expect(await staff("hr")).toEqual(expect.arrayContaining([U.r3a, U.l1, U.coach, U.admin]));
  });
});

describe("DataHub people picker", () => {
  const people = async (key: Key) => ids((await get(key, "/api/v1/datahub/people?limit=50")).items);

  it("a lead sees their team only", async () => {
    const p = await people("l1");
    expect(p).toEqual(expect.arrayContaining([U.l1, U.r1a, U.r1b]));
    for (const id of [U.r2a, U.l2, U.m1, U.coach, U.hr]) expect(p).not.toContain(id);
  });

  it("a manager sees their reporting subtree", async () => {
    const p = await people("m1");
    expect(p).toEqual(expect.arrayContaining([U.m1, U.l2, U.r2a]));
    for (const id of [U.r3a, U.m2, U.ad]) expect(p).not.toContain(id);
  });

  it("datahub:manage holders and org-scope creators are unchanged", async () => {
    expect(await people("hr")).toEqual(expect.arrayContaining([U.r3a, U.coach]));
    expect(await people("ceo")).toEqual(expect.arrayContaining([U.r3a, U.coach]));
  });
});

describe("My team addable recruiters", () => {
  const addable = async (key: Key) => ids((await get(key, "/api/v1/teams/mine")).addable);

  it("a lead sees recruiters reporting to them and those with no manager yet", async () => {
    const a = await addable("l1");
    expect(a).toEqual(expect.arrayContaining([NEW_L1, NEW_NONE]));
    expect(a).not.toContain(NEW_L3);
  });

  it("a manager sees recruiters in their reporting line, not a sibling's", async () => {
    const a = await addable("m2");
    expect(a).toEqual(expect.arrayContaining([NEW_L3, NEW_NONE]));
    expect(a).not.toContain(NEW_L1);
  });

  it("an associate director sees all of them", async () => {
    expect(await addable("ad")).toEqual(expect.arrayContaining([NEW_L1, NEW_L3, NEW_NONE]));
  });
});
