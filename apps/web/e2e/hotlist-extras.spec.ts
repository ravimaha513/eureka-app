import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { apiAs, cell, freshCandidate, login, uniq, type Api } from "./support";

/**
 * Hot List extras (FR-HOT, migration 0025/0030): saved views, export (button
 * only for report:export holders; the file is masked) and bulk status changes
 * on the lead's own team. Each test works on candidates it creates.
 */

const hotlist = (page: Page) => page.getByRole("table", { name: "Hot List" });
const filters = (page: Page) => page.getByRole("search", { name: "Hot List filters" });
const filter = (page: Page, name: string) => filters(page).getByRole("combobox", { name, exact: true });
const views = (page: Page) => page.getByRole("region", { name: "Saved views" });

/** Fresh candidates moved to Active (new ones start in training, which is not on the Hot List). */
async function onHotList(api: Api, tag: string, n: number) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = await freshCandidate(api, `${tag}${String.fromCharCode(97 + i)}`);
    await api.send("POST", `/api/v1/candidates/${c.id}/transition`, { to: "active" });
    out.push(c);
  }
  return out;
}

async function search(page: Page, text: string, rows: number) {
  await filters(page).getByLabel("Search name").fill(text);
  await expect(hotlist(page).locator("tbody tr")).toHaveCount(rows);
  await expect(hotlist(page)).not.toHaveAttribute("aria-busy", "true");
}

test("a saved view stores the filters, reapplies them after a reload and can be deleted", async ({ page }) => {
  const name = `E2E view ${uniq()}`;
  await login(page, "r1a@eureka.example");
  await filter(page, "Status").selectOption({ label: "On hold" });
  await filter(page, "Visibility").selectOption({ label: "Open to all teams" });

  await views(page).getByRole("button", { name: "Save current filters…" }).click();
  const form = page.getByRole("form", { name: "Save view" });
  await form.getByLabel("View name").fill(name);
  await form.getByRole("button", { name: "Save view" }).click();
  await expect(views(page).getByRole("status")).toHaveText(`Saved view “${name}”.`);

  // A new session: the view is still there and puts its filters back.
  await page.reload();
  await expect(filter(page, "Status")).toHaveValue("");
  await views(page).getByRole("combobox", { name: "Saved view", exact: true }).selectOption({ label: name });
  await expect(views(page).getByRole("status")).toHaveText(`Showing saved view “${name}”.`);
  await expect(filter(page, "Status")).toHaveValue("on_hold");
  await expect(filter(page, "Visibility")).toHaveValue("all_teams");
  const rows = hotlist(page).locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  for (const row of await rows.all()) {
    await expect(await cell(hotlist(page), row, "Status")).toContainText("On hold");
    await expect(row.getByText("Open to all teams")).toBeVisible();
  }

  await views(page).getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("group", { name: "Confirm delete" }).getByRole("button", { name: "Delete view" }).click();
  await expect(views(page).getByRole("status")).toHaveText(`Deleted view “${name}”.`);
  await expect(views(page).getByRole("combobox", { name: "Saved view", exact: true }).getByRole("option", { name })).toHaveCount(0);
});

test("export is offered to a lead only, and the file is scoped and masked", async ({ page, playwright, baseURL }) => {
  const tag = `Exp${uniq()}`;
  const r1a = await apiAs(playwright, baseURL, "r1a@eureka.example");
  const phone = `+1972555${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}`;
  const c = await freshCandidate(r1a, tag, { phone, confirmDuplicate: true });
  await r1a.send("POST", `/api/v1/candidates/${c.id}/transition`, { to: "active" });
  expect((await r1a.send("POST", "/api/v1/hotlist/export", {}, 403))).toMatchObject({ status: 403 });
  await r1a.dispose();

  for (const email of ["r1a@eureka.example", "locD@eureka.example"]) {
    await login(page, email);
    await expect(hotlist(page).locator("tbody tr").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Export CSV" })).toHaveCount(0);
  }

  await login(page, "l1@eureka.example");
  await search(page, tag, 1);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^hotlist-\d{4}-\d{2}-\d{2}\.csv$/);
  await expect(page.getByRole("status").filter({ hasText: "Exported" })).toHaveText("Exported 1 row.");
  const csv = await readFile(await file.path(), "utf8");
  const lines = csv.trim().split(/\r?\n/);
  expect(lines).toHaveLength(2); // header + the one filtered candidate
  expect(lines[1]).toContain(c.name);
  expect(lines[1]).toContain("Team Rohit");
  // Phones are masked in exports even inside the lead's own scope.
  expect(lines[1]).toContain(`•••-•••-${phone.slice(-2)}`);
  expect(csv).not.toContain(phone.slice(2));
});

test("lead changes the status of own-team candidates in bulk; other teams' are refused", async ({ page, playwright, baseURL }) => {
  const tag = `Bulk${uniq()}`;
  const r1a = await apiAs(playwright, baseURL, "r1a@eureka.example");
  const r2a = await apiAs(playwright, baseURL, "r2a@eureka.example");
  const own = await onHotList(r1a, tag, 2);
  const [theirs] = await onHotList(r2a, tag, 1);
  await Promise.all([r1a.dispose(), r2a.dispose()]);

  await login(page, "l1@eureka.example");
  // The Hot List is open to everyone, but another team's row cannot be selected.
  await search(page, tag, 3);
  await expect(hotlist(page).getByRole("checkbox", { name: `Select ${theirs!.name}` })).toBeDisabled();
  for (const c of own) await hotlist(page).getByRole("checkbox", { name: `Select ${c.name}` }).check();
  const bar = page.getByRole("region", { name: "Bulk actions" });
  await expect(bar).toContainText("2 candidates selected");
  await bar.getByRole("combobox", { name: "Set status", exact: true }).selectOption({ label: "On hold" });
  await bar.getByRole("button", { name: "Apply status" }).click();
  await expect(bar.getByRole("status")).toHaveText("2 updated.");
  for (const c of own) {
    const row = hotlist(page).getByRole("row").filter({ hasText: c.name });
    await expect(await cell(hotlist(page), row, "Status")).toContainText("On hold");
  }

  // The server checks every record: another team's candidate is refused in the same request.
  const me = await (await page.request.get("/api/v1/me")).json();
  const res = await page.request.post("/api/v1/hotlist/bulk/status", {
    headers: { "x-csrf-token": me.csrfToken }, data: { ids: [own[0]!.id, theirs!.id], to: "active" },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.succeeded).toBe(1);
  expect(body.results.find((r: { id: string }) => r.id === theirs!.id)).toMatchObject({ ok: false });
  expect((await (await page.request.get(`/api/v1/candidates/${own[0]!.id}`)).json()).status).toBe("active");
});
