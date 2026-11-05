/** New candidates and the duplicate check. */
import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import { hasTrait, resolveScope } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import type { CreateCandidate, DuplicateCheck } from "./candidates.schemas.js";
import { creatableTeam, mapCreateError } from "./candidate-common.js";

/**
 * Duplicate checks per user per minute (design N11). Counted per API task;
 * going over is logged as a warning (high-volume alert).
 */
export const DUPLICATE_CHECKS_PER_MINUTE = 20;

@Injectable()
export class CandidateCreateService {
  private readonly log = new Logger(CandidateCreateService.name);
  private readonly duplicateLimiter = new RateLimiter(DUPLICATE_CHECKS_PER_MINUTE, 60_000);

  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /**
   * `then` runs in the same transaction after the candidate row exists (jobs-portal:
   * linking the hired application), so both commit or neither does.
   */
  async create(user: AuthedUser, body: CreateCandidate, then?: (c: pg.PoolClient, candidateId: string) => Promise<void>) {
    const team = creatableTeam(user, body.teamId);

    // Email and phone are each unique across candidates (CA-6). The check runs
    // in its own transaction so its audit row stays when the create is refused;
    // the 409 carries no details, the caller asks POST /candidates/duplicate-check
    // for the minimal info. authz.candidate_contact_unique (0260) is the
    // race-safe backstop.
    if (!body.email) throw new UnprocessableEntityException("email_required");
    if (!body.phone) throw new UnprocessableEntityException("phone_required");
    if ((await this.duplicates(user, body)).length > 0) throw new ConflictException("duplicate_contact");

    return this.db.withUser(user.id, async (c) => {
      // With no team, only the recruiter link keeps the candidate in the creator's scope (org scope needs none).
      const recruiter = team === null && !resolveScope(user.access, "candidate:create")?.all ? user.id
        : body.recruiterId === undefined ? (hasTrait(user.access, "recruiter") ? user.id : null)
        : body.recruiterId;
      // The person row becomes visible only through its candidate, so its id is
      // generated here rather than read back with RETURNING (RLS would hide it).
      const personId = randomUUID();
      await c.query(`INSERT INTO eureka.person (id, first_name, last_name, phone_e164, personal_email) VALUES ($1,$2,$3,$4,$5)`,
        [personId, body.firstName, body.lastName, body.phone, body.email]);
      const cand = await c.query<{ id: string }>(
        `INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id, batch_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [personId, body.technologyId, team, recruiter, body.locationId, body.batchId ?? null]).catch(mapCreateError);
      await this.audit.record(c, { actorId: user.id, action: "candidate.created", entityType: "candidate", entityId: cand.rows[0]!.id });
      if (body.initialStatus === "active") {
        // authz.transition_candidate re-checks candidate:update scope; a refusal rolls the create back.
        await c.query(`SELECT authz.transition_candidate($1, 'active')`, [cand.rows[0]!.id]).catch((err: { code?: string }) => {
          if (err.code === "insufficient_privilege" || err.code === "P0002") throw new ForbiddenException("Not permitted to set this status");
          throw err;
        });
        await this.audit.record(c, { actorId: user.id, action: "candidate.transition", entityType: "candidate", entityId: cand.rows[0]!.id,
          changes: { from: "in_training", to: "active" } });
      }
      if (then) await then(c, cand.rows[0]!.id);
      return { id: cand.rows[0]!.id };
    });
  }

  /**
   * Duplicate check (design B3, N11) through authz.candidate_duplicates: only
   * that a likely duplicate exists, which supplied identifier matched, the
   * owning team and its lead as the contact, and the candidate id when the
   * caller can read it. Rate-limited per user; every call is audited without
   * the values checked.
   */
  async duplicates(user: AuthedUser, body: DuplicateCheck) {
    if (!this.duplicateLimiter.take(user.id)) {
      this.log.warn(`Duplicate check rate limit exceeded by user ${user.id}`);
      throw new HttpException("Too many duplicate checks; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
    }
    return this.db.withUser(user.id, async (c) => {
      const { rows } = await c.query<{ candidate_id: string | null; team_name: string; contact_name: string | null; matched_on: string[] }>(
        `SELECT * FROM authz.candidate_duplicates($1, $2, $3, $4)`,
        [body.firstName, body.lastName, body.email ?? null, body.phone ?? null]);
      await this.audit.record(c, {
        actorId: user.id, action: "candidate.duplicate_check", entityType: "candidate",
        changes: { checked: [body.email !== undefined && "email", body.phone !== undefined && "phone"].filter(Boolean), matches: rows.length },
      });
      return rows.map((r) => ({
        candidateId: r.candidate_id,
        team: r.team_name,
        contact: r.contact_name,
        matchedOn: r.matched_on,
      }));
    });
  }
}
