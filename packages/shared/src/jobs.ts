import { z } from "zod";
import { GRANTS, SALES_ROLES } from "./authz/catalog.js";
import { resolveScope, type UserAccess } from "./authz/engine.js";

/**
 * Jobs, the applicant portal and applications (jobs-portal package; migrations
 * 0060-0062; docs/jobs-portal-api.md). Shared by the API (validation, access
 * hints), the web app (labels, forms) and the tests. The database enforces the
 * same lists in CHECK constraints.
 */

export const JOB_KINDS = ["client_requirement", "internal_opening"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_CATEGORIES = [
  "engineering", "sales", "marketing", "hr", "finance", "operations", "customer_support", "administration", "other",
] as const;
export const EXPERIENCE_LEVELS = ["entry", "junior", "mid", "senior", "lead"] as const;
export const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract"] as const;
export const WORK_MODES = ["on_site", "remote", "hybrid"] as const;
export const JOB_STATUSES = ["draft", "open", "on_hold", "closed"] as const;
export const PAY_FREQUENCIES = ["hourly", "monthly", "yearly"] as const;
export const PAY_CURRENCIES = ["USD", "INR", "EUR", "GBP", "CAD", "AUD"] as const;

export const JOB_LABELS: Record<string, string> = {
  client_requirement: "Client requirement", internal_opening: "Internal opening",
  engineering: "Engineering", sales: "Sales", marketing: "Marketing", hr: "HR", finance: "Finance",
  operations: "Operations", customer_support: "Customer support", administration: "Administration", other: "Other",
  entry: "Entry level", junior: "Junior", mid: "Mid level", senior: "Senior", lead: "Lead",
  full_time: "Full time", part_time: "Part time", contract: "Contract",
  on_site: "On-site", remote: "Remote", hybrid: "Hybrid",
  draft: "Draft", open: "Open", on_hold: "On hold", closed: "Closed",
  hourly: "Hourly", monthly: "Monthly", yearly: "Yearly",
};
export const jobLabel = (v: string) => JOB_LABELS[v] ?? v.replace(/_/g, " ");

// ---------- rich text ----------

/**
 * Rich text is stored as a small document tree, never as HTML: paragraphs and
 * (unnested) bulleted or numbered lists of text runs, each run with optional
 * bold/italic/underline/strike marks and an optional https link. The schema is
 * the allow-list: anything else (tags, attributes, styles, scripts, other URL
 * schemes) cannot be represented, and the web app renders the tree with React
 * elements (no innerHTML).
 */
export const RICH_MARKS = ["b", "i", "u", "s"] as const;
export type RichMark = (typeof RICH_MARKS)[number];
export interface RichRun { text: string; marks?: RichMark[]; href?: string }
export type RichBlock = { type: "p"; runs: RichRun[] } | { type: "ul" | "ol"; items: RichRun[][] };
export interface RichDoc { blocks: RichBlock[] }

export const RICH_LIMITS = { blocks: 200, runsPerLine: 100, items: 100, runText: 4000, totalText: 20000, href: 2000 } as const;

/** An absolute https URL without credentials (what links may point to). */
export function isSafeHttpsUrl(v: string): boolean {
  if (v.length > RICH_LIMITS.href || /[\s<>"'`\\]/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname.length > 0 && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const Run = z.object({
  text: z.string().min(1).max(RICH_LIMITS.runText).refine((t) => !CONTROL.test(t), "control characters are not allowed"),
  marks: z.array(z.enum(RICH_MARKS)).max(4).refine((m) => new Set(m).size === m.length, "duplicate mark").optional(),
  href: z.string().refine(isSafeHttpsUrl, "links must be https URLs").optional(),
}).strict();
const Line = z.array(Run).max(RICH_LIMITS.runsPerLine);
const Block = z.discriminatedUnion("type", [
  z.object({ type: z.literal("p"), runs: Line }).strict(),
  z.object({ type: z.enum(["ul", "ol"]), items: z.array(Line).min(1).max(RICH_LIMITS.items) }).strict(),
]);
export const RichDocSchema = z.object({ blocks: z.array(Block).max(RICH_LIMITS.blocks) }).strict()
  .refine((d) => richTextLength(d) <= RICH_LIMITS.totalText, `text is longer than ${RICH_LIMITS.totalText} characters`);

function lines(d: RichDoc): RichRun[][] {
  return d.blocks.flatMap((b) => (b.type === "p" ? [b.runs] : b.items));
}
export function richTextLength(d: RichDoc): number {
  return lines(d).reduce((n, l) => n + l.reduce((m, r) => m + r.text.length, 0), 0);
}
/** Plain text of a document (lines joined by newlines). */
export function richToPlain(d: RichDoc | null | undefined): string {
  if (!d) return "";
  return lines(d).map((l) => l.map((r) => r.text).join("")).join("\n").trim();
}
/** First `max` characters of the plain text on one line (job cards). */
export function richExcerpt(d: RichDoc | null | undefined, max = 180): string {
  const t = richToPlain(d).replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
export const isRichEmpty = (d: RichDoc | null | undefined) => richToPlain(d) === "";

// ---------- access ----------

export interface JobRef {
  kind: JobKind;
  ownerId: string;
  teamId: string | null;
  hiringManagerId: string | null;
}

const isSales = (role: string) => (SALES_ROLES as readonly string[]).includes(role);

/**
 * Who may read or manage a job (docs/jobs-portal-api.md JP-1, JP-2; the RLS
 * policies of migration 0060 apply the same rules):
 *   - client requirements: job:read / job:manage held by a Sales role, at its
 *     scope over the job's owner (the creator) and team snapshot;
 *   - internal openings: job:read / job:manage at org scope held by a non-Sales
 *     role (HR);
 *   - the hiring manager of a job can always read it.
 * Catalog invariant (tested): non-org job grants are held by Sales roles only.
 */
export function jobAllowed(access: UserAccess, perm: "job:read" | "job:manage", j: JobRef): boolean {
  if (perm === "job:read" && j.hiringManagerId !== null && j.hiringManagerId === access.userId) return true;
  const roles = access.roles.filter((a) => GRANTS[a.role][perm] !== undefined && isSales(a.role) === (j.kind === "client_requirement"));
  if (roles.length === 0) return false;
  const scope = resolveScope({ ...access, roles }, perm);
  if (!scope) return false;
  if (j.kind === "internal_opening") return scope.all;
  return scope.all || scope.recruiterIds.has(j.ownerId) || (j.teamId !== null && scope.teamIds.has(j.teamId));
}

/** Which kinds of job the user may create (presentation and validation). */
export function creatableJobKinds(access: UserAccess): JobKind[] {
  const out: JobKind[] = [];
  const holders = access.roles.filter((a) => GRANTS[a.role]["job:manage"] !== undefined);
  if (holders.some((a) => isSales(a.role))) out.push("client_requirement");
  if (holders.some((a) => !isSales(a.role) && GRANTS[a.role]["job:manage"] === "org")) out.push("internal_opening");
  return out;
}

// ---------- applications ----------

export const APPLICATION_STATUSES = ["applied", "shortlisted", "interview_scheduled", "offered", "hired", "rejected", "withdrawn"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  applied: "Applied", shortlisted: "Shortlisted", interview_scheduled: "Interview scheduled",
  offered: "Offered", hired: "Hired", rejected: "Rejected", withdrawn: "Withdrawn",
};

/**
 * Staff status changes (JP-20). Forward along applied -> shortlisted ->
 * interview_scheduled -> offered -> hired, a step may be skipped forward, and
 * any open application can be rejected. hired, rejected and withdrawn are
 * final. Only the applicant withdraws (applied..offered).
 */
const ORDER: ApplicationStatus[] = ["applied", "shortlisted", "interview_scheduled", "offered", "hired"];
export const FINAL_APPLICATION_STATUSES: readonly ApplicationStatus[] = ["hired", "rejected", "withdrawn"];
export function applicationTransitionAllowed(from: ApplicationStatus, to: ApplicationStatus): boolean {
  if (FINAL_APPLICATION_STATUSES.includes(from) || from === to || to === "withdrawn") return false;
  if (to === "rejected") return true;
  return ORDER.indexOf(to) > ORDER.indexOf(from);
}
export function nextApplicationStatuses(from: ApplicationStatus): ApplicationStatus[] {
  return APPLICATION_STATUSES.filter((to) => applicationTransitionAllowed(from, to));
}
export const applicantMayWithdraw = (s: ApplicationStatus) => ["applied", "shortlisted", "interview_scheduled", "offered"].includes(s);

export const APP_INTERVIEW_TYPES = ["phone", "video", "in_person"] as const;
export const APP_INTERVIEW_ROUNDS = ["screening", "technical", "hr", "managerial", "final"] as const;
export const APP_INTERVIEW_STATUSES = ["scheduled", "completed", "cancelled", "no_show"] as const;
export const APP_INTERVIEW_LABELS: Record<string, string> = {
  phone: "Phone", video: "Video", in_person: "In person",
  screening: "Initial screening", technical: "Technical", hr: "HR", managerial: "Managerial", final: "Final round",
  scheduled: "Scheduled", completed: "Completed", cancelled: "Cancelled", no_show: "No show",
};
export const SCORE_FIELDS = ["technical", "communication", "problemSolving", "attitude"] as const;
