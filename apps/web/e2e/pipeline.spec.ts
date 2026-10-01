import { expect, test, type Page } from "@playwright/test";

/**
 * Pipeline journey against the full stack with the dev seed (apps/api/test/fixtures.ts)
 * and the placements contract (docs/placements-api.md): a recruiter moves a fresh
 * submission forward to Selected, creates a placement from it and finds it in Placements.
 * Each run uses its own job title; creating the placement moves the candidate to
 * Confirmation, so a run consumes one active candidate owned by the recruiter.
 */

/** Seeded client "Northwind Financial" (fixtures CLIENT_ID). */
const CLIENT_ID = "00000000-0000-0000-0000-000000000601";
const RECRUITER = "r1a@eureka.example";
const FORWARD = ["Under review", "Interview requested", "Interview scheduled", "Interview completed", "Selected"];

async function login(page: Page, email: string) {
  await page.goto("/");
  const response = await page.request.post("/api/auth/dev-login", { data: { email } });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Main navigation" })).toBeVisible();
}

async function screenFor(page: Page, name: string) {
  await page.getByRole("complementary", { name: "Main navigation" }).getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
}

test("recruiter moves a submission to Selected, creates a placement and sees it in Placements", async ({ page }) => {
  await login(page, RECRUITER);
  const me = await (await page.request.get("/api/v1/me")).json();
  const list = await (await page.request.get("/api/v1/candidates?status=active&limit=100")).json();
  const candidate = list.items.find((c: { recruiter: { id: string } | null }) => c.recruiter?.id === me.id);
  test.skip(!candidate, "no active candidate owned by the recruiter is left in this database");
  const jobTitle = `Pipeline journey ${Date.now().toString(36)}`;
  const created = await page.request.post("/api/v1/submissions", {
    headers: { "x-csrf-token": me.csrfToken }, data: { candidateId: candidate.id, clientId: CLIENT_ID, jobTitle },
  });
  expect(created.ok()).toBeTruthy();

  // Submissions: open the new submission and step it forward with the offered actions.
  await screenFor(page, "Submissions");
  const row = page.getByRole("table", { name: "Submissions" }).locator("tbody tr").filter({ hasText: jobTitle });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /^Open submission of / }).click();
  const drawer = page.getByRole("dialog", { name: new RegExp(jobTitle) });
  await expect(drawer).toBeVisible();
  for (const step of FORWARD) {
    await drawer.getByRole("button", { name: `Move to ${step}`, exact: true }).click();
    await expect(drawer.getByRole("status")).toHaveText(`Status changed to ${step}.`);
  }
  await expect(drawer.getByRole("group", { name: "Change status" })).toHaveCount(0);

  // Create the placement from the selected submission.
  await drawer.getByRole("button", { name: "Create placement" }).click();
  const dialog = page.getByRole("dialog", { name: /^Create placement · / });
  await dialog.getByLabel("Placement type").selectOption({ label: "C2C" });
  await dialog.getByLabel("Work mode").selectOption({ label: "Hybrid" });
  await dialog.getByLabel("Project city (optional)").fill("Dallas");
  await dialog.getByLabel("Project state (optional)").fill("TX");
  const start = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  await dialog.getByLabel("Tentative start date").fill(start);
  await dialog.getByLabel("Rate per hour (optional)").fill("70");
  await dialog.getByRole("button", { name: "Add contact" }).click();
  const contact = dialog.getByRole("group", { name: "Contact 1" });
  await contact.getByLabel("Kind").selectOption({ label: "Vendor POC" });
  await contact.getByLabel("Name").fill("Pat Lee");
  await contact.getByLabel("Email (optional)").fill("pat.lee@vendor.example");
  await dialog.getByRole("button", { name: "Create placement" }).click();
  await expect(dialog).toBeHidden();
  await expect(drawer.getByRole("status")).toContainText(`Placement created for ${candidate.name}.`);
  // Offered again only while no active placement exists.
  await expect(drawer.getByRole("button", { name: "Create placement" })).toHaveCount(0);

  // Placements: the new placement opens with its contact; recruiters don't hold rate:read, so no rate.
  await drawer.getByRole("button", { name: "Open the new placement" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Placements" })).toBeVisible();
  const placement = page.getByRole("dialog", { name: `${candidate.name} · Northwind Financial` });
  await expect(placement).toBeVisible();
  await expect(placement.getByText("Confirmed", { exact: true })).toBeVisible();
  await expect(placement.getByRole("table", { name: "Contacts" })).toContainText("Pat Lee");
  await expect(placement.getByText("Rate", { exact: true })).toHaveCount(0);
  await expect(placement.getByRole("button", { name: "Move to Paperwork" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(placement).toBeHidden();

  const placements = page.getByRole("table", { name: "Placements" });
  await expect(placements.locator("tbody tr").filter({ hasText: candidate.name }).first()).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Rate" })).toHaveCount(0);
});
