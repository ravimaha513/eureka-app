/**
 * Candidate rows, scope predicates, presentation and the read-before-write
 * helpers shared by the candidate services (list, profile, create, batches,
 * timeline). Other modules import these through candidates.service.ts.
 */
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import {
  HOTLIST_STATUSES,
  MARKETABLE_STATUSES,
  applyCandidateFieldPolicy,
  marketingStatusLabel,
  ownsCandidate,
  resolveScope,
  type CandidateRef,
  type CandidateVisibility,
  type EffectiveScope,
  type Permission,
  type UserAccess,
} from "@eureka/shared";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { dbErrorMapper } from "../../platform/errors.js";
import type { ProfileUpdate } from "./candidates.schemas.js";

export interface CandidateRow {
  id: string;
  first_name: string;
  last_name: string;
  phone_e164: string | null;
  dob_year: number | null;
  technology: string;
  team_id: string | null;
  team_name: string | null;
  recruiter_id: string | null;
  recruiter_name: string | null;
  location_id: string;
  location_name: string;
  visibility: CandidateVisibility;
  marketing_status: string;
  priority: string;
  marketing_start_date: string | null;
  technical_rating: number | null;
  row_version: number;
  batch_id: string | null;
  batch_name: string | null;
  batch_month: string | null;
  batch_technology: string | null;
  batch_location: string | null;
  visa_category: string | null;
  documents_status: string | null;
  gh_remote: boolean;
  gh_location_id: string | null;
  gh_location_name: string | null;
  team_assigned_at: Date;
  lead_name: string | null;
  in_person_ok: boolean | null;
  /** A resume link is recorded (the link itself is owner-only, profileExtras). */
  resume_link: boolean;
}

/** Guest house or remote (Hot List "stay"), from the two columns behind it. */
export const stayOf = (r: { gh_remote: boolean; gh_location_name: string | null }) =>
  r.gh_remote ? "remote" : r.gh_location_name !== null ? "guest_house" : null;

/**
 * "Java · Dallas · Nov 2026" from a batch's technology, location and start month (YYYY-MM-DD),
 * or "Fall cohort · Dallas" when the batch has a custom name (Training).
 */
export function batchLabel(technology: string, location: string, startMonth: string, name?: string | null): string {
  if (name?.trim()) return `${name.trim()} · ${location}`;
  const month = new Date(`${startMonth.slice(0, 7)}-01T00:00:00Z`)
    .toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  return `${technology} · ${location} · ${month}`;
}

export const BATCH_ERRORS: Record<string, () => HttpException> = {
  invalid_batch: () => new UnprocessableEntityException("invalid_batch"),
  batch_exists: () => new ConflictException("batch_exists"),
  batch_not_allowed: () => new UnprocessableEntityException("batch_not_allowed"),
  location_not_in_scope: () => new ForbiddenException("location_not_in_scope"),
  batch_not_found: () => new NotFoundException(),
  invalid_transition: () => new UnprocessableEntityException("invalid_transition"),
};

/** Profile write errors: batch codes (0026), an unknown guest house location (FK). */
export function mapProfileError(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === "23503" && e.constraint === "candidate_gh_location_id_fkey") throw new UnprocessableEntityException("invalid_location");
  return mapBatchError(err);
}

/**
 * Audit summary of a profile update (rule 5): links and marketing locations
 * are free text, recorded as "changed" flags only; the rest are keys and ids.
 */
export function auditSafeProfile(body: ProfileUpdate): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const k of ["linkedinUrl", "resumeUrl", "marketingLocations", "marketingEmail", "vitelNumber"] as const) {
    if (k in out) out[k] = true;
  }
  return out;
}

/** Maps the batch functions' and trigger's coded errors (migration 0026) to problem details. */
export const mapBatchError: (err: unknown) => never = dbErrorMapper(BATCH_ERRORS);

/** Create errors: batch codes, and a contact another candidate took meanwhile (0260). */
export const mapCreateError: (err: unknown) => never = dbErrorMapper({
  ...BATCH_ERRORS,
  duplicate_email: () => new ConflictException("duplicate_contact"),
  duplicate_phone: () => new ConflictException("duplicate_contact"),
});

/** If-Match named a version the candidate no longer has (docs/candidates-api.md "Optimistic concurrency"). */
export const stale = () => new HttpException("stale", HttpStatus.PRECONDITION_FAILED);


/**
 * Application-layer scope predicate (design B4.4). Parameterized; RLS applies
 * the same rule independently in the database.
 */
export function scopePredicate(scope: EffectiveScope, params: unknown[], alias = "c"): string {
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (scope.all || scope.hotlistOpen) {
    // hotlistOpen: every Hot List candidate (the caller filters by HOTLIST_STATUSES).
    return scope.all ? "true" : `${alias}.marketing_status = ANY(${p([...HOTLIST_STATUSES])}::text[])`;
  }
  const parts = [
    `${alias}.recruiter_id = ANY(${p([...scope.recruiterIds])}::uuid[])`,
    `${alias}.team_id = ANY(${p([...scope.teamIds])}::uuid[])`,
    `${alias}.location_id = ANY(${p([...scope.locationIds])}::uuid[])`,
  ];
  if (scope.allTeams) {
    parts.push(`(${alias}.visibility = 'all_teams' AND ${alias}.marketing_status = ANY(${p([...MARKETABLE_STATUSES])}::text[]))`);
    // "Selected teams" (0240): the set is already limited to marketable, selected_teams candidates.
    if (scope.sharedCandidateIds.size > 0) parts.push(`${alias}.id = ANY(${p([...scope.sharedCandidateIds])}::uuid[])`);
  }
  return `(${parts.join(" OR ")})`;
}

/** Part of the DOB (the birth year) is shown only to holders of candidate.dob:read who own the candidate (A-10). */
export function dobReadable(access: UserAccess, ref: CandidateRef): boolean {
  const scope = resolveScope(access, "candidate.dob:read");
  return scope !== null && ownsCandidate(scope, ref);
}

export const toRef = (r: Pick<CandidateRow, "id" | "recruiter_id" | "team_id" | "location_id" | "visibility" | "marketing_status">): CandidateRef => ({
  id: r.id,
  recruiterId: r.recruiter_id,
  teamId: r.team_id,
  locationId: r.location_id,
  visibility: r.visibility,
  marketingStatus: r.marketing_status,
});

export interface ProfileExtraRow {
  in_person_ok: boolean | null;
  marketing_email: string | null;
  vitel_number: string | null;
  linkedin_url: string | null;
  resume_url: string | null;
  marketing_locations: string[] | null;
  eligibility: string[] | null;
}

/**
 * Profile-only fields of GET /candidates/:id (FR-CAN-04..06), so what Edit
 * profile saves can be read back. `inPersonOk` goes to every profile reader.
 * The marketing contact details (business identities, not the candidate's
 * personal phone/email) go to callers who own the candidate through
 * `candidate.phone:read` or `candidate:update` (the people who edit them in
 * Edit profile), never through the Open-to-all-teams rule; otherwise both keys
 * are omitted.
 */
export function profileExtras(access: UserAccess, ref: CandidateRef, r: ProfileExtraRow) {
  const ownsThrough = (p: "candidate.phone:read" | "candidate:update") => {
    const scope = resolveScope(access, p);
    return scope !== null && ownsCandidate(scope, ref);
  };
  const contact = ownsThrough("candidate.phone:read") || ownsThrough("candidate:update");
  // LinkedIn and the resume link follow the uploaded-resume rule: owners of
  // the candidate (candidate:read through ownership, team, hierarchy, location
  // or org), never through Open to all teams.
  const readScope = resolveScope(access, "candidate:read");
  const owner = readScope !== null && ownsCandidate(readScope, ref);
  return {
    inPersonOk: r.in_person_ok,
    eligibility: r.eligibility ?? [],
    marketingLocations: r.marketing_locations ?? [],
    ...(contact ? { marketingEmail: r.marketing_email, vitelNumber: r.vitel_number } : {}),
    ...(owner ? { linkedinUrl: r.linkedin_url, resumeUrl: r.resume_url } : {}),
  };
}

/** List and profile columns of a candidate (CandidateRow); callers append WHERE / ORDER BY. */
export const CANDIDATE_SELECT = `
    SELECT c.id, p.first_name, p.last_name, p.phone_e164, p.dob_year, t.name AS technology,
           c.team_id, tm.name AS team_name, c.recruiter_id, u.display_name AS recruiter_name,
           c.location_id, l.name AS location_name, c.visibility, c.marketing_status, c.priority,
           c.marketing_start_date::text, c.technical_rating, c.row_version,
           c.batch_id, b.name AS batch_name, b.start_month::text AS batch_month, bt.name AS batch_technology, bl.name AS batch_location,
           c.visa_category, c.documents_status, c.gh_remote, c.gh_location_id, gl.name AS gh_location_name,
           c.team_assigned_at, (c.resume_url IS NOT NULL) AS resume_link,
           lu.display_name AS lead_name, c.in_person_ok
    FROM eureka.candidate c
    JOIN eureka.person p ON p.id = c.person_id
    JOIN eureka.technology t ON t.id = c.technology_id
    LEFT JOIN eureka.team tm ON tm.id = c.team_id
    JOIN eureka.location l ON l.id = c.location_id
    LEFT JOIN eureka.app_user u ON u.id = c.recruiter_id
    LEFT JOIN eureka.app_user lu ON lu.id = tm.lead_id
    LEFT JOIN eureka.batch b ON b.id = c.batch_id
    LEFT JOIN eureka.technology bt ON bt.id = b.technology_id
    LEFT JOIN eureka.location bl ON bl.id = b.location_id
    LEFT JOIN eureka.location gl ON gl.id = c.gh_location_id`;

/** A candidate row as the list and profile return it, with the phone and DOB field policy applied. */
export function presentCandidate(access: UserAccess, r: CandidateRow, hasResume?: boolean) {
  const ref = toRef(r);
  const fields = applyCandidateFieldPolicy(access, ref, {
    phone: r.phone_e164,
    dob: null, // DOB is encrypted; decrypted only for candidate.dob:read (Phase 3)
  });
  const days = r.marketing_start_date
    ? Math.floor((Date.now() - Date.parse(r.marketing_start_date)) / 86_400_000)
    : null;
  return {
    id: r.id,
    name: `${r.first_name} ${r.last_name}`,
    technology: r.technology,
    status: r.marketing_status,
    statusLabel: marketingStatusLabel(r.marketing_status, r.visibility, r.gh_remote),
    visibility: r.visibility,
    priority: r.priority,
    team: { id: r.team_id, name: r.team_name ?? "No team yet", lead: r.lead_name },
    teamAssignedAt: r.team_assigned_at.toISOString(),
    inPersonOk: r.in_person_ok,
    recruiter: r.recruiter_id ? { id: r.recruiter_id, name: r.recruiter_name } : null,
    location: { id: r.location_id, name: r.location_name },
    ghLocation: r.gh_location_id && r.gh_location_name ? { id: r.gh_location_id, name: r.gh_location_name } : null,
    stay: stayOf(r),
    visaCategory: r.visa_category,
    documentsStatus: r.documents_status,
    ...(hasResume === undefined ? {} : { hasResume }),
    marketingStartDate: r.marketing_start_date,
    daysInMarket: days,
    technicalRating: r.technical_rating,
    phone: fields.phone,
    phoneMasked: fields.phoneMasked,
    // The birth year follows the DOB policy (candidate.dob:read over the candidate), as the phone follows its own.
    dobMasked: r.dob_year && dobReadable(access, ref) ? `•• / •• / ${r.dob_year}` : null,
    rowVersion: r.row_version,
    batch: r.batch_id && r.batch_month
      ? { id: r.batch_id, label: batchLabel(r.batch_technology ?? "", r.batch_location ?? "", r.batch_month, r.batch_name) }
      : null,
  };
}

/** Read-before-write rule (design B3): 404 if not visible, 403 if visible but not permitted. */
export async function loadForWrite(c: pg.PoolClient, user: AuthedUser, id: string, perm: Permission): Promise<CandidateRow> {
  const readScope = resolveScope(user.access, "candidate:read");
  if (!readScope) throw new NotFoundException();
  const params: unknown[] = [id];
  const { rows } = await c.query<CandidateRow>(
    `${CANDIDATE_SELECT} WHERE c.id = $1 AND ${scopePredicate(readScope, params)}`, params);
  const row = rows[0];
  if (!row) throw new NotFoundException();
  const scope = resolveScope(user.access, perm);
  if (!scope || !ownsCandidate(scope, toRef(row))) throw new ForbiddenException("Not permitted");
  return row;
}

/**
 * Optional If-Match for writes through definer functions: locks the candidate
 * (authz.candidate_version_lock, 0475) and compares its row_version, so no other
 * write lands between the check and this transaction's own. `null`: no check.
 */
export async function checkVersion(c: pg.PoolClient, id: string, expected: number | null) {
  if (expected === null) return;
  const { rows } = await c.query<{ v: number }>(`SELECT authz.candidate_version_lock($1) AS v`, [id]);
  if (rows[0]!.v !== expected) throw stale();
}

/** row_version after a write the caller made (the caller still owns the candidate, so RLS shows it). */
export async function currentVersion(c: pg.PoolClient, id: string): Promise<number | null> {
  return (await c.query<{ v: number }>(`SELECT row_version AS v FROM eureka.candidate WHERE id = $1`, [id])).rows[0]?.v ?? null;
}

/**
 * The team a new candidate goes to: the one asked for, else the caller's own;
 * `null` asks for no team yet (0410). 403 outside candidate:create.
 */
export function creatableTeam(user: AuthedUser, teamId?: string | null): string | null {
  const team = teamId === null ? null : teamId ?? user.access.teamIds[0];
  if (team === undefined) throw new ForbiddenException("No team to assign");
  const scope = resolveScope(user.access, "candidate:create");
  const teamAllowed = scope && (team === null || scope.all || scope.teamIds.has(team)
    || (scope.recruiterIds.has(user.id) && user.access.teamIds[0] === team));
  if (!teamAllowed) throw new ForbiddenException("Not permitted to create candidates in this team");
  return team;
}
