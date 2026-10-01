import { expect, test, type Page } from "@playwright/test";
import { DALLAS, JAVA, apiAs, freshCandidate, login, screen, uniq, type Api } from "./support";

/**
 * Candidate extras (FR-CAN-02, 09, 10; migrations 0026/0032): the batch filter
 * on Candidates, the timeline on the profile, and the duplicate warning when
 * creating a candidate. Each test creates its own batch and candidates.
 */

/** A new planned batch in a month nobody else is likely to use (retries on a clash). */
async function freshBatch(lead: Api): Promise<{ id: string; label: string }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const year = 2040 + Math.floor(Math.random() * 60);
    const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
    const created = await lead.send("POST", "/api/v1/batches", { locationId: DALLAS, technologyId: JAVA, startMonth: `${year}-${month}` }).catch(() => null);
    if (!created) continue;
    const { items } = await lead.get(`/api/v1/batches?locationId=${DALLAS}`);
    return items.find((b: { id: string }) => b.id === created.id);
  }
  throw new Error("could not create a batch");
}

const candidatesTable = (page: Page) => page.getByRole("table", { name: "Candidates" });

test("batch filter on Candidates, and the batch and timeline on the profile", async ({ page, playwright, baseURL }) => {
  const l1 = await apiAs(playwright, baseURL, "l1@eureka.example");
  const r1a = await apiAs(playwright, baseURL, "r1a@eureka.example");
  const batch = await freshBatch(l1);
  const inBatch = await freshCandidate(r1a, "Batch");
  const outside = await freshCandidate(r1a, "Batch");
  await r1a.send("PATCH", `/api/v1/candidates/${inBatch.id}`, { batchId: batch.id, priority: "P1" });
  await r1a.send("POST", `/api/v1/candidates/${inBatch.id}/transition`, { to: "active" });
  await Promise.all([l1.dispose(), r1a.dispose()]);

  await login(page, "r1a@eureka.example");
  await screen(page, "Candidates");
  const search = page.getByRole("search", { name: "Candidates filters" });
  await search.getByRole("combobox", { name: "Batch", exact: true }).selectOption({ label: batch.label });
  const rows = candidatesTable(page).locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(inBatch.name);
  await expect(candidatesTable(page).getByText(outside.name)).toHaveCount(0);

  await rows.getByRole("button", { name: `Open profile of ${inBatch.name}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: inBatch.name })).toBeVisible();
  const details = page.getByRole("region", { name: "Details" });
  await expect(details.locator("dt", { hasText: "Batch" }).locator("+ dd")).toHaveText(batch.label);

  // Newest first: status change, batch assignment, creation.
  const timeline = page.getByRole("list", { name: "Candidate activity, newest first" });
  const events = timeline.getByRole("listitem");
  await expect(events.filter({ hasText: "Status changed from In training to Active" })).toHaveCount(1);
  await expect(events.filter({ hasText: `Added to batch ${batch.label}` })).toHaveCount(1);
  await expect(events.filter({ hasText: "Candidate created" })).toHaveCount(1);
  await expect(events.first()).toContainText("Status changed from In training to Active");
  await expect(events.last()).toContainText("Candidate created");
  await expect(events.last()).toContainText("r1a");

  // The other candidate has no batch and only its creation on the timeline.
  await page.getByRole("button", { name: /^← Back to / }).click();
  await search.getByRole("combobox", { name: "Batch", exact: true }).selectOption({ label: "Any batch" });
  await search.getByLabel("Search name").fill(outside.name.split(" ")[1]!);
  await candidatesTable(page).getByRole("button", { name: `Open profile of ${outside.name}` }).click();
  await expect(page.getByRole("region", { name: "Details" }).locator("dt", { hasText: "Batch" }).locator("+ dd")).toHaveText("No batch");
  await expect(page.getByRole("list", { name: "Candidate activity, newest first" }).getByRole("listitem")).toHaveCount(1);
});

async function openNewCandidate(page: Page) {
  await screen(page, "Candidates");
  await page.getByRole("button", { name: "New candidate" }).click();
  const dialog = page.getByRole("dialog", { name: "New candidate" });
  await expect(dialog.getByRole("combobox", { name: "Technology", exact: true })).toBeEnabled();
  return dialog;
}

test("duplicate warning on create: another team's match can be created anyway", async ({ page, playwright, baseURL }) => {
  const email = `e2e-dup-${uniq()}@example.test`;
  // Team Vikram's lead holds a candidate with this email; r1a cannot open that profile.
  const l3 = await apiAs(playwright, baseURL, "l3@eureka.example");
  const existing = await freshCandidate(l3, "DupOther", { email });
  await l3.dispose();

  await login(page, "r1a@eureka.example");
  const dialog = await openNewCandidate(page);
  const last = uniq();
  await dialog.getByLabel("First name").fill("E2EDupNew");
  await dialog.getByLabel("Last name").fill(last);
  await dialog.getByLabel("Personal email (optional)").fill(email.toUpperCase());
  await dialog.getByRole("combobox", { name: "Technology", exact: true }).selectOption({ label: "Java" });
  await dialog.getByRole("combobox", { name: "Location", exact: true }).selectOption({ label: "Dallas" });
  await dialog.getByRole("button", { name: "Create candidate" }).click();

  const warning = dialog.getByRole("alert").filter({ hasText: "Possible duplicate." });
  await expect(warning).toContainText("A candidate with the same email already exists.");
  await expect(warning).toContainText("Same email: Team Vikram, contact l3");
  await expect(warning.getByRole("button", { name: "Open existing profile" })).toHaveCount(0);
  expect((await page.request.get(`/api/v1/candidates/${existing.id}`)).status()).toBe(404);

  await dialog.getByRole("button", { name: "Create anyway" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: `E2EDupNew ${last}` })).toBeVisible();
});

test("duplicate warning on create: a teammate's match links to the existing profile", async ({ page, playwright, baseURL }) => {
  const email = `e2e-dup-${uniq()}@example.test`;
  const r1b = await apiAs(playwright, baseURL, "r1b@eureka.example");
  const existing = await freshCandidate(r1b, "DupTeam", { email });
  await r1b.dispose();

  await login(page, "r1a@eureka.example");
  const dialog = await openNewCandidate(page);
  await dialog.getByLabel("First name").fill("E2EDupNew");
  await dialog.getByLabel("Last name").fill(uniq());
  await dialog.getByLabel("Personal email (optional)").fill(email);
  await dialog.getByRole("combobox", { name: "Technology", exact: true }).selectOption({ label: "Java" });
  await dialog.getByRole("combobox", { name: "Location", exact: true }).selectOption({ label: "Dallas" });
  await dialog.getByRole("button", { name: "Create candidate" }).click();

  const warning = dialog.getByRole("alert").filter({ hasText: "Possible duplicate." });
  await expect(warning).toContainText("Same email: Team Rohit");
  await warning.getByRole("button", { name: "Open existing profile" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: existing.name })).toBeVisible();
});
