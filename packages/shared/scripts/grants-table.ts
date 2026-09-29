/**
 * Prints the role grants as a Markdown table for docs/design.md (section B4.2).
 * Run: pnpm docs:grants
 */
import { GRANTS, ROLES, ROLE_LABELS, SCOPES, type Permission, type Scope } from "../src/authz/catalog.js";

const rows: string[] = ["| Role | Grants by scope |", "|---|---|"];
for (const role of ROLES) {
  const byScope = new Map<Scope, Permission[]>();
  for (const [perm, scope] of Object.entries(GRANTS[role]) as [Permission, Scope][]) {
    byScope.set(scope, [...(byScope.get(scope) ?? []), perm]);
  }
  const parts = SCOPES.filter((s) => byScope.has(s)).map(
    (s) => `**${s}:** ${byScope.get(s)!.sort().join(", ")}`,
  );
  rows.push(`| ${ROLE_LABELS[role]} | ${parts.join("<br>")} |`);
}
console.log(rows.join("\n"));
