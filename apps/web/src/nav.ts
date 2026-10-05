import type { Permission } from "@eureka/shared";

export interface NavItem {
  key: string;
  label: string;
  section: "Workspace" | "Hiring" | "Operations" | "Training" | "Insights" | "Admin" | "Other";
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
  // jobs-portal
  { key: "jobs", label: "Jobs", section: "Hiring", anyOf: ["job:read"] },
  // Hiring managers (job:read) and interviewers (often coaches, interview:read) see the applications they work on.
  { key: "applications", label: "Applications", section: "Hiring", anyOf: ["application:read", "job:read", "interview:read"] },
  { key: "applicants", label: "Applicants", section: "Hiring", anyOf: ["applicant:read"] },
  { key: "paperwork", label: "Paperwork & BGC", section: "Operations", anyOf: ["document:read", "bgc:update"] },
  { key: "employees", label: "Employees", section: "Operations", anyOf: ["employee:read"] },
  // datahub
  { key: "datahub", label: "DataHub", section: "Operations", anyOf: ["datahub:read"] },
  { key: "payments", label: "Payments", section: "Operations", anyOf: ["invoice:read"] },
  { key: "companies", label: "Companies", section: "Operations", anyOf: ["company:read"] },
  { key: "facilities", label: "Facilities", section: "Operations", anyOf: ["facility:read"] },
  // training
  { key: "training", label: "Training Batches", section: "Training", anyOf: ["training:read"] },
  { key: "courses", label: "Courses", section: "Training", anyOf: ["training:manage"] },
  { key: "performance", label: "Performance", section: "Insights", anyOf: ["performance:read"] },
  { key: "reports", label: "Reports", section: "Insights", anyOf: ["report:read"] },
  { key: "access", label: "Users & Access", section: "Admin", anyOf: ["access:manage"] },
  // chat
  { key: "chat", label: "Chat", section: "Other", anyOf: ["chat:use"] },
];

/**
 * Settings & Preferences (interviews-settings): every signed-in user's own
 * settings, reached from the avatar menu rather than the sidebar.
 */
export const SETTINGS_NAV: NavItem = { key: "settings", label: "Settings & Preferences", section: "Admin", anyOf: [] };

export function visibleNav(capabilities: readonly string[]): NavItem[] {
  const caps = new Set(capabilities);
  return NAV.filter((n) => n.anyOf.some((p) => caps.has(p)));
}
