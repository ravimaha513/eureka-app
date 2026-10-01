import { expect, test } from "@playwright/test";
import { apiAs, cell, freshCandidate, localDay, login, screen, submissionWithInterview, uniq } from "./support";

/**
 * Scoped team views (Phase 2 journeys): a lead sees the whole team's pipeline
 * and nothing from other teams; an interview coach sees only coached teams
 * (Team Anjali). Each test creates its own candidates, submissions and interviews.
 */

test("lead sees the team pipeline: both recruiters' submissions, no other team's", async ({ page, playwright, baseURL }) => {
  const run = uniq();
  const r1a = await apiAs(playwright, baseURL, "r1a@eureka.example");
  const r1b = await apiAs(playwright, baseURL, "r1b@eureka.example");
  const r2a = await apiAs(playwright, baseURL, "r2a@eureka.example");
  const mine = { r1a: `Lead view ${run} r1a`, r1b: `Lead view ${run} r1b`, r2a: `Lead view ${run} r2a` };
  for (const [api, key] of [[r1a, "r1a"], [r1b, "r1b"], [r2a, "r2a"]] as const) {
    const c = await freshCandidate(api, "Lead");
    await submissionWithInterview(api, c.id, { jobTitle: mine[key] });
  }
  await Promise.all([r1a, r1b, r2a].map((a) => a.dispose()));

  await login(page, "l1@eureka.example");
  await screen(page, "Submissions");
  const table = page.getByRole("table", { name: "Submissions" });
  const rows = table.locator("tbody tr").filter({ hasText: `Lead view ${run}` });
  // Newest first, so all three would be on page 1 if the lead could see them.
  await expect(rows).toHaveCount(2);
  for (const key of ["r1a", "r1b"] as const) {
    const row = rows.filter({ hasText: mine[key] });
    await expect(await cell(table, row, "Recruiter")).toHaveText(key);
    await expect(await cell(table, row, "Status")).toContainText("Submitted");
  }
  await expect(table.getByText(mine.r2a)).toHaveCount(0);

  // The lead may act on the team's submissions: open r1b's and see the next steps offered.
  await rows.filter({ hasText: mine.r1b }).getByRole("button", { name: /^Open submission of / }).click();
  const drawer = page.getByRole("dialog", { name: new RegExp(mine.r1b) });
  await expect(drawer.getByRole("button", { name: "Move to Under review", exact: true })).toBeVisible();
});

test("interview coach sees coached teams only", async ({ page, playwright, baseURL }) => {
  const run = uniq();
  // A day of its own (well in the future), so the board can be narrowed to it.
  const day = new Date();
  day.setDate(day.getDate() + 30 + Math.floor(Math.random() * 300));
  day.setHours(10, 0, 0, 0);
  const coached = await apiAs(playwright, baseURL, "r2a@eureka.example"); // Team Anjali
  const other = await apiAs(playwright, baseURL, "r1a@eureka.example"); // Team Rohit
  const a = await freshCandidate(coached, "Coached");
  const b = await freshCandidate(other, "NotCoached");
  await submissionWithInterview(coached, a.id, { jobTitle: `Coach ${run}`, round: `Coach ${run}`, startsAt: day });
  await submissionWithInterview(other, b.id, { jobTitle: `Coach ${run}`, round: `Coach ${run}`, startsAt: day });
  await Promise.all([coached.dispose(), other.dispose()]);

  await login(page, "coach@eureka.example");
  const nav = page.getByRole("complementary", { name: "Main navigation" });
  await expect(nav.getByRole("button", { name: "Submissions" })).toHaveCount(0);
  await nav.getByRole("button", { name: "Interviews", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Interviews", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Schedule interview" })).toHaveCount(0);
  await page.getByLabel("From date", { exact: true }).fill(localDay(day));
  await page.getByLabel("Through date", { exact: true }).fill(localDay(day));

  const rows = page.locator("tbody tr").filter({ hasText: `Coach ${run}` });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(a.name);
  await expect(rows).toContainText("Team Anjali");
  await expect(page.getByText(b.name)).toHaveCount(0);
  // Coaches add feedback but do not edit interviews.
  await expect(rows.getByRole("button", { name: "Feedback", exact: true })).toBeVisible();
  await expect(rows.getByRole("button", { name: "Edit interview" })).toHaveCount(0);

  // Candidates and Hot List are limited to the coached team as well.
  await screen(page, "Candidates");
  const candidates = page.getByRole("table", { name: "Candidates" });
  await expect(candidates.locator("tbody tr").first()).toBeVisible();
  const teams = new Set<string>();
  for (const row of await candidates.locator("tbody tr").all()) teams.add((await (await cell(candidates, row, "Team")).innerText()).trim());
  expect([...teams]).toEqual(["Team Anjali"]);
  expect((await page.request.get(`/api/v1/candidates/${b.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/v1/candidates/${a.id}`)).status()).toBe(200);
});
