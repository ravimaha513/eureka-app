import { expect, test } from "@playwright/test";
import { apiAs, freshCandidate, login, screen, uniq } from "./support";

/**
 * Training journey (docs/training-api.md, migration 0065): the Dallas Location
 * Ops Admin builds a course, creates a batch trained by the fixture coach,
 * assigns the course, adds a recruiter's fresh candidate and ticks a module;
 * the recruiter then sees the batch and the progress card on the profile.
 * Batches are unique per location, technology and month, so the batch starts
 * in a random far-future month (retried on a clash).
 */
test("a location admin runs a batch; the recruiter sees the student's progress", async ({ page, playwright, baseURL }) => {
  const tag = uniq();
  const r1a = await apiAs(playwright, baseURL, "r1a@eureka.example");
  const student = await freshCandidate(r1a, "Tr");
  await r1a.dispose();

  await login(page, "locD@eureka.example");

  // Course library: a course with one module.
  await screen(page, "Courses");
  await page.getByRole("button", { name: "Add course" }).click();
  const courseDlg = page.getByRole("dialog", { name: "Add course" });
  await courseDlg.getByRole("textbox", { name: "Title" }).fill(`E2E Course ${tag}`);
  await courseDlg.getByRole("button", { name: "Create course" }).click();
  const drawer = page.getByRole("dialog", { name: `E2E Course ${tag}` });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Add module" }).click();
  const moduleDlg = page.getByRole("dialog", { name: "Add module" });
  await moduleDlg.getByRole("textbox", { name: "Module title" }).fill("Intro");
  await moduleDlg.getByRole("spinbutton", { name: "Duration (minutes)" }).fill("60");
  await moduleDlg.getByRole("button", { name: "Add module" }).click();
  await expect(moduleDlg).toBeHidden();
  await expect(drawer.getByText("Intro", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "Close course" }).click();

  // A new batch.
  await screen(page, "Training Batches");
  const name = `E2E Batch ${tag}`;
  let created = false;
  for (let attempt = 0; attempt < 6 && !created; attempt++) {
    await page.getByRole("button", { name: "Add training batch" }).click();
    const dlg = page.getByRole("dialog", { name: "Add training batch" });
    await dlg.getByRole("textbox", { name: /Batch name/ }).fill(name);
    await dlg.getByRole("combobox", { name: "Location", exact: true }).selectOption({ label: "Dallas" });
    await dlg.getByRole("combobox", { name: "Technology", exact: true }).selectOption({ label: "Java" });
    const year = 2040 + Math.floor(Math.random() * 60);
    const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, "0");
    await dlg.getByLabel("Start date").fill(`${year}-${month}-10`);
    await dlg.getByRole("combobox", { name: "Trainer", exact: true }).selectOption({ label: "coach" });
    await dlg.getByRole("button", { name: "Create batch" }).click();
    const outcome = await Promise.race([
      page.getByRole("heading", { level: 1, name }).waitFor().then(() => "ok"),
      dlg.getByText("A batch for this location, technology and month already exists.").waitFor().then(() => "clash"),
    ]);
    if (outcome === "ok") created = true;
    else await dlg.getByRole("button", { name: "Cancel" }).click();
  }
  expect(created).toBe(true);
  await expect(page.getByRole("list", { name: "Batch figures" })).toContainText("Students");

  // Assign the course.
  await page.getByRole("button", { name: "Add course" }).click();
  const addCourse = page.getByRole("dialog", { name: "Add course" });
  await addCourse.getByRole("combobox", { name: "Course", exact: true }).selectOption({ label: `E2E Course ${tag} (1 modules · 1h)` });
  await addCourse.getByRole("button", { name: "Add course" }).click();
  await expect(page.getByRole("status").filter({ hasText: `E2E Course ${tag} added.` })).toBeVisible();

  // Add the student and tick the module.
  await page.getByRole("tab", { name: /View Students/ }).click();
  await page.getByRole("button", { name: "Add student" }).click();
  const addStudent = page.getByRole("dialog", { name: "Add student" });
  await addStudent.getByRole("searchbox", { name: "Search candidates" }).fill(student.name);
  await addStudent.getByRole("button", { name: `Add ${student.name}` }).click();
  await expect(page.getByRole("status").filter({ hasText: `${student.name} added to the batch.` })).toBeVisible();
  await addStudent.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: new RegExp(`^${student.name}`) }).click();
  await page.getByRole("checkbox", { name: /Intro/ }).check();
  await expect(page.getByRole("status").filter({ hasText: `Intro marked complete for ${student.name}.` })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: `Overall progress of ${student.name}` })).toHaveAttribute("aria-valuenow", "100");

  // The recruiter: the batch shows their one student; the profile has the training card.
  await page.context().clearCookies();
  await login(page, "r1a@eureka.example");
  await screen(page, "Training Batches");
  const card = page.getByRole("list", { name: "Training batches" }).locator("li").filter({ has: page.getByRole("heading", { name }) });
  await expect(card).toContainText("1Students");
  await screen(page, "Candidates");
  await page.getByRole("search", { name: "Candidates filters" }).getByLabel("Search name").fill(student.name.split(" ")[1]!);
  await page.getByRole("table", { name: "Candidates" }).getByRole("button", { name: `Open profile of ${student.name}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: student.name })).toBeVisible();
  const training = page.getByRole("region", { name: "Training" });
  await expect(training).toContainText(name);
  await expect(training.getByRole("progressbar", { name: "Overall training progress" })).toHaveAttribute("aria-valuenow", "100");
});
