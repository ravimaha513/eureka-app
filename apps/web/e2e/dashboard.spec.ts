import { expect, test, type Page } from "@playwright/test";
import { AUSTIN, apiAs, freshCandidate, login, screen, submissionWithInterview, uniq } from "./support";

/**
 * Role dashboards (docs/dashboards-api.md) for a lead and a location admin.
 * Setup: r1a (Team Rohit) logs one interview in Dallas and one in Austin that
 * ended 29 days ago with no feedback, so both land near the top of "Interviews
 * without feedback" (oldest first, 30-day lookback). The lead sees both; the
 * Dallas location admin sees only the Dallas one.
 */

async function setup(playwright: Parameters<typeof apiAs>[0], baseURL: string | undefined) {
  const run = uniq();
  const r1a = await apiAs(playwright, baseURL, "r1a@eureka.example");
  const startsAt = new Date(Date.now() - 29 * 86_400_000);
  const dallas = await freshCandidate(r1a, "DashD");
  const austin = await freshCandidate(r1a, "DashA", { locationId: AUSTIN });
  await submissionWithInterview(r1a, dallas.id, { jobTitle: `Dash ${run}`, round: `Dash ${run} D`, startsAt });
  await submissionWithInterview(r1a, austin.id, { jobTitle: `Dash ${run}`, round: `Dash ${run} A`, startsAt });
  await r1a.dispose();
  return { run, dallas, austin };
}

const missingFeedback = (page: Page) => page.getByRole("table", { name: "Interviews without feedback" });

test("lead dashboard: team activity by recruiter and the team's interviews without feedback", async ({ page, playwright, baseURL }) => {
  const { run, dallas, austin } = await setup(playwright, baseURL);
  await login(page, "l1@eureka.example");
  await screen(page, "Dashboard");

  await page.getByRole("button", { name: "Last 30 days" }).click();
  await expect(page.getByRole("button", { name: "Last 30 days" })).toHaveAttribute("aria-pressed", "true");
  for (const tile of ["Submissions", "Interviews", "Candidates added"]) {
    await expect(page.locator(".tile").filter({ has: page.getByText(tile, { exact: true }) })).toBeVisible();
  }

  // Grouped by recruiter by default: the team's recruiters only.
  const byRecruiter = page.getByRole("table", { name: "Activity by recruiter" });
  await expect(byRecruiter.getByRole("row", { name: /^r1a / })).toBeVisible();
  await expect(byRecruiter.getByRole("row", { name: /^r1b / })).toBeVisible();
  await expect(byRecruiter.getByRole("row", { name: /^r2a / })).toHaveCount(0);
  await expect(byRecruiter.getByRole("row", { name: /^r3a / })).toHaveCount(0);

  await page.getByRole("combobox", { name: "Group by", exact: true }).selectOption({ label: "Team" });
  const byTeam = page.getByRole("table", { name: "Activity by team" });
  await expect(byTeam.getByRole("row", { name: /^Team Rohit / })).toBeVisible();
  await expect(byTeam.getByRole("row")).toHaveCount(2); // header + Team Rohit

  // Needs attention: both of r1a's interviews, with round and client.
  const table = missingFeedback(page);
  await expect(table.getByRole("row").filter({ hasText: dallas.name })).toContainText(`Dash ${run} D · Northwind Financial`);
  await expect(table.getByRole("row").filter({ hasText: austin.name })).toContainText(`Dash ${run} A · Northwind Financial`);
  await page.screenshot({ path: "e2e-artifacts/lead-dashboard.png", fullPage: true });
});

test("location admin dashboard: own location only", async ({ page, playwright, baseURL }) => {
  const { run, dallas, austin } = await setup(playwright, baseURL);
  await login(page, "locD@eureka.example");
  await screen(page, "Dashboard");

  // Grouped by location by default for a location role: Dallas, never Austin.
  const byLocation = page.getByRole("table", { name: "Activity by location" });
  await expect(byLocation.getByRole("row", { name: /^Dallas / })).toBeVisible();
  await expect(byLocation.getByRole("row", { name: /^Austin / })).toHaveCount(0);

  const table = missingFeedback(page);
  await expect(table.getByRole("row").filter({ hasText: dallas.name })).toContainText(`Dash ${run} D`);
  await expect(table.getByText(austin.name)).toHaveCount(0);
  await expect(table.getByText(`Dash ${run} A`)).toHaveCount(0);

  // A location admin may open interviews from the list.
  await table.getByRole("button", { name: `Open ${dallas.name} in Interviews` }).click();
  await expect(page.getByRole("heading", { name: "Interviews", exact: true })).toBeVisible();
});
