import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, label: string) {
  await page.goto("/");
  await page.getByLabel("Development sign-in (fictional users)").selectOption({ label });
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("complementary", { name: "Main navigation" })).toBeVisible();
}

test("recruiter sees their team's Hot List with other teams' phones masked", async ({ page }) => {
  await signIn(page, "Recruiter (Team Rohit)");
  const nav = page.getByRole("complementary", { name: "Main navigation" });
  await expect(nav.getByRole("button", { name: "Hot List" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Users & Access" })).toHaveCount(0);
  const rows = page.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  // Every row is either Team Rohit's or an Open-to-all-teams candidate; others' phones are masked.
  for (const row of await rows.all()) {
    const team = await row.locator("td").nth(4).innerText();
    const phone = row.locator("td").nth(7);
    if (team !== "Team Rohit") {
      await expect(row.getByText("all teams")).toBeVisible();
      await expect(phone).toHaveClass(/masked/);
    }
  }
  await page.screenshot({ path: "e2e-artifacts/recruiter-hotlist.png", fullPage: true });
});

test("location admin sees only Dallas candidates", async ({ page }) => {
  await signIn(page, "Location Ops Admin (Dallas)");
  const locations = await page.locator("tbody tr td:nth-child(7)").allInnerTexts();
  expect(locations.length).toBeGreaterThan(0);
  expect(new Set(locations)).toEqual(new Set(["Dallas"]));
  await page.screenshot({ path: "e2e-artifacts/location-admin-hotlist.png", fullPage: true });
});

test("org admin gets the admin screen and no business data", async ({ page }) => {
  await signIn(page, "Org Admin");
  const nav = page.getByRole("complementary", { name: "Main navigation" });
  await expect(nav.getByRole("button", { name: "Users & Access" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Hot List" })).toHaveCount(0);
  const res = await page.request.get("/api/v1/hotlist");
  expect(res.status()).toBe(403);
});
