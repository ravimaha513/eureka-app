import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, type Permission } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { createTestDb, type TestDb } from "./db-harness.js";
import { LOC, T, TECH_ID, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";

/** API contract of docs/training-api.md (migration 0065). */
let db: TestDb;
let app: NestFastifyApplication;
let candidates: FixtureCandidate[];
const users = Object.keys(U) as (keyof typeof U)[];
const ZERO = "00000000-0000-4000-8000-000000000000";

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

type Session = { cookie: string; csrf: string };
const sessions = new Map<string, Session>();
async function login(key: keyof typeof U): Promise<Session> {
  const cached = sessions.get(key);
  if (cached) return cached;
  const res = await app.inject({ method: "POST", url: "/api/auth/dev-login", payload: { email: `${key}@eureka.example` } });
  expect(res.statusCode).toBe(204);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
  const s = { cookie, csrf: me.json().csrfToken as string };
  sessions.set(key, s);
  return s;
}
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
async function call(key: keyof typeof U, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers },
  });
}

describe("authorization matrix (route permission)", () => {
  const endpoints: { name: string; perm: Permission; method: Method; url: string; body?: unknown }[] = [
    { name: "GET /training/batches", perm: "training:read", method: "GET", url: "/api/v1/training/batches" },
    { name: "GET /training/courses", perm: "training:read", method: "GET", url: "/api/v1/training/courses" },
    { name: "GET /training/batches/:id", perm: "training:read", method: "GET", url: `/api/v1/training/batches/${ZERO}` },
    { name: "POST /training/batches", perm: "training:manage", method: "POST", url: "/api/v1/training/batches", body: {} },
    { name: "POST /training/courses", perm: "training:manage", method: "POST", url: "/api/v1/training/courses", body: {} },
    { name: "GET /training/trainers", perm: "training:manage", method: "GET", url: "/api/v1/training/trainers" },
    { name: "PUT progress", perm: "training.progress:update", method: "PUT", url: `/api/v1/training/batches/${ZERO}/students/${ZERO}/modules/${ZERO}`, body: { completed: true } },
    { name: "GET /candidates/:id/training", perm: "training:read", method: "GET", url: `/api/v1/candidates/${ZERO}/training` },
  ];
  it.each(users.flatMap((u) => endpoints.map((e) => [u, e.name, e] as const)))("%s → %s", async (key, _n, e) => {
    const res = await call(key, e.method, e.url, e.body);
    if (can(toUserAccess(key), e.perm)) expect(res.statusCode, res.body).not.toBe(403);
    else expect(res.statusCode, res.body).toBe(403);
  });
});

describe("course library (TR-4)", () => {
  let courseId: string;
  it("a location manager creates a course with modules; validation is strict", async () => {
    const bad = [
      { title: "X", modules: [{ title: "M", durationMinutes: 10, resources: ["http://example.com"] }] },
      { title: "X", modules: [{ title: "M", durationMinutes: 0 }] },
      { title: "X", createdBy: U.l1 },
      { title: "" },
      { title: "X", coverColor: "#ff0000" },
    ];
    for (const b of bad) expect((await call("locD", "POST", "/api/v1/training/courses", b)).statusCode, JSON.stringify(b)).toBe(422);
    expect((await call("locD", "POST", "/api/v1/training/courses", { title: "X", locationId: LOC.austin })).json().detail).toBe("location_not_in_scope");
    const r = await call("locD", "POST", "/api/v1/training/courses", {
      title: "Secret Course Title", description: "Fictional description", coverColor: "teal", coverIcon: "code",
      modules: [{ title: "Intro", durationMinutes: 60, resources: ["https://example.com/intro"] }, { title: "Deep dive", durationMinutes: 180 }],
    });
    expect(r.statusCode, r.body).toBe(201);
    courseId = r.json().id;
    const detail = (await call("r1a", "GET", `/api/v1/training/courses/${courseId}`)).json();
    expect(detail).toMatchObject({ title: "Secret Course Title", totalMinutes: 240, canEdit: false, location: { id: LOC.dallas, name: "Dallas" },
      cover: { color: "teal", icon: "code" } });
    expect(detail.modules.map((m: { title: string; position: number }) => [m.title, m.position])).toEqual([["Intro", 1], ["Deep dive", 2]]);
    const list = (await call("locD", "GET", "/api/v1/training/courses")).json();
    expect(list.canCreate).toBe(true);
    expect(list.items.find((c: { id: string }) => c.id === courseId)).toMatchObject({ modules: 2, totalMinutes: 240, canEdit: true, batches: 0 });
  });

  it("edits need If-Match (428), refuse stale versions (412) and other locations' managers (403)", async () => {
    expect((await call("locD", "PATCH", `/api/v1/training/courses/${courseId}`, { title: "New" })).statusCode).toBe(428);
    expect((await call("locD", "PATCH", `/api/v1/training/courses/${courseId}`, { title: "New" }, { "if-match": '"9"' })).statusCode).toBe(412);
    expect((await call("locA", "PATCH", `/api/v1/training/courses/${courseId}`, { title: "New" }, { "if-match": '"1"' })).statusCode).toBe(403);
    const ok = await call("locD", "PATCH", `/api/v1/training/courses/${courseId}`, { title: "Secret Course Title 2" }, { "if-match": '"1"' });
    expect([ok.statusCode, ok.json().rowVersion]).toEqual([200, 2]);
  });

  it("modules: add, edit with If-Match, reorder as a permutation", async () => {
    const add = await call("locD", "POST", `/api/v1/training/courses/${courseId}/modules`, { title: "Wrap-up", durationMinutes: 30 });
    expect([add.statusCode, add.json().position]).toEqual([201, 3]);
    const mods = (await call("locD", "GET", `/api/v1/training/courses/${courseId}`)).json().modules as { id: string; rowVersion: number }[];
    expect((await call("locD", "PATCH", `/api/v1/training/courses/${courseId}/modules/${mods[2]!.id}`, { durationMinutes: 45 }, { "if-match": "1" })).statusCode).toBe(200);
    expect((await call("locD", "PUT", `/api/v1/training/courses/${courseId}/modules/order`, { moduleIds: [mods[0]!.id] })).json().detail).toBe("invalid_order");
    const order = [mods[2]!.id, mods[0]!.id, mods[1]!.id];
    expect((await call("locD", "PUT", `/api/v1/training/courses/${courseId}/modules/order`, { moduleIds: order })).statusCode).toBe(200);
    const after = (await call("locD", "GET", `/api/v1/training/courses/${courseId}`)).json();
    expect(after.modules.map((m: { id: string }) => m.id)).toEqual(order);
    expect(after.totalMinutes).toBe(285);
  });
});

describe("training batches, students and progress (TR-5..TR-11)", () => {
  let batchId: string; let courseId: string; let modules: string[]; let rowVersion: number;
  let s1: FixtureCandidate; let s2: FixtureCandidate;

  beforeAll(async () => {
    s1 = candidates.find((c) => c.recruiterId === U.r1a && c.locationId === LOC.dallas)!;
    s2 = candidates.find((c) => c.teamId === T.t2 && c.locationId === LOC.dallas)!;
    const c = await call("locD", "POST", "/api/v1/training/courses", {
      title: "Dotnet Core", modules: [{ title: "C# basics", durationMinutes: 60 }, { title: "ASP.NET", durationMinutes: 180 }],
    });
    courseId = c.json().id;
    modules = (await call("locD", "GET", `/api/v1/training/courses/${courseId}`)).json().modules.map((m: { id: string }) => m.id);
  });

  it("creates a batch with a name, trainer and dates; refuses bad input", async () => {
    const base = { locationId: LOC.dallas, technologyId: TECH_ID, startDate: "2032-09-30" };
    expect((await call("locD", "POST", "/api/v1/training/batches", { ...base, endDate: "2032-09-01" })).statusCode).toBe(422);
    expect((await call("locD", "POST", "/api/v1/training/batches", { ...base, status: "completed" })).statusCode).toBe(422);
    expect((await call("locD", "POST", "/api/v1/training/batches", { ...base, trainerId: U.r1a })).json().detail).toBe("invalid_trainer");
    expect((await call("locD", "POST", "/api/v1/training/batches", { ...base, locationId: LOC.austin })).json().detail).toBe("location_not_in_scope");
    const r = await call("locD", "POST", "/api/v1/training/batches", { ...base, endDate: "2033-06-30", name: "Secret Batch Name", trainerId: U.coach, coverColor: "violet" });
    expect(r.statusCode, r.body).toBe(201);
    batchId = r.json().id;
    expect((await call("locD", "POST", "/api/v1/training/batches", base)).json().detail).toBe("batch_exists");
    const card = (await call("locD", "GET", "/api/v1/training/batches")).json().items.find((b: { id: string }) => b.id === batchId);
    expect(card).toMatchObject({
      name: "Secret Batch Name", status: "planned", trainer: { id: U.coach, name: "coach" }, students: 0, courses: 0,
      startDate: "2032-09-30", endDate: "2033-06-30", batchYear: 2032, cover: { color: "violet", icon: "users" },
      actions: { manage: true, delete: true, updateProgress: true },
    });
    rowVersion = card.rowVersion;
  });

  it("who sees the batch: managers of its location and its trainer; Sales only once they own a student", async () => {
    const ids = async (k: keyof typeof U) => (await call(k, "GET", "/api/v1/training/batches")).json().items.map((b: { id: string }) => b.id);
    expect(await ids("coach")).toContain(batchId);
    expect(await ids("ceo")).toContain(batchId);
    expect(await ids("locA")).not.toContain(batchId);
    expect(await ids("r1a")).not.toContain(batchId);
    expect((await call("locA", "GET", `/api/v1/training/batches/${batchId}`)).statusCode).toBe(404);
    const coachCard = (await call("coach", "GET", `/api/v1/training/batches/${batchId}`)).json();
    expect(coachCard.actions).toEqual({ manage: false, delete: false, updateProgress: true });
  });

  it("PATCH needs If-Match and a manager; a derived name appears when the name is cleared", async () => {
    expect((await call("locD", "PATCH", `/api/v1/training/batches/${batchId}`, { name: null })).statusCode).toBe(428);
    expect((await call("coach", "PATCH", `/api/v1/training/batches/${batchId}`, { name: null }, { "if-match": String(rowVersion) })).statusCode).toBe(403);
    expect((await call("locD", "PATCH", `/api/v1/training/batches/${batchId}`, { name: null }, { "if-match": "99" })).statusCode).toBe(412);
    const ok = await call("locD", "PATCH", `/api/v1/training/batches/${batchId}`, { name: null }, { "if-match": String(rowVersion) });
    expect(ok.statusCode, ok.body).toBe(200);
    const b = (await call("locD", "GET", `/api/v1/training/batches/${batchId}`)).json();
    expect([b.name, b.customName, b.trainer?.id, b.endDate]).toEqual(["Java Sep 2032", null, U.coach, "2033-06-30"]);
    await call("locD", "PATCH", `/api/v1/training/batches/${batchId}`, { name: "Secret Batch Name" }, { "if-match": String(b.rowVersion) });
  });

  it("assigns courses (manager only) and shows them with modules", async () => {
    expect((await call("coach", "POST", `/api/v1/training/batches/${batchId}/courses`, { courseId })).statusCode).toBe(403);
    expect((await call("locD", "POST", `/api/v1/training/batches/${batchId}/courses`, { courseId: ZERO })).json().detail).toBe("invalid_course");
    expect((await call("locD", "POST", `/api/v1/training/batches/${batchId}/courses`, { courseId })).statusCode).toBe(201);
    expect((await call("locD", "POST", `/api/v1/training/batches/${batchId}/courses`, { courseId })).json().detail).toBe("course_already_assigned");
    const d = (await call("coach", "GET", `/api/v1/training/batches/${batchId}`)).json();
    expect(d.courses).toBe(1);
    expect(d.assignedCourses).toEqual([expect.objectContaining({ id: courseId, title: "Dotnet Core", totalMinutes: 240,
      modules: [expect.objectContaining({ title: "C# basics", durationMinutes: 60 }), expect.objectContaining({ title: "ASP.NET", durationMinutes: 180 })] })]);
  });

  it("adds students of the batch location; the eligible list leaves members out", async () => {
    const eligible = (await call("locD", "GET", `/api/v1/training/batches/${batchId}/eligible-students?search=Cand`)).json().items;
    expect(eligible.length).toBeGreaterThan(0);
    expect(eligible.every((e: { candidateId: string }) => candidates.find((c) => c.id === e.candidateId)?.locationId === LOC.dallas)).toBe(true);
    expect((await call("coach", "GET", `/api/v1/training/batches/${batchId}/eligible-students`)).statusCode).toBe(403);
    const austin = candidates.find((c) => c.locationId === LOC.austin)!;
    expect((await call("locD", "POST", `/api/v1/training/batches/${batchId}/students`, { candidateId: austin.id })).json().detail).toBe("candidate_not_eligible");
    for (const s of [s1, s2]) expect((await call("locD", "POST", `/api/v1/training/batches/${batchId}/students`, { candidateId: s.id })).statusCode).toBe(201);
    const again = (await call("locD", "GET", `/api/v1/training/batches/${batchId}/eligible-students`)).json().items.map((e: { candidateId: string }) => e.candidateId);
    expect(again).not.toContain(s1.id);
    const card = (await call("locD", "GET", `/api/v1/training/batches/${batchId}`)).json();
    expect([card.students, card.actions.delete]).toEqual([2, false]);
  });

  it("the trainer marks modules; progress is weighted by duration (TR-9)", async () => {
    const url = (s: string, m: string) => `/api/v1/training/batches/${batchId}/students/${s}/modules/${m}`;
    const r = await call("coach", "PUT", url(s1.id, modules[0]!), { completed: true });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ completed: true, completedBy: { id: U.coach, name: "coach" } });
    expect((await call("locA", "PUT", url(s1.id, modules[0]!), { completed: true })).statusCode).toBe(404);
    expect((await call("coach", "PUT", url(s1.id, ZERO), { completed: true })).json().detail).toBe("module_not_in_batch");
    expect((await call("coach", "PUT", url(s1.id, modules[0]!), { completed: "yes" })).statusCode).toBe(422);
    await call("locD", "PUT", url(s2.id, modules[1]!), { completed: true });
    const list = (await call("coach", "GET", `/api/v1/training/batches/${batchId}/students`)).json().items;
    const p1 = list.find((s: { candidateId: string }) => s.candidateId === s1.id);
    const p2 = list.find((s: { candidateId: string }) => s.candidateId === s2.id);
    expect([p1.percent, p1.completedMinutes, p1.totalMinutes, p2.percent]).toEqual([25, 60, 240, 75]);
    expect(p1.courses).toEqual([{ courseId, percent: 25, completedModules: 1, totalModules: 2 }]);
    expect(p1.completions).toEqual([expect.objectContaining({ moduleId: modules[0], completedBy: { id: U.coach, name: "coach" } })]);
    // Search narrows the list.
    const name = p1.name as string;
    expect((await call("coach", "GET", `/api/v1/training/batches/${batchId}/students?search=${encodeURIComponent(name)}`)).json().items.length).toBe(1);
  });

  it("Sales read only their own students' progress, on the screen and on the profile card (TR-3, TR-11)", async () => {
    const card = (await call("r1a", "GET", "/api/v1/training/batches")).json().items.find((b: { id: string }) => b.id === batchId);
    expect(card).toMatchObject({ students: 1, actions: { manage: false, delete: false, updateProgress: false } });
    const students = (await call("r1a", "GET", `/api/v1/training/batches/${batchId}/students`)).json().items;
    expect(students.map((s: { candidateId: string }) => s.candidateId)).toEqual([s1.id]);
    const t = (await call("r1a", "GET", `/api/v1/candidates/${s1.id}/training`)).json();
    expect(t).toMatchObject({ batch: { id: batchId, name: "Secret Batch Name", status: "planned" }, percent: 25,
      courses: [{ id: courseId, title: "Dotnet Core", percent: 25, completedModules: 1, totalModules: 2 }] });
    // r1a cannot read s2 at all (another team): 404; r3a has no student here.
    expect((await call("r1a", "GET", `/api/v1/candidates/${s2.id}/training`)).statusCode).toBe(404);
    expect((await call("r3a", "GET", "/api/v1/training/batches")).json().items.map((b: { id: string }) => b.id)).not.toContain(batchId);
    // The coach reads s2's card (coached team) and the trainer covers the batch.
    expect((await call("coach", "GET", `/api/v1/candidates/${s2.id}/training`)).json().percent).toBe(75);
  });

  it("status changes and deletion: manager only, no delete with students (409), cancel instead", async () => {
    expect((await call("coach", "PUT", `/api/v1/training/batches/${batchId}/status`, { to: "in_training" })).statusCode).toBe(403);
    expect((await call("locD", "PUT", `/api/v1/training/batches/${batchId}/status`, { to: "completed" })).json().detail).toBe("invalid_transition");
    expect((await call("locD", "PUT", `/api/v1/training/batches/${batchId}/status`, { to: "in_training" })).statusCode).toBe(200);
    expect((await call("locD", "DELETE", `/api/v1/training/batches/${batchId}`)).json().detail).toBe("batch_has_students");
    expect((await call("locD", "DELETE", `/api/v1/training/courses/${courseId}`)).json().detail).toBe("course_in_use");
    expect((await call("locD", "DELETE", `/api/v1/training/courses/${courseId}/modules/${modules[0]}`)).json().detail).toBe("module_in_use");
    expect((await call("locD", "PUT", `/api/v1/training/batches/${batchId}/status`, { to: "cancelled" })).statusCode).toBe(200);
    // Closed: no more progress.
    const closed = await call("coach", "PUT", `/api/v1/training/batches/${batchId}/students/${s1.id}/modules/${modules[1]}`, { completed: true });
    expect(closed.json().detail).toBe("batch_closed");
  });

  it("an empty batch is deleted (204)", async () => {
    const r = await call("locD", "POST", "/api/v1/training/batches", { locationId: LOC.dallas, technologyId: TECH_ID, startDate: "2033-01-10" });
    expect((await call("coach", "DELETE", `/api/v1/training/batches/${r.json().id}`)).statusCode).toBe(403);
    expect((await call("locD", "DELETE", `/api/v1/training/batches/${r.json().id}`)).statusCode).toBe(204);
    expect((await call("locD", "GET", `/api/v1/training/batches/${r.json().id}`)).statusCode).toBe(404);
  });

  it("audit rows carry ids, codes and field names only (rule 5)", async () => {
    const { rows } = await db.admin.query<{ action: string; changes: unknown }>(
      `SELECT action, changes FROM eureka.audit_event WHERE action LIKE 'training.%' OR action LIKE 'batch.%'`);
    expect(rows.length).toBeGreaterThan(10);
    const text = JSON.stringify(rows);
    for (const secret of ["Secret Course Title", "Secret Batch Name", "Fictional description", "example.com", "Cand", "Intro"]) {
      expect(text).not.toContain(secret);
    }
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining([
      "training.course_created", "training.course_updated", "batch.created", "batch.updated", "training.batch_course_added",
      "training.student_added", "training.progress", "batch.status", "batch.deleted",
    ]));
  });
});
