/**
 * Notification event types delivered from the outbox (docs/notifications.md is
 * the contract other modules write against; migration 0046).
 *
 * Each type names its channels (email, in-app inbox) and renders, from the
 * payload alone, the email and the inbox entry. Recipients are resolved in the
 * database by authz.notification_recipients (by type: role holders and/or the
 * recruiter, team lead and manager around the candidate or placement), never
 * from the payload's say-so, except the placement events' `notify` groups.
 *
 * Content rule (HANDOFF rule 5, design B6 "outbox-delivery"): an email or an
 * inbox entry carries only the event, statuses or enum labels, counts, an id
 * reference and a sign-in link. Never a name, rate, contact detail, document
 * type, expiry date or free-text reason. A payload that does not validate fails
 * the event before anyone is notified (the runner retries with backoff and alerts).
 */

export interface OutboxEvent { id: string; type: string; aggregate_id: string; payload: Record<string, unknown> }

/** What a recipient can open from the inbox (the web app has a screen for each). */
export interface EntityRef { type: "placement" | "candidate"; id: string }

export interface Rendered {
  subject: string;
  /** First line(s) of the email body. */
  message: string;
  /** The id reference line of the email ("Placement reference"). */
  refLabel: string;
  refId: string;
  /** Inbox entry (in-app types only). */
  inbox?: { title: string; body: string; entity: EntityRef };
}

export interface EventSpec {
  email: boolean;
  inApp: boolean;
  render(ev: OutboxEvent): Rendered;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || !UUID.test(v)) throw new Error(`outbox event payload has an invalid ${key}`);
  return v;
}

function optionalUuid(p: Record<string, unknown>, key: string): string | undefined {
  return p[key] === undefined || p[key] === null ? undefined : uuid(p, key);
}

function int(p: Record<string, unknown>, key: string, min: number, max: number): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`outbox event payload has an invalid ${key}`);
  return v;
}

function oneOf<T extends string>(p: Record<string, unknown>, key: string, values: readonly T[]): T {
  const v = p[key];
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw new Error(`outbox event payload has an invalid ${key}`);
  return v as T;
}

function date(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new Error(`outbox event payload has an invalid ${key}`);
  }
  return v;
}

function aggregate(ev: OutboxEvent): string {
  if (!UUID.test(ev.aggregate_id)) throw new Error("outbox event has an invalid aggregate id");
  return ev.aggregate_id;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export const PLACEMENT_STATUS_LABELS: Record<string, string> = {
  confirmed: "Confirmed", paperwork: "Paperwork", bgc: "Background check", ready: "Ready to join",
  joined: "Joined", backout: "Backed out", bgc_failed: "Background check failed",
};

function statusLabel(v: unknown): string {
  if (typeof v !== "string" || !(v in PLACEMENT_STATUS_LABELS)) throw new Error("outbox event has an unknown status");
  return PLACEMENT_STATUS_LABELS[v]!;
}

/**
 * The roles a type's payload `notify` list may name. Recipients are decided by
 * the registry and authz.notification_recipients, never by the payload: a
 * producer's `notify` is only checked against this list (a mismatch means the
 * producer and the registry disagree, so the event fails loudly instead of
 * notifying the wrong people). Placement events are the one exception kept from
 * 0022-0024: their `notify` groups select among hr, accounts and immigration.
 */
function checkNotify(p: Record<string, unknown>, allowed: readonly string[]): void {
  const n = p.notify;
  if (n === undefined) return;
  if (!Array.isArray(n) || n.some((g) => typeof g !== "string" || !allowed.includes(g))) {
    throw new Error("outbox event payload has an invalid notify list");
  }
}

const ADMIN_TEAMS_BU_CEO = ["hr", "accounts", "immigration", "bu_head", "ceo"] as const;

export const EVENT_SPECS: Record<string, EventSpec> = {
  // Placements (PL-7, migrations 0022-0024): unchanged, email only.
  "placement.created": {
    email: true, inApp: false,
    render: (ev) => ({
      subject: "Eureka: new placement",
      message: `A new placement was recorded in Eureka (status: ${statusLabel(ev.payload.status)}).`,
      refLabel: "Placement reference", refId: aggregate(ev),
    }),
  },
  "placement.state_changed": {
    email: true, inApp: false,
    render: (ev) => {
      const from = statusLabel(ev.payload.from);
      const to = statusLabel(ev.payload.to);
      return {
        subject: `Eureka: placement status changed to ${to}`,
        message: `A placement in Eureka moved from ${from} to ${to}.`,
        refLabel: "Placement reference", refId: aggregate(ev),
      };
    },
  },


  // FR-NTF-11 visa-expiry (FR-VIS-03; producer: visa-expiry job, migration 0042): HR and Immigration.
  "work_authorization.expiring": {
    email: true, inApp: true,
    render: (ev) => {
      aggregate(ev);
      const candidateId = uuid(ev.payload, "candidate_id");
      uuid(ev.payload, "person_id");
      date(ev.payload, "expires_on"); // validated, never shown
      const days = int(ev.payload, "threshold_days", 1, 365);
      const left = int(ev.payload, "days_left", 0, 365);
      if (left > days) throw new Error("outbox event payload has an invalid days_left");
      checkNotify(ev.payload, ["hr", "immigration"]);
      return {
        subject: `Eureka: work authorization expires within ${plural(days, "day")}`,
        message: `A work authorization recorded in Eureka reaches its ${days}-day expiry notice.`,
        refLabel: "Candidate reference", refId: candidateId,
        inbox: {
          title: `Work authorization expires within ${plural(days, "day")}`,
          body: `A candidate's work authorization reaches its ${days}-day expiry notice. Open the candidate to review it.`,
          entity: { type: "candidate", id: candidateId },
        },
      };
    },
  },

  // FR-NTF-09 project-exit (FR-EMP-04, design B5 flow 6): an assignment ended and the employee is on the
  // bench (producer: migration 0045 trigger on assignment end, bgc_failed after joining included).
  // Admin teams, BU, CEO.
  "employee.benched": {
    email: true, inApp: true,
    render: (ev) => {
      aggregate(ev);
      uuid(ev.payload, "personId");
      uuid(ev.payload, "candidateId");
      uuid(ev.payload, "assignmentId");
      const placementId = uuid(ev.payload, "placementId");
      date(ev.payload, "endDate");
      oneOf(ev.payload, "endReason", ["bgc_failed", "completed", "terminated", "resigned"] as const); // validated, never shown
      checkNotify(ev.payload, ADMIN_TEAMS_BU_CEO);
      return {
        subject: "Eureka: project assignment ended",
        message: "An employee's project assignment has ended in Eureka and the employee is on the bench.",
        refLabel: "Placement reference", refId: placementId,
        inbox: {
          title: "Project assignment ended",
          body: "An employee's project assignment has ended and the employee is on the bench. Open the placement for the details.",
          entity: { type: "placement", id: placementId },
        },
      };
    },
  },

  // The employee left the company (bench -> exited; producer: authz.exit_employee, migration 0045).
  // Same audience as project exit (FR-NTF-09).
  "employee.exited": {
    email: true, inApp: true,
    render: (ev) => {
      aggregate(ev);
      uuid(ev.payload, "personId");
      const candidateId = uuid(ev.payload, "candidateId");
      uuid(ev.payload, "lastAssignmentId");
      date(ev.payload, "exitDate");
      oneOf(ev.payload, "exitReason", ["resigned", "terminated", "other"] as const); // validated, never shown
      checkNotify(ev.payload, ADMIN_TEAMS_BU_CEO);
      return {
        subject: "Eureka: employee exit recorded",
        message: "An employee's exit from the company was recorded in Eureka.",
        refLabel: "Candidate reference", refId: candidateId,
        inbox: {
          title: "Employee exit recorded",
          body: "An employee's exit from the company was recorded. Open the candidate for the details.",
          entity: { type: "candidate", id: candidateId },
        },
      };
    },
  },

  // Not in design B6 (producer: assignment-ending-soon job, migration 0045): HR and Accounts, in-app only
  // (conservative default; see docs/notifications.md).
  "assignment.ending_soon": {
    email: false, inApp: true,
    render: (ev) => {
      aggregate(ev);
      uuid(ev.payload, "assignmentId");
      const placementId = uuid(ev.payload, "placementId");
      uuid(ev.payload, "personId");
      uuid(ev.payload, "candidateId");
      date(ev.payload, "plannedEndDate"); // validated, never shown
      const days = int(ev.payload, "daysLeft", 0, 365);
      checkNotify(ev.payload, ["hr", "accounts"]);
      const when = days === 0 ? "today" : `within ${plural(days, "day")}`;
      return {
        subject: `Eureka: project assignment ends ${when}`,
        message: `A project assignment ends ${when}.`,
        refLabel: "Placement reference", refId: placementId,
        inbox: {
          title: `Project assignment ends ${when}`,
          body: "A project assignment is ending soon. Open the placement for the details.",
          entity: { type: "placement", id: placementId },
        },
      };
    },
  },

  // FR-NTF-05 bench-time (producer: the bench-time job, migration 0046): TL, recruiter, manager, CEO once
  // a candidate has been on bench for N days. Distinct from employee.benched (the move to the bench).
  "employee.bench_time": {
    email: true, inApp: true,
    render: (ev) => {
      const candidateId = uuid(ev.payload, "candidateId");
      date(ev.payload, "benchSince");
      int(ev.payload, "benchDays", 0, 36500);
      const threshold = int(ev.payload, "thresholdDays", 1, 365);
      checkNotify(ev.payload, ["recruiter", "lead", "manager", "ceo"]);
      return {
        subject: `Eureka: candidate on bench for more than ${plural(threshold, "day")}`,
        message: `A candidate has been on bench for more than ${plural(threshold, "day")}.`,
        refLabel: "Candidate reference", refId: candidateId,
        inbox: {
          title: `Candidate on bench for more than ${plural(threshold, "day")}`,
          body: `A candidate has been on bench for more than ${plural(threshold, "day")}. Open the candidate to plan the next step.`,
          entity: { type: "candidate", id: candidateId },
        },
      };
    },
  },

  // FR-NTF-10 team-assigned (FR-EMP-05, on candidate.assigned): the new Lead and Manager.
  "candidate.assigned": {
    email: true, inApp: true,
    render: (ev) => {
      const candidateId = uuid(ev.payload, "candidateId");
      uuid(ev.payload, "teamId");
      optionalUuid(ev.payload, "fromTeamId");
      checkNotify(ev.payload, ["lead", "manager"]);
      return {
        subject: "Eureka: candidate assigned to your team",
        message: "A candidate was assigned to a team you lead or manage.",
        refLabel: "Candidate reference", refId: candidateId,
        inbox: {
          title: "Candidate assigned to your team",
          body: "A candidate was assigned to a team you lead or manage. Open the candidate to pick it up.",
          entity: { type: "candidate", id: candidateId },
        },
      };
    },
  },

  // FR-NTF-04 paperwork-pending (TL, recruiter, manager) and FR-NTF-03 documents-pending (the assigned Documents Team member).
  "checklist.item_overdue": {
    email: true, inApp: true,
    render: (ev) => {
      uuid(ev.payload, "checklistItemId");
      const placementId = uuid(ev.payload, "placementId");
      optionalUuid(ev.payload, "assigneeId");
      const days = int(ev.payload, "daysOverdue", 0, 3650);
      checkNotify(ev.payload, ["recruiter", "lead", "manager", "documents_team"]);
      return {
        subject: "Eureka: paperwork item overdue",
        message: `A paperwork checklist item on a placement is overdue (${plural(days, "day")}).`,
        refLabel: "Placement reference", refId: placementId,
        inbox: {
          title: "Paperwork item overdue",
          body: `A paperwork checklist item on a placement is overdue (${plural(days, "day")}). Open the placement to follow it up.`,
          entity: { type: "placement", id: placementId },
        },
      };
    },
  },
};

export const DELIVERED_TYPES = Object.keys(EVENT_SPECS);
export const EMAIL_TYPES = DELIVERED_TYPES.filter((t) => EVENT_SPECS[t]!.email);
export const INBOX_TYPES = DELIVERED_TYPES.filter((t) => EVENT_SPECS[t]!.inApp);

export function specOf(type: string): EventSpec {
  const spec = EVENT_SPECS[type];
  if (!spec) throw new Error("outbox event type is not delivered");
  return spec;
}

/** Why a recipient gets the email, from the reasons authz.notification_recipients returned. */
const GROUP_LABELS: Record<string, string> = { hr: "HR", accounts: "Accounts", immigration: "Immigration" };
const OTHER_LABELS: Record<string, string> = {
  ceo: "the CEO", bu_head: "a BU Head", recruiter: "the recruiter", lead: "the team lead",
  manager: "the team lead's manager", documents_team: "the assigned Documents Team member",
};

export function whyLine(reasons: readonly string[]): string {
  const sorted = [...new Set(reasons)].sort();
  const groups = sorted.filter((r) => r in GROUP_LABELS).map((r) => GROUP_LABELS[r]!);
  const parts = [
    ...(groups.length ? [`a member of ${groups.join(" and ")}`] : []),
    ...sorted.filter((r) => r in OTHER_LABELS).map((r) => OTHER_LABELS[r]!),
  ];
  if (parts.length === 0) throw new Error("recipient has no known reason");
  return `You receive this email as ${parts.join(" and ")}.`;
}

/** Subject and body of the email for one recipient. */
export function renderEmail(ev: OutboxEvent, origin: string, reasons: readonly string[]): { subject: string; text: string } {
  const r = specOf(ev.type).render(ev);
  if (!UUID.test(r.refId)) throw new Error("outbox event has an invalid reference");
  const footer = `${r.refLabel}: ${r.refId}\n\nSign in to Eureka for the details: ${origin}/\n${whyLine(reasons)}\n`;
  return { subject: r.subject, text: `${r.message}\n${footer}` };
}
