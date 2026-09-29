import { expect, test, type Page } from "@playwright/test";

/**
 * Sales journeys against the full stack with the dev seed (apps/api/test/fixtures.ts):
 * a recruiter filters the Hot List, opens their own candidate and logs
 * submissions; a lead flips a candidate's "Open to all teams" visibility.
 * Safe to repeat on the same database (visibility is restored; submissions only add).
 */

/** Seeded client "Northwind Financial" (fixtures CLIENT_ID); the API has no client list yet. */
const CLIENT_ID = "00000000-0000-0000-0000-000000000601";
const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function signIn(page: Page, label: string) {
  await page.goto("/");
  await page.getByLabel("Development sign-in (fictional users)").selectOption({ label });
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("complementary", { name: "Main navigation" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Hot List" })).toBeVisible();
}

const hotlist = (page: Page) => page.getByRole("table", { name: "Hot List" });

/** Filters to active, team-only candidates and waits for the result count to settle. */
async function filterActiveTeamOnly(page: Page) {
  await page.getByLabel("Status").selectOption({ label: "Active" });
  await page.getByLabel("Visibility").selectOption({ label: "Team only" });
  await expect(page.getByRole("status")).toContainText("on page 1");
  await expect(hotlist(page)).not.toHaveAttribute("aria-busy", "true");
}

/** Opens the first Team Rohit candidate whose profile the user can open; returns its name. */
async function openFirstTeamRohitProfile(page: Page): Promise<string> {
  const row = hotlist(page).getByRole("row").filter({ hasText: "Team Rohit" })
    .filter({ has: page.getByRole("button", { name: /^Open profile of / }) }).first();
  const link = row.getByRole("button", { name: /^Open profile of / });
  const name = (await link.innerText()).trim();
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return name;
}

test.describe.configure({ mode: "serial" });

test("recruiter filters the Hot List, opens an own candidate and logs submissions", async ({ page }) => {
  await signIn(page, "Recruiter (Team Rohit)");
  await filterActiveTeamOnly(page);

  const rows = hotlist(page).locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) {
    await expect(row.locator("td").nth(2)).toContainText("Active");
    await expect(row.getByText("Open to all teams")).toHaveCount(0);
    // Other teams' team-only candidates: phone masked and no profile link.
    if ((await row.locator("td").nth(4).innerText()) !== "Team Rohit") {
      await expect(row.locator("td").nth(7)).toHaveClass(/masked/);
      await expect(row.getByText("Profile belongs to another team")).toBeVisible();
    }
  }

  // Name search narrows the list (debounced).
  await page.getByLabel("Search name").fill("Cand1");
  await expect(page.getByLabel("Search name")).toHaveValue("Cand1");
  await expect.poll(async () => {
    const names = await hotlist(page).locator("tbody tr td:first-child b").allInnerTexts();
    return names.length > 0 && names.every((n) => n.startsWith("Cand1"));
  }).toBe(true);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await filterActiveTeamOnly(page);

  // Quick view, then the full profile.
  const firstOwn = hotlist(page).getByRole("row").filter({ hasText: "Team Rohit" }).first();
  await firstOwn.getByRole("button", { name: /^Quick view of / }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("button", { name: "Open full profile" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  const name = await openFirstTeamRohitProfile(page);
  await expect(page.getByRole("button", { name: "Edit profile" })).toBeVisible();
  await expect(page.getByRole("switch")).toHaveCount(0); // recruiters can't change visibility

  // First submission to this client.
  const job = `E2E Java Developer ${run}`;
  await page.getByRole("button", { name: "Log submission" }).click();
  let dlg = page.getByRole("dialog", { name: `Log submission for ${name}` });
  await dlg.getByRole("button", { name: "Log submission" }).click();
  await expect(dlg.getByLabel("Job title")).toHaveAttribute("aria-invalid", "true");
  await dlg.getByLabel("Job title").fill(job);
  await dlg.getByLabel("Client ID").fill(CLIENT_ID);
  await dlg.getByLabel("Rate per hour (optional)").fill("65");
  await dlg.getByRole("button", { name: "Log submission" }).click();

  // On a fresh database the first one is clean; on a repeat run it's already a duplicate.
  const done = page.getByRole("dialog", { name: "Submission logged" });
  await expect(dlg.or(done)).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText("Submission logged.");
  if (await done.isVisible()) await done.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Same candidate to the same client again: the server flags a likely duplicate.
  await page.getByRole("button", { name: "Log submission" }).click();
  dlg = page.getByRole("dialog", { name: `Log submission for ${name}` });
  await dlg.getByLabel("Job title").fill(`${job} (again)`);
  await dlg.getByLabel("Client ID").fill(CLIENT_ID);
  await dlg.getByRole("button", { name: "Log submission" }).click();
  await expect(done.getByRole("alert")).toContainText("already submitted to this client in the last 90 days");
  await page.screenshot({ path: "e2e-artifacts/recruiter-duplicate-submission.png", fullPage: true });
  await done.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("alert")).toContainText("Possible duplicate");

  // Back to the list with the filters kept.
  await page.getByRole("button", { name: "← Back to Hot List" }).click();
  await expect(page.getByLabel("Status")).toHaveValue("active");
  await expect(page.getByLabel("Visibility")).toHaveValue("team");
});

test("lead toggles a candidate's Open to all teams visibility", async ({ page }) => {
  await signIn(page, "Lead (Team Rohit)");
  await filterActiveTeamOnly(page);
  const name = await openFirstTeamRohitProfile(page);

  const sw = page.getByRole("switch", { name: "Open to all teams" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(page.getByRole("status")).toHaveText(`${name} is now open to all teams.`);
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("heading", { level: 1, name }).locator("..").getByText("Open to all teams")).toBeVisible();
  await page.screenshot({ path: "e2e-artifacts/lead-visibility.png", fullPage: true });

  // Restore, so the run is repeatable.
  await sw.click();
  await expect(page.getByRole("status")).toHaveText(`${name} is now visible to your team only.`);
  await expect(sw).toHaveAttribute("aria-checked", "false");
});
