import { expect, test } from "@playwright/test";
import { CLIENT_ID, apiAs, freshCandidate, login, screen, uniq } from "./support";

/**
 * Paperwork & BGC journey (docs/paperwork-api.md, migration 0044) against the
 * full stack with the dev seed, which publishes fictional sample templates
 * (apps/api/src/db/dev-pipeline.ts). A recruiter's fresh W2 placement gets the
 * sample checklist; HR receives and verifies an item and records the BGC as
 * initiated, and adds an employer row on the placement's paperwork page; the
 * recruiter then sees the progress and the BGC status in the placement drawer.
 */
const FORWARD = ["under_review", "interview_requested", "interview_scheduled", "interview_completed", "selected"];

test("HR works a placement's paperwork and BGC; the recruiter sees the progress", async ({ page, playwright, baseURL }) => {
  const r1a = await apiAs(playwright, baseURL, "r1a@eureka.example");
  const cand = await freshCandidate(r1a, "Pw");
  // New candidates start in training; a placement needs an active one.
  await r1a.send("POST", `/api/v1/candidates/${cand.id}/transition`, { to: "active" });
  const sub = await r1a.send("POST", "/api/v1/submissions", { candidateId: cand.id, clientId: CLIENT_ID, jobTitle: `Paperwork ${uniq()}` }, 201);
  for (const to of FORWARD) await r1a.send("PATCH", `/api/v1/submissions/${sub.id}/status`, { to });
  const start = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  const placement = await r1a.send("POST", "/api/v1/placements",
    { submissionId: sub.id, placementType: "w2", workMode: "remote", tentativeStart: start }, 201, { "Idempotency-Key": `e2e-${uniq()}` });
  const detail = await r1a.get(`/api/v1/placements/${placement.id}`);
  test.skip(!detail.checklist?.length, "no W2 paperwork template in this database (the dev seed publishes a fictional one)");
  const firstDoc = detail.checklist[0].docType as string;
  const firstLabel = firstDoc.charAt(0).toUpperCase() + firstDoc.slice(1).replace(/_/g, " ");

  // HR: the queue lists the new placement; open its paperwork.
  await login(page, "hr@eureka.example");
  await screen(page, "Paperwork & BGC");
  const queue = page.getByRole("table", { name: "Paperwork queue" });
  const row = queue.locator("tbody tr").filter({ hasText: cand.name });
  await expect(row).toBeVisible();
  await expect(row).toContainText(`0 of ${detail.checklist.length} done`);
  // The candidate name opens the placement's paperwork page.
  await row.getByRole("link", { name: cand.name }).click();
  await expect(page.getByRole("heading", { level: 1, name: cand.name })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/paperwork/${placement.id}`));

  await page.getByRole("tab", { name: "Checklist" }).click();
  for (const [status, label] of [["received", "Received"], ["verified", "Verified"]] as const) {
    await page.getByRole("button", { name: `Update ${firstLabel}` }).click();
    const dlg = page.getByRole("dialog", { name: `Update ${firstLabel}` });
    await dlg.getByRole("combobox", { name: "Status", exact: true }).selectOption(status);
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByText(`${firstLabel} marked ${label}.`)).toBeVisible();
    await expect(page.getByRole("table", { name: "Paperwork checklist" }).locator("tbody tr").first()).toContainText(label);
  }

  await page.getByRole("tab", { name: "Background check" }).click();
  await page.getByRole("button", { name: "Edit check details" }).click();
  await page.getByRole("textbox", { name: "BGC company", exact: true }).fill("Fictional Checks LLC");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Check details saved.")).toBeVisible();
  await page.getByRole("combobox", { name: "Move to", exact: true }).selectOption("initiated");
  await page.getByRole("button", { name: "Update status" }).click();
  await expect(page.getByText("Background check marked Initiated.")).toBeVisible();

  // Employment history as rows (PW-12).
  await page.getByRole("button", { name: "+ Add employer" }).click();
  const form = page.getByRole("form", { name: "Add employer" });
  await form.getByRole("textbox", { name: "Employer", exact: true }).fill("Fictional Corp");
  await form.getByLabel("From", { exact: true }).fill("2019-03");
  await form.getByRole("checkbox", { name: "Currently works here" }).check();
  await form.getByRole("textbox", { name: "Notes (optional)", exact: true }).fill("Fictional: confirmed by the vendor");
  await form.getByRole("button", { name: "Add employer" }).click();
  await expect(page.getByText("Fictional Corp added.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Employment history, newest first" })).toContainText("Fictional: confirmed by the vendor");

  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByRole("list", { name: "Background check history" })).toContainText("Not started → Initiated");

  // Recruiter: progress and BGC status in the placement drawer.
  await page.context().clearCookies();
  await login(page, "r1a@eureka.example");
  await screen(page, "Placements");
  const prow = page.getByRole("table", { name: "Placements" }).locator("tbody tr").filter({ hasText: cand.name });
  await prow.getByRole("button", { name: /^Open placement of / }).click();
  const pdrawer = page.getByRole("dialog", { name: new RegExp(`^${cand.name}`) });
  await expect(pdrawer.getByText(`1 of ${detail.checklist.length} done`, { exact: false })).toBeVisible();
  await expect(pdrawer.getByRole("heading", { name: "Background check" })).toBeVisible();
  await expect(pdrawer.getByText("Initiated", { exact: true })).toBeVisible();
  await r1a.dispose();
});
