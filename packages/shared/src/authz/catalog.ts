/**
 * Authorization catalog: the single source of truth for roles, permissions and
 * scoped grants. The database seed (role_permission), the design document's
 * grants table and the authorization matrix tests are all generated from this
 * file, so they cannot drift apart. Changes here require code review.
 */

/**
 * Hot List visibility policy (OD-01, decided 2026-09-29): "everyone" means every
 * signed-in user sees every candidate in a Hot List status (list columns only),
 * with the phone masked unless they own the candidate. Candidate profiles, submissions,
 * interviews and placements stay scoped. Set to "team" to restore AS-07 (team
 * hierarchy plus Open-to-all-teams candidates). The migration runner copies this
 * value into authz.policy_setting, where authz.hotlist_page() reads it.
 */
export const HOTLIST_VISIBILITY: "everyone" | "team" = "everyone";

/** Statuses shown on the Hot List. */
export const HOTLIST_STATUSES = ["active", "on_hold", "full_of_interviews", "confirmation", "bench", "stopped"] as const;

export const SCOPES = ["own", "team", "coached", "hierarchy", "location", "org"] as const;
export type Scope = (typeof SCOPES)[number];

export const ROLES = [
  "recruiter",
  "lead",
  "manager",
  "assoc_director",
  "offshore_manager",
  "ceo",
  "location_incharge",
  "location_ops_admin",
  "hr",
  "associate_hr",
  "accounts",
  "immigration",
  "interview_coach",
  "documents_team",
  "bu_head",
  "org_admin",
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  recruiter: "Recruiter",
  lead: "Lead (Sales)",
  manager: "Manager (Sales)",
  assoc_director: "Associate Director",
  offshore_manager: "Offshore Office Manager",
  ceo: "CEO",
  location_incharge: "Location Incharge",
  location_ops_admin: "Location Ops Admin",
  hr: "HR",
  associate_hr: "Associate HR",
  accounts: "Accounts",
  immigration: "Immigration",
  interview_coach: "Interview Coach",
  documents_team: "Documents Team",
  bu_head: "BU Head",
  org_admin: "Org Admin",
};

/** Sales roles can see candidates marked "Open to all teams" (design AS-07). */
export const SALES_ROLES: readonly Role[] = [
  "recruiter",
  "lead",
  "manager",
  "assoc_director",
  "offshore_manager",
  "ceo",
];

/** Location-bound roles: their grants carry a location id. */
export const LOCATION_ROLES: readonly Role[] = ["location_incharge", "location_ops_admin"];

export const PERMISSIONS = [
  // candidates
  "candidate:read",
  "candidate:create",
  "candidate:update",
  "candidate:assign",
  "candidate.visibility:update",
  "candidate.rating:update",
  "candidate.phone:read",
  "candidate.dob:read",
  "hotlist:read",
  // marketing
  "submission:read",
  "submission:create",
  "submission:update",
  // interviews
  "interview:read",
  "interview:create",
  "interview:update",
  "interview.feedback:create",
  // placements and compliance
  "placement:read",
  "placement:create",
  "placement:update",
  "placement.bgc_status:update",
  "rate:read",
  "document:read",
  "document:upload",
  "document:verify",
  "document.restricted:read",
  "bgc:update",
  "visa:read",
  "visa:update",
  // employment and finance
  "employee:read",
  "assignment:read",
  "assignment:update",
  "invoice:read",
  "invoice:update",
  // insight
  "report:read",
  "report:export",
  "performance:read",
  // vendors and org
  "vendor.preferred:create",
  "vendor.preferred:read",
  // own companies and facilities (guest houses), their utilities and bills
  "company:read",
  "company:manage",
  "facility:read",
  "facility:manage",
  "utility:read",
  "utility:manage",
  "utility.secret:read",
  "bill:read",
  "bill:manage",
  "team:move_member",
  "designation:change",
  // administration
  "access:manage",
  "audit:read",
  // datahub
  "datahub:read",
  "datahub:manage",
  // training
  "training:read",
  "training:manage",
  "training.progress:update",
  // interviews-settings
  /** Staff contact details (phone, bio) entered in Settings; read by HR and in Users & Access. */
  "staff.contact:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Permissions that expose restricted data; granting them needs a second approver. */
export const RESTRICTED_PERMISSIONS: readonly Permission[] = [
  "document.restricted:read",
  "candidate.dob:read",
  "visa:read",
  "visa:update",
  "utility.secret:read",
  // datahub: a manager can name themself a member of any Restricted folder they manage (docs/datahub-api.md DH-3).
  "datahub:manage",
];

type Grants = Partial<Record<Permission, Scope>>;

const salesLine = (s: Scope, submitScope: Scope): Grants => ({
  "candidate:read": s,
  "candidate:create": s,
  "candidate:update": s,
  "candidate.phone:read": s,
  "hotlist:read": s,
  "submission:read": s,
  "submission:create": submitScope,
  "submission:update": s,
  "interview:read": s,
  "interview:create": s,
  "interview:update": s,
  "interview.feedback:create": s,
  "placement:read": s,
  "placement:create": submitScope,
  "placement:update": s,
  "assignment:read": s,
  "performance:read": s,
  "report:read": s,
  "document:read": s,
  "document:upload": s,
});

export const GRANTS: Record<Role, Grants> = {
  recruiter: {
    ...salesLine("team", "team"),
    "candidate:create": "own",
    "candidate:update": "own",
    "assignment:read": "own",
    "submission:read": "own",
    "submission:update": "own",
    "interview:read": "own",
    "interview:create": "own",
    "interview:update": "own",
    "interview.feedback:create": "own",
    "placement:read": "own",
    "placement:update": "own",
    "performance:read": "own",
    "report:read": "own",
    "document:read": "own",
    "document:upload": "own",
    "vendor.preferred:create": "own",
    // datahub
    "datahub:read": "own",
    // training
    "training:read": "own",
  },
  lead: {
    ...salesLine("team", "team"),
    "candidate:assign": "team",
    "candidate.visibility:update": "team",
    "report:export": "team",
    "vendor.preferred:create": "own",
    "vendor.preferred:read": "team",
    // datahub
    "datahub:read": "own",
    // training
    "training:read": "team",
  },
  manager: {
    ...salesLine("hierarchy", "hierarchy"),
    "candidate:assign": "hierarchy",
    "candidate.visibility:update": "hierarchy",
    "placement.bgc_status:update": "hierarchy",
    "rate:read": "hierarchy",
    "report:export": "hierarchy",
    "vendor.preferred:read": "hierarchy",
    "team:move_member": "hierarchy",
    "designation:change": "hierarchy",
    // datahub
    "datahub:read": "own",
    // training
    "training:read": "hierarchy",
  },
  assoc_director: {
    ...salesLine("hierarchy", "hierarchy"),
    "candidate:assign": "hierarchy",
    "candidate.visibility:update": "hierarchy",
    "placement.bgc_status:update": "hierarchy",
    "rate:read": "hierarchy",
    "report:export": "hierarchy",
    "vendor.preferred:read": "hierarchy",
    "team:move_member": "hierarchy",
    "designation:change": "hierarchy",
    // datahub
    "datahub:read": "own",
    // training
    "training:read": "hierarchy",
  },
  offshore_manager: {
    "candidate:read": "org",
    "candidate:assign": "org",
    "assignment:read": "org",
    "candidate.phone:read": "org",
    "hotlist:read": "org",
    "submission:read": "org",
    "interview:read": "org",
    "placement:read": "org",
    "rate:read": "org",
    "performance:read": "org",
    "report:read": "org",
    "report:export": "org",
    "vendor.preferred:read": "org",
    "team:move_member": "org",
    "designation:change": "org",
    // datahub
    "datahub:read": "own",
    // training
    "training:read": "org",
  },
  ceo: {
    "candidate:read": "org",
    "assignment:read": "org",
    "hotlist:read": "org",
    "submission:read": "org",
    "interview:read": "org",
    "placement:read": "org",
    "rate:read": "org",
    "employee:read": "org",
    "invoice:read": "org",
    "performance:read": "org",
    "report:read": "org",
    "report:export": "org",
    "vendor.preferred:read": "org",
    // datahub
    "datahub:read": "own",
    // training
    "training:read": "org",
  },
  location_incharge: {
    "candidate:read": "location",
    "candidate.phone:read": "location",
    "candidate.rating:update": "location",
    "hotlist:read": "location",
    "submission:read": "location",
    "interview:read": "location",
    "interview:update": "location",
    "interview.feedback:create": "location",
    "placement:read": "location",
    "performance:read": "location",
    "report:read": "location",
    // datahub
    "datahub:read": "own",
    // training
    "training:read": "location",
    "training:manage": "location",
    "training.progress:update": "location",
  },
  location_ops_admin: {
    // Companies and facilities of their location, with utilities and bills (utility
    // portal passwords: restricted, step-up on every reveal).
    "company:read": "location",
    "company:manage": "location",
    "facility:read": "location",
    "facility:manage": "location",
    "utility:read": "location",
    "utility:manage": "location",
    "utility.secret:read": "location",
    "bill:read": "location",
    "bill:manage": "location",
    "candidate:read": "location",
    "candidate.phone:read": "location",
    "candidate.rating:update": "location",
    "hotlist:read": "location",
    "submission:read": "location",
    "interview:read": "location",
    "interview:update": "location",
    "interview.feedback:create": "location",
    "placement:read": "location",
    "report:read": "location",
    // datahub
    "datahub:read": "own",
    "datahub:manage": "location",
    // training
    "training:read": "location",
    "training:manage": "location",
    "training.progress:update": "location",
  },
  hr: {
    "assignment:read": "org",
    "candidate:read": "org",
    "candidate.phone:read": "org",
    "candidate.dob:read": "org",
    "placement:read": "org",
    "employee:read": "org",
    "assignment:update": "org",
    "document:read": "org",
    "document:upload": "org",
    "document:verify": "org",
    "document.restricted:read": "org",
    "bgc:update": "org",
    "visa:read": "org",
    "report:read": "org",
    // datahub
    "datahub:read": "own",
    "datahub:manage": "org",
    // interviews-settings
    "staff.contact:read": "org",
  },
  associate_hr: {
    "assignment:read": "org",
    "candidate:read": "org",
    "candidate.phone:read": "org",
    "placement:read": "org",
    "employee:read": "org",
    "assignment:update": "org",
    "document:read": "org",
    "document:upload": "org",
    // datahub
    "datahub:read": "own",
  },
  accounts: {
    "assignment:read": "org",
    "candidate:read": "org",
    "placement:read": "org",
    "rate:read": "org",
    "employee:read": "org",
    "assignment:update": "org",
    "invoice:read": "org",
    "invoice:update": "org",
    "document:read": "org",
    "document.restricted:read": "org",
    "report:read": "org",
    // datahub
    "datahub:read": "own",
    "datahub:manage": "org",
  },
  immigration: {
    "assignment:read": "org",
    "candidate:read": "org",
    "candidate.phone:read": "org",
    "candidate.dob:read": "org",
    "employee:read": "org",
    "document:read": "org",
    "document:upload": "org",
    "document:verify": "org",
    "document.restricted:read": "org",
    "visa:read": "org",
    "visa:update": "org",
    // datahub
    "datahub:read": "own",
  },
  interview_coach: {
    "candidate:read": "coached",
    "hotlist:read": "coached",
    "interview:read": "coached",
    "interview.feedback:create": "coached",
    // datahub
    "datahub:read": "own",
    // training: batches where they are the trainer (and progress of coached teams' candidates)
    "training:read": "coached",
    "training.progress:update": "coached",
  },
  documents_team: {
    "candidate:read": "org",
    "document:read": "org",
    "document:upload": "org",
    "document:verify": "org",
    // datahub
    "datahub:read": "own",
  },
  bu_head: {
    "assignment:read": "org",
    "employee:read": "org",
    "placement:read": "org",
    "report:read": "org",
    // datahub
    "datahub:read": "own",
  },
  org_admin: {
    "access:manage": "org",
    "audit:read": "org",
    // interviews-settings: staff directory data (work phone), not business data.
    "staff.contact:read": "org",
  },
};

export function grantFor(role: Role, permission: Permission): Scope | undefined {
  return GRANTS[role][permission];
}

/**
 * Restricted roles need a second approver when granted (admin-api.md AD-3):
 * org_admin, every role holding a permission in RESTRICTED_PERMISSIONS, and
 * every role holding an organisation-wide sensitive permission
 * (ORG_SENSITIVE_PERMISSIONS at "org" scope). Security review 2026-09-29: one
 * admin must not be able to hand out org-wide phones, rates, invoices or
 * documents alone.
 * The migration runner copies this into eureka.role.is_restricted, which the
 * database approval functions read.
 */
export const ORG_SENSITIVE_PERMISSIONS: readonly Permission[] = [
  "rate:read",
  "invoice:read",
  "employee:read",
  "candidate.phone:read",
  "candidate:assign",
  "team:move_member",
  "document:read",
];

export function isRestrictedRole(role: Role): boolean {
  return (
    role === "org_admin" ||
    RESTRICTED_PERMISSIONS.some((p) => GRANTS[role][p] !== undefined) ||
    ORG_SENSITIVE_PERMISSIONS.some((p) => GRANTS[role][p] === "org")
  );
}
