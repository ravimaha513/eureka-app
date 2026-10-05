import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Org admin journey through Users & Access (docs/admin-api.md, AD-1..AD-9).
 * Runs against the full stack with the dev seed. Every run creates its own
 * uniquely named users and teams, so it is safe to repeat on the same database.
 */

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const person = (tag: string) => ({ name: `E2E ${tag} ${run}`, email: `e2e-${tag.toLowerCase()}-${run}@eureka.example` });

async function signIn(page: Page, label: string) {
  await page.goto("/");
  await page.getByLabel("Sign in as").selectOption({ label });
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("complementary", { name: "Main navigation" })).toBeVisible();
}

async function openAccess(page: Page) {
  await page.getByRole("complementary", { name: "Main navigation" }).getByRole("button", { name: "Users & Access" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Users & Access" })).toBeVisible();
}

const liveStatus = (page: Page) => page.getByRole("status");

async function openTab(page: Page, name: "Users" | "Approvals" | "Teams") {
  await page.getByRole("tab", { name }).click();
  await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
}

async function createUser(page: Page, p: { name: string; email: string }) {
  await openTab(page, "Users");
  await page.getByRole("button", { name: "New user" }).click();
  const dlg = page.getByRole("dialog", { name: "New user" });
  await dlg.getByLabel("Email").fill(p.email);
  await dlg.getByLabel("Name").fill(p.name);
  await dlg.getByRole("button", { name: "Create user" }).click();
  await expect(dlg).toBeHidden();
  await expect(liveStatus(page)).toContainText(`Created ${p.name}.`);
}

async function userRow(page: Page, search: string, name: string): Promise<Locator> {
  await openTab(page, "Users");
  await page.getByLabel("Search users").fill(search);
  const row = page.getByRole("table", { name: "Users" }).getByRole("row").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  return row;
}

const teamCard = (page: Page, name: string) =>
  page.getByRole("tabpanel").locator("section").filter({ has: page.getByRole("heading", { name, exact: true }) });

test.describe.configure({ mode: "serial" });

test("non-admins never see Users & Access", async ({ page }) => {
  await signIn(page, "Recruiter (Team Rohit)");
  await expect(page.getByRole("complementary", { name: "Main navigation" }).getByRole("button", { name: "Users & Access" })).toHaveCount(0);
  expect((await page.request.get("/api/v1/admin/users")).status()).toBe(403);
});

test("org admin: create a user, grant and revoke roles, second approver, deactivate and reactivate", async ({ page }) => {
  const a = person("Alpha");
  await signIn(page, "Org Admin");
  await openAccess(page);

  // Own row is read-only (AD-2).
  const self = await userRow(page, "admin@eureka.example", "admin@eureka.example");
  await expect(self.getByText("you", { exact: true })).toBeVisible();
  await expect(self.getByRole("button")).toHaveCount(0);

  await createUser(page, a);
  let row = await userRow(page, a.email, a.name);
  await expect(row.getByText("No roles")).toBeVisible();

  // A plain role applies immediately.
  await row.getByRole("button", { name: `Grant role to ${a.name}` }).click();
  let dlg = page.getByRole("dialog", { name: `Grant a role to ${a.name}` });
  await dlg.getByLabel("Role").selectOption({ label: "Recruiter" });
  await expect(dlg.getByLabel("Location")).toHaveCount(0);
  await dlg.getByRole("button", { name: "Grant role" }).click();
  await expect(dlg).toBeHidden();
  await expect(liveStatus(page)).toContainText(`Granted Recruiter to ${a.name}.`);
  await expect(row.getByRole("list", { name: `Roles of ${a.name}` }).getByText("Recruiter")).toBeVisible();

  // A location-bound role asks for a location.
  await row.getByRole("button", { name: `Grant role to ${a.name}` }).click();
  dlg = page.getByRole("dialog", { name: `Grant a role to ${a.name}` });
  await dlg.getByLabel("Role").selectOption({ label: "Location Incharge" });
  await expect(dlg.getByLabel("Location")).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Grant role" })).toBeDisabled();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toBeHidden();

  // A restricted role needs a second approver (AD-3).
  await row.getByRole("button", { name: `Grant role to ${a.name}` }).click();
  dlg = page.getByRole("dialog", { name: `Grant a role to ${a.name}` });
  await dlg.getByLabel("Role").selectOption({ label: "HR (restricted)" });
  await expect(dlg.getByText(/needs a second approver/)).toBeVisible();
  await dlg.getByRole("button", { name: "Request approval" }).click();
  await expect(dlg).toBeHidden();
  await expect(liveStatus(page)).toContainText("waiting for a second approver");

  await openTab(page, "Approvals");
  const req = page.getByRole("table", { name: "Role requests" }).getByRole("row").filter({ hasText: a.name });
  await expect(req).toHaveCount(1);
  const approve = req.getByRole("button", { name: `Approve HR for ${a.name}` });
  await expect(approve).toBeDisabled();
  await expect(req.getByText("You requested this. Another admin has to approve it.")).toBeVisible();
  await req.getByRole("button", { name: `Reject HR for ${a.name}` }).click();
  await expect(liveStatus(page)).toContainText(`Rejected HR for ${a.name}.`);
  await expect(req).toHaveCount(0);

  // Revoking is immediate (AD-4).
  row = await userRow(page, a.email, a.name);
  await row.getByRole("button", { name: `Revoke Recruiter from ${a.name}` }).click();
  dlg = page.getByRole("dialog", { name: "Revoke Recruiter?" });
  await dlg.getByRole("button", { name: "Revoke role" }).click();
  await expect(dlg).toBeHidden();
  await expect(row.getByText("No roles")).toBeVisible();

  // Deactivation revokes sessions at once (AD-5).
  await row.getByRole("button", { name: `Deactivate ${a.name}` }).click();
  dlg = page.getByRole("dialog", { name: `Deactivate ${a.name}?` });
  await expect(dlg).toContainText(/sessions are revoked immediately/i);
  await dlg.getByRole("button", { name: "Deactivate", exact: true }).click();
  await expect(dlg).toBeHidden();
  await expect(row.getByText("inactive", { exact: true })).toBeVisible();

  await row.getByRole("button", { name: `Reactivate ${a.name}` }).click();
  dlg = page.getByRole("dialog", { name: `Reactivate ${a.name}?` });
  await dlg.getByRole("button", { name: "Reactivate", exact: true }).click();
  await expect(dlg).toBeHidden();
  await expect(row.getByText("active", { exact: true })).toBeVisible();
});

test("org admin: reporting line, teams, members and moving a member", async ({ page }) => {
  const [lead1, member, lead2] = [person("LeadOne"), person("Member"), person("LeadTwo")];
  const [team1, team2] = [`E2E Team One ${run}`, `E2E Team Two ${run}`];
  await signIn(page, "Org Admin");
  await openAccess(page);
  for (const p of [lead1, member, lead2]) await createUser(page, p);

  // Reporting line, then a cycle is refused with a friendly message (AD-9).
  let row = await userRow(page, member.email, member.name);
  await row.getByRole("button", { name: `Set manager for ${member.name}` }).click();
  let dlg = page.getByRole("dialog", { name: `Set manager for ${member.name}` });
  await dlg.getByLabel("Manager").selectOption({ label: `${lead1.name} (${lead1.email})` });
  await dlg.getByRole("button", { name: "Save manager" }).click();
  await expect(dlg).toBeHidden();
  await expect(row.getByText(lead1.name)).toBeVisible();

  row = await userRow(page, lead1.email, lead1.name);
  await row.getByRole("button", { name: `Set manager for ${lead1.name}` }).click();
  dlg = page.getByRole("dialog", { name: `Set manager for ${lead1.name}` });
  await dlg.getByLabel("Manager").selectOption({ label: `${member.name} (${member.email})` });
  await dlg.getByRole("button", { name: "Save manager" }).click();
  await expect(dlg.getByRole("alert")).toContainText("reporting loop");
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();

  // Two teams, one member.
  await openTab(page, "Teams");
  for (const [name, lead] of [[team1, lead1], [team2, lead2]] as const) {
    await page.getByRole("button", { name: "New team" }).click();
    dlg = page.getByRole("dialog", { name: "New team" });
    await dlg.getByLabel("Team name").fill(name);
    await dlg.getByLabel("Lead").selectOption({ label: `${lead.name} (${lead.email})` });
    await dlg.getByRole("button", { name: "Create team" }).click();
    await expect(dlg).toBeHidden();
    await expect(liveStatus(page)).toContainText(`Created ${name}.`);
  }
  await teamCard(page, team1).getByRole("button", { name: `Add member to ${team1}` }).click();
  dlg = page.getByRole("dialog", { name: `Add member to ${team1}` });
  await dlg.getByLabel("Person").selectOption({ label: `${member.name} (${member.email})` });
  await dlg.getByRole("button", { name: "Add member" }).click();
  await expect(dlg).toBeHidden();
  await expect(teamCard(page, team1).getByRole("list", { name: `Members of ${team1}` })).toContainText(member.name);

  // Adding someone who already has a team is refused (use Move instead).
  await teamCard(page, team2).getByRole("button", { name: `Add member to ${team2}` }).click();
  dlg = page.getByRole("dialog", { name: `Add member to ${team2}` });
  await dlg.getByLabel("Person").selectOption({ label: `${member.name} (${member.email}) · in ${team1}` });
  await dlg.getByRole("button", { name: "Add member" }).click();
  await expect(dlg.getByRole("alert")).toContainText("Move to team");
  await dlg.getByRole("button", { name: "Cancel" }).click();

  // Moving needs team:move_member over both teams (AD-8). org_admin holds no data
  // permissions in the current catalog, so the button is disabled with an explanation;
  // if the role gains the permission, exercise the full move.
  const move = teamCard(page, team1).getByRole("button", { name: `Move ${member.name} to another team` });
  if (await move.isDisabled()) {
    await expect(page.getByText(/Moving people between teams needs/)).toBeVisible();
  } else {
    await move.click();
    dlg = page.getByRole("dialog", { name: `Move ${member.name} to another team` });
    await expect(dlg.getByLabel("Reassign candidates to")).toContainText(`${lead1.name} (lead of ${team1}, default)`);
    await dlg.getByLabel("Move to team").selectOption({ label: team2 });
    await dlg.getByRole("button", { name: "Move", exact: true }).click();
    const result = page.getByRole("dialog", { name: `${member.name} moved to ${team2}` });
    await expect(result).toContainText(/no candidates to hand over|reassigned to/);
    await result.getByRole("button", { name: "Done" }).click();
    await expect(teamCard(page, team2).getByRole("list", { name: `Members of ${team2}` })).toContainText(member.name);
  }

  // Change the lead of team two.
  await teamCard(page, team2).getByRole("button", { name: `Change lead of ${team2}` }).click();
  dlg = page.getByRole("dialog", { name: `Change lead of ${team2}` });
  await dlg.getByLabel("New lead").selectOption({ label: `${lead1.name} (${lead1.email})` });
  await dlg.getByRole("button", { name: "Change lead" }).click();
  await expect(dlg).toBeHidden();
  await expect(liveStatus(page)).toContainText(`${lead1.name} now leads ${team2}.`);
  await page.screenshot({ path: "e2e-artifacts/admin-teams.png", fullPage: true });
});
