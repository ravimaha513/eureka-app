import { expect, test } from "@playwright/test";
import { CLIENT_ID, apiAs, freshCandidate, login, screen, uniq } from "./support";

/**
 * Paperwork & BGC journey (docs/paperwork-api.md, migration 0044) against the
 * full stack with the dev seed, which publishes fictional sample templates
 * (apps/api/src/db/dev-pipeline.ts). A recruiter's fresh W2 placement gets the
 * sample checklist; HR receives and verifies an item and records the BGC as
 * initiated on the Paperwork & BGC screen; the recruiter then sees the progress
 * and the BGC status in the placement drawer.
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
  await row.getByRole("button", { name: `Open paperwork of ${cand.name}` }).click();
  const drawer = page.getByRole("dialog", { name: `Paperwork · ${cand.name}` });
  await expect(drawer).toBeVisible();

  for (const [status, label] of [["received", "Received"], ["verified", "Verified"]] as const) {
    await drawer.getByRole("button", { name: `Update ${firstLabel}` }).click();
    const dlg = page.getByRole("dialog", { name: `Update ${firstLabel}` });
    await dlg.getByRole("combobox", { name: "Status", exact: true }).selectOption(status);
    await dlg.getByRole("button", { name: "Save" }).click();
    await expect(dlg).toBeHidden();
    await expect(drawer.getByRole("status")).toHaveText(`${firstLabel} marked ${label}.`);
  }

  await drawer.getByRole("button", { name: "Update background check" }).click();
  const bgc = page.getByRole("dialog", { name: "Update background check" });
  await bgc.getByRole("combobox", { name: "Status", exact: true }).selectOption("initiated");
  await bgc.getByRole("textbox", { name: "BGC company" }).fill("Fictional Checks LLC");
  await bgc.getByRole("button", { name: "Save" }).click();
  await expect(bgc).toBeHidden();
  await expect(drawer.getByRole("status")).toHaveText("Background check marked Initiated.");
  await expect(drawer.getByRole("list", { name: "Background check history" })).toContainText("Not started → Initiated");
  await page.keyboard.press("Escape");

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
