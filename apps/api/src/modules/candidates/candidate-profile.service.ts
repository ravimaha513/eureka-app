/** One candidate: profile read and edits, compliance, team, visibility, recruiter, rating, transitions, delete. */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import {
  candidateActions,
  candidateTransitionAllowed,
  ownsCandidate,
  resolveScope,
  type CandidateCompanyLink,
  type CandidateVisibility,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import type { ComplianceUpdate, ProfileUpdate } from "./candidates.schemas.js";
import {
  CANDIDATE_SELECT,
  auditSafeProfile,
  checkVersion,
  currentVersion,
  loadForWrite,
  mapProfileError,
  presentCandidate,
  profileExtras,
  scopePredicate,
  stale,
  toRef,
  type CandidateRow,
  type ProfileExtraRow,
} from "./candidate-common.js";

@Injectable()
export class CandidateProfileService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async get(user: AuthedUser, id: string) {
    const scope = resolveScope(user.access, "candidate:read");
    if (!scope) throw new NotFoundException();
    const params: unknown[] = [id];
    const found = await this.db.withUser(user.id, async (c) => {
      const r = (await c.query<CandidateRow>(`${CANDIDATE_SELECT} WHERE c.id = $1 AND ${scopePredicate(scope, params)}`, params)).rows[0];
      // Only a candidate in confirmation can have an open placement (PL-5).
      const open = r?.marketing_status === "confirmation"
        ? (await c.query<{ o: boolean }>(`SELECT authz.candidate_has_open_placement($1) AS o`, [id])).rows[0]!.o
        : false;
      // Profile-only fields (not on list rows), read under the same RLS.
      const extra = r ? (await c.query<ProfileExtraRow & { confirmations: number }>(
        `SELECT in_person_ok, marketing_email::text, vitel_number, linkedin_url, resume_url, marketing_locations, eligibility,
                -- Times the candidate reached confirmation (candidate_event, readable with the candidate).
                (SELECT count(*)::int FROM eureka.candidate_event e
                  WHERE e.candidate_id = candidate.id AND e.type = 'candidate.status_changed' AND e.to_value = 'confirmation') AS confirmations
         FROM eureka.candidate WHERE id = $1`, [id])).rows[0] : undefined;
      // Linked company names (authz.candidate_companies re-checks ownership or candidate.compliance:update).
      const companies = r ? (await c.query<{ link: CandidateCompanyLink; company_id: string; company_name: string }>(
        `SELECT * FROM authz.candidate_companies($1)`, [id])).rows : [];
      const uploaded = r ? (await c.query<{ ids: string[] }>(`SELECT authz.resume_flags(ARRAY[$1]::uuid[]) AS ids`, [id])).rows[0]!.ids : [];
      // "Selected teams" picks (0240), readable with the candidate.
      const sharedTeams = r?.visibility === "selected_teams" ? (await c.query<{ id: string; name: string }>(
        `SELECT t.id, t.name FROM eureka.candidate_team_share s JOIN eureka.team t ON t.id = s.team_id
          WHERE s.candidate_id = $1 ORDER BY t.name, t.id`, [id])).rows : [];
      return r && extra ? { row: r, open, extra, companies, sharedTeams, hasResume: r.resume_link || uploaded.length > 0 } : undefined;
    });
    if (!found) throw new NotFoundException();
    const ref = toRef(found.row);
    const readScope = resolveScope(user.access, "candidate:read");
    const createScope = resolveScope(user.access, "candidate:create");
    const complianceScope = resolveScope(user.access, "candidate.compliance:update");
    const canCompliance = complianceScope !== null && ownsCandidate(complianceScope, ref);
    const showCompanies = canCompliance || (readScope !== null && ownsCandidate(readScope, ref));
    const link = (k: CandidateCompanyLink) => {
      const x = found.companies.find((cmp) => cmp.link === k);
      return x ? { id: x.company_id, name: x.company_name } : null;
    };
    return {
      ...presentCandidate(user.access, found.row, found.hasResume),
      ...profileExtras(user.access, ref, found.extra),
      confirmations: found.extra.confirmations,
      /** Owners and compliance editors only (E-Verify, offer letter and 1099 companies). */
      ...(showCompanies ? { companies: { everify: link("everify"), offerLetter: link("offerLetter"), form1099: link("form1099") } } : {}),
      canEditCompliance: canCompliance,
      /** No team yet (0410) and the caller may give it one: PUT /candidates/:id/team. */
      canAssignTeam: found.row.team_id === null && createScope !== null && ownsCandidate(createScope, ref),
      /** Owners only: the teams a "Selected teams" candidate is shared with. */
      ...(readScope !== null && ownsCandidate(readScope, ref) ? { sharedTeams: found.sharedTeams } : {}),
      /** Hints for the UI (docs/placements-api.md); every write is checked again. */
      actions: candidateActions(user.access, toRef(found.row), found.open),
    };
  }

  /** `expected`: the If-Match row version (412 when stale); null keeps the unchecked write (Hot List bulk, older clients). */
  async updateProfile(user: AuthedUser, id: string, body: ProfileUpdate, expected: number | null = null) {
    return this.db.withUser(user.id, async (c) => {
      const row = await loadForWrite(c, user, id, "candidate:update");
      if (expected !== null && expected !== row.row_version) throw stale();
      let rowVersion = row.row_version;
      const map: Record<string, string> = {
        priority: "priority", marketingEmail: "marketing_email", vitelNumber: "vitel_number",
        marketingStartDate: "marketing_start_date", inPersonOk: "in_person_ok", technologyId: "technology_id",
        batchId: "batch_id", marketingLocations: "marketing_locations", linkedinUrl: "linkedin_url",
        resumeUrl: "resume_url", eligibility: "eligibility", visaCategory: "visa_category",
      };
      const empty = (v: unknown) => (Array.isArray(v) && v.length === 0 ? null : v); // one spelling of "none"
      const entries: [string, unknown][] = Object.entries(body).filter(([k]) => k in map).map(([k, v]) => [map[k]!, empty(v)]);
      if (body.ghLocation !== undefined) {
        entries.push(["gh_location_id", body.ghLocation === "remote" ? null : body.ghLocation]);
        entries.push(["gh_remote", body.ghLocation === "remote"]);
      }
      if (entries.length) {
        const params: unknown[] = [id];
        const sets = entries.map(([col, v]) => { params.push(v); return `${col} = $${params.length}`; });
        const version = expected === null ? "" : ` AND row_version = $${params.push(expected)}`;
        const r = await c.query<{ row_version: number }>(
          `UPDATE eureka.candidate SET ${sets.join(", ")} WHERE id = $1${version} RETURNING row_version`, params).catch(mapProfileError);
        if (expected !== null && r.rowCount === 0) throw stale();
        rowVersion = r.rows[0]?.row_version ?? rowVersion;
        await this.audit.record(c, {
          actorId: user.id, action: "candidate.updated", entityType: "candidate", entityId: id, changes: auditSafeProfile(body),
        });
      }
      return { id, rowVersion };
    });
  }

  /**
   * Company links and documents status (candidate.compliance:update) through
   * authz.set_candidate_compliance, which re-checks scope and that a changed
   * link names an active company. Read-before-write: 404 if the candidate is
   * not readable, 403 if readable but not covered.
   */
  async setCompliance(user: AuthedUser, id: string, body: ComplianceUpdate, expected: number | null = null) {
    return this.db.withUser(user.id, async (c) => {
      await loadForWrite(c, user, id, "candidate.compliance:update");
      // With If-Match the row stays locked from here, so the merge below reads what it overwrites.
      await checkVersion(c, id, expected);
      const cur = (await c.query<{ e: string | null; o: string | null; f: string | null; d: string | null }>(
        `SELECT everify_company_id AS e, offer_letter_company_id AS o, form1099_company_id AS f, documents_status AS d
         FROM eureka.candidate WHERE id = $1`, [id])).rows[0]!;
      const next = {
        e: body.everifyCompanyId === undefined ? cur.e : body.everifyCompanyId,
        o: body.offerLetterCompanyId === undefined ? cur.o : body.offerLetterCompanyId,
        f: body.form1099CompanyId === undefined ? cur.f : body.form1099CompanyId,
        d: body.documentsStatus === undefined ? cur.d : body.documentsStatus,
      };
      let rowVersion: number;
      try {
        rowVersion = (await c.query<{ v: number }>(`SELECT authz.set_candidate_compliance($1, $2, $3, $4, $5) AS v`,
          [id, next.e, next.o, next.f, next.d])).rows[0]!.v;
      } catch (err) {
        if ((err as { message?: string }).message === "invalid_company") throw new UnprocessableEntityException("invalid_company");
        throw err;
      }
      // Ids and the status key only: no names or free text (rule 5).
      await this.audit.record(c, { actorId: user.id, action: "candidate.compliance", entityType: "candidate", entityId: id, changes: body });
      return {
        id, rowVersion,
        everifyCompanyId: next.e, offerLetterCompanyId: next.o, form1099CompanyId: next.f, documentsStatus: next.d,
      };
    });
  }

  /** Active companies for the compliance picker; empty for callers without candidate.compliance:update. */
  async complianceCompanies(user: AuthedUser) {
    if (!resolveScope(user.access, "candidate.compliance:update")) throw new ForbiddenException();
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<{ id: string; name: string; location_name: string }>(
      `SELECT * FROM authz.compliance_company_options()`)).rows);
    return { items: rows.map((r) => ({ id: r.id, name: r.name, location: r.location_name })) };
  }

  /** Every team, with its lead, for the "Selected teams" picker; callers without candidate.visibility:update get 403. */
  async shareTeams(user: AuthedUser) {
    if (!resolveScope(user.access, "candidate.visibility:update")) throw new ForbiddenException();
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<{ id: string; name: string; lead_name: string | null }>(
      `SELECT t.id, t.name, u.display_name AS lead_name
         FROM eureka.team t LEFT JOIN eureka.app_user u ON u.id = t.lead_id
        WHERE t.deleted_at IS NULL ORDER BY lower(t.name), t.id`)).rows);
    return { items: rows.map((r) => ({ id: r.id, name: r.name, lead: r.lead_name })) };
  }

  /** Teams the New candidate dialog offers: the caller's candidate:create scope, their own team first. */
  async createTeams(user: AuthedUser) {
    const scope = resolveScope(user.access, "candidate:create");
    if (!scope) throw new ForbiddenException();
    const own = user.access.teamIds[0] ?? null;
    const ids = scope.all ? null : [...scope.teamIds];
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<{ id: string; name: string; lead_name: string | null }>(
      `SELECT t.id, t.name, u.display_name AS lead_name
         FROM eureka.team t LEFT JOIN eureka.app_user u ON u.id = t.lead_id
        WHERE t.deleted_at IS NULL AND ($1::uuid[] IS NULL OR t.id = ANY ($1::uuid[]))
        ORDER BY t.id IS DISTINCT FROM $2::uuid, lower(t.name), t.id`, [ids, own])).rows);
    return { items: rows.map((r) => ({ id: r.id, name: r.name, lead: r.lead_name })), defaultTeamId: rows.some((r) => r.id === own) ? own : null };
  }

  /** Gives a candidate with no team (0410) their team, from the same teams the New candidate dialog offers. */
  async assignTeam(user: AuthedUser, id: string, teamId: string) {
    const scope = resolveScope(user.access, "candidate:create");
    if (!scope || !(scope.all || scope.teamIds.has(teamId))) throw new ForbiddenException("Not permitted to assign candidates to this team");
    return this.db.withUser(user.id, async (c) => {
      const row = await loadForWrite(c, user, id, "candidate:create");
      if (row.team_id !== null) throw new ConflictException("team_already_assigned");
      try {
        await c.query(`SELECT authz.assign_candidate_team($1, $2)`, [id, teamId]);
      } catch (err) {
        if ((err as { message?: string }).message === "invalid_team") throw new UnprocessableEntityException("invalid_team");
        throw err;
      }
      await this.audit.record(c, { actorId: user.id, action: "candidate.team_assigned", entityType: "candidate", entityId: id, changes: { teamId } });
      return { id, teamId };
    });
  }

  async setVisibility(user: AuthedUser, id: string, visibility: CandidateVisibility, teamIds: string[] = [], expected: number | null = null) {
    return this.db.withUser(user.id, async (c) => {
      await loadForWrite(c, user, id, "candidate.visibility:update");
      await checkVersion(c, id, expected);
      try {
        // authz.set_candidate_visibility (0240) re-checks and replaces the "Selected teams" picks.
        await c.query(`SELECT authz.set_candidate_visibility($1, $2, $3::uuid[])`, [id, visibility, visibility === "selected_teams" ? teamIds : []]);
      } catch (err) {
        const m = (err as { message?: string }).message;
        if (m === "teams_required" || m === "invalid_team" || m === "too_many_teams") throw new UnprocessableEntityException(m);
        throw err;
      }
      // Ids only (rule 5).
      await this.audit.record(c, { actorId: user.id, action: "candidate.visibility", entityType: "candidate", entityId: id,
        changes: visibility === "selected_teams" ? { visibility, teamIds } : { visibility } });
      return { id, visibility, ...(visibility === "selected_teams" ? { teamIds } : {}), rowVersion: await currentVersion(c, id) };
    });
  }

  /**
   * The team's active members and its lead: the same people a removed member's candidates can go to.
   * None for a candidate with no team yet (0410): the team is assigned first.
   */
  private async teamRecruiters(c: pg.PoolClient, teamId: string | null) {
    if (teamId === null) return [];
    return (await c.query<{ id: string; name: string }>(
      `SELECT u.id, u.display_name AS name FROM eureka.app_user u
        WHERE u.status = 'active'
          AND (u.id = (SELECT t.lead_id FROM eureka.team t WHERE t.id = $1)
               OR EXISTS (SELECT 1 FROM eureka.team_member tm
                           WHERE tm.team_id = $1 AND tm.user_id = u.id AND tm.valid @> now()))
        ORDER BY lower(u.display_name), u.id`, [teamId])).rows;
  }

  async recruiterOptions(user: AuthedUser, id: string) {
    return this.db.withUser(user.id, async (c) => {
      const row = await loadForWrite(c, user, id, "candidate:assign");
      return { items: await this.teamRecruiters(c, row.team_id) };
    });
  }

  async setRecruiter(user: AuthedUser, id: string, recruiterId: string | null, expected: number | null = null) {
    return this.db.withUser(user.id, async (c) => {
      const row = await loadForWrite(c, user, id, "candidate:assign");
      if (expected !== null && expected !== row.row_version) throw stale();
      if (recruiterId === row.recruiter_id) return { id, recruiterId, rowVersion: row.row_version };
      // With no team the recruiter is what keeps the candidate in scope (0410); assign the team first.
      if (row.team_id === null) throw new UnprocessableEntityException("team_required");
      if (recruiterId && !(await this.teamRecruiters(c, row.team_id)).some((u) => u.id === recruiterId)) {
        throw new UnprocessableEntityException("invalid_recruiter");
      }
      const r = await c.query<{ row_version: number }>(
        `UPDATE eureka.candidate SET recruiter_id = $2 WHERE id = $1 AND ($3::int IS NULL OR row_version = $3) RETURNING row_version`,
        [id, recruiterId, expected]);
      if (expected !== null && r.rowCount === 0) throw stale();
      await this.audit.record(c, { actorId: user.id, action: "candidate.recruiter", entityType: "candidate", entityId: id,
        changes: { fromRecruiterId: row.recruiter_id, toRecruiterId: recruiterId } });
      return { id, recruiterId, rowVersion: r.rows[0]?.row_version ?? row.row_version };
    });
  }

  async setRating(user: AuthedUser, id: string, rating: number, expected: number | null = null) {
    return this.db.withUser(user.id, async (c) => {
      const row = await loadForWrite(c, user, id, "candidate.rating:update");
      if (expected !== null && expected !== row.row_version) throw stale();
      const r = await c.query<{ row_version: number }>(
        `UPDATE eureka.candidate SET technical_rating = $2 WHERE id = $1 AND ($3::int IS NULL OR row_version = $3) RETURNING row_version`,
        [id, rating, expected]);
      if (expected !== null && r.rowCount === 0) throw stale();
      await this.audit.record(c, { actorId: user.id, action: "candidate.rating", entityType: "candidate", entityId: id, changes: { rating } });
      return { id, technicalRating: rating, rowVersion: r.rows[0]?.row_version ?? row.row_version };
    });
  }

  async transition(user: AuthedUser, id: string, to: string, expected: number | null = null) {
    return this.db.withUser(user.id, async (c) => {
      const row = await loadForWrite(c, user, id, "candidate:update");
      await checkVersion(c, id, expected);
      if (!candidateTransitionAllowed(row.marketing_status, to)) throw new UnprocessableEntityException("invalid_transition");
      let rows: { s: string }[];
      try {
        rows = (await c.query<{ s: string }>(`SELECT authz.transition_candidate($1, $2) AS s`, [id, to])).rows;
      } catch (err) {
        // The placement drives the candidate until it joins or backs out (migration 0022).
        if ((err as { message?: string }).message === "placement_open") throw new UnprocessableEntityException("placement_open");
        if ((err as { message?: string }).message === "team_required") throw new UnprocessableEntityException("team_required");
        throw err;
      }
      await this.audit.record(c, { actorId: user.id, action: "candidate.transition", entityType: "candidate", entityId: id, changes: { from: row.marketing_status, to } });
      return { id, status: rows[0]!.s, rowVersion: await currentVersion(c, id) };
    });
  }

  /** Cascade delete (authz.delete_candidate re-checks scope); placed candidates keep their records. */
  async remove(user: AuthedUser, id: string) {
    await this.db.withUser(user.id, async (c) => {
      const row = await loadForWrite(c, user, id, "candidate:delete");
      try {
        await c.query(`SELECT authz.delete_candidate($1)`, [id]);
      } catch (err) {
        if ((err as { message?: string }).message === "candidate_placed") throw new ConflictException("candidate_placed");
        throw err;
      }
      await this.audit.record(c, { actorId: user.id, action: "candidate.delete", entityType: "candidate", entityId: id, changes: { teamId: row.team_id } });
    });
  }
}
