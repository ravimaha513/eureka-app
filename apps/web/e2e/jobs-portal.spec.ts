import { expect, test } from "@playwright/test";
import { login, screen, uniq } from "./support";

/**
 * Jobs and applicant portal journey (docs/jobs-portal-api.md), against the dev stack (AUTH_MODE=dev:
 * the sign-in link is read from the development mailbox endpoint). HR publishes an internal opening, an
 * applicant signs up, follows the emailed link, applies; HR shortlists the application, schedules an
 * interview, and the applicant sees the status and the interview (no internal data).
 */
test("applicant applies through the portal; HR moves the application and schedules an interview", async ({ page, browser, baseURL }) => {
  const tag = uniq();
  const title = `E2E Opening ${tag}`;
  const email = `e2e-${tag}@applicants.invalid`;

  // HR creates a published internal opening through the UI.
  await login(page, "hr@eureka.example");
  await screen(page, "Jobs");
  await page.getByRole("button", { name: /Add job/ }).click();
  const dlg = page.getByRole("dialog", { name: "Create job" });
  await dlg.getByLabel("Job title").fill(title);
  await dlg.getByRole("textbox", { name: "Description" }).fill("Answer questions from consultants.");
  await dlg.getByLabel(/Publish on the careers portal/).check();
  await dlg.getByRole("button", { name: "Create job" }).click();
  await expect(page.getByText("Job created.")).toBeVisible();
  await expect(page.getByRole("table", { name: "Jobs" }).locator("tbody tr").filter({ hasText: title })).toBeVisible();

  // The applicant signs up in a separate browser context (own cookies) and follows the emailed link.
  const ctx = await browser.newContext({ baseURL });
  const ap = await ctx.newPage();
  await ap.goto("/portal/sign-up");
  await ap.getByLabel("First name").fill("Ela");
  await ap.getByLabel("Last name").fill("Applicant");
  await ap.getByLabel("Phone").fill("+1 212 555 0142");
  await ap.getByLabel("Email").fill(email);
  await ap.getByRole("button", { name: "Sign up" }).click();
  await expect(ap.getByRole("status")).toContainText("we sent a sign-in link");
  const mail = await (await ap.request.get(`/api/portal/dev/mailbox?to=${encodeURIComponent(email)}`)).json();
  const link = /(https?:\/\/[^\s]+\/portal\/verify#token=[^\s]+)/.exec(mail.items[0].text)![1]!;
  await ap.goto(new URL(link).pathname + new URL(link).hash);
  await ap.getByRole("button", { name: "Continue" }).click();
  await expect(ap.getByRole("heading", { level: 1, name: "Finding Job" })).toBeVisible();
  const card = ap.getByRole("article", { name: title });
  await card.getByRole("button", { name: "Apply now" }).click();
  await expect(card.getByRole("button", { name: "Applied" })).toBeDisabled();

  // Staff routes refuse the applicant session.
  expect((await ap.request.get("/api/v1/jobs")).status()).toBe(401);

  // HR shortlists it and schedules an interview.
  await screen(page, "Applications");
  await page.getByRole("searchbox", { name: "Applicant" }).fill("Ela Applicant");
  const row = page.getByRole("table", { name: "Applications" }).locator("tbody tr").filter({ hasText: title });
  await row.getByRole("button", { name: /^Open application of/ }).click();
  const drawer = page.getByRole("dialog", { name: new RegExp(title) });
  await drawer.getByRole("button", { name: "Change status…" }).click();
  const st = page.getByRole("dialog", { name: "Application status" });
  await st.getByRole("combobox", { name: "Status", exact: true }).selectOption({ label: "Shortlisted" });
  await st.getByLabel(/Comment/).fill("Internal note only");
  await st.getByRole("button", { name: "Save status" }).click();
  await expect(drawer.getByRole("status")).toContainText("Status changed to Shortlisted");
  await drawer.getByRole("button", { name: "Schedule interview…" }).click();
  const iv = page.getByRole("dialog", { name: "Create interview" });
  await iv.getByLabel("Meeting link (optional)").fill("https://meet.example.com/e2e");
  await iv.getByRole("button", { name: "Create interview" }).click();
  await expect(drawer.getByRole("status")).toContainText("Interview scheduled");

  // The applicant sees the status and the interview, nothing internal.
  await ap.getByRole("button", { name: "My applications" }).click();
  const arow = ap.getByRole("table", { name: "Applications" }).locator("tbody tr").filter({ hasText: title });
  await expect(arow.getByText("Interview scheduled")).toBeVisible();
  await arow.getByRole("button", { name: /^View application/ }).click();
  const ad = ap.getByRole("dialog", { name: title });
  await expect(ad.getByText("Video")).toBeVisible();
  await expect(ad).not.toContainText("Internal note only");
  await ctx.close();
});
