import type { Permission } from "@eureka/shared";

export interface NavItem {
  key: string;
  label: string;
  section: "Workspace" | "Operations" | "Insights" | "Admin" | "Other";
  /** Shown when the user holds ANY of these capabilities (presentation only; the API decides). */
  anyOf: Permission[];
}

export const NAV: NavItem[] = [
  { key: "dashboard", label: "Dashboard", section: "Workspace", anyOf: ["report:read"] }, // GET /api/v1/dashboard needs report:read
  { key: "hotlist", label: "Hot List", section: "Workspace", anyOf: ["hotlist:read"] },
  { key: "candidates", label: "Candidates", section: "Workspace", anyOf: ["candidate:read"] },
  { key: "submissions", label: "Submissions", section: "Workspace", anyOf: ["submission:read"] },
  { key: "interviews", label: "Interviews", section: "Workspace", anyOf: ["interview:read"] },
  { key: "placements", label: "Placements", section: "Workspace", anyOf: ["placement:read"] },
  { key: "paperwork", label: "Paperwork & BGC", section: "Operations", anyOf: ["document:read", "bgc:update"] },
  { key: "employees", label: "Employees", section: "Operations", anyOf: ["employee:read"] },
  { key: "payments", label: "Payments", section: "Operations", anyOf: ["invoice:read"] },
  { key: "performance", label: "Performance", section: "Insights", anyOf: ["performance:read"] },
  { key: "reports", label: "Reports", section: "Insights", anyOf: ["report:read"] },
  { key: "access", label: "Users & Access", section: "Admin", anyOf: ["access:manage"] },
  // chat
  { key: "chat", label: "Chat", section: "Other", anyOf: ["chat:use"] },
];

export function visibleNav(capabilities: readonly string[]): NavItem[] {
  const caps = new Set(capabilities);
  return NAV.filter((n) => n.anyOf.some((p) => caps.has(p)));
}
