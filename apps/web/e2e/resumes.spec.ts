import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { apiAs, freshCandidate, login, screen } from "./support";

/**
 * Resumes on the candidate profile (FR-CAN-07, design A6.5): upload through the
 * signed storage form, malware scan by the worker, then an audited download of
 * the clean copy. Needs the worker running (scripts/local-dev.sh starts it with
 * the local driver and the fake scanner, which flags the EICAR test string).
 */

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
/** The scan runs on the worker's job tick; allow a few ticks. */
const SCAN_TIMEOUT = 45_000;

async function openProfile(page: Page, name: string) {
  await screen(page, "Candidates");
  await page.getByRole("search", { name: "Candidates filters" }).getByLabel("Search name").fill(name.split(" ")[1]!);
  await page.getByRole("table", { name: "Candidates" }).getByRole("button", { name: `Open profile of ${name}` }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return page.getByRole("region", { name: "Resume" });
}

async function upload(page: Page, section: ReturnType<Page["getByRole"]>, name: string, body: Buffer) {
  await section.getByLabel("Resume file").setInputFiles({ name, mimeType: "application/pdf", buffer: body });
  await section.getByRole("button", { name: "Upload resume" }).click();
  await expect(section.getByText("Uploaded. Scanning for malware")).toBeVisible();
}

test("recruiter uploads a resume; after a clean scan it downloads as the same file", async ({ page, playwright, baseURL }) => {
  test.setTimeout(90_000);
  const r1a = await apiAs(playwright, baseURL, "r1a@eureka.example");
  const c = await freshCandidate(r1a, "Cv");
  await r1a.dispose();
  const file = Buffer.from(`%PDF-1.7\n% fictional resume of ${c.name}\n%%EOF\n`);

  await login(page, "r1a@eureka.example");
  const section = await openProfile(page, c.name);
  await expect(section.getByText("No resume yet.")).toBeVisible();
  await upload(page, section, "cv.pdf", file);
  await expect(section.getByText("Resume version 1 is ready.")).toBeVisible({ timeout: SCAN_TIMEOUT });
  await expect(section.getByText("Current: version 1")).toBeVisible();
  await expect(section.getByRole("table", { name: "Resume uploads, newest first" }).getByRole("row").nth(1)).toContainText("v1 (current)");

  const download = page.waitForEvent("download");
  await section.getByRole("button", { name: "Download current version" }).click();
  const d = await download;
  expect(d.suggestedFilename()).toMatch(/\.pdf$/);
  expect(d.suggestedFilename()).not.toContain("cv"); // the server names the file, not the uploader
  expect((await readFile(await d.path())).equals(file)).toBe(true);
});

test("a file carrying the EICAR test string is blocked and cannot be downloaded", async ({ page, playwright, baseURL }) => {
  test.setTimeout(90_000);
  const r1a = await apiAs(playwright, baseURL, "r1a@eureka.example");
  const c = await freshCandidate(r1a, "Eicar");
  await r1a.dispose();

  await login(page, "r1a@eureka.example");
  const section = await openProfile(page, c.name);
  await upload(page, section, "cv.pdf", Buffer.from(`%PDF-1.7\n${EICAR}\n%%EOF\n`));
  await expect(section.getByText("Upload not accepted. Blocked: malware found.")).toBeVisible({ timeout: SCAN_TIMEOUT });
  const row = section.getByRole("table", { name: "Resume uploads, newest first" }).getByRole("row").nth(1);
  await expect(row).toContainText("Blocked: malware found");
  await expect(row.getByRole("button", { name: /^Download/ })).toHaveCount(0);
  await expect(section.getByText("No resume yet.")).toBeVisible();

  // The server refuses a download link for it too.
  const { items } = await (await page.request.get(`/api/v1/candidates/${c.id}/resumes`)).json();
  const me = await (await page.request.get("/api/v1/me")).json();
  const res = await page.request.post(`/api/v1/candidates/${c.id}/resumes/${items[0].id}/download`, { headers: { "x-csrf-token": me.csrfToken } });
  expect(res.status()).toBe(409);
});
