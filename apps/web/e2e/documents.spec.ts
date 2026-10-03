import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { apiAs, freshCandidate, login, screen } from "./support";

/**
 * Restricted documents (FR-PPR-01 to 03; design A6.1, A6.3; implementation plan
 * Phase 3 "Playwright: HR opens a restricted document with step-up"). Needs the
 * worker running (scan and promotion) and the development step-up
 * (scripts/local-dev.sh: AUTH_MODE=dev, and the dev seed turns on the database
 * switch dev_step_up).
 */
const SCAN_TIMEOUT = 45_000;

async function openDocuments(page: Page, name: string) {
  await screen(page, "Candidates");
  await page.getByRole("search", { name: "Candidates filters" }).getByLabel("Search name").fill(name.split(" ")[1]!);
  await page.getByRole("table", { name: "Candidates" }).getByRole("button", { name: `Open profile of ${name}` }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return page.getByRole("region", { name: "Paperwork documents" });
}

test("HR opens a restricted document with step-up; the opening is in the access log; a recruiter never sees it", async ({ page, playwright, baseURL }) => {
  test.setTimeout(120_000);
  const r1a = await apiAs(playwright, baseURL, "r1a@eureka.example");
  const c = await freshCandidate(r1a, "Docs");
  const file = Buffer.from(`%PDF-1.7\n% fictional Form I-9 of ${c.name}\n%%EOF\n`);

  await login(page, "hr@eureka.example");
  const section = await openDocuments(page, c.name);
  await expect(section.getByText("No documents yet.")).toBeVisible();
  await section.getByRole("combobox", { name: "Document type", exact: true }).selectOption({ label: "Form I-9 (restricted)" });
  await section.getByLabel("Document file").setInputFiles({ name: "i9-scan.pdf", mimeType: "application/pdf", buffer: file });
  await section.getByRole("button", { name: "Upload document" }).click();
  await expect(section.getByText("Uploaded. Scanning for malware")).toBeVisible();
  await expect(section.getByText("Form I-9 is ready.")).toBeVisible({ timeout: SCAN_TIMEOUT });
  const row = section.getByRole("table", { name: "Paperwork documents, newest first" }).getByRole("row").nth(1);
  await expect(row).toContainText("Restricted");

  // Opening needs a fresh confirmation (step-up) first.
  await row.getByRole("button", { name: "Open Form I-9" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Confirm (development)" }).click();
  const d = await download;
  await expect(dialog).toBeHidden();
  expect(d.suggestedFilename()).toMatch(/^i9-[0-9a-f]{8}\.pdf$/);
  expect((await readFile(await d.path())).equals(file)).toBe(true);

  // Within the step-up window a second opening needs no new confirmation.
  const again = page.waitForEvent("download");
  await row.getByRole("button", { name: "Open Form I-9" }).click();
  await again;
  await expect(page.getByRole("dialog", { name: "Confirm it's you" })).toHaveCount(0);

  // Every opening is in the access log.
  await row.getByRole("button", { name: "Access log for Form I-9" }).click();
  const log = page.getByRole("dialog", { name: "Access log: Form I-9" });
  await expect(log.getByRole("table", { name: "Access log, newest first" }).getByRole("row")).toHaveCount(3);
  await expect(log.getByRole("row").nth(1)).toContainText("hr");
  await expect(log.getByRole("row").nth(1)).toContainText("Signed in again");
  await log.getByRole("button", { name: "Close" }).click();

  // The recruiter who owns the candidate does not see the restricted document at all.
  const docs = await r1a.get(`/api/v1/candidates/${c.id}/documents`);
  expect(docs.items).toEqual([]);
  expect(docs.canUploadRestricted).toBe(false);
  await r1a.dispose();
});
