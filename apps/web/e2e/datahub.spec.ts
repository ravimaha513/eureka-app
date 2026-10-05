import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { apiAs, login, screen, uniq } from "./support";

/**
 * DataHub (docs/datahub-api.md; reference screen "DataHub"): HR creates a
 * Restricted folder naming themself, uploads a file (presigned POST, malware
 * scan by the worker), downloads it after "Confirm it's you" and finds the
 * download in the folder's access log; a recruiter who is not a member never
 * sees the folder. Needs the worker (scan) and the development step-up
 * (scripts/local-dev.sh: AUTH_MODE=dev; the dev seed turns on dev_step_up).
 */
const SCAN_TIMEOUT = 45_000;

test("HR creates a restricted folder, uploads, downloads with step-up; the access log records it; others never see it", async ({ page, playwright, baseURL }) => {
  test.setTimeout(120_000);
  const name = `E2E Payroll ${uniq()}`;
  const fileName = `June-${uniq()}.pdf`;
  const body = Buffer.from(`%PDF-1.7\n% fictional payroll export ${name}\n%%EOF\n`);

  await login(page, "hr@eureka.example");
  await screen(page, "DataHub");
  await expect(page.getByText("Secure document management and collaboration")).toBeVisible();

  // Create New Folder: the reference dialog's fields; Restricted asks for people.
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create New Folder" });
  await dialog.getByLabel("Folder name *").fill(name);
  await dialog.getByRole("combobox", { name: "Security level", exact: true }).selectOption({ label: "Restricted – Limited access" });
  await dialog.getByRole("searchbox", { name: "People" }).fill("hr");
  await dialog.getByRole("button", { name: "Add hr", exact: true }).click();
  await dialog.getByLabel("Description (Optional)").fill("Fictional payroll exports for the e2e journey");
  await dialog.getByRole("button", { name: "Create Folder" }).click();
  await expect(dialog).toBeHidden();

  const folders = page.getByRole("list", { name: "Folders" });
  const folderButton = folders.getByRole("button", { name: new RegExp(name) });
  await expect(folderButton).toContainText("Restricted");
  await expect(folderButton).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();

  // Upload with progress; the file opens after the scan.
  await page.getByRole("button", { name: "Upload to folder" }).click();
  const up = page.getByRole("dialog", { name: "Upload a file" });
  await up.getByLabel("File", { exact: true }).setInputFiles({ name: fileName, mimeType: "application/pdf", buffer: body });
  await up.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(up).toBeHidden();
  await expect(page.getByText(`${fileName} is ready.`)).toBeVisible({ timeout: SCAN_TIMEOUT });
  const row = page.getByRole("table", { name: `Files in ${name}` }).getByRole("row").filter({ hasText: fileName });
  await expect(row).toContainText("v1");
  await expect(row).toContainText("Clean");

  // A restricted download asks to confirm it's you first.
  await row.getByRole("button", { name: `Download ${fileName}` }).click();
  const stepUp = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(stepUp).toContainText("This file is in a restricted folder.");
  const download = page.waitForEvent("download");
  await stepUp.getByRole("button", { name: "Confirm (development)" }).click();
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/^June-[a-z0-9]+-v1\.pdf$/);
  expect((await readFile(await d.path())).equals(body)).toBe(true);

  // The download is in the folder's access log.
  await page.getByRole("button", { name: "Access log" }).click();
  const log = page.getByRole("dialog", { name: `Access log: ${name}` });
  const entries = log.getByRole("table", { name: "Access log, newest first" }).getByRole("row");
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(1)).toContainText(fileName);
  await expect(entries.nth(1)).toContainText("Signed in again");
  await log.getByRole("button", { name: "Close" }).click();

  // Search finds it for HR; a recruiter who is not a member sees neither the folder nor the file.
  await page.getByRole("searchbox", { name: "Search documents" }).fill(fileName.slice(0, 10));
  await expect(page.getByRole("table", { name: "Matching files" }).getByRole("cell", { name: fileName, exact: true })).toBeVisible();
  const r2a = await apiAs(playwright, baseURL, "r2a@eureka.example");
  const visible = await r2a.get("/api/v1/datahub/folders");
  expect(visible.items.map((f: { name: string }) => f.name)).not.toContain(name);
  expect((await r2a.get(`/api/v1/datahub/search?q=${encodeURIComponent(fileName)}`)).files).toEqual([]);
  await r2a.dispose();
});

test("phone layout: panels stack and the page never scrolls sideways", async ({ page }) => {
  await login(page, "r1a@eureka.example");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Menu" }).click();
  await screen(page, "DataHub");
  await expect(page.getByRole("heading", { level: 2, name: "Folders" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const folders = await page.locator(".dh-folders").boundingBox();
  const files = await page.locator(".dh-files").boundingBox();
  expect(files!.y).toBeGreaterThan(folders!.y + folders!.height - 1);
});
