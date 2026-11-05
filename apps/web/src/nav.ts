import type { Permission } from "@eureka/shared";

/** Sidebar groups, in display order: grouped by the job being done, daily work first. */
export const NAV_SECTIONS = ["Work", "Hiring", "Operations", "Training", "Insights", "Team & admin"] as const;
export type NavSection = (typeof NAV_SECTIONS)[number];

export interface NavItem {
  key: string;
  label: string;
  section: NavSection;
  /** Shown when the user holds ANY of these capabilities (presentation only; the API decides). */
  anyOf: Permission[];
  /** And, when set, ALL of these (presentation only; the API decides). */
  allOf?: Permission[];
}

// The order here is the sidebar order. Visibility (anyOf/allOf) is per item and does not depend on the grouping.
export const NAV: NavItem[] = [
  { key: "hotlist", label: "Hot List", section: "Work", anyOf: ["hotlist:read"] },
  { key: "candidates", label: "Candidates", section: "Work", anyOf: ["candidate:read"] },
  { key: "submissions", label: "Submissions", section: "Work", anyOf: ["submission:read"] },
  { key: "interviews", label: "Interviews", section: "Work", anyOf: ["interview:read"] },
  { key: "placements", label: "Placements", section: "Work", anyOf: ["placement:read"] },
  // chat
  { key: "chat", label: "Chat", section: "Work", anyOf: ["chat:use"] },
  // jobs-portal
  { key: "jobs", label: "Jobs", section: "Hiring", anyOf: ["job:read"] },
  // Hiring managers (job:read) and interviewers (often coaches, interview:read) see the applications they work on.
  { key: "applications", label: "Applications", section: "Hiring", anyOf: ["application:read", "job:read", "interview:read"] },
  { key: "applicants", label: "Applicants", section: "Hiring", anyOf: ["applicant:read"] },
  { key: "paperwork", label: "Paperwork & BGC", section: "Operations", anyOf: ["document:read", "bgc:update"] },
  { key: "employees", label: "Employees", section: "Operations", anyOf: ["employee:read"] },
  { key: "payments", label: "Payments", section: "Operations", anyOf: ["invoice:read"] },
  { key: "companies", label: "Companies", section: "Operations", anyOf: ["company:read"] },
  { key: "facilities", label: "Facilities", section: "Operations", anyOf: ["facility:read"] },
  // datahub
  { key: "datahub", label: "DataHub", section: "Operations", anyOf: ["datahub:read"] },
  // training
  { key: "training", label: "Training Batches", section: "Training", anyOf: ["training:read"] },
  { key: "courses", label: "Courses", section: "Training", anyOf: ["training:manage"] },
  { key: "dashboard", label: "Dashboard", section: "Insights", anyOf: ["report:read"] }, // GET /api/v1/dashboard needs report:read
  { key: "performance", label: "Performance", section: "Insights", anyOf: ["performance:read"] },
  { key: "reports", label: "Reports", section: "Insights", anyOf: ["report:read", "report.market:read"] },
  // interview-reports: interviews the user can read, where they may read reports.
  { key: "interview-reports", label: "Interview reports", section: "Insights", anyOf: ["report:read"], allOf: ["interview:read"] },
  // pipeline-vendors: GET /api/v1/reports/pipeline needs report:read (and candidate:read, checked by the API)
  { key: "pipeline", label: "Candidate Pipeline", section: "Insights", anyOf: ["report:read"] },
  { key: "vendors", label: "Preferred Vendors", section: "Team & admin", anyOf: ["vendor.preferred:create", "vendor.preferred:read"] },
  // AD-10: leads add unassigned recruiters to their own team.
  { key: "myteam", label: "My team", section: "Team & admin", anyOf: ["team:add_member"] },
  // AD-11: an Interview Lead assigns their coaches to sales teams.
  { key: "coaching", label: "Coach assignments", section: "Team & admin", anyOf: ["coach:assign"] },
  { key: "access", label: "Users & Access", section: "Team & admin", anyOf: ["access:manage"] },
  // interview-alerts: HR keeps the staff birthdays the CEO's morning digest is built from.
  { key: "birthdays", label: "Staff birthdays", section: "Team & admin", anyOf: ["staff.birthday:manage"] },
];

/**
 * Settings & Preferences (interviews-settings): every signed-in user's own
 * settings, reached from the avatar menu rather than the sidebar.
 */
export const SETTINGS_NAV: NavItem = { key: "settings", label: "Settings & Preferences", section: "Team & admin", anyOf: [] };

export function visibleNav(capabilities: readonly Permission[]): NavItem[] {
  const caps = new Set(capabilities);
  return NAV.filter((n) => n.anyOf.some((p) => caps.has(p)) && (n.allOf ?? []).every((p) => caps.has(p)));
}

/**
 * The screen "/" opens: the Hot List, else the Dashboard, else the first screen in sidebar order.
 * Chat lands only when it is the role's only screen, so the regrouped sidebar (Chat moved up into
 * Work) does not change any role's landing screen.
 */
export function landingScreen(items: readonly NavItem[]): string | undefined {
  return (items.find((i) => i.key === "hotlist") ?? items.find((i) => i.key === "dashboard")
    ?? items.find((i) => i.key !== "chat") ?? items[0])?.key;
}


/**
 * URL routing: each screen lives at /<key>; an open record at /<key>/<id>
 * (a candidate profile under hotlist or candidates, a placement, an application, an interview, a chat).
 */
export const screenPath = (key: string, id?: string | null) => (id ? `/${key}/${encodeURIComponent(id)}` : `/${key}`);

export function parseScreenPath(pathname: string): { key: string | null; id: string | null } {
  const [key, id] = pathname.split("/").filter(Boolean);
  let decoded: string | null = null;
  try { decoded = id ? decodeURIComponent(id) : null; } catch { /* malformed escape: no record */ }
  return { key: key ?? null, id: decoded };
}
