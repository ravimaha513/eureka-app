/** Batches (list, create, status) and the bulk add of new candidates to a batch. */
import { randomUUID } from "node:crypto";
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type pg from "pg";
import {
  canCreateBatch,
  hasTrait,
  normalizePhoneE164,
  phoneProblem,
  resolveScope,
} from "@eureka/shared";
import { AuditService, redactChanges } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { dbErrorMapper } from "../../platform/errors.js";
import { RateLimiter } from "../../platform/rate-limit.js";
import type { BatchStatus } from "../training/training.schemas.js";
import type { BatchListQuery, BulkBatchCandidates, CreateBatch } from "./candidates.schemas.js";
import { Email } from "./candidates.schemas.js";
import { buildCandidateImportTemplate } from "./candidate-import-template.js";
import { batchLabel, creatableTeam, mapBatchError, mapCreateError } from "./candidate-common.js";

/** A file answers "is this contact taken?" for up to 500 rows, so previews are limited per user too. */
export const BULK_CANDIDATE_CALLS_PER_MINUTE = 10;

/**
 * Rows per user per UTC day that the bulk add may check against existing
 * candidates' contacts, previews included (A-01). Stored in the database
 * (eureka.bulk_candidate_budget, 0475), so it holds across API tasks.
 * docs/candidates-api.md "Bulk add to a batch".
 */
export const BULK_CANDIDATE_ROWS_PER_DAY = 2000;

/** Thrown inside the transaction to roll a bulk add back and still answer with its report. */
class BulkCandidatesRollback extends Error {
  constructor(readonly report: unknown) { super("bulk_rollback"); }
}

/** The bulk add's daily row budget (0475): 429 once spent. */
const mapBudgetError: (err: unknown) => never = dbErrorMapper({
  bulk_budget_exceeded: () => new HttpException("bulk_budget_exceeded", HttpStatus.TOO_MANY_REQUESTS),
});

@Injectable()
export class CandidateBatchesService {
  private readonly log = new Logger(CandidateBatchesService.name);
  private readonly bulkCandidateLimiter = new RateLimiter(BULK_CANDIDATE_CALLS_PER_MINUTE, 60_000);

  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** Batches (FR-CAN-02), readable by every candidate:read holder; `canCreate` is a UI hint. */
  async batches(user: AuthedUser, q: BatchListQuery) {
    const params: unknown[] = [];
    const where: string[] = ["true"];
    if (q.locationId) { params.push(q.locationId); where.push(`b.location_id = $${params.length}`); }
    if (q.technologyId) { params.push(q.technologyId); where.push(`b.technology_id = $${params.length}`); }
    if (q.status) { params.push(q.status); where.push(`b.status = $${params.length}`); }
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<{
      id: string; name: string | null; start_month: string; size_planned: number | null; status: string;
      location_id: string; location_name: string; technology_id: string; technology_name: string; candidates: number;
    }>(
      `SELECT b.id, b.name, b.start_month::text, b.size_planned, b.status,
              b.location_id, l.name AS location_name, b.technology_id, t.name AS technology_name,
              (SELECT count(*)::int FROM eureka.candidate c WHERE c.batch_id = b.id) AS candidates
       FROM eureka.batch b
       JOIN eureka.location l ON l.id = b.location_id
       JOIN eureka.technology t ON t.id = b.technology_id
       WHERE ${where.join(" AND ")}
       ORDER BY b.start_month DESC, l.name, t.name, b.id
       LIMIT 200`, params)).rows);
    return {
      items: rows.map((b) => ({
        id: b.id,
        label: batchLabel(b.technology_name, b.location_name, b.start_month, b.name),
        customName: b.name,
        location: { id: b.location_id, name: b.location_name },
        technology: { id: b.technology_id, name: b.technology_name },
        startMonth: b.start_month.slice(0, 7),
        sizePlanned: b.size_planned,
        status: b.status,
        /** Candidates in this batch that the caller can read. */
        candidatesInScope: b.candidates,
      })),
      canCreate: canCreateBatch(user.access),
    };
  }

  /** The body is parsed only after the permission check, so callers without it always get 403. */
  async createBatch(user: AuthedUser, parse: () => CreateBatch) {
    if (!canCreateBatch(user.access)) throw new ForbiddenException("Not permitted");
    const body = parse();
    return this.db.withUser(user.id, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT authz.create_batch($1, $2, $3::date, $4) AS id`,
        [body.locationId, body.technologyId, `${body.startMonth}-01`, body.sizePlanned ?? null]).catch(mapBatchError);
      const id = rows[0]!.id;
      // Named in the same transaction (TR-1a); the name itself stays out of the audit row (rule 5).
      await c.query(`SELECT authz.update_batch($1, 1, $2, NULL, NULL, NULL, $3, 'indigo', 'users')`,
        [id, body.name, body.sizePlanned ?? null]).catch(mapBatchError);
      const { name: _name, ...details } = body;
      await this.audit.record(c, { actorId: user.id, action: "batch.created", entityType: "batch", entityId: id, changes: { ...details, named: true } });
      return { id };
    });
  }

  /**
   * Batch status (planned -> in_training -> completed; cancel before completion)
   * through authz.set_batch_status: same permission as create, batch location
   * in the caller's scope. Read-before-write: 404 if not visible, then 403.
   */
  async setBatchStatus(user: AuthedUser, id: string, to: BatchStatus) {
    return this.db.withUser(user.id, async (c) => {
      const b = (await c.query<{ status: string }>(`SELECT status FROM eureka.batch WHERE id = $1`, [id])).rows[0];
      if (!b) throw new NotFoundException();
      if (!canCreateBatch(user.access)) throw new ForbiddenException("Not permitted");
      await c.query(`SELECT authz.set_batch_status($1, $2)`, [id, to]).catch(mapBatchError);
      await this.audit.record(c, { actorId: user.id, action: "batch.status", entityType: "batch", entityId: id, changes: { from: b.status, to } });
      return { id, status: to };
    });
  }

  /**
   * The batch a bulk add goes to, and the team and recruiter its candidates get:
   * 404 unknown batch, 403 team outside candidate:create, 422 closed batch.
   */
  private async bulkTarget(c: pg.PoolClient, user: AuthedUser, batchId: string, teamId: string | null | undefined) {
    const batch = (await c.query<{ location_id: string; technology_id: string; status: string }>(
      `SELECT location_id, technology_id, status FROM eureka.batch WHERE id = $1`, [batchId])).rows[0];
    if (!batch) throw new NotFoundException();
    const team = creatableTeam(user, teamId);
    if (batch.status !== "planned" && batch.status !== "in_training") throw new UnprocessableEntityException("batch_not_allowed");
    // As in create(): with no team, only the recruiter link keeps the candidates in the caller's scope.
    const recruiter = (team === null && !resolveScope(user.access, "candidate:create")?.all) || hasTrait(user.access, "recruiter") ? user.id : null;
    return { batch, team, recruiter };
  }

  /**
   * New candidates for a batch from the Excel template (docs/candidates-api.md). All
   * or nothing: every row is inserted in one transaction, rolled back when any row
   * fails or when `dryRun` is set, so a preview shows exactly what a real run would
   * do. Each row is the single create's insert and audit event; technology and
   * location come from the batch. Rows are validated in memory, then their contacts
   * are checked in one call (authz.candidate_contacts_taken, 0475, which holds the
   * contact lock until the transaction ends) and the rest inserted set-based; the
   * trigger authz.candidate_contact_unique (0260) stays the backstop. A row reports
   * only which value is taken, not whose it is. Rows checked against existing
   * contacts are charged to the caller's daily budget first (429 once spent, A-01).
   */
  async bulkAddToBatch(user: AuthedUser, batchId: string, body: BulkBatchCandidates) {
    if (!this.bulkCandidateLimiter.take(user.id)) {
      this.log.warn(`Bulk candidate rate limit exceeded by user ${user.id}`);
      throw new HttpException("Too many imports; try again in a minute", HttpStatus.TOO_MANY_REQUESTS);
    }
    type Row = { row: number; firstName: string; lastName: string; phone: string; email: string; status: "ok" | "error"; error?: string };
    const fail = (res: Row, code: string) => { res.status = "error"; res.error = code; };
    // In-memory validation, in file order; `check` are the rows whose contacts go to the database.
    const emails = new Set<string>();
    const phones = new Set<string>();
    const rows: Row[] = [];
    const check: { res: Row; email: string; phone: string }[] = [];
    for (const [i, r] of body.rows.entries()) {
      const firstName = r.firstName.trim();
      const lastName = r.lastName.trim();
      const email = Email.safeParse(r.email);
      const phone = normalizePhoneE164(r.phone);
      const res: Row = { row: i + 1, firstName, lastName, phone: phone ?? r.phone.trim(), email: email.success ? email.data : r.email.trim(), status: "ok" };
      rows.push(res);
      if (!firstName || firstName.length > 80) { fail(res, "invalid_first_name"); continue; }
      if (!lastName || lastName.length > 80) { fail(res, "invalid_last_name"); continue; }
      if (!phone) { fail(res, phoneProblem(r.phone) ?? "invalid"); continue; }
      if (!email.success) { fail(res, "invalid_email"); continue; }
      if (emails.has(email.data) || phones.has(phone)) { fail(res, "duplicate_in_file"); continue; }
      emails.add(email.data);
      phones.add(phone);
      check.push({ res, email: email.data, phone });
    }

    // The budget is charged in its own transaction, after the batch and team checks,
    // so a preview (rolled back below) still counts.
    await this.db.withUser(user.id, async (c) => {
      await this.bulkTarget(c, user, batchId, body.teamId);
      if (check.length === 0) return;
      await c.query(`SELECT authz.bulk_candidate_budget_take($1, $2)`, [check.length, BULK_CANDIDATE_ROWS_PER_DAY]).catch((err: unknown) => {
        if ((err as { message?: string }).message === "bulk_budget_exceeded") {
          this.log.warn(`Bulk candidate daily row budget exceeded by user ${user.id}`);
        }
        return mapBudgetError(err);
      });
    });

    let taken = 0;
    try {
      const report = await this.db.withUser(user.id, async (c) => {
        const { batch, team, recruiter } = await this.bulkTarget(c, user, batchId, body.teamId);
        const insert: { email: string; phone: string; res: Row }[] = [];
        if (check.length > 0) {
          const found = (await c.query<{ kind: "email" | "phone"; value: string }>(
            `SELECT kind, value FROM authz.candidate_contacts_taken($1::text[], $2::text[])`,
            [check.map((x) => x.email), check.map((x) => x.phone)])).rows;
          const takenEmails = new Set(found.filter((f) => f.kind === "email").map((f) => f.value));
          const takenPhones = new Set(found.filter((f) => f.kind === "phone").map((f) => f.value));
          // Email first, then phone: the trigger's order.
          for (const x of check) {
            if (takenEmails.has(x.email)) { fail(x.res, "duplicate_email"); taken++; }
            else if (takenPhones.has(x.phone)) { fail(x.res, "duplicate_phone"); taken++; }
            else insert.push(x);
          }
        }
        if (insert.length > 0) {
          const personIds = insert.map(() => randomUUID());
          await c.query(
            `INSERT INTO eureka.person (id, first_name, last_name, phone_e164, personal_email)
             SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[])`,
            [personIds, insert.map((x) => x.res.firstName), insert.map((x) => x.res.lastName), insert.map((x) => x.phone), insert.map((x) => x.email)]);
          const made = await c.query<{ id: string }>(
            `INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id, batch_id)
             SELECT p, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid FROM unnest($1::uuid[]) WITH ORDINALITY AS u(p, n) ORDER BY n RETURNING id`,
            [personIds, batch.technology_id, team, recruiter, batch.location_id, batchId]);
          // One candidate.created per row, as the single create writes (ids and flags only, rule 5).
          await c.query(
            `INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes)
             SELECT $1::uuid, 'candidate.created', 'candidate', id, $3::jsonb FROM unnest($2::uuid[]) AS id`,
            [user.id, made.rows.map((r) => r.id), JSON.stringify(redactChanges({ batchId, bulk: true }))]);
        }
        const failed = rows.filter((r) => r.status === "error").length;
        const out = { dryRun: body.dryRun, committed: !body.dryRun && failed === 0, created: body.dryRun || failed > 0 ? 0 : rows.length, failed, rows };
        if (!out.committed) throw new BulkCandidatesRollback(out);
        await this.audit.record(c, { actorId: user.id, action: "batch.candidates_added", entityType: "batch", entityId: batchId,
          changes: { teamId: team, created: rows.length, checked: check.length, taken } });
        return out;
      }).catch(mapCreateError);
      return report;
    } catch (err) {
      if (!(err instanceof BulkCandidatesRollback)) throw err;
      // Audited apart: the check's transaction was rolled back. Counts only (rule 5).
      const { rows: reported, failed } = err.report as { rows: Row[]; failed: number };
      await this.db.withUser(user.id, (c) => this.audit.record(c, {
        actorId: user.id, action: "batch.candidates_checked", entityType: "batch", entityId: batchId,
        changes: { rows: reported.length, failed, checked: check.length, taken },
      }));
      return err.report;
    }
  }

  /** The Excel template of bulkAddToBatch. */
  candidateTemplate(): Promise<Buffer> {
    return buildCandidateImportTemplate();
  }
}
