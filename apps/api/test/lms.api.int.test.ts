import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { U, seedFixtures } from "./fixtures.js";

/** API checks for docs/lms-api.md. */
let db: TestDb;
let app: NestFastifyApplication;
const SECRET = "test-secret-test-secret-test-secret-123";
const sessions = new Map<string, { cookie: string; csrf: string }>();

beforeAll(async () => {
  db = await createTestDb();
  await seedFixtures(db.admin);
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
async function login(key: Key) {
  const cached = sessions.get(key);
  if (cached) return cached;
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  const s = { cookie, csrf: me.json().csrfToken as string };
  sessions.set(key, s);
  return s;
}
async function call(key: Key, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const s = await login(key);
  return app.inject({ method, url: `/api/v1/lms${url}`, payload: payload as never, headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers } });
}
const audits = async (action: string) => (await db.admin.query(`SELECT actor_id, entity_id, changes FROM eureka.audit_event WHERE action = $1 ORDER BY seq`, [action])).rows;

const mods = [{ title: "Intro", durationMinutes: 60 }, { title: "Deep dive", durationMinutes: 180 }];
let course: any;
let batch: any;

describe("permission matrix", () => {
  const staff: Key[] = ["hr", "coach"];
  const others = Object.keys(U).filter((k) => !staff.includes(k as Key)) as Key[];
  it.each(staff)("%s can use staff endpoints", async (k) => {
    expect((await call(k, "GET", "/courses")).statusCode).toBe(200);
    expect((await call(k, "GET", "/batches")).statusCode).toBe(200);
    expect((await call(k, "GET", "/students/lookup")).statusCode).toBe(200);
  });
  it.each(others)("%s is refused on staff endpoints (403)", async (k) => {
    for (const url of ["/courses", "/batches", "/students/lookup"]) expect((await call(k, "GET", url)).statusCode).toBe(403);
    expect((await call(k, "POST", "/courses", { title: "x" })).statusCode).toBe(403);
    expect((await call(k, "POST", "/batches", { name: "x", startDate: "2026-01-01", endDate: "2026-02-01" })).statusCode).toBe(403);
  });
  it("org_admin cannot use the learner endpoints either (no lms:learn)", async () => {
    expect((await call("admin", "GET", "/me/trainings")).statusCode).toBe(403);
  });
  it("staff mutations need a CSRF token", async () => {
    const s = await login("hr");
    const res = await app.inject({ method: "POST", url: "/api/v1/lms/courses", payload: { title: "x" }, headers: { cookie: s.cookie } });
    expect(res.statusCode).toBe(403);
  });
});

describe("courses", () => {
  it("create, modules, If-Match patch", async () => {
    const created = await call("hr", "POST", "/courses", { title: "  Java  ", description: "Core" });
    expect(created.statusCode).toBe(201);
    course = created.json();
    expect(course).toMatchObject({ title: "Java", description: "Core", moduleCount: 0, version: 1, archivedAt: null, modules: [] });

    const put = await call("hr", "PUT", `/courses/${course.id}/modules`, { modules: mods });
    expect(put.statusCode).toBe(200);
    course = put.json();
    expect(course.modules.map((m: any) => [m.position, m.title, m.durationMinutes])).toEqual([[1, "Intro", 60], [2, "Deep dive", 180]]);
    expect([course.moduleCount, course.totalMinutes]).toEqual([2, 240]);

    expect((await call("hr", "PATCH", `/courses/${course.id}`, { title: "Java 2" })).statusCode).toBe(428);
    const stale = await call("hr", "PATCH", `/courses/${course.id}`, { title: "Java 2" }, { "if-match": '"1"' });
    expect(stale.statusCode).toBe(412);
    const ok = await call("hr", "PATCH", `/courses/${course.id}`, { title: "Java 2" }, { "if-match": `"${course.version}"` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ title: "Java 2", version: course.version + 1 });
    course = ok.json();
  });

  it("validation and unknown ids", async () => {
    expect((await call("hr", "POST", "/courses", { title: "" })).statusCode).toBe(422);
    expect((await call("hr", "POST", "/courses", { title: "x", extra: 1 })).statusCode).toBe(422);
    expect((await call("hr", "PUT", `/courses/${course.id}/modules`, { modules: [{ title: "x", durationMinutes: 9999 }] })).statusCode).toBe(422);
    const foreign = await call("hr", "PUT", `/courses/${course.id}/modules`, { modules: [{ id: "00000000-0000-0000-0000-0000000000aa", title: "x", durationMinutes: 1 }] });
    expect([foreign.statusCode, foreign.json().detail]).toEqual([422, "invalid_module"]);
    expect((await call("hr", "GET", "/courses/00000000-0000-0000-0000-0000000000aa")).statusCode).toBe(404);
    expect((await call("hr", "GET", "/courses/not-a-uuid")).statusCode).toBe(400);
  });

  it("list: search, archived filter, version present", async () => {
    const l = await call("hr", "GET", "/courses?q=java");
    expect(l.json().items.map((c: any) => c.id)).toEqual([course.id]);
    expect(l.json().items[0].version).toBe(course.version);
    const arch = await call("coach", "POST", "/courses", { title: "Old" });
    await call("coach", "PATCH", `/courses/${arch.json().id}`, { archived: true }, { "if-match": "1" });
    expect((await call("hr", "GET", "/courses")).json().items.map((c: any) => c.title)).not.toContain("Old");
    expect((await call("hr", "GET", "/courses?archived=true")).json().items.map((c: any) => c.title)).toEqual(["Old"]);
  });
});

describe("batches, students and progress", () => {
  it("create, assign courses, enroll", async () => {
    const created = await call("hr", "POST", "/batches", { name: "Batch 2026", startDate: "2026-01-05", endDate: "2026-03-30" });
    expect(created.statusCode).toBe(201);
    batch = created.json();
    expect(batch).toMatchObject({ name: "Batch 2026", year: 2026, status: "completed", studentCount: 0, courseCount: 0, courses: [] });
    expect((await call("hr", "POST", "/batches", { name: "bad", startDate: "2026-03-01", endDate: "2026-01-01" })).statusCode).toBe(422);

    const assigned = await call("hr", "PUT", `/batches/${batch.id}/courses`, { courseIds: [course.id] });
    expect(assigned.json().courses).toMatchObject([{ id: course.id, moduleCount: 2, totalMinutes: 240 }]);
    expect((await call("hr", "PUT", `/batches/${batch.id}/courses`, { courseIds: ["00000000-0000-0000-0000-0000000000aa"] })).json().detail).toBe("course_not_found");

    const look = await call("hr", "GET", "/students/lookup?q=r1a");
    expect(look.json().items).toEqual([{ userId: U.r1a, name: expect.any(String), email: "r1a@eureka.example" }]);
    const add = await call("hr", "POST", `/batches/${batch.id}/students`, { userIds: [U.r1a, U.r1b] });
    expect([add.statusCode, add.json()]).toEqual([200, { added: 2 }]);
    expect((await call("hr", "POST", `/batches/${batch.id}/students`, { userIds: [U.r1a] })).json()).toEqual({ added: 0 });
    const bad = await call("hr", "POST", `/batches/${batch.id}/students`, { userIds: ["00000000-0000-0000-0000-0000000000aa"] });
    expect([bad.statusCode, bad.json().detail]).toEqual([422, "student_not_found"]);
    expect((await audits("lms.students.added"))[0]!.changes).toEqual({ requested: 2, added: 2 });
  });

  it("learner sees only own training, updates own progress; derived percentages", async () => {
    const list = await call("r1a", "GET", "/me/trainings");
    expect(list.json().items).toMatchObject([{ batchId: batch.id, name: "Batch 2026", percent: 0, courseCount: 1 }]);
    expect((await call("r2a", "GET", "/me/trainings")).json().items).toEqual([]);
    expect((await call("r2a", "GET", `/me/trainings/${batch.id}`)).statusCode).toBe(404);
    expect((await call("r2a", "PUT", `/me/trainings/${batch.id}/progress/${course.modules[0].id}`, { percent: 10 })).statusCode).toBe(404);

    const m0 = course.modules[0].id; const m1 = course.modules[1].id;
    const done = await call("r1a", "PUT", `/me/trainings/${batch.id}/progress/${m0}`, { percent: 100 });
    expect(done.json()).toMatchObject({ batchId: batch.id, moduleId: m0, percent: 100, completedAt: expect.any(String) });
    const detail = (await call("r1a", "GET", `/me/trainings/${batch.id}`)).json();
    expect(detail.percent).toBe(25); // 60 of 240 minutes
    expect(detail.courses[0]).toMatchObject({ percent: 25 });
    expect(detail.courses[0].modules.map((m: any) => [m.percent, m.completedAt !== null])).toEqual([[100, true], [0, false]]);
    expect((await call("r1a", "PUT", `/me/trainings/${batch.id}/progress/${m0}`, { percent: 40 })).json().completedAt).toBeNull();
    expect((await call("r1a", "PUT", `/me/trainings/${batch.id}/progress/${m1}`, { percent: 101 })).statusCode).toBe(422);
    expect((await call("r1a", "PUT", `/me/trainings/${batch.id}/progress/${m1}`, { percent: 50, userId: U.r1b })).statusCode).toBe(422);
    const foreignModule = (await call("hr", "POST", "/courses", { title: "Elsewhere" })).json();
    const fm = (await call("hr", "PUT", `/courses/${foreignModule.id}/modules`, { modules: [{ title: "m", durationMinutes: 5 }] })).json().modules[0].id;
    const notIn = await call("r1a", "PUT", `/me/trainings/${batch.id}/progress/${fm}`, { percent: 5 });
    expect([notIn.statusCode, notIn.json().detail]).toEqual([422, "course_not_in_batch"]);
    expect((await audits("lms.progress.self"))[0]).toMatchObject({ actor_id: U.r1a, entity_id: batch.id });
  });

  it("staff sees every student's progress per course and module, others' never leak to learners", async () => {
    await call("hr", "PUT", `/batches/${batch.id}/students/${U.r1b}/progress/${course.modules[1].id}`, { percent: 50 });
    const s = (await call("hr", "GET", `/batches/${batch.id}/students`)).json();
    expect(s.nextCursor).toBeNull();
    const byId = Object.fromEntries(s.items.map((i: any) => [i.userId, i]));
    expect(byId[U.r1a]).toMatchObject({ email: "r1a@eureka.example", percent: 10 }); // 40% of 60 / 240
    expect(byId[U.r1b].percent).toBe(38); // 50% of 180 / 240 = 37.5
    expect(byId[U.r1b].courses[0].modules.map((m: any) => m.percent)).toEqual([0, 50]);
    expect((await call("hr", "GET", `/batches/${batch.id}/students?q=r1b`)).json().items).toHaveLength(1);
    const page = (await call("hr", "GET", `/batches/${batch.id}/students?limit=1`)).json();
    expect(page.items).toHaveLength(1);
    expect((await call("hr", "GET", `/batches/${batch.id}/students?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`)).json().items).toHaveLength(1);
    expect((await call("r1a", "GET", `/batches/${batch.id}/students`)).statusCode).toBe(403);
    const mine = JSON.stringify((await call("r1a", "GET", `/me/trainings/${batch.id}`)).json());
    expect(mine).not.toContain(U.r1b);
    expect((await audits("lms.progress.set"))[0]!.changes).toEqual({ userId: U.r1b, moduleId: course.modules[1].id, percent: 50 });
  });

  it("list filters, status, delete refused with progress (409), remove student, archive", async () => {
    const l = await call("hr", "GET", "/batches?status=completed");
    expect(l.json().items.map((b: any) => b.id)).toContain(batch.id);
    expect((await call("hr", "GET", "/batches?status=in_progress")).json().items.map((b: any) => b.id)).not.toContain(batch.id);
    expect((await call("hr", "GET", "/batches?q=zzz")).json().items).toEqual([]);
    const del = await call("hr", "DELETE", `/batches/${batch.id}`);
    expect([del.statusCode, del.json().detail]).toEqual([409, "batch_has_progress"]);
    const rc = await call("hr", "PUT", `/batches/${batch.id}/courses`, { courseIds: [] });
    expect([rc.statusCode, rc.json().detail]).toEqual([409, "course_has_progress"]);
    expect((await call("hr", "DELETE", `/batches/${batch.id}/students/${U.r1b}`)).statusCode).toBe(204);
    expect((await call("hr", "DELETE", `/batches/${batch.id}/students/${U.r1b}`)).statusCode).toBe(404);
    const patched = await call("hr", "PATCH", `/batches/${batch.id}`, { name: "Renamed", archived: true });
    expect(patched.json()).toMatchObject({ name: "Renamed" });
    expect(patched.json().archivedAt).not.toBeNull();
    expect((await call("hr", "GET", "/batches")).json().items.map((b: any) => b.id)).not.toContain(batch.id);
    expect((await call("r1a", "GET", "/me/trainings")).json().items).toEqual([]); // archived batches are hidden from learners
    expect((await call("r1a", "GET", `/me/trainings/${batch.id}`)).statusCode).toBe(404);
  });

  it("an empty batch can be deleted (204) and the audit rows hold ids and counts only", async () => {
    const b = (await call("coach", "POST", "/batches", { name: "Temp", startDate: "2099-01-01", endDate: "2099-02-01" })).json();
    expect(b.status).toBe("not_started");
    expect((await call("coach", "DELETE", `/batches/${b.id}`)).statusCode).toBe(204);
    expect((await call("coach", "GET", `/batches/${b.id}`)).statusCode).toBe(404);
    const all = (await db.admin.query(`SELECT changes::text AS c FROM eureka.audit_event WHERE action LIKE 'lms.%'`)).rows.map((r) => r.c).join(" ");
    expect(all).not.toMatch(/Java|Batch 2026|Renamed|@eureka/);
  });
});
