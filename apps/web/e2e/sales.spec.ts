import { expect, test, type Page } from "@playwright/test";
import { cell, signInAs } from "./support";

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
  await signInAs(page, label);
  await expect(page.getByRole("heading", { level: 1, name: "Hot List" })).toBeVisible();
}

const hotlist = (page: Page) => page.getByRole("table", { name: "Hot List" });
/** Filter controls (the bulk bar has its own "Set status" select, so scope to the filter form; HANDOFF rule 8). */
const filters = (page: Page) => page.getByRole("search", { name: "Hot List filters" });
const filter = (page: Page, name: string) => filters(page).getByRole("combobox", { name, exact: true });
/** The list footer's result count (other live regions: saved views, export, bulk results). */
const resultCount = (page: Page) => page.getByRole("status").filter({ hasText: / on page \d+/ });

/** Ticks one option in a filter's search combobox (options may read "Active, 3 candidates"). */
async function pickFilter(page: Page, name: string, option: string) {
  const box = filter(page, name);
  await box.click();
  await filters(page).getByRole("listbox", { name }).getByRole("option", { name: new RegExp(`^${option}(,|$)`) }).click();
  await box.press("Escape");
  await expect(box).toHaveValue(option);
}

/** The one live region saying this (other status regions: result count, offline banners). */
const statusSaying = (page: Page, text: string) => expect(page.getByRole("status").filter({ hasText: text })).toHaveText(text);

/** Filters to active, team-only candidates and waits for the result count to settle. */
async function filterActiveTeamOnly(page: Page) {
  await pickFilter(page, "Status", "Active");
  // Visibility sits behind "More filters", which stays open once opened.
  const more = filters(page).getByRole("button", { name: /^More filters/ });
  if (await more.getAttribute("aria-expanded") !== "true") await more.click();
  await pickFilter(page, "Visibility", "Team only");
  await expect(resultCount(page)).toContainText("on page 1");
  await expect(hotlist(page)).not.toHaveAttribute("aria-busy", "true");
}

/** Opens the first Team Rohit candidate whose profile the user can open; returns its name. */
async function openFirstTeamRohitProfile(page: Page): Promise<string> {
  // The recruiter's own candidate: per-record actions hide Edit on a teammate's candidate.
  const row = hotlist(page).getByRole("row").filter({ hasText: "Team Rohit" }).filter({ has: page.getByRole("cell", { name: "r1a", exact: true }) })
    .filter({ has: page.getByRole("button", { name: /^Open profile of / }) }).first();
  const link = row.getByRole("button", { name: /^Open profile of / });
  const name = (await link.innerText()).trim();
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return name;
}

test.describe.configure({ mode: "serial" });

test("a candidate profile has its own address: reload keeps it open and Back returns to the list", async ({ page }) => {
  await signIn(page, "Recruiter (Team Rohit)");
  await expect(page).toHaveURL(/\/hotlist$/);
  const name = await openFirstTeamRohitProfile(page);
  await expect(page).toHaveURL(/\/hotlist\/[^/]+$/);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/hotlist$/);
  await expect(hotlist(page)).toBeVisible();
});

test("recruiter filters the Hot List, opens an own candidate and logs submissions", async ({ page }) => {
  await signIn(page, "Recruiter (Team Rohit)");
  await filterActiveTeamOnly(page);

  const rows = hotlist(page).locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) {
    await expect(await cell(hotlist(page), row, "Status")).toContainText("Active");
    await expect(row.getByText("Open to all teams")).toHaveCount(0);
    // Team-only candidates of other teams are not on this Hot List (team policy).
    await expect(await cell(hotlist(page), row, "Team")).toContainText(/^\s*Team Rohit\b/);
  }

  // Name search narrows the list (debounced).
  await page.getByLabel("Search name").fill("Cand1");
  await expect(page.getByLabel("Search name")).toHaveValue("Cand1");
  await expect.poll(async () => {
    const names = await hotlist(page).locator("tbody tr td b").allInnerTexts();
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
  await dlg.getByRole("combobox", { name: "Client", exact: true }).selectOption(CLIENT_ID);
  // Its own vendor: the seed has none, and the picker offers to add one.
  const vendor = `E2E Vendor ${run}`;
  const vendorBox = dlg.getByRole("combobox", { name: "Vendor", exact: true });
  await vendorBox.selectOption({ label: "Add a new vendor…" });
  await dlg.getByLabel("New vendor").fill(vendor);
  await dlg.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dlg.getByLabel("New vendor")).toBeHidden();
  await expect(vendorBox).not.toHaveValue("");
  await dlg.getByLabel("Rate per hour").fill("65");
  await dlg.getByRole("button", { name: "Log submission" }).click();

  // On a fresh database the first one is clean; on a repeat run it's already a duplicate.
  const done = page.getByRole("dialog", { name: "Submission logged" });
  await expect(dlg.or(done)).toHaveCount(1);
  await statusSaying(page, "Submission logged.");
  if (await done.isVisible()) await done.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Same candidate to the same client again: the server flags a likely duplicate.
  await page.getByRole("button", { name: "Log submission" }).click();
  dlg = page.getByRole("dialog", { name: `Log submission for ${name}` });
  await dlg.getByLabel("Job title").fill(`${job} (again)`);
  await dlg.getByRole("combobox", { name: "Client", exact: true }).selectOption(CLIENT_ID);
  await dlg.getByRole("combobox", { name: "Vendor", exact: true }).selectOption({ label: vendor });
  await dlg.getByLabel("Rate per hour").fill("65");
  await dlg.getByRole("button", { name: "Log submission" }).click();
  await expect(done.getByRole("alert")).toContainText("already submitted to this client in the last 90 days");
  await page.screenshot({ path: "e2e-artifacts/recruiter-duplicate-submission.png", fullPage: true });
  await done.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("alert")).toContainText("Possible duplicate");

  // Back to the list with the filters kept.
  await page.getByRole("button", { name: "← Back to Hot List" }).click();
  await expect(filter(page, "Status")).toHaveValue("Active");
  await expect(filter(page, "Visibility")).toHaveValue("Team only");
});

test("lead toggles a candidate's Open to all teams visibility", async ({ page }) => {
  await signIn(page, "Lead (Team Rohit)");
  await filterActiveTeamOnly(page);
  const name = await openFirstTeamRohitProfile(page);

  const sw = page.getByRole("switch", { name: "Open to all teams" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  const label = page.getByText("Open to all teams", { exact: true });
  const before = await label.count();
  await sw.click();
  await statusSaying(page, `${name} is now open to all teams.`);
  await expect(sw).toHaveAttribute("aria-checked", "true");
  // The header chip appears; it goes again on restore.
  await expect(label).not.toHaveCount(before);
  await page.screenshot({ path: "e2e-artifacts/lead-visibility.png", fullPage: true });

  // Restore, so the run is repeatable.
  await sw.click();
  await statusSaying(page, `${name} is now visible to your team only.`);
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(label).toHaveCount(before);
});
