import { expect, request, test } from "@playwright/test";
import { CLIENT_ID, COACH_ID, login, screen, uniq } from "./support";

/**
 * interviews-settings package: Create interview with type, panel, lead,
 * duration and meeting link; the details drawer with the calendar file and a
 * coach's scorecard as read-only stars; Settings (profile, notifications,
 * signing out another session).
 */
test("recruiter creates an interview with a panel; coach scores it; the drawer shows stars and the calendar file", async ({ page }) => {
  await login(page, "r2a@eureka.example");
  const me = await (await page.request.get("/api/v1/me")).json();
  const candidates = await (await page.request.get("/api/v1/candidates?status=active&limit=100")).json();
  const candidate = candidates.items.find((c: { recruiter: { id: string } | null }) => c.recruiter?.id === me.id);
  expect(candidate).toBeTruthy();
  const jobTitle = `Panel journey ${uniq()}`;
  const sub = await page.request.post("/api/v1/submissions", { headers: { "x-csrf-token": me.csrfToken }, data: { candidateId: candidate.id, clientId: CLIENT_ID, jobTitle } });
  expect(sub.ok()).toBeTruthy();
  const submission = await sub.json();
  const day = new Date(Date.now() + (1 + Math.floor(Math.random() * 3000)) * 86400000).toISOString().slice(0, 10);

  await screen(page, "Interviews");
  await page.getByLabel("From date", { exact: true }).fill(day);
  await page.getByLabel("Through date", { exact: true }).fill(day);
  await page.getByRole("button", { name: "Schedule interview" }).click();
  const dialog = page.getByRole("dialog", { name: "Create interview" });
  await dialog.getByRole("radio", { name: "Video" }).check();
  await dialog.getByRole("combobox", { name: "Submission", exact: true }).selectOption(submission.id);
  await expect(dialog.getByLabel("Position", { exact: true })).toHaveValue(jobTitle);
  await dialog.getByLabel("Round", { exact: true }).fill("Technical Screening");
  await dialog.getByLabel("Find panel member", { exact: true }).fill("coach");
  await dialog.getByRole("button", { name: "Add coach" }).click();
  await dialog.getByLabel("Find panel member", { exact: true }).fill("l2");
  await dialog.getByRole("button", { name: "Add l2" }).click();
  await dialog.getByRole("combobox", { name: "Lead user", exact: true }).selectOption(COACH_ID);
  await dialog.getByLabel("Interview slot", { exact: true }).fill(`${day}T16:00`);
  await dialog.getByRole("combobox", { name: "Duration (minutes)", exact: true }).selectOption("30");
  await dialog.getByLabel("Meeting link", { exact: true }).fill(`https://meet.example.com/${uniq()}`);
  await dialog.getByRole("button", { name: "Create interview", exact: true }).click();
  await expect(dialog).toBeHidden();

  const row = page.locator("tbody tr").filter({ hasText: candidate.name }).filter({ hasText: "Technical Screening" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Video");
  await row.getByRole("button", { name: /^Details of the interview/ }).click();
  const drawer = page.getByRole("dialog", { name: "Interview details" });
  await expect(drawer.getByText("Interview info")).toBeVisible();
  await expect(drawer.locator("dd").filter({ hasText: "coach, l2" })).toBeVisible();
  const cal = drawer.getByRole("link", { name: /Add to calendar/ });
  const ics = await page.request.get((await cal.getAttribute("href"))!);
  expect(ics.ok()).toBeTruthy();
  const body = await ics.text();
  expect(body).toContain("ATTENDEE;CN=\"coach\";ROLE=CHAIR:mailto:coach@eureka.example");
  expect(body).not.toContain(candidate.id);
  await drawer.getByRole("button", { name: "Close interview details" }).click();

  // The coach (Team Anjali) adds a scorecard.
  await login(page, "coach@eureka.example");
  await screen(page, "Interviews");
  await page.getByLabel("From date", { exact: true }).fill(day);
  await page.getByLabel("Through date", { exact: true }).fill(day);
  await row.getByRole("button", { name: "Feedback", exact: true }).click();
  const fb = page.getByRole("dialog");
  for (const [name, v] of [["Technical skills", "4"], ["Communication", "5"], ["Problem solving", "3"], ["Attitude", "4"]] as const) {
    await fb.getByRole("combobox", { name, exact: true }).selectOption(v);
  }
  await fb.getByRole("button", { name: "Add feedback" }).click();
  await expect(fb.getByText("Feedback added.")).toBeVisible();
  await fb.getByRole("button", { name: "Cancel" }).click();
  await row.getByRole("button", { name: /^Details of the interview/ }).click();
  const card = page.getByRole("article", { name: "Reviewer: coach" });
  await expect(card.getByRole("img", { name: "Technical skills: 4 out of 5" })).toBeVisible();
  await expect(card.getByRole("img", { name: "Communication: 5 out of 5" })).toBeVisible();
});

test("settings: profile, notifications and signing out another session", async ({ page, baseURL }) => {
  await login(page, "hr@eureka.example");
  await page.getByRole("button", { name: /^Account:/ }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings & Preferences" })).toBeVisible();

  const phone = `+1 469 555 01${String(Math.floor(Math.random() * 90) + 10)}`;
  await page.getByLabel("Work phone", { exact: true }).fill(phone);
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved.")).toBeVisible();

  await page.getByRole("tab", { name: "Notifications" }).click();
  await expect(page.getByRole("switch", { name: "Work authorization expiring" })).toBeDisabled();
  const bench = page.getByRole("switch", { name: "Employee exited" });
  const before = await bench.getAttribute("aria-checked");
  await bench.click();
  await expect(bench).toHaveAttribute("aria-checked", before === "true" ? "false" : "true");
  await bench.click();
  await expect(bench).toHaveAttribute("aria-checked", before ?? "true");

  // A second, independent session for the same user (another "device").
  const other = await request.newContext({ baseURL, extraHTTPHeaders: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile Safari/604.1" } });
  expect((await other.post("/api/auth/dev-login", { data: { email: "hr@eureka.example" } })).ok()).toBeTruthy();
  expect((await other.get("/api/v1/me")).status()).toBe(200);

  await page.getByRole("tab", { name: "Security" }).click();
  const table = page.getByRole("table", { name: "Login activity" });
  await expect(table.getByText("Current session")).toBeVisible();
  // Newest first: the first Mobile Safari sign-out button is the session opened above.
  await table.getByRole("button", { name: /^Sign out the Mobile Safari session/ }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByText("Session signed out.")).toBeVisible();
  expect((await other.get("/api/v1/me")).status()).toBe(401);
  // This browser stays signed in.
  expect((await page.request.get("/api/v1/me")).status()).toBe(200);
  await other.dispose();
});
