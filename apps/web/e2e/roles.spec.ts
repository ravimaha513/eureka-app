import { expect, test, type Page } from "@playwright/test";
import { cell } from "./support";

async function signIn(page: Page, label: string) {
  await page.goto("/");
  await page.getByLabel("Development sign-in (fictional users)").selectOption({ label });
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("complementary", { name: "Main navigation" })).toBeVisible();
}

// Hot List is open to every signed-in user (OD-01); contact details stay masked
// outside the user's own scope.
test("recruiter sees the whole Hot List with other teams' phones masked", async ({ page }) => {
  await signIn(page, "Recruiter (Team Rohit)");
  const nav = page.getByRole("complementary", { name: "Main navigation" });
  await expect(nav.getByRole("button", { name: "Hot List" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Users & Access" })).toHaveCount(0);
  const table = page.getByRole("table", { name: "Hot List" });
  const rows = table.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  const teams = new Set<string>();
  for (const row of await rows.all()) {
    const team = await (await cell(table, row, "Team")).innerText();
    teams.add(team);
    if (team !== "Team Rohit") await expect(await cell(table, row, "Phone")).toHaveClass(/masked/);
  }
  expect(teams.size).toBeGreaterThan(1);
  await page.screenshot({ path: "e2e-artifacts/recruiter-hotlist.png", fullPage: true });
});

test("location admin sees all locations, with phones only for Dallas", async ({ page }) => {
  await signIn(page, "Location Ops Admin (Dallas)");
  const table = page.getByRole("table", { name: "Hot List" });
  const rows = table.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  const locations = new Set<string>();
  for (const row of await rows.all()) {
    const location = await (await cell(table, row, "Location")).innerText();
    locations.add(location);
    if (location !== "Dallas") await expect(await cell(table, row, "Phone")).toHaveClass(/masked/);
  }
  expect(locations.size).toBeGreaterThan(1);
  await page.screenshot({ path: "e2e-artifacts/location-admin-hotlist.png", fullPage: true });
});

test("org admin gets the admin screen and the masked Hot List, nothing else", async ({ page }) => {
  await signIn(page, "Org Admin");
  const nav = page.getByRole("complementary", { name: "Main navigation" });
  await expect(nav.getByRole("button", { name: "Users & Access" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Hot List" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Candidates" })).toHaveCount(0);
  expect((await page.request.get("/api/v1/candidates")).status()).toBe(403);
  const table = page.getByRole("table", { name: "Hot List" });
  const rows = table.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) await expect(await cell(table, row, "Phone")).toHaveClass(/masked/);
});
