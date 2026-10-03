import { randomUUID } from "node:crypto";
import {
  ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import {
  WORK_AUTH_NUMBER_MASK, resolveScope, workAuthAccess, type CandidateRef, type WorkAuthStatus, type WorkAuthType,
} from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { FIELD_CRYPTO, type FieldCrypto } from "../../platform/crypto/config.js";
import { DbService } from "../../platform/db.service.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import { requireStepUp } from "../../platform/step-up.js";
import { scopePredicate } from "../candidates/candidates.service.js";
import type { WorkAuthCreate, WorkAuthUpdate } from "./work-authorization.schemas.js";

export const REVEALS_PER_MINUTE = 20;

interface Row {
  id: string;
  auth_type: WorkAuthType;
  has_number: boolean;
  valid_from: string | null;
  valid_to: string | null;
  status: WorkAuthStatus;
  row_version: number;
  created_at: Date;
  updated_at: Date;
  updated_by: string;
  updater_name: string | null;
  days_left: number | null;
}

const COLUMNS = `w.id, w.auth_type, (w.number_enc IS NOT NULL) AS has_number, w.valid_from::text AS valid_from,
  w.valid_to::text AS valid_to, w.status, w.row_version, w.created_at, w.updated_at, w.updated_by,
  u.display_name AS updater_name, (w.valid_to - (now() AT TIME ZONE 'America/New_York')::date) AS days_left`;

/** Never the number: a fixed mask when one is stored (B4.6; reveal is a separate, audited call). */
const present = (r: Row) => ({
  id: r.id,
  type: r.auth_type,
  numberMasked: r.has_number ? WORK_AUTH_NUMBER_MASK : null,
  hasNumber: r.has_number,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  status: r.status,
  /** valid_to has passed (New York calendar day); derived, never stored. */
  expired: r.days_left !== null && r.days_left < 0,
  daysToExpiry: r.days_left,
  rowVersion: r.row_version,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  updatedBy: { id: r.updated_by, name: r.updater_name },
});

const DB_ERRORS: Record<string, () => HttpException> = {
  not_found: () => new NotFoundException(),
  not_permitted: () => new ForbiddenException("Not permitted"),
  stale: () => new HttpException("stale", HttpStatus.PRECONDITION_FAILED),
  invalid_number: () => new UnprocessableEntityException("invalid_number"),
  invalid_record: () => new UnprocessableEntityException("invalid_record"),
};

function mapDbError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  const make = e.message !== undefined && e.code !== undefined ? DB_ERRORS[e.message] : undefined;
  if (make) throw make();
  throw err;
}

/**
 * Work authorization records (FR-VIS-01, 02; design B4.4, B4.6; migration
 * 0042). Read-before-write: 404 when the candidate is not readable or
 * visa:read does not cover it, 403 when visa:update does not. The database
 * re-checks everything (RLS work_authorization_read, authz.work_auth_create /
 * update). The number is encrypted here before it reaches the database and
 * decrypted only for an audited reveal; it never appears in logs, audit or
 * outbox rows.
 */
@Injectable()
export class WorkAuthorizationService {
  private readonly revealLimiter = new RateLimiter(REVEALS_PER_MINUTE, 60_000);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(FIELD_CRYPTO) private readonly crypto: FieldCrypto,
  ) {}

  /** The candidate as the caller sees it under candidate:read, and its access; 404 when not readable. */
  private async access(c: pg.PoolClient, user: AuthedUser, id: string) {
    const scope = resolveScope(user.access, "candidate:read");
    if (!scope) throw new NotFoundException();
    const params: unknown[] = [id];
    const row = (await c.query<{ recruiter_id: string | null; team_id: string; location_id: string; visibility: "team" | "all_teams"; marketing_status: string }>(
      `SELECT c.recruiter_id, c.team_id, c.location_id, c.visibility, c.marketing_status
       FROM eureka.candidate c WHERE c.id = $1 AND ${scopePredicate(scope, params)}`, params)).rows[0];
    if (!row) throw new NotFoundException();
    const ref: CandidateRef = { recruiterId: row.recruiter_id, teamId: row.team_id, locationId: row.location_id, visibility: row.visibility, marketingStatus: row.marketing_status };
    const access = workAuthAccess(user.access, ref);
    if (!access.read) throw new NotFoundException();
    return access;
  }

  private async row(c: pg.PoolClient, candidateId: string, id: string): Promise<Row & { number_enc: Buffer | null }> {
    const r = (await c.query<Row & { number_enc: Buffer | null }>(
      `SELECT ${COLUMNS}, w.number_enc FROM eureka.work_authorization w
         JOIN eureka.candidate c ON c.person_id = w.person_id
         LEFT JOIN eureka.app_user u ON u.id = w.updated_by
        WHERE w.id = $1 AND c.id = $2`, [id, candidateId])).rows[0];
    if (!r) throw new NotFoundException();
    return r;
  }

  async list(user: AuthedUser, candidateId: string) {
    return this.db.withUser(user.id, async (c) => {
      const access = await this.access(c, user, candidateId);
      const { rows } = await c.query<Row>(
        `SELECT ${COLUMNS} FROM eureka.work_authorization w
           JOIN eureka.candidate c ON c.person_id = w.person_id
           LEFT JOIN eureka.app_user u ON u.id = w.updated_by
          WHERE c.id = $1
          ORDER BY w.valid_to DESC NULLS FIRST, w.created_at DESC, w.id LIMIT 50`, [candidateId]);
      return { items: rows.map(present), canEdit: access.update, canReveal: access.read };
    });
  }

  /** The body is parsed after the scope check, so callers without rights get 403/404, not 422. */
  async create(user: AuthedUser, candidateId: string, parse: () => WorkAuthCreate) {
    return this.db.withUser(user.id, async (c) => {
      const access = await this.access(c, user, candidateId);
      if (!access.update) throw new ForbiddenException("Not permitted");
      const body = parse();
      const id = randomUUID();
      const sealed = body.number
        ? await this.crypto.cipher.encrypt(c, { cls: "work_auth_number", rowId: id }, body.number)
        : null;
      await c.query(`SELECT authz.work_auth_create($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, candidateId, body.type, sealed?.enc ?? null, sealed?.keyId ?? null, body.validFrom ?? null, body.validTo ?? null, body.status])
        .catch(mapDbError);
      // Rule 5: never the number; whether one was given is enough.
      await this.audit.record(c, {
        actorId: user.id, action: "work_authorization.created", entityType: "work_authorization", entityId: id,
        changes: { candidateId, type: body.type, status: body.status, validFrom: body.validFrom ?? null, validTo: body.validTo ?? null, numberSet: sealed !== null },
      });
      return { id, rowVersion: 1 };
    });
  }

  async update(user: AuthedUser, candidateId: string, id: string, expectedVersion: number | null, parse: () => WorkAuthUpdate) {
    return this.db.withUser(user.id, async (c) => {
      const access = await this.access(c, user, candidateId);
      const cur = await this.row(c, candidateId, id);
      if (!access.update) throw new ForbiddenException("Not permitted");
      const body = parse();
      if (expectedVersion === null) throw new HttpException("if_match_required", HttpStatus.PRECONDITION_REQUIRED);
      if (expectedVersion !== cur.row_version) throw new HttpException("stale", HttpStatus.PRECONDITION_FAILED);
      const next = {
        type: body.type ?? cur.auth_type,
        validFrom: body.validFrom !== undefined ? body.validFrom : cur.valid_from,
        validTo: body.validTo !== undefined ? body.validTo : cur.valid_to,
        status: body.status ?? cur.status,
      };
      if (next.validFrom && next.validTo && next.validTo < next.validFrom) {
        throw new UnprocessableEntityException("validTo must not be before validFrom");
      }
      const setNumber = body.number !== undefined;
      const sealed = body.number ? await this.crypto.cipher.encrypt(c, { cls: "work_auth_number", rowId: id }, body.number) : null;
      const rowVersion = (await c.query<{ v: number }>(
        `SELECT authz.work_auth_update($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS v`,
        [id, candidateId, expectedVersion, next.type, setNumber, sealed?.enc ?? null, sealed?.keyId ?? null, next.validFrom, next.validTo, next.status])
        .catch(mapDbError)).rows[0]!.v;
      const changed = (["type", "validFrom", "validTo", "status"] as const).filter((k) => body[k] !== undefined && body[k] !== (
        k === "type" ? cur.auth_type : k === "validFrom" ? cur.valid_from : k === "validTo" ? cur.valid_to : cur.status));
      await this.audit.record(c, {
        actorId: user.id, action: "work_authorization.updated", entityType: "work_authorization", entityId: id,
        changes: {
          candidateId, ...Object.fromEntries(changed.map((k) => [k, next[k]])),
          ...(setNumber ? { numberChanged: true, numberSet: sealed !== null } : {}),
        },
      });
      return { id, rowVersion };
    });
  }

  /**
   * The number in clear for one record (B4.6: visa:read; A6.3 restricted).
   * Needs a live step-up grant of this session (design A6.1, the same gate as
   * restricted documents: requireStepUp), is rate-limited and audited (who,
   * which record, the step-up grant id; never the number) in the same transaction.
   */
  async reveal(user: AuthedUser, candidateId: string, id: string) {
    return this.db.withUser(user.id, async (c) => {
      await this.access(c, user, candidateId);
      const r = await this.row(c, candidateId, id);
      if (!r.number_enc) throw new ConflictException("no_number");
      const stepUpGrantId = await requireStepUp(c, user);
      if (!this.revealLimiter.take(user.id)) {
        throw new HttpException("Too many requests; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
      }
      const number = await this.crypto.cipher.decrypt(c, { cls: "work_auth_number", rowId: id }, r.number_enc);
      await this.audit.record(c, {
        actorId: user.id, action: "work_authorization.number_revealed", entityType: "work_authorization", entityId: id,
        changes: { candidateId, stepUpGrantId },
      });
      return { id, number };
    });
  }
}
