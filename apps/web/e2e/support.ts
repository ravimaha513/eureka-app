import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { expect, type APIRequestContext, type Locator, type Page, type PlaywrightWorkerArgs } from "@playwright/test";

/**
 * Shared helpers for the journeys. Every journey creates the records it looks at
 * (a fresh candidate, submission or interview with a unique name), so specs are
 * independent of each other, of their order and of earlier runs on the same database.
 * Seed data (apps/api/test/fixtures.ts): see the ids below.
 */
export const DALLAS = "00000000-0000-0000-0000-00000000d001";
export const AUSTIN = "00000000-0000-0000-0000-00000000a001";
export const JAVA = "00000000-0000-0000-0000-000000000501";
/** "Northwind Financial". */
export const CLIENT_ID = "00000000-0000-0000-0000-000000000601";
/** The fixture interview coach, who coaches Team Anjali (l2, r2a) only. */
export const COACH_ID = "00000000-0000-0000-0000-000000000013";

/** A short id unique to this run and call, for names and job titles. */
export const uniq = () => `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

/** Signs the browser in through the dev sign-in endpoint and waits for the shell. */
export async function login(page: Page, email: string) {
  await page.goto("/");
  const response = await page.request.post("/api/auth/dev-login", { data: { email } });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Main navigation" })).toBeVisible();
}

/** Opens a screen from the main navigation and waits for its heading. */
export async function screen(page: Page, name: string) {
  await page.getByRole("complementary", { name: "Main navigation" }).getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
}

/** The cell of `row` under the column headed `header` (columns differ per role, e.g. the bulk checkbox). */
export async function cell(table: Locator, row: Locator, header: string): Promise<Locator> {
  // textContent, not innerText: headers are upper-cased by CSS.
  const headers = (await table.locator("thead th").allTextContents()).map((h) => h.trim());
  const i = headers.indexOf(header);
  expect(i, `column ${header} in ${headers.join(" | ")}`).toBeGreaterThanOrEqual(0);
  // nth-child, so `row` may also match several rows (the cells of that column).
  return row.locator(`td:nth-child(${i + 1})`);
}

/** A phone cell is masked, or empty ("—") for a candidate with no phone (journeys create such candidates). */
export async function expectMaskedPhone(phoneCell: Locator) {
  if ((await phoneCell.innerText()).trim() === "—") return;
  await expect(phoneCell).toHaveClass(/masked/);
}

export interface Api {
  me: { id: string; csrfToken: string; capabilities: string[] };
  get(path: string): Promise<any>;
  send(method: "POST" | "PATCH" | "PUT", path: string, data: unknown, status?: number, headers?: Record<string, string>): Promise<any>;
  dispose(): Promise<void>;
}

/** A separate API session (own cookies) for setting up data as another user. */
export async function apiAs(playwright: PlaywrightWorkerArgs["playwright"], baseURL: string | undefined, email: string): Promise<Api> {
  const ctx: APIRequestContext = await playwright.request.newContext({ baseURL });
  const r = await ctx.post("/api/auth/dev-login", { data: { email } });
  expect(r.ok(), `dev-login ${email}`).toBeTruthy();
  const me = await (await ctx.get("/api/v1/me")).json();
  return {
    me,
    async get(path) {
      const res = await ctx.get(path);
      expect(res.status(), `GET ${path}: ${await res.text()}`).toBe(200);
      return res.json();
    },
    async send(method, path, data, status, headers = {}) {
      const res = await ctx.fetch(path, { method, data, headers: { "x-csrf-token": me.csrfToken, ...headers } });
      if (status !== undefined) expect(res.status(), `${method} ${path}: ${await res.text()}`).toBe(status);
      else expect(res.ok(), `${method} ${path}: ${res.status()} ${await res.text()}`).toBeTruthy();
      const text = await res.text();
      return text ? JSON.parse(text) : undefined;
    },
    dispose: () => ctx.dispose(),
  };
}

/** A fresh Dallas Java candidate created by `api`'s user (no phone or email, so no duplicate check). */
export async function freshCandidate(api: Api, tag: string, extra: Record<string, unknown> = {}) {
  const firstName = `E2E${tag}`;
  const lastName = uniq();
  const { id } = await api.send("POST", "/api/v1/candidates", { firstName, lastName, technologyId: JAVA, locationId: DALLAS, ...extra }, 201);
  const c = await api.get(`/api/v1/candidates/${id}`);
  return { id: id as string, name: c.name as string };
}

/** A submission of `candidateId` to Northwind Financial and, optionally, one interview on it. */
export async function submissionWithInterview(api: Api, candidateId: string, opts: {
  jobTitle: string; round?: string; startsAt?: Date; minutes?: number; coachId?: string;
}) {
  const sub = await api.send("POST", "/api/v1/submissions", { candidateId, clientId: CLIENT_ID, jobTitle: opts.jobTitle }, 201);
  if (!opts.round || !opts.startsAt) return { submissionId: sub.id as string };
  const endsAt = new Date(opts.startsAt.getTime() + (opts.minutes ?? 60) * 60_000);
  const int = await api.send("POST", "/api/v1/interviews", {
    submissionId: sub.id, round: opts.round, startsAt: opts.startsAt.toISOString(), endsAt: endsAt.toISOString(),
    ...(opts.coachId ? { coachId: opts.coachId } : {}),
  }, 201);
  return { submissionId: sub.id as string, interviewId: int.id as string };
}

/** YYYY-MM-DD of an instant in the browser's (and this process's) local time zone. */
export const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Superuser URL of the stack's database. Only the candidate feedback journey needs it:
 * the link is minted by the worker and emailed, so the test mints one the same way
 * (a random token whose SHA-256 is stored). Tests that need it skip without it.
 */
export const ADMIN_DB_URL = process.env.E2E_DATABASE_URL;

/** Runs one SQL statement with psql against E2E_DATABASE_URL and returns the unaligned output. */
export function sql(statement: string): string {
  if (!ADMIN_DB_URL) throw new Error("E2E_DATABASE_URL is not set");
  return execFileSync("psql", [ADMIN_DB_URL, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", statement], { encoding: "utf8" }).trim();
}

/**
 * Issues a candidate feedback link for an interview that already ended, as the
 * feedback-email job does (eureka.feedback_prepare + feedback_sent), and returns the token.
 */
export function mintFeedbackToken(interviewId: string): string {
  expect(interviewId).toMatch(/^[0-9a-f-]{36}$/);
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const id = sql(`SELECT eureka.feedback_prepare('${interviewId}', '${hash}', '')`);
  expect(id, "feedback_prepare refused the interview (has it ended over an hour ago?)").toMatch(/^[0-9a-f-]{36}$/);
  sql(`SELECT eureka.feedback_sent('${id}')`);
  return token;
}
