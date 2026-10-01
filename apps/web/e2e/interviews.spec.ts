import { expect, test, type Page } from "@playwright/test";

// Uses seeded Team Anjali, which is coached by the fixture interview coach.
async function login(page: Page, email: string) {
  await page.goto("/");
  const response = await page.request.post("/api/auth/dev-login", { data: { email } });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("complementary", { name: "Main navigation" })).toBeVisible();
}
async function board(page: Page, day?: string) {
  await page.getByRole("complementary", { name: "Main navigation" }).getByRole("button", { name: "Interviews", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Interviews", exact: true })).toBeVisible();
  if (day) {
    await page.getByLabel("From date", { exact: true }).fill(day);
    await page.getByLabel("Through date", { exact: true }).fill(day);
  }
}

test("recruiter schedules, location clears and coach records feedback", async ({ page }) => {
  await login(page, "r2a@eureka.example");
  const me = await (await page.request.get("/api/v1/me")).json();
  const candidates = await (await page.request.get("/api/v1/candidates?status=active&limit=100")).json();
  const candidate = candidates.items.find((c: { recruiter: { id: string } | null; location: { name: string } }) => c.recruiter?.id === me.id && c.location.name === "Dallas");
  expect(candidate).toBeTruthy();
  const jobTitle = `Interview journey ${Date.now()}`;
  const response = await page.request.post("/api/v1/submissions", { headers: { "x-csrf-token": me.csrfToken }, data: { candidateId: candidate.id, clientId: "00000000-0000-0000-0000-000000000601", jobTitle } });
  expect(response.ok()).toBeTruthy();
  const submission = await response.json();
  // A random future day: the same candidate is reused on every run, and its interviews must not overlap.
  const day = new Date(Date.now() + (1 + Math.floor(Math.random() * 3000)) * 86400000).toISOString().slice(0, 10);
  await board(page, day);
  await page.getByRole("button", { name: "Schedule interview" }).click();
  const schedule = page.getByRole("dialog");
  await schedule.getByRole("combobox", { name: "Submission", exact: true }).selectOption(submission.id);
  await schedule.getByLabel("Round", { exact: true }).fill(jobTitle);
  await schedule.getByLabel("Start", { exact: true }).fill(`${day}T10:00`);
  await schedule.getByLabel("End", { exact: true }).fill(`${day}T11:00`);
  await schedule.getByRole("combobox", { name: "Coach", exact: true }).selectOption("00000000-0000-0000-0000-000000000013");
  await schedule.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(schedule).toBeHidden();
  const row = page.locator("tbody tr").filter({ hasText: jobTitle });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Consent required");

  await login(page, "locD@eureka.example"); await board(page, day);
  await row.getByRole("button", { name: "Edit interview" }).click();
  const edit = page.getByRole("dialog");
  await expect(edit.getByLabel("Round", { exact: true })).toHaveCount(0);
  await edit.getByLabel("Cleared", { exact: true }).check();
  await edit.getByLabel("Consent captured", { exact: true }).check();
  await edit.getByRole("button", { name: "Save interview" }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText("Consent captured");

  await login(page, "coach@eureka.example"); await board(page, day);
  await expect(row.getByRole("button", { name: "Edit interview" })).toHaveCount(0);
  await row.getByRole("button", { name: "Feedback", exact: true }).click();
  const feedback = page.getByRole("dialog");
  await expect(feedback.getByLabel("Feedback kind")).toHaveValue("coach");
  await feedback.getByRole("combobox", { name: "Rating", exact: true }).selectOption("4");
  await feedback.getByLabel("Notes", { exact: true }).fill("Clear examples and thoughtful explanations.");
  await feedback.getByRole("button", { name: "Add feedback" }).click();
  await expect(feedback.getByText("Feedback added.")).toBeVisible();
  await expect(feedback.getByText("Clear examples and thoughtful explanations.")).toBeVisible();
});
