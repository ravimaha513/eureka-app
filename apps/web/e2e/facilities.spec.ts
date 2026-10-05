import { expect, test, type Page } from "@playwright/test";
import { localDay, login, screen, uniq } from "./support";

/**
 * Companies and facilities (Phase 3b): the Dallas Location Ops Admin manages the group's
 * own companies and rented guest houses, their utilities (portal passwords behind
 * "Confirm it's you") and bills. Seed (dev seed): company "Eureka Info Tech" and facility
 * "Guest House 2013" in Dallas. Every journey creates its own utilities, bills and
 * facilities with unique names, so runs don't depend on each other. Needs the
 * development step-up (scripts/local-dev.sh: AUTH_MODE=dev, dev_step_up switch on).
 */
const OPS = "locD@eureka.example";

async function openDetails(page: Page, kind: "company" | "facility", name: string) {
  const list = page.getByRole("region", { name: kind === "company" ? "Companies List" : "Facilities List" });
  await list.getByRole("searchbox").fill(name);
  await list.getByRole("button", { name: `Open ${kind} ${name}`, exact: true }).click();
  const drawer = page.getByRole("dialog", { name: kind === "company" ? "Company details" : "Facility details" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(name, { exact: true })).toBeVisible();
  return drawer;
}

test("ops admin adds a utility, reveals its password after step-up, adds and voids a bill", async ({ page }) => {
  test.setTimeout(90_000);
  const provider = `E2E Power ${uniq()}`;
  const password = `Pw-${uniq()}`;
  await login(page, OPS);
  await screen(page, "Companies");
  await expect(page.getByRole("region", { name: "Companies at a glance" })).toContainText("Total companies");
  await expect(page.getByRole("link", { name: "Export companies as CSV" })).toHaveAttribute("href", "/api/v1/companies/export.csv");

  const drawer = await openDetails(page, "company", "Eureka Info Tech");
  await expect(drawer.getByRole("tab")).toHaveText(["Overview", "Employees", "Incharges", "Utilities", "Bills"]);

  // Add a utility with a portal password; the list never shows it.
  await drawer.getByRole("tab", { name: "Utilities" }).click();
  await drawer.getByRole("button", { name: "Add utility" }).click();
  const add = page.getByRole("dialog", { name: "Add utility" });
  await add.getByLabel("Account number").fill(`ACC-${uniq()}`);
  await add.getByLabel("Username").fill("eureka-ops");
  await add.getByLabel("Password", { exact: true }).fill(password);
  await add.getByLabel("Utility type").selectOption({ label: "Electricity" });
  await add.getByLabel("Service provider").fill(provider);
  await add.getByLabel("Website URL").fill("https://power.example/login");
  await add.getByRole("button", { name: "Submit" }).click();
  await expect(add).toBeHidden();
  await expect(drawer.getByText("Utility added.")).toBeVisible();
  const row = drawer.getByRole("table", { name: "Utilities" }).getByRole("row").filter({ hasText: provider });
  await expect(row.getByLabel("Password hidden")).toBeVisible();
  await expect(page.getByText(password)).toHaveCount(0);

  // Reveal asks to confirm it's you first (unless this session already did), then shows it.
  await row.getByRole("button", { name: "Reveal password for Electricity" }).click();
  const stepUp = page.getByRole("dialog", { name: "Confirm it's you" });
  const shown = row.getByText(password, { exact: true });
  await expect(stepUp.or(shown)).toBeVisible();
  if (await stepUp.isVisible()) {
    await stepUp.getByRole("button", { name: "Confirm (development)" }).click();
    await expect(stepUp).toBeHidden();
  }
  await expect(shown).toBeVisible();
  await row.getByRole("button", { name: "Hide password for Electricity" }).click();
  await expect(page.getByText(password)).toHaveCount(0);

  // Add a bill for it, then void it with a reason.
  await drawer.getByRole("tab", { name: "Bills" }).click();
  await drawer.getByRole("button", { name: "Add bill" }).click();
  const bill = page.getByRole("dialog", { name: "Add bill" });
  await bill.getByLabel("Utility").selectOption({ label: `Electricity · ${provider}` });
  await bill.getByLabel("Payment method").selectOption({ label: "ACH" });
  await bill.getByLabel("Amount").fill("123.45");
  const today = localDay(new Date());
  await bill.getByLabel("Billing start").fill(today);
  await bill.getByLabel("Billing end").fill(today);
  await bill.getByLabel("Due date").fill(today);
  await bill.getByRole("button", { name: "Add bill" }).click();
  await expect(bill).toBeHidden();
  await drawer.getByRole("searchbox", { name: "Search bills" }).fill(provider);
  const billRow = drawer.getByRole("table", { name: "Bills" }).getByRole("row").filter({ hasText: provider });
  await expect(billRow).toContainText("$123.45");
  await expect(billRow).toContainText(/Due|Overdue/);
  await billRow.getByRole("button", { name: /^Void Electricity bill due/ }).click();
  const voiding = page.getByRole("dialog", { name: "Void bill" });
  await voiding.getByLabel("Reason").fill("E2E: entered twice");
  await voiding.getByRole("button", { name: "Void bill" }).click();
  await expect(voiding).toBeHidden();
  await expect(drawer.getByText(/was voided\./)).toBeVisible();
  await expect(billRow).toHaveCount(0);
});

test("ops admin adds a facility through the 3-column form and opens the seeded guest house", async ({ page }) => {
  const name = `E2E Guest House ${uniq()}`;
  await login(page, OPS);
  await screen(page, "Facilities");
  await page.getByRole("button", { name: "Add facility" }).click();
  const dialog = page.getByRole("dialog", { name: "Add facility" });
  await dialog.getByRole("button", { name: "Add facility" }).click();
  await expect(dialog.getByText("Enter the facility name.")).toBeVisible();
  await dialog.getByLabel("Facility name").fill(name);
  await dialog.getByLabel("Street").fill("1 Test Way");
  await dialog.getByLabel("City").fill("Irving");
  await dialog.getByLabel("State").fill("TX");
  await dialog.getByLabel("Zip code").fill("75039");
  await dialog.getByLabel("Rent").fill("1800");
  await dialog.getByLabel("Fee frequency").selectOption("monthly");
  await dialog.getByLabel("Capacity").fill("4");
  await dialog.getByLabel("Beds").fill("2");
  await dialog.getByLabel("Baths").fill("1.5");
  await dialog.getByRole("button", { name: "Add facility" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`${name} added.`)).toBeVisible();
  const list = page.getByRole("region", { name: "Facilities List" });
  await list.getByRole("searchbox").fill(name);
  const row = list.getByRole("row").filter({ hasText: name });
  await expect(row).toContainText("$1,800.00/mo");
  await expect(row.getByText("Active")).toBeVisible();

  await list.getByRole("searchbox").fill("");
  const drawer = await openDetails(page, "facility", "Guest House 2013");
  await expect(drawer.getByRole("tab")).toHaveText(["Overview", "Incharges", "Utilities", "Bills"]);
  await expect(drawer.getByRole("tabpanel")).toContainText("Rent");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("a recruiter has no Companies or Facilities screen", async ({ page }) => {
  await login(page, "r1a@eureka.example");
  const nav = page.getByRole("complementary", { name: "Main navigation" });
  await expect(nav.getByRole("button", { name: "Hot List", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Companies", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Facilities", exact: true })).toHaveCount(0);
});
