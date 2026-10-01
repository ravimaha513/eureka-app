import { expect, test } from "@playwright/test";
import { ADMIN_DB_URL, apiAs, freshCandidate, localDay, login, mintFeedbackToken, screen, submissionWithInterview, uniq } from "./support";

/**
 * Candidate feedback through the public form (FR-INT, migration 0021): the
 * candidate opens the emailed link (no staff session), answers once, and the
 * link is spent; the recruiter then reads the answer on the interview board.
 * The worker normally mints and emails the link; here the test mints it the
 * same way through the database, so it needs E2E_DATABASE_URL (superuser URL
 * of the stack's database).
 */
test("candidate submits feedback via the public link, once; the recruiter sees it", async ({ page, playwright, baseURL }) => {
  test.skip(!ADMIN_DB_URL, "set E2E_DATABASE_URL to the stack's superuser database URL");
  const run = uniq();
  const r1a = await apiAs(playwright, baseURL, "r1a@eureka.example");
  const candidate = await freshCandidate(r1a, "Fb");
  const startsAt = new Date(Date.now() - 3 * 3_600_000); // ended two hours ago
  const { interviewId } = await submissionWithInterview(r1a, candidate.id, { jobTitle: `Feedback ${run}`, round: `Feedback ${run}`, startsAt });
  await r1a.dispose();
  const token = mintFeedbackToken(interviewId!);
  const firstName = candidate.name.split(" ")[0];

  // Opening (GET) the link does not spend it: open it twice.
  await page.goto(`/feedback/${token}`);
  await expect(page.getByRole("heading", { name: "Interview feedback" })).toBeVisible();
  await expect(page.getByText(`Hi ${firstName}. Tell us how your interview with Northwind Financial went.`)).toBeVisible();
  await page.reload();
  await expect(page.getByText(`Hi ${firstName}.`, { exact: false })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Main navigation" })).toHaveCount(0); // no staff shell

  const send = page.getByRole("button", { name: "Send feedback" });
  await expect(send).toBeDisabled(); // a rating is required
  await page.getByRole("radio", { name: "4" }).check();
  await page.getByRole("combobox", { name: "Interview format (optional)" }).selectOption("Video");
  await page.getByLabel("Duration in minutes (optional)").fill("45");
  await page.getByLabel("Topics covered (optional)").fill("Java, Spring Boot");
  await page.getByLabel("Anything you'd like your team to know? (optional)").fill(`Friendly panel ${run}`);
  await send.click();
  await expect(page.getByRole("heading", { name: "Thank you for your feedback" })).toBeVisible();

  // Single use: the link is closed now.
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("This feedback link is no longer available");
  await expect(page.getByRole("button", { name: "Send feedback" })).toHaveCount(0);
  const again = await page.request.post(`/api/public/feedback/${token}`, { data: { rating: 1 } });
  expect(again.status()).toBe(404);

  // The recruiter reads it on the interview board.
  await login(page, "r1a@eureka.example");
  await screen(page, "Interviews");
  await page.getByLabel("From date", { exact: true }).fill(localDay(startsAt));
  await page.getByLabel("Through date", { exact: true }).fill(localDay(startsAt));
  const row = page.locator("tbody tr").filter({ hasText: `Feedback ${run}` });
  await row.getByRole("button", { name: "Feedback", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Feedback · ${candidate.name}` });
  const answer = dialog.locator(".note").filter({ hasText: `Friendly panel ${run}` });
  await expect(answer).toContainText("candidate · Candidate"); // kind · author (no staff author)
  await expect(answer).toContainText("4/5");
  await expect(answer).toContainText("Format: Video");
  await expect(answer).toContainText("Topics: Java, Spring Boot");
  await expect(answer).toContainText("Duration (minutes): 45");
});

test("a malformed or unknown feedback link shows the unavailable message", async ({ page }) => {
  await page.goto("/feedback/not-a-token");
  await expect(page.getByRole("alert")).toContainText("This feedback link is no longer available");
  await page.goto(`/feedback/${"A".repeat(43)}`);
  await expect(page.getByRole("alert")).toContainText("This feedback link is no longer available");
});
