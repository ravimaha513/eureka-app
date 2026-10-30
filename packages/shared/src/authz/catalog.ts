/**
 * Authorization catalog: the single source of truth for permissions, scopes and
 * the system roles (templates an admin clones into custom roles; docs/roles-api.md).
 * The database seed (eureka.permission, the system rows of role and
 * role_permission), the design document's grants table and the authorization
 * matrix tests are all generated from this file, so they cannot drift apart.
 * Custom roles live only in the database; at runtime the engine reads every
 * role's grants and traits from there (AccessService), never from this file.
 * Changes here require code review.
 */

/**
 * Hot List visibility policy. "team" (Eureka App 4 spec, 2026-10-16; AS-07): a
 * candidate assigned to a team is on the Hot List of that lead's sales team (its
 * hierarchy upwards) and of the interview prep team (interview coaches of that
 * team); candidates marked "Open to all teams" are on every Sales user's Hot List.
 * Location roles keep their location and the CEO the organisation. "everyone"
 * (OD-01, 2026-09-29 to 2026-10-16) lists every Hot List candidate to every
 * signed-in user (list columns only, phones masked). The migration runner
 * copies this value into authz.policy_setting, where authz.hotlist_page() reads it.
 */
export const HOTLIST_VISIBILITY: "everyone" | "team" = "team";

/** Statuses shown on the Hot List. */
export const HOTLIST_STATUSES = ["active", "on_hold", "full_of_interviews", "confirmation", "bench", "stopped"] as const;

/**
 * `coached`: teams the user supports as an Interview Coach (coach_assignment).
 * `coached_hierarchy`: those teams plus the teams coached by anyone below the
 * user in the reporting hierarchy (the Interview Lead over their coaches).
 */
export const SCOPES = ["own", "team", "coached", "coached_hierarchy", "hierarchy", "location", "org"] as const;
export type Scope = (typeof SCOPES)[number];

export const ROLES = [
  "recruiter",
  "lead",
  "manager",
  "assoc_director",
  "ceo",
  "location_incharge",
  "location_ops_admin",
  "hr",
  "associate_hr",
  "accounts",
  "immigration",
  "interview_coach",
  "interview_lead",
  "interview_coordinator",
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
  ceo: "CEO",
  location_incharge: "Location Incharge",
  location_ops_admin: "Location Ops Admin",
  hr: "HR",
  associate_hr: "Associate HR",
  accounts: "Accounts",
  immigration: "Immigration",
  interview_coach: "Interview Coach",
  interview_lead: "Interview Lead",
  interview_coordinator: "Interview Coordinator (Support)",
  documents_team: "Documents Team",
  bu_head: "BU Head",
  org_admin: "Org Admin",
};

/**
 * How the system treats a role's holders, independent of its grants (docs/roles-api.md).
 * Code branches on these, never on the role key, so a custom role cloned from a
 * system role behaves like it. Stored in eureka.role; editable on custom roles.
 */
export interface RoleTraits {
  /** Sees candidates marked "Open to all teams" (design AS-07); client-requirement jobs; performance subject. */
  sales: boolean;
  /** Grants carry a location id. */
  locationBound: boolean;
  /** Users & Access administrator: separation of duties, last-admin guard, restricted by definition. */
  admin: boolean;
  /** Owns candidates by default (candidate.recruiter_id); may be added to a team as a member (AD-10). */
  recruiter: boolean;
  /** May be assigned to coach sales teams (AD-11) and train batches. */
  coach: boolean;
}

const traits = (over: Partial<RoleTraits> = {}): RoleTraits => ({
  sales: false, locationBound: false, admin: false, recruiter: false, coach: false, ...over,
});

export const ROLE_TRAITS: Record<Role, RoleTraits> = {
  recruiter: traits({ sales: true, recruiter: true }),
  lead: traits({ sales: true }),
  manager: traits({ sales: true }),
  assoc_director: traits({ sales: true }),
  ceo: traits({ sales: true }),
  location_incharge: traits({ locationBound: true }),
  location_ops_admin: traits({ locationBound: true }),
  hr: traits(),
  associate_hr: traits(),
  accounts: traits(),
  immigration: traits(),
  interview_coach: traits({ coach: true }),
  interview_lead: traits({ coach: true }),
  interview_coordinator: traits(),
  documents_team: traits(),
  bu_head: traits(),
  org_admin: traits({ admin: true }),
};

/**
 * Ladder position (docs/roles-api.md): `track` groups roles that form a reporting
 * line, `level` orders them bottom-up. Presentation and promotion only; grants nothing.
 */
export const ROLE_LADDER: Record<Role, { track: string; level: number }> = {
  recruiter: { track: "sales", level: 1 },
  lead: { track: "sales", level: 2 },
  manager: { track: "sales", level: 3 },
  assoc_director: { track: "sales", level: 4 },
  ceo: { track: "sales", level: 5 },
  interview_coach: { track: "interview_prep", level: 1 },
  interview_lead: { track: "interview_prep", level: 2 },
  interview_coordinator: { track: "interview_prep", level: 1 },
  location_ops_admin: { track: "location", level: 1 },
  location_incharge: { track: "location", level: 2 },
  associate_hr: { track: "hr", level: 1 },
  hr: { track: "hr", level: 2 },
  accounts: { track: "operations", level: 1 },
  immigration: { track: "operations", level: 1 },
  documents_team: { track: "operations", level: 1 },
  bu_head: { track: "operations", level: 2 },
  org_admin: { track: "administration", level: 1 },
};

/** Sales roles can see candidates marked "Open to all teams" (design AS-07). */
export const SALES_ROLES: readonly Role[] = ROLES.filter((r) => ROLE_TRAITS[r].sales);

/** Location-bound roles: their grants carry a location id. */
export const LOCATION_ROLES: readonly Role[] = ROLES.filter((r) => ROLE_TRAITS[r].locationBound);

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
  /** E-Verify, offer letter and 1099 company links and the documents status summary (gap/candidates). */
  "candidate.compliance:update",
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
  /** Block the support team's shared Google Calendar for an interview (interview-alerts package). */
  "calendar:block",
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
  /** Recruiter targets per period (docs/performance-api.md PF-4); set by managers and associate directors. */
  "performance.target:manage",
  // market-reports: point-in-time candidate counts (in market, placed, per status) for planning batches
  "report.market:read",
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
  /** Add an unassigned recruiter to a team one leads, or one led in one's hierarchy (docs/admin-api.md AD-10). */
  "team:add_member",
  "designation:change",
  /** Assign interview coaches to sales teams: coaches in one's reporting subtree (docs/admin-api.md AD-11). */
  "coach:assign",
  // administration
  "access:manage",
  "audit:read",
  // datahub
  "datahub:read",
  "datahub:manage",
  /** Create organisation-wide folders and manage only the folders one created (docs/datahub-api.md DH-2a). */
  "datahub:create",
  // training
  "training:read",
  "training:manage",
  "training.progress:update",
  /** Create training batches anywhere (docs/training-api.md TR-1a); editing them needs training:manage. */
  "training.batch:create",
  // reference data
  /** Add a technology to the pickers (docs/lookups-api.md); reading the list is open to everyone. */
  "technology:create",
  /** Add a client or vendor to the pickers (docs/lookups-api.md); every Sales role. */
  "client:create",
  "vendor:create",
  // interviews-settings
  /** Staff contact details (phone, bio) entered in Settings; read by HR and in Users & Access. */
  "staff.contact:read",
  /** Staff birthdays (month and day) entered for HR and the offshore team; the CEO's morning digest. */
  "staff.birthday:manage",
  // chat
  "chat:use",
  // jobs-portal: jobs (client requirements, internal openings), applicants and their applications
  "job:read",
  "job:manage",
  "applicant:read",
  "applicant.phone:read",
  "application:read",
  "application:manage",
  // notifications: who receives an event (authz.notification_recipients); docs/roles-api.md
  "notify.placement_hr:receive",
  "notify.placement_accounts:receive",
  "notify.placement_immigration:receive",
  "notify.work_authorization:receive",
  "notify.employee_exit:receive",
  "notify.assignment_ending:receive",
  "notify.bench_time:receive",
  "notify.application:receive",
  "notify.interview_request:receive",
  "notify.contract:receive",
  "notify.birthdays:receive",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Grid headings of the Roles screen, by the permission key's first segment. */
export const PERMISSION_AREAS: Record<string, string> = {
  candidate: "Candidates",
  hotlist: "Candidates",
  submission: "Marketing",
  interview: "Interviews",
  calendar: "Interviews",
  placement: "Placements",
  rate: "Placements",
  document: "Documents",
  bgc: "Documents",
  visa: "Documents",
  employee: "Employees",
  assignment: "Employees",
  invoice: "Finance",
  bill: "Finance",
  report: "Insight",
  performance: "Insight",
  vendor: "Vendors",
  company: "Companies & facilities",
  facility: "Companies & facilities",
  utility: "Companies & facilities",
  team: "Organisation",
  designation: "Organisation",
  coach: "Organisation",
  staff: "Organisation",
  access: "Administration",
  audit: "Administration",
  technology: "Administration",
  datahub: "Data Hub",
  training: "Training",
  chat: "Chat",
  job: "Jobs portal",
  applicant: "Jobs portal",
  application: "Jobs portal",
  notify: "Notifications",
};

export function permissionArea(p: Permission): string {
  return PERMISSION_AREAS[p.split(/[.:]/)[0]!] ?? "Other";
}

/** One line per permission for the Roles screen. */
export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  "candidate:read": "See candidates and their profiles",
  "candidate:create": "Add candidates",
  "candidate:update": "Edit candidates",
  "candidate:assign": "Move candidates between recruiters and teams",
  "candidate.visibility:update": "Open a candidate to all or selected teams",
  "candidate.rating:update": "Rate candidates",
  "candidate.phone:read": "See candidate phone numbers",
  "candidate.dob:read": "See candidate dates of birth (restricted)",
  "candidate.compliance:update": "E-Verify, offer letter and 1099 links; documents status",
  "hotlist:read": "See the Hot List",
  "submission:read": "See submissions",
  "submission:create": "Submit candidates to clients",
  "submission:update": "Edit submissions",
  "interview:read": "See interviews",
  "interview:create": "Schedule interviews",
  "interview:update": "Edit interviews and outcomes",
  "interview.feedback:create": "Record interview feedback",
  "calendar:block": "Block the support team's calendar",
  "placement:read": "See placements",
  "placement:create": "Create placements",
  "placement:update": "Edit placements",
  "placement.bgc_status:update": "Update background-check status",
  "rate:read": "See bill and pay rates",
  "document:read": "See candidate documents",
  "document:upload": "Upload candidate documents",
  "document:verify": "Verify documents",
  "document.restricted:read": "Open restricted documents (restricted)",
  "bgc:update": "Edit background-check details",
  "visa:read": "See visa and work-authorisation details (restricted)",
  "visa:update": "Edit visa and work-authorisation details (restricted)",
  "employee:read": "See employees and their assignments",
  "assignment:read": "See client assignments",
  "assignment:update": "Edit client assignments",
  "invoice:read": "See invoices and payments",
  "invoice:update": "Record invoices and payments",
  "report:read": "See reports and the dashboard",
  "report:export": "Export reports",
  "performance:read": "See recruiter performance",
  "performance.target:manage": "Set recruiter targets",
  "report.market:read": "See market reports",
  "vendor.preferred:create": "Add preferred vendors",
  "vendor.preferred:read": "See preferred vendors",
  "company:read": "See own companies",
  "company:manage": "Edit own companies",
  "facility:read": "See facilities (guest houses)",
  "facility:manage": "Edit facilities",
  "utility:read": "See utility accounts",
  "utility:manage": "Edit utility accounts",
  "utility.secret:read": "Reveal utility portal passwords (restricted)",
  "bill:read": "See bills",
  "bill:manage": "Edit bills",
  "team:move_member": "Move people between teams",
  "team:add_member": "Add unassigned recruiters to a team",
  "designation:change": "Change designations",
  "coach:assign": "Assign interview coaches to teams",
  "access:manage": "Users & Access administration",
  "audit:read": "Read the audit log",
  "datahub:read": "Read Data Hub folders",
  "datahub:manage": "Manage Data Hub folders (restricted)",
  "datahub:create": "Create Data Hub folders",
  "training:read": "See training batches",
  "training:manage": "Edit training batches",
  "training.progress:update": "Update trainee progress",
  "training.batch:create": "Create training batches",
  "technology:create": "Add technologies to the pickers",
  "client:create": "Add clients to the pickers",
  "vendor:create": "Add vendors to the pickers",
  "staff.contact:read": "See staff contact details",
  "staff.birthday:manage": "Manage staff birthdays",
  "chat:use": "Use chat",
  "job:read": "See jobs",
  "job:manage": "Edit jobs",
  "applicant:read": "See applicants",
  "applicant.phone:read": "See applicant phone numbers",
  "application:read": "See applications",
  "application:manage": "Process applications",
  "notify.placement_hr:receive": "Placement notifications addressed to HR",
  "notify.placement_accounts:receive": "Placement notifications addressed to Accounts",
  "notify.placement_immigration:receive": "Placement notifications addressed to Immigration",
  "notify.work_authorization:receive": "Work authorisation expiring",
  "notify.employee_exit:receive": "Employee benched or exited",
  "notify.assignment_ending:receive": "Assignment ending soon",
  "notify.bench_time:receive": "Bench time alerts",
  "notify.application:receive": "New job applications",
  "notify.interview_request:receive": "Interview requests to coordinate",
  "notify.contract:receive": "New contracts",
  "notify.birthdays:receive": "Staff birthdays digest",
};

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

export type Grants = Partial<Record<Permission, Scope>>;

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
  // reference data: anyone logging submissions can add a missing client or vendor
  "client:create": "org",
  "vendor:create": "org",
});

const withoutCandidateCreate = ({ "candidate:create": _, ...rest }: Grants): Grants => rest;

export const GRANTS: Record<Role, Grants> = {
  recruiter: {
    // CA-6: only a lead or above adds candidates, so no candidate:create.
    ...withoutCandidateCreate(salesLine("team", "team")),
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
    // chat
    "chat:use": "own",
    // jobs-portal
    "job:read": "team",
    // payments (gap L1, migration 0100): invoices of their placements; amounts still need rate:read
    "invoice:read": "own",
  },
  lead: {
    ...salesLine("team", "team"),
    "candidate:assign": "team",
    "candidate.visibility:update": "team",
    "report:export": "team",
    // AD-10: add unassigned recruiters to the team they lead
    "team:add_member": "team",
    "vendor.preferred:create": "own",
    "vendor.preferred:read": "team",
    // interview-alerts: block the support calendar for the team's interviews
    "calendar:block": "team",
    // reference data: add technologies (docs/lookups-api.md)
    "technology:create": "org",
    // market-reports
    "report.market:read": "team",
    // datahub
    "datahub:read": "own",
    "datahub:create": "own",
    // training
    "training:read": "team",
    // chat
    "chat:use": "own",
    // jobs-portal
    "job:read": "team",
    "job:manage": "team",
    // payments (gap L1, migration 0100): invoices of their placements; amounts still need rate:read
    "invoice:read": "team",
  },
  manager: {
    // reference data: add technologies (docs/lookups-api.md)
    "technology:create": "org",
    ...salesLine("hierarchy", "hierarchy"),
    "calendar:block": "hierarchy",
    "candidate:assign": "hierarchy",
    "candidate.visibility:update": "hierarchy",
    "placement.bgc_status:update": "hierarchy",
    "rate:read": "hierarchy",
    "report:export": "hierarchy",
    "vendor.preferred:read": "hierarchy",
    "team:move_member": "hierarchy",
    // AD-10: add unassigned recruiters to teams led within their hierarchy
    "team:add_member": "hierarchy",
    "designation:change": "hierarchy",
    // performance: recruiter targets for the hierarchy
    "performance.target:manage": "hierarchy",
    // market-reports
    "report.market:read": "hierarchy",
    // datahub
    "datahub:read": "own",
    "datahub:create": "own",
    // training
    "training:read": "hierarchy",
    // chat
    "chat:use": "own",
    // jobs-portal
    "job:read": "hierarchy",
    "job:manage": "hierarchy",
    // payments (gap L1, migration 0100): invoices of their placements; amounts still need rate:read
    "invoice:read": "hierarchy",
  },
  assoc_director: {
    // reference data: add technologies (docs/lookups-api.md)
    "technology:create": "org",
    ...salesLine("hierarchy", "hierarchy"),
    "calendar:block": "hierarchy",
    "candidate:assign": "hierarchy",
    "candidate.visibility:update": "hierarchy",
    "placement.bgc_status:update": "hierarchy",
    "rate:read": "hierarchy",
    "report:export": "hierarchy",
    "vendor.preferred:read": "hierarchy",
    "team:move_member": "hierarchy",
    // AD-10: add unassigned recruiters to teams led within their hierarchy
    "team:add_member": "hierarchy",
    "designation:change": "hierarchy",
    // performance: recruiter targets for the hierarchy
    "performance.target:manage": "hierarchy",
    // market-reports
    "report.market:read": "hierarchy",
    // datahub
    "datahub:read": "own",
    // training
    "training:read": "hierarchy",
    // chat
    "chat:use": "own",
    // jobs-portal
    "job:read": "hierarchy",
    "job:manage": "hierarchy",
    // payments (gap L1, migration 0100): invoices of their placements; amounts still need rate:read
    "invoice:read": "hierarchy",
  },
  ceo: {
    // reference data: add technologies (docs/lookups-api.md)
    "technology:create": "org",
    "candidate:read": "org",
    // CA-6: adds candidates to any team (picked in the New candidate dialog)
    "candidate:create": "org",
    "assignment:read": "org",
    "hotlist:read": "org",
    "submission:read": "org",
    // Anyone above lead logs submissions; the CEO for any candidate
    "submission:create": "org",
    "client:create": "org",
    "vendor:create": "org",
    "interview:read": "org",
    // Schedules interviews for any submission: creation is checked against submission:update (design B4.8)
    "submission:update": "org",
    "interview:create": "org",
    "interview:update": "org",
    "placement:read": "org",
    "rate:read": "org",
    "employee:read": "org",
    "invoice:read": "org",
    "performance:read": "org",
    "report:read": "org",
    "report:export": "org",
    "vendor.preferred:read": "org",
    // market-reports
    "report.market:read": "org",
    // datahub
    "datahub:read": "own",
    "datahub:create": "own",
    // training
    "training:read": "org",
    "training.batch:create": "org",
    // chat
    "chat:use": "own",
    // jobs-portal
    "job:read": "org",
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
    // market-reports
    "report.market:read": "location",
    // datahub
    "datahub:read": "own",
    // training
    "training:read": "location",
    "training:manage": "location",
    "training.progress:update": "location",
    // chat
    "chat:use": "own",
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
    // market-reports
    "report.market:read": "location",
    // datahub
    "datahub:read": "own",
    "datahub:manage": "location",
    // training
    "training:read": "location",
    "training:manage": "location",
    "training.progress:update": "location",
    "training.batch:create": "org",
    // chat
    "chat:use": "own",
  },
  hr: {
    "assignment:read": "org",
    "candidate:read": "org",
    "candidate.compliance:update": "org",
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
    // interview-alerts: staff birthdays for the CEO's morning digest
    "staff.birthday:manage": "org",
    // training
    "training:read": "org",
    "training.batch:create": "org",
    // chat
    "chat:use": "own",
    // jobs-portal
    "job:read": "org",
    "job:manage": "org",
    "applicant:read": "org",
    "applicant.phone:read": "org",
    "application:read": "org",
    "application:manage": "org",
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
    // training
    "training:read": "org",
    "training.batch:create": "org",
    // chat
    "chat:use": "own",
  },
  accounts: {
    "assignment:read": "org",
    "candidate:read": "org",
    "candidate.compliance:update": "org",
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
    // training
    "training:read": "org",
    "training.batch:create": "org",
    // chat
    "chat:use": "own",
  },
  immigration: {
    "assignment:read": "org",
    "candidate:read": "org",
    "candidate.compliance:update": "org",
    "candidate.phone:read": "org",
    "candidate.dob:read": "org",
    "employee:read": "org",
    "document:read": "org",
    "document:upload": "org",
    "document:verify": "org",
    "document.restricted:read": "org",
    "visa:read": "org",
    "visa:update": "org",
    // employees gaps (0150): joinings/exits and active-employee counts (no placement scope: client columns stay empty).
    "report:read": "org",
    // datahub
    "datahub:read": "own",
    // training
    "training:read": "org",
    "training.batch:create": "org",
    // chat
    "chat:use": "own",
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
    // chat
    "chat:use": "own",
  },
  // Interview Prep sub-department head: reports to the Associate Director; the
  // Interview Coaches report to them. Sees what their coaches see (teams coached
  // by anyone in their reporting subtree, or by themself) and assigns their
  // coaches to sales teams (AD-11).
  interview_lead: {
    "candidate:read": "coached_hierarchy",
    "hotlist:read": "coached_hierarchy",
    "interview:read": "coached_hierarchy",
    "interview.feedback:create": "coached_hierarchy",
    "coach:assign": "hierarchy",
    // datahub
    "datahub:read": "own",
    // training: batches trained by them or their coaches (and progress of coached teams' candidates)
    "training:read": "coached_hierarchy",
    "training.progress:update": "coached_hierarchy",
    // chat
    "chat:use": "own",
  },
  // interview-alerts: the support team that coordinates interviews. Reads every
  // interview to coordinate, blocks the support calendar; no Sales writes, no
  // documents, no rates. No candidate:read (gap/candidates, team-scoped Hot List):
  // the candidate's name on each interview comes from
  // authz.interview_candidate_name (0141), not from the Candidates list.
  interview_coordinator: {
    "interview:read": "org",
    "calendar:block": "org",
    // datahub
    "datahub:read": "own",
    // chat
    "chat:use": "own",
  },
  documents_team: {
    "candidate:read": "org",
    "candidate.compliance:update": "org",
    "document:read": "org",
    "document:upload": "org",
    "document:verify": "org",
    // datahub
    "datahub:read": "own",
    // training
    "training:read": "org",
    "training.batch:create": "org",
    // chat
    "chat:use": "own",
  },
  bu_head: {
    "assignment:read": "org",
    "employee:read": "org",
    "placement:read": "org",
    "report:read": "org",
    // datahub
    "datahub:read": "own",
    // training
    "training:read": "org",
    "training.batch:create": "org",
    // chat
    "chat:use": "own",
  },
  org_admin: {
    "access:manage": "org",
    "audit:read": "org",
    // interviews-settings: staff directory data (work phone), not business data.
    "staff.contact:read": "org",
    // reference data: add technologies (docs/lookups-api.md)
    "technology:create": "org",
    // chat
    "chat:use": "own",
  },
};

/**
 * Notification audiences (docs/roles-api.md): authz.notification_recipients sends
 * an event to the holders of its permission; these are the system roles that hold
 * each one, merged into GRANTS at "org" scope.
 */
export const NOTIFY_RECIPIENTS: Record<Extract<Permission, `notify.${string}`>, readonly Role[]> = {
  "notify.placement_hr:receive": ["hr"],
  "notify.placement_accounts:receive": ["accounts"],
  "notify.placement_immigration:receive": ["immigration"],
  "notify.work_authorization:receive": ["hr", "immigration"],
  "notify.employee_exit:receive": ["hr", "accounts", "immigration", "bu_head", "ceo"],
  "notify.assignment_ending:receive": ["hr", "accounts"],
  "notify.bench_time:receive": ["ceo"],
  "notify.application:receive": ["hr"],
  "notify.interview_request:receive": ["interview_coordinator"],
  "notify.contract:receive": ["hr", "associate_hr", "accounts"],
  "notify.birthdays:receive": ["ceo"],
};
for (const [permission, roles] of Object.entries(NOTIFY_RECIPIENTS) as [Permission, readonly Role[]][]) {
  for (const role of roles) GRANTS[role][permission] = "org";
}

/** A role assignment as the engine sees it, built from the catalog (tests, seeds). */
export function assignmentFor(role: Role, locationId?: string): {
  role: Role; locationId?: string; grants: Grants; traits: RoleTraits;
} {
  return { role, ...(locationId === undefined ? {} : { locationId }), grants: GRANTS[role], traits: ROLE_TRAITS[role] };
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
  // jobs-portal
  "applicant.phone:read",
];

export function isRestrictedRole(role: Role): boolean {
  return (
    role === "org_admin" ||
    RESTRICTED_PERMISSIONS.some((p) => GRANTS[role][p] !== undefined) ||
    ORG_SENSITIVE_PERMISSIONS.some((p) => GRANTS[role][p] === "org")
  );
}
