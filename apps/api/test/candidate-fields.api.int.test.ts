import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOTLIST_VISIBILITY, candidateVisible, hotlistVisible, ownsCandidate, resolveScope } from "@eureka/shared";
import { createApp } from "../src/app.module.js";
import { loadConfig } from "../src/platform/config.js";
import { asUser, createTestDb, type TestDb } from "./db-harness.js";
import { CLIENT_ID, LOC, T, U, seedFixtures, toUserAccess, type FixtureCandidate } from "./fixtures.js";

/**
 * Candidate/Hot List gaps (Eureka App 4; migration 0140, docs/candidates-api.md):
 * team-scoped Hot List, the new filters, profile fields, company links and
 * documents status, recruiter entry rights.
 */
let db: TestDb;
let app: NestFastifyApplication;
let candidates: FixtureCandidate[];
const SECRET = "test-secret-test-secret-test-secret-123";
const users = Object.keys(U) as (keyof typeof U)[];
const NOBODY = "99999999-9999-4999-8999-999999999999";

beforeAll(async () => {
  db = await createTestDb();
  candidates = await seedFixtures(db.admin);
  const url = new URL(process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432");
  app = await createApp(loadConfig({
    NODE_ENV: "test", AUTH_MODE: "dev", SESSION_SECRET: SECRET,
    DATABASE_URL: `postgres://eureka_app:eureka_app_test@${url.host}/${db.name}`,
  }));
}, 90_000);

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

async function call(key: keyof typeof U, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown,
  headers: Record<string, string> = {}) {
  const s = await login(key);
  return app.inject({
    method, url, payload: payload as never,
    headers: { cookie: s.cookie, ...(method !== "GET" ? { "x-csrf-token": s.csrf } : {}), ...headers },
  });
}

/** Every page of a list endpoint (the Hot List limiter allows 60 pages a minute per user). */
async function all(key: keyof typeof U, path: string): Promise<{ id: string; [k: string]: unknown }[]> {
  const items: { id: string }[] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const r = await call(key, "GET", `${path}${sep}limit=200${cursor ? `&cursor=${cursor}` : ""}`);
    expect(r.statusCode, `${key} ${path}`).toBe(200);
    const page = r.json() as { items: { id: string }[]; nextCursor: string | null };
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

const sorted = (ids: string[]) => [...ids].sort();
const setPolicy = (v: "everyone" | "team") =>
  db.admin.query(`UPDATE authz.policy_setting SET value = $1 WHERE key = 'hotlist_visibility'`, [v]);
const audits = async (action: string, actor: string) =>
  (await db.admin.query<{ changes: Record<string, unknown> }>(
    `SELECT changes FROM eureka.audit_event WHERE action = $1 AND actor_id = $2 ORDER BY seq`, [action, actor])).rows;

/** Test setup only: a write as the superuser with triggers off (guards and event triggers skipped). */
async function raw(sql: string, params: unknown[] = []) {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(sql, params);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

const own = () => candidates.find((c) => c.recruiterId === U.r1a && c.visibility === "team" && c.marketingStatus === "active")!;
const teammate = () => candidates.find((c) => c.recruiterId === U.r1b && c.visibility === "team" && c.marketingStatus === "active")!;
const otherAllTeams = () => candidates.find((c) => c.teamId === T.t3 && c.visibility === "all_teams" && c.marketingStatus === "active")!;
const otherHidden = () => candidates.find((c) => c.teamId === T.t3 && c.visibility === "team" && c.marketingStatus === "active")!;

describe("Hot List visibility (team policy)", () => {
  it("the catalog and the database agree on the team policy", async () => {
    expect(HOTLIST_VISIBILITY).toBe("team");
    const { rows } = await db.admin.query(`SELECT value FROM authz.policy_setting WHERE key = 'hotlist_visibility'`);
    expect(rows[0].value).toBe("team");
  });

  it.each(users)("GET /hotlist for %s = engine hotlistVisible (team), 403 without hotlist:read", async (key) => {
    const access = toUserAccess(key);
    const scope = resolveScope(access, "hotlist:read");
    if (!scope) {
      expect((await call(key, "GET", "/api/v1/hotlist?limit=1")).statusCode).toBe(403);
      return;
    }
    const expected = candidates.filter((c) => hotlistVisible(scope, c)).map((c) => c.id);
    const items = await all(key, "/api/v1/hotlist");
    expect(sorted(items.map((i) => i.id))).toEqual(sorted(expected));
    // Every row comes from the caller's own candidate:read scope, so every profile opens.
    for (const i of items) expect(i.canOpenProfile).toBe(true);
  });

  it("the interview prep team sees the coached team's Team-only candidates, not another team's", async () => {
    const ids = (await all("coach", "/api/v1/hotlist")).map((i) => i.id);
    const coached = toUserAccess("coach").coachedTeamIds;
    expect(coached.length).toBeGreaterThan(0);
    for (const c of candidates.filter((x) => x.visibility === "team" && x.marketingStatus === "active")) {
      expect(ids.includes(c.id), c.id).toBe(coached.includes(c.teamId!));
    }
  });

  it("team-policy Hot List pages are audited (filter summary, no free text)", async () => {
    await call("r2a", "GET", "/api/v1/hotlist?limit=2&search=Cand&visa=h1b&stay=remote");
    const last = (await audits("hotlist.read", U.r2a)).at(-1)!;
    expect(last.changes.filters).toMatchObject({ search: true, visa: "h1b", stay: "remote" });
    expect(JSON.stringify(last.changes)).not.toContain("Cand");
  });
});

describe("Hot List filters", () => {
  const pick = (pred: (c: FixtureCandidate) => boolean, n: number) => candidates.filter(pred).slice(0, n);
  let h1b: FixtureCandidate[];
  let remote: FixtureCandidate[];
  let guestHouse: FixtureCandidate[];
  let complete: FixtureCandidate[];
  let withLink: FixtureCandidate[];
  let uploaded: FixtureCandidate[];

  beforeAll(async () => {
    const hot = (c: FixtureCandidate) => ["active", "on_hold", "full_of_interviews"].includes(c.marketingStatus);
    h1b = pick((c) => hot(c) && c.teamId === T.t1, 3);
    remote = pick((c) => hot(c) && c.teamId === T.t2, 2);
    guestHouse = pick((c) => hot(c) && c.teamId === T.t3, 2);
    complete = pick((c) => hot(c) && c.locationId === LOC.austin, 2);
    withLink = pick((c) => hot(c) && c.teamId === T.t2 && c.locationId === LOC.austin, 1);
    uploaded = pick((c) => hot(c) && c.teamId === T.t3 && c.locationId === LOC.austin, 1);
    const ids = (cs: FixtureCandidate[]) => cs.map((c) => c.id);
    await raw(`UPDATE eureka.candidate SET visa_category = 'h1b' WHERE id = ANY($1)`, [ids(h1b)]);
    await raw(`UPDATE eureka.candidate SET gh_remote = true WHERE id = ANY($1)`, [ids(remote)]);
    await raw(`UPDATE eureka.candidate SET gh_location_id = $2 WHERE id = ANY($1)`, [ids(guestHouse), LOC.dallas]);
    await raw(`UPDATE eureka.candidate SET documents_status = 'complete' WHERE id = ANY($1)`, [ids(complete)]);
    await raw(`UPDATE eureka.candidate SET resume_url = 'https://drive.example/r' WHERE id = ANY($1)`, [ids(withLink)]);
    // Sheet columns (0290): priority, in person, marketing start dates.
    await raw(`UPDATE eureka.candidate SET priority = 'P1' WHERE id = ANY($1)`, [ids(h1b)]);
    await raw(`UPDATE eureka.candidate SET priority = 'P3' WHERE id = ANY($1)`, [ids(remote)]);
    await raw(`UPDATE eureka.candidate SET in_person_ok = true WHERE id = ANY($1)`, [ids(complete)]);
    await raw(`UPDATE eureka.candidate SET in_person_ok = false WHERE id = ANY($1)`, [ids(withLink)]);
    await raw(`UPDATE eureka.candidate SET marketing_start_date = date '2026-01-01' + (abs(hashtext(id::text)) % 200)
                WHERE id = ANY($1)`, [ids([...h1b, ...remote, ...guestHouse])]);
    // A current (clean) uploaded resume for one candidate, bypassing the upload and scan flow.
    await raw(`
      INSERT INTO eureka.resume (candidate_id, status, content_type, size_bytes, sha256_hex, version, is_current, uploaded_by,
                                 upload_expires_at, scanned_at)
      VALUES ($1, 'clean', 'application/pdf', 10, repeat('a', 64), 1, true, $2, now() + interval '1 hour', now())`,
    [uploaded[0]!.id, U.r3a]);
  });

  const ceoIds = async (q: string) => sorted((await all("ceo", `/api/v1/hotlist?${q}`)).map((i) => i.id));
  const hotAll = () => candidates.filter((c) => hotlistVisible(resolveScope(toUserAccess("ceo"), "hotlist:read"), c));

  describe.each(["team", "everyone"] as const)("served under the %s policy", (policy) => {
    beforeAll(() => setPolicy(policy));
    afterAll(() => setPolicy(HOTLIST_VISIBILITY));

    it("visa, stay, documents, location and resume filters", async () => {
      expect(await ceoIds("visa=h1b")).toEqual(sorted(h1b.map((c) => c.id)));
      expect(await ceoIds("stay=remote")).toEqual(sorted(remote.map((c) => c.id)));
      expect(await ceoIds("stay=guest_house")).toEqual(sorted(guestHouse.map((c) => c.id)));
      expect(await ceoIds("documents=complete")).toEqual(sorted(complete.map((c) => c.id)));
      const none = await ceoIds("documents=none");
      expect(none).toEqual(sorted(hotAll().filter((c) => !complete.includes(c)).map((c) => c.id)));
      expect(await ceoIds(`locationId=${LOC.austin}`)).toEqual(sorted(hotAll().filter((c) => c.locationId === LOC.austin).map((c) => c.id)));
      expect(await ceoIds("resume=yes")).toEqual(sorted([...withLink, ...uploaded].map((c) => c.id)));
      expect((await ceoIds("resume=no")).length).toBe(hotAll().length - 2);
      expect(await ceoIds(`visa=h1b&locationId=${LOC.austin}`))
        .toEqual(sorted(h1b.filter((c) => c.locationId === LOC.austin).map((c) => c.id)));
    });

    it("sheet filters: priority, team, recruiter, in person, guest house", async () => {
      const ids = (cs: FixtureCandidate[]) => sorted(cs.map((c) => c.id));
      expect(await ceoIds("priority=P1")).toEqual(ids(h1b));
      expect(await ceoIds("priority=P3")).toEqual(ids(remote));
      expect(await ceoIds(`teamId=${T.t2}`)).toEqual(ids(hotAll().filter((c) => c.teamId === T.t2)));
      expect(await ceoIds(`recruiterId=${U.r1a}`)).toEqual(ids(hotAll().filter((c) => c.recruiterId === U.r1a)));
      expect(await ceoIds("inPerson=yes")).toEqual(ids(complete));
      expect(await ceoIds("inPerson=no")).toEqual(ids(withLink));
      expect(await ceoIds(`ghLocationId=${LOC.dallas}`)).toEqual(ids(guestHouse));
      expect(await ceoIds(`priority=P1&teamId=${T.t2}`)).toEqual([]);
    });

    // As the AD (org scope like the CEO): the CEO's page budget (60 a minute) goes to the filter tests.
    it.each(["priority", "days", "name"] as const)("sort=%s pages in order with no row lost or repeated", async (sort) => {
      const rows: { id: string; priority: string; marketingStartDate: string | null; name: string }[] = [];
      let cursor: string | null = null;
      do {
        const r = await call("ad", "GET", `/api/v1/hotlist?sort=${sort}&limit=40${cursor ? `&cursor=${cursor}` : ""}`);
        expect(r.statusCode).toBe(200);
        const page = r.json() as { items: typeof rows; nextCursor: string | null };
        rows.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      const adScope = resolveScope(toUserAccess("ad"), "hotlist:read");
      expect(sorted(rows.map((r) => r.id))).toEqual(sorted(candidates.filter((c) => hotlistVisible(adScope, c)).map((c) => c.id)));
      expect(rows.length).toBeGreaterThan(40); // more than one page
      const key = (r: (typeof rows)[number]) =>
        sort === "priority" ? r.priority : sort === "days" ? (r.marketingStartDate ?? "9999-12-31") : r.name.toLowerCase();
      // Compared in the database: names sort by its collation (glibc en_US in CI skips spaces), not code points.
      const unsorted = (await db.admin.query<{ i: number }>(
        `SELECT i::int FROM (SELECT i, k, lag(k) OVER (ORDER BY i) AS prev FROM unnest($1::text[]) WITH ORDINALITY u(k, i)) x
          WHERE prev > k ORDER BY i LIMIT 1`, [rows.map(key)])).rows[0];
      expect(unsorted, `${sort} row ${(unsorted?.i ?? 0) - 1}`).toBeUndefined();
    });

    it("rows carry the team lead and in-person", async () => {
      const rows = await all("ceo", `/api/v1/hotlist?teamId=${T.t1}`);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.team).toMatchObject({ id: T.t1, lead: "l1" });
      const inPerson = (await all("ceo", "/api/v1/hotlist?inPerson=yes"))[0]!;
      expect(inPerson.inPersonOk).toBe(true);
    });

    it("rows carry the list columns", async () => {
      const rows = await all("ceo", "/api/v1/hotlist?stay=remote");
      for (const r of rows) expect(r).toMatchObject({ stay: "remote", hasResume: expect.any(Boolean) });
      const link = (await all("ceo", "/api/v1/hotlist?resume=yes")).find((r) => r.id === withLink[0]!.id)!;
      expect(link.hasResume).toBe(true);
      const ghRow = (await all("ceo", "/api/v1/hotlist?stay=guest_house"))[0]!;
      expect(ghRow).toMatchObject({ stay: "guest_house", ghLocation: { name: "Dallas" } });
    });
  });

  it("the Candidates list takes the same filters", async () => {
    const ids = sorted((await all("hr", "/api/v1/candidates?visa=h1b")).map((i) => i.id));
    expect(ids).toEqual(sorted(h1b.map((c) => c.id)));
  });

  it.each([["visa=xx"], ["documents=done"], ["resume=maybe"], ["stay=hotel"], ["locationId=dallas"]])(
    "rejects %s with 422", async (q) => {
      expect((await call("ceo", "GET", `/api/v1/hotlist?${q}`)).statusCode).toBe(422);
    });

  it("export applies the filters and adds Visa, Documents and Stay columns", async () => {
    const r = await call("l1", "POST", "/api/v1/hotlist/export", { visa: "h1b" });
    expect(r.statusCode).toBe(200);
    const lines = r.body.replace(/^﻿/, "").split("\r\n").filter(Boolean);
    expect(lines[0]).toMatch(/,Visa,Documents,Stay,In person$/);
    const l1 = resolveScope(toUserAccess("l1"), "report:export")!;
    expect(lines.length - 1).toBe(h1b.filter((c) => ownsCandidate(l1, c)).length);
    for (const line of lines.slice(1)) expect(line).toContain("H-1B");
  });

  it("saved views keep the new filters", async () => {
    const r = await call("r1a", "POST", "/api/v1/hotlist/views", { name: "H1B remote", filters: { visa: "h1b", stay: "remote", resume: "yes" } });
    expect(r.statusCode).toBe(201);
    expect(r.json().filters).toEqual({ visa: "h1b", stay: "remote", resume: "yes" });
  });
});

describe("profile fields (PATCH /candidates/:id)", () => {
  it("round-trips the new fields; links and marketing locations are audited as flags", async () => {
    const id = own().id;
    const body = {
      ghLocation: "remote", marketingLocations: ["Dallas, TX", "Austin, TX"], linkedinUrl: "https://www.linkedin.com/in/cand-one",
      resumeUrl: "https://drive.example/resume/1", eligibility: ["in_person", "relocation"], visaCategory: "f1_opt",
    };
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${id}`, body)).statusCode).toBe(200);
    const got = (await call("r1a", "GET", `/api/v1/candidates/${id}`)).json();
    expect(got).toMatchObject({
      stay: "remote", ghLocation: null, marketingLocations: ["Dallas, TX", "Austin, TX"], linkedinUrl: body.linkedinUrl,
      resumeUrl: body.resumeUrl, eligibility: ["in_person", "relocation"], visaCategory: "f1_opt", statusLabel: "Active/Remote",
      hasResume: true,
    });
    const a = (await audits("candidate.updated", U.r1a)).at(-1)!.changes;
    expect(a).toMatchObject({ ghLocation: "remote", linkedinUrl: true, resumeUrl: true, marketingLocations: true, visaCategory: "f1_opt" });
    expect(JSON.stringify(a)).not.toMatch(/linkedin\.com|drive\.example|Dallas/);

    // A guest house location replaces remote; [] and null clear.
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${id}`, { ghLocation: LOC.dallas, eligibility: [], linkedinUrl: null })).statusCode).toBe(200);
    const again = (await call("r1a", "GET", `/api/v1/candidates/${id}`)).json();
    expect(again).toMatchObject({ stay: "guest_house", ghLocation: { id: LOC.dallas, name: "Dallas" }, eligibility: [], linkedinUrl: null });
    const row = (await db.admin.query(`SELECT gh_remote, eligibility FROM eureka.candidate WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ gh_remote: false, eligibility: null });
  });

  it.each([
    ["a non-LinkedIn link", { linkedinUrl: "https://example.com/in/x" }],
    ["an http resume link", { resumeUrl: "http://drive.example/x" }],
    ["an unknown eligibility", { eligibility: ["anywhere"] }],
    ["duplicate eligibility", { eligibility: ["remote", "remote"] }],
    ["six marketing locations", { marketingLocations: ["A", "B", "C", "D", "E", "F"] }],
    ["an unknown visa", { visaCategory: "b1" }],
    ["teamAssignedAt", { teamAssignedAt: "2020-01-01T00:00:00Z" }],
    ["documentsStatus", { documentsStatus: "complete" }],
    ["everifyCompanyId", { everifyCompanyId: NOBODY }],
  ])("rejects %s with 422", async (_what, body) => {
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${own().id}`, body)).statusCode).toBe(422);
  });

  it("an unknown guest house location is 422; another recruiter's candidate is 403, another team's 404", async () => {
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${own().id}`, { ghLocation: NOBODY })).statusCode).toBe(422);
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${teammate().id}`, { visaCategory: "h1b" })).statusCode).toBe(403);
    expect((await call("r1a", "PATCH", `/api/v1/candidates/${otherHidden().id}`, { visaCategory: "h1b" })).statusCode).toBe(404);
  });

  it("links are owner-only: an Open-to-all-teams viewer sees eligibility and visa but not LinkedIn or the resume link", async () => {
    const id = otherAllTeams().id;
    expect((await call("l3", "PATCH", `/api/v1/candidates/${id}`, {
      linkedinUrl: "https://linkedin.com/in/shared", eligibility: ["remote"], visaCategory: "h4_ead",
    })).statusCode).toBe(200);
    const owner = (await call("l3", "GET", `/api/v1/candidates/${id}`)).json();
    expect(owner.linkedinUrl).toBe("https://linkedin.com/in/shared");
    const viewer = (await call("r1a", "GET", `/api/v1/candidates/${id}`)).json();
    expect(viewer).toMatchObject({ eligibility: ["remote"], visaCategory: "h4_ead" });
    expect(viewer).not.toHaveProperty("linkedinUrl");
    expect(viewer).not.toHaveProperty("resumeUrl");
    expect(viewer).not.toHaveProperty("companies");
    expect(viewer.statusLabel).toBe("Active/All Teams");
  });

  it("date added to team is set by the server and moves with a reassignment; confirmations are counted", async () => {
    const c = teammate();
    const before = (await call("l1", "GET", `/api/v1/candidates/${c.id}`)).json();
    expect(Date.parse(before.teamAssignedAt)).not.toBeNaN();
    const t0 = Date.now();
    await asUser(db.app, U.m1, (cl) => cl.query(`UPDATE eureka.candidate SET team_id = $2, recruiter_id = NULL WHERE id = $1`, [c.id, T.t2]), true);
    const after = (await call("m1", "GET", `/api/v1/candidates/${c.id}`)).json();
    expect(Date.parse(after.teamAssignedAt)).toBeGreaterThanOrEqual(t0 - 1000);
    expect(after.team.id).toBe(T.t2);

    await raw(`INSERT INTO eureka.candidate_event (candidate_id, type, from_value, to_value)
      VALUES ($1, 'candidate.status_changed', 'active', 'confirmation'), ($1, 'candidate.status_changed', 'confirmation', 'active'),
             ($1, 'candidate.status_changed', 'active', 'confirmation')`, [c.id]);
    expect((await call("m1", "GET", `/api/v1/candidates/${c.id}`)).json().confirmations).toBe(2);
  });
});

describe("company links and documents status (PUT /candidates/:id/compliance)", () => {
  let co1: string;
  let co2: string;
  let inactive: string;

  beforeAll(async () => {
    const mk = async (name: string) => {
      const r = await call("locD", "POST", "/api/v1/companies", { locationId: LOC.dallas, name });
      expect(r.statusCode).toBe(201);
      return r.json() as { id: string; rowVersion: number };
    };
    co1 = (await mk("Eureka Payroll LLC")).id;
    co2 = (await mk("Eureka Consulting Inc")).id;
    const gone = await mk("Old Co");
    inactive = gone.id;
    expect((await call("locD", "PATCH", `/api/v1/companies/${gone.id}`, { status: "inactive" }, { "if-match": `"${gone.rowVersion}"` })).statusCode).toBe(200);
  });

  it.each(users)("%s: PUT is allowed exactly with candidate.compliance:update", async (key) => {
    const access = toUserAccess(key);
    const c = own();
    const r = await call(key, "PUT", `/api/v1/candidates/${c.id}/compliance`, { documentsStatus: "pending" });
    const scope = resolveScope(access, "candidate.compliance:update");
    if (!scope) expect(r.statusCode).toBe(403);
    else expect(r.statusCode).toBe(ownsCandidate(scope, c) ? 200 : candidateVisible(resolveScope(access, "candidate:read"), c) ? 403 : 404);
  });

  it("HR links companies; owners and compliance teams see the names, others do not; audit carries ids only", async () => {
    const c = own();
    const r = await call("hr", "PUT", `/api/v1/candidates/${c.id}/compliance`, {
      everifyCompanyId: co1, offerLetterCompanyId: co2, form1099CompanyId: co1, documentsStatus: "partial",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ everifyCompanyId: co1, offerLetterCompanyId: co2, form1099CompanyId: co1, documentsStatus: "partial" });
    // Omitted keys keep their value; null clears one.
    expect((await call("imm", "PUT", `/api/v1/candidates/${c.id}/compliance`, { form1099CompanyId: null })).json())
      .toMatchObject({ everifyCompanyId: co1, form1099CompanyId: null, documentsStatus: "partial" });
    for (const key of ["hr", "acct", "imm", "r1a", "l1", "m1"] as const) {
      const got = (await call(key, "GET", `/api/v1/candidates/${c.id}`)).json();
      expect(got.companies, key).toEqual({
        everify: { id: co1, name: "Eureka Payroll LLC" }, offerLetter: { id: co2, name: "Eureka Consulting Inc" }, form1099: null,
      });
      expect(got.documentsStatus).toBe("partial");
      expect(got.canEditCompliance, key).toBe(["hr", "acct", "imm"].includes(key));
    }
    const a = (await audits("candidate.compliance", U.hr)).at(-1)!.changes;
    expect(JSON.stringify(a)).not.toMatch(/Eureka Payroll|Consulting/);
    // The documents status shows on the Hot List row, and the filter finds it.
    const rows = await all("r1a", "/api/v1/hotlist?documents=partial");
    expect(rows.map((x) => x.id)).toEqual([c.id]);
  });

  it("a newly linked company must be active and exist; an unknown candidate is 404", async () => {
    const c = teammate();
    expect((await call("hr", "PUT", `/api/v1/candidates/${c.id}/compliance`, { everifyCompanyId: inactive })).statusCode).toBe(422);
    expect((await call("hr", "PUT", `/api/v1/candidates/${c.id}/compliance`, { everifyCompanyId: NOBODY })).statusCode).toBe(422);
    expect((await call("hr", "PUT", `/api/v1/candidates/${NOBODY}/compliance`, { documentsStatus: "complete" })).statusCode).toBe(404);
    expect((await call("hr", "PUT", `/api/v1/candidates/${c.id}/compliance`, {})).statusCode).toBe(422);
    expect((await call("hr", "PUT", `/api/v1/candidates/${c.id}/compliance`, { documentsStatus: "done" })).statusCode).toBe(422);
  });

  it("GET /candidate-companies lists active companies for compliance editors only", async () => {
    const r = await call("acct", "GET", "/api/v1/candidate-companies");
    expect(r.statusCode).toBe(200);
    const names = r.json().items.map((i: { name: string }) => i.name);
    expect(names).toEqual(expect.arrayContaining(["Eureka Payroll LLC", "Eureka Consulting Inc"]));
    expect(names).not.toContain("Old Co");
    expect((await call("r1a", "GET", "/api/v1/candidate-companies")).statusCode).toBe(403);
  });
});

describe("recruiter entry rights", () => {
  it("a recruiter logs a submission for any Hot List candidate they see, own team or Open to all teams", async () => {
    const access = toUserAccess("r1b");
    const scope = resolveScope(access, "hotlist:read")!;
    const visible = candidates.filter((c) => hotlistVisible(scope, c));
    const picks = [
      visible.find((c) => c.teamId === T.t1 && c.recruiterId === U.r1a && c.marketingStatus === "on_hold")!,
      visible.find((c) => c.teamId === T.t1 && c.recruiterId === null && c.marketingStatus === "full_of_interviews")!,
      visible.find((c) => c.teamId === T.t2 && c.visibility === "all_teams" && c.marketingStatus === "active")!,
    ];
    for (const c of picks) {
      expect(c).toBeDefined();
      const r = await call("r1b", "POST", "/api/v1/submissions", { candidateId: c.id, jobTitle: "Java Developer", clientId: CLIENT_ID });
      expect(r.statusCode, c.id).toBe(201);
    }
    // Not on the Hot List: another team's Team-only candidate.
    expect((await call("r1b", "POST", "/api/v1/submissions", { candidateId: otherHidden().id, jobTitle: "x", clientId: CLIENT_ID })).statusCode).toBe(404);
  });
});
