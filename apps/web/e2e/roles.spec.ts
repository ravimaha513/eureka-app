import { expect, test, type Page } from "@playwright/test";
import { cell, expectMaskedPhone } from "./support";

async function signIn(page: Page, label: string) {
  await page.goto("/");
  await page.getByLabel("Sign in as").selectOption({ label });
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("complementary", { name: "Main navigation" })).toBeVisible();
}

// Hot List is team-scoped (Eureka App 4): the user's own team plus candidates
// open to all teams; contact details stay masked outside the user's own scope.
test("recruiter sees the team's Hot List plus Open to all teams, other teams' phones masked", async ({ page }) => {
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
    if (team !== "Team Rohit") {
      await expectMaskedPhone(await cell(table, row, "Phone"));
      await expect(row.getByText("Open to all teams")).toBeVisible();
    }
  }
  expect(teams.has("Team Rohit")).toBe(true);
  await page.screenshot({ path: "e2e-artifacts/recruiter-hotlist.png", fullPage: true });
});

test("location admin sees the Dallas Hot List only", async ({ page }) => {
  await signIn(page, "Location Ops Admin (Dallas)");
  const table = page.getByRole("table", { name: "Hot List" });
  const rows = table.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) {
    await expect(await cell(table, row, "Location")).toHaveText("Dallas");
  }
  await page.screenshot({ path: "e2e-artifacts/location-admin-hotlist.png", fullPage: true });
});

test("org admin gets the admin screen and no business data", async ({ page }) => {
  await signIn(page, "Org Admin");
  const nav = page.getByRole("complementary", { name: "Main navigation" });
  await expect(nav.getByRole("button", { name: "Users & Access" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Hot List" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Candidates" })).toHaveCount(0);
  expect((await page.request.get("/api/v1/candidates")).status()).toBe(403);
  expect((await page.request.get("/api/v1/hotlist")).status()).toBe(403);
});
