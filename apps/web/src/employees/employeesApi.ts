/** Typed client for employees, the assignment lifecycle and the joinings/exits report (docs/employees-api.md). */
import { ApiError, api } from "../api";
import { fetchCsv, type ExportResult } from "../lib/download";

export interface Named { id: string; name: string | null }

export const EMPLOYEE_STATUSES = ["on_assignment", "bench", "exited"] as const;
export const END_REASONS = ["completed", "terminated", "resigned"] as const;
export const EXIT_REASONS = ["resigned", "terminated", "other"] as const;

/** Per-record hints from the server; it checks every action again. */
export interface EmployeeActions {
  endAssignment: boolean; setEndDate: boolean; exit: boolean; returnToMarket: boolean;
  /** 0150: assign a Sales team after a project; edit payroll company and E-Verify / onboarded dates. */
  assignTeam?: boolean; editEmployment?: boolean;
}

export interface EmployeeAssignment {
  id: string;
  assignmentNo: number;
  placementId: string;
  startDate: string;
  endDate: string | null;
  endReason: string | null;
  plannedEndDate: string | null;
  client: Named | null;
  isFirstPlacement?: boolean;
  /** 0150: vendor of the placement, HR-owned employment facts. */
  vendor?: Named | null;
  payrollCompany?: Named | null;
  everifyDate?: string | null;
  onboardedDate?: string | null;
  /** Present (number or null) only when the caller may see and set it (rate:read over the placement). */
  payRate?: number | null;
}

export interface Employee {
  id: string;
  candidate: Named;
  status: string;
  employeeSince: string;
  statusSince: string;
  exitedOn: string | null;
  exitReason: string | null;
  location: Named | null;
  team: Named | null;
  /** 0150: the team's lead and the candidate's recruiter. */
  lead?: Named | null;
  recruiter?: Named | null;
  /** Personal email and phone; masked unless the caller may read the candidate's contacts (EM-C1). */
  contact?: { email: string | null; phone: string | null; masked: boolean };
  /** Latest assignment the caller can read (null when none is readable). */
  assignment: EmployeeAssignment | null;
  actions: EmployeeActions;
}

export interface HistoryEntry {
  id: string;
  kind: string;
  at: string;
  actor: string | null;
  assignmentId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  effectiveOn: string | null;
  previousOn: string | null;
  reason: string | null;
}

export interface EmployeeDetail extends Employee {
  assignments: (EmployeeAssignment & { client: Named })[];
  history: HistoryEntry[];
}

export interface EmployeeFilters {
  status?: string;
  locationId?: string;
  clientId?: string;
  /** 0150: "current" limits the client filter to the open assignment (default: any assignment). */
  clientMatch?: "any" | "current";
  vendorId?: string;
  payrollCompanyId?: string;
  endingWithinDays?: number;
  search?: string;
  cursor?: string;
  limit?: number;
}

export interface ReportItem {
  kind: "joining" | "exit";
  date: string;
  assignmentId: string;
  assignmentNo: number;
  placementId: string;
  candidate: Named;
  /** null when the caller cannot read the placement (Immigration). */
  client: string | null;
  team: Named | null;
  recruiter: string | null;
  location: string | null;
  isFirstPlacement: boolean;
  isFirstAssignment?: boolean;
  technology?: string | null;
  payrollCompany?: Named | null;
  endReason: string | null;
}

export interface JoiningsExits {
  from: string;
  to: string;
  totals: {
    joinings: number; firstPlacements: number; exits: number; exitsByReason: Record<string, number>;
    firstAssignments?: number; laterAssignments?: number;
  };
  byTeam: { team: Named | null; joinings: number; exits: number }[];
  byCompany?: { company: Named | null; joinings: number; firstAssignments: number; laterAssignments: number; exits: number }[];
  items: ReportItem[];
  truncated: boolean;
}

export interface ActiveEmployees {
  month: string;
  from: string;
  to: string;
  total: number;
  byClient: { client: Named | null; count: number }[];
  byCompany: { company: Named | null; count: number }[];
}

export interface PayrollCompany { id: string; name: string; status: string }
export interface AssignableTeam { id: string; name: string; lead: Named; location: string | null }

/** PATCH body: send only what changes; null clears. */
export interface EmploymentChanges {
  payrollCompanyId?: string | null;
  everifyDate?: string | null;
  onboardedDate?: string | null;
  payRate?: number | null;
}

export type { ExportResult };

const LABELS: Record<string, string> = {
  on_assignment: "On assignment", bgc_failed: "BGC failed", returned_to_market: "Returned to marketing",
  end_date_set: "Planned end date", started: "Assignment started", ended: "Assignment ended", exited: "Left the company",
};
export const employmentLabel = (s: string) => {
  if (LABELS[s]) return LABELS[s]!;
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const enc = encodeURIComponent;
const qs = (f: object) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  return q.toString();
};
const json = (b: unknown) => ({ body: JSON.stringify(b) });

export const employeesApi = {
  list: (f: EmployeeFilters) => api<{ items: Employee[]; nextCursor: string | null }>(`/api/v1/employees?${qs({ limit: 50, ...f })}`),
  get: (id: string) => api<EmployeeDetail>(`/api/v1/employees/${enc(id)}`),
  endAssignment: (id: string, endDate: string, reason: string) =>
    api<{ id: string; employeeStatus: string }>(`/api/v1/assignments/${enc(id)}/end`, { method: "POST", ...json({ endDate, reason }) }),
  setPlannedEnd: (id: string, plannedEndDate: string) =>
    api<{ id: string; plannedEndDate: string }>(`/api/v1/assignments/${enc(id)}/planned-end-date`, { method: "PUT", ...json({ plannedEndDate }) }),
  exit: (id: string, exitDate: string, reason: string) =>
    api<{ id: string; status: string }>(`/api/v1/employees/${enc(id)}/exit`, { method: "POST", ...json({ exitDate, reason }) }),
  returnToMarket: (id: string) =>
    api<{ id: string; candidateStatus: string }>(`/api/v1/employees/${enc(id)}/return-to-market`, { method: "POST", ...json({}) }),
  exportEmployees: (f: Omit<EmployeeFilters, "cursor" | "limit">): Promise<ExportResult> => {
    const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== ""));
    return fetchCsv("/api/v1/employees/export", body, "employees.csv");
  },
  payrollCompanies: () => api<{ items: PayrollCompany[] }>("/api/v1/employees/payroll-companies"),
  teams: () => api<{ items: AssignableTeam[] }>("/api/v1/employees/teams"),
  setEmployment: (assignmentId: string, changes: EmploymentChanges) =>
    api<{ id: string; changed: string[] }>(`/api/v1/assignments/${enc(assignmentId)}/employment`, { method: "PATCH", ...json(changes) }),
  assignTeam: (id: string, teamId: string) =>
    api<{ id: string; team: Named }>(`/api/v1/employees/${enc(id)}/assign-team`, { method: "POST", ...json({ teamId }) }),
  activeEmployees: (month: string, clientId?: string) =>
    api<ActiveEmployees>(`/api/v1/reports/active-employees?${qs({ month, clientId })}`),
  joiningsExits: (from: string, to: string) => api<JoiningsExits>(`/api/v1/reports/joinings-exits?${qs({ from, to })}`),
  exportJoiningsExits: (from: string, to: string): Promise<ExportResult> =>
    fetchCsv("/api/v1/reports/joinings-exits/export", { from, to }, "joinings-exits.csv"),
};

export const employeeKeys = {
  all: ["employees"] as const,
  detail: (id: string) => ["employees", "detail", id] as const,
  report: (from: string, to: string) => ["reports", "joinings-exits", from, to] as const,
  active: (month: string, clientId: string) => ["reports", "active-employees", month, clientId] as const,
  payrollCompanies: ["employees", "payroll-companies"] as const,
  teams: ["employees", "teams"] as const,
};

/** Friendly text for the API's `detail` codes. */
const ERRORS: Record<string, string> = {
  assignment_closed: "This assignment has already ended. Refresh to see the latest state.",
  invalid_end_date: "That date isn't allowed: an end or exit date can't be in the future or before the start, and a planned end date must be today or later.",
  invalid_reason: "Choose one of the listed reasons.",
  invalid_transition: "That change isn't allowed from the employee's current status. Refresh to see the latest state.",
  unchanged: "Nothing changed: that is already the current value.",
  bgc_failed_last: "The last assignment ended with a failed background check. Whether the employee can be re-placed is still an open decision, so this isn't available here.",
  candidate_not_on_bench: "The candidate is no longer on the bench (Sales may have moved them already).",
  not_permitted: "You don't have permission to do that for this employee.",
  invalid_company: "Choose an active company from the list.",
  invalid_date: "Enter a valid date between 2000 and 2100.",
  invalid_rate: "Enter a pay rate above 0 and up to 1,000, with at most two decimals.",
  invalid_team: "That team no longer exists. Refresh and choose another.",
  invalid_field: "The server rejected one of the fields. Refresh and try again.",
};

export function employmentError(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : "Something went wrong.";
  if (e.detail && ERRORS[e.detail]) return ERRORS[e.detail]!;
  switch (e.status) {
    case 401: return "Your session ended. Sign in again.";
    case 403: return "You don't have permission to do that.";
    case 404: return "This record doesn't exist or is outside your scope.";
    case 422: return e.errors?.length ? "Some fields need attention." : "The server rejected this change. Check the values and try again.";
    case 429: return e.detail ?? "Too many requests. Try again in a few minutes.";
    case 503: return e.detail ?? "The report took too long. Choose a shorter period.";
    default: return e.detail ?? e.title ?? e.message ?? "Something went wrong.";
  }
}

/** Today in the browser's time zone as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 10);
}

export function shiftDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
