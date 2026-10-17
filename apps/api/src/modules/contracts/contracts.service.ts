import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type pg from "pg";
import { CLOSED_BEFORE_JOIN_STATUSES, ownsActivity, resolveScope, type UserAccess } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import type { CreateContract } from "./contracts.schemas.js";

interface ContractRow {
  id: string; placement_id: string; kind: string; title: string; reference: string | null; starts_on: string | null;
  ends_on: string | null; notes: string | null; created_at: Date; created_by: string; created_by_name: string | null;
}
interface PlacementRef { recruiter_id: string; team_id: string | null; location_id: string | null; status: string }

const present = (r: ContractRow) => ({
  id: r.id, placementId: r.placement_id, kind: r.kind, title: r.title, reference: r.reference, startsOn: r.starts_on, endsOn: r.ends_on,
  notes: r.notes, createdAt: r.created_at, createdBy: { id: r.created_by, name: r.created_by_name },
});

/**
 * Contracts on a placement (interview-alerts package, migration 0086;
 * docs/alerts-calendar-birthdays.md CT-1..CT-6). Reads follow the placement
 * (RLS: 404 where the placement is not visible); writes go through
 * authz.create_contract, which re-checks visibility (404) and the right to add
 * (placement:update over the actor snapshot, or invoice:update at org scope;
 * 403) and records the `contract.created` outbox event. Notes are free text:
 * returned to readers of the placement, never audited.
 */
@Injectable()
export class ContractsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** Mirrors authz.create_contract's permission rule for the UI's "Add contract" button. */
  static canAdd(access: UserAccess, p: PlacementRef): boolean {
    if (resolveScope(access, "invoice:update") !== null) return true;
    return ownsActivity(resolveScope(access, "placement:update"), { recruiterId: p.recruiter_id, teamId: p.team_id, locationId: p.location_id });
  }

  private async placement(c: pg.PoolClient, id: string): Promise<PlacementRef> {
    const { rows } = await c.query<PlacementRef>(
      `SELECT recruiter_id, team_id, location_id, status FROM eureka.placement WHERE id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }

  async list(user: AuthedUser, placementId: string) {
    return this.db.withUser(user.id, async (c) => {
      const p = await this.placement(c, placementId);
      const { rows } = await c.query<ContractRow>(
        `SELECT k.id, k.placement_id, k.kind, k.title, k.reference, k.starts_on::text AS starts_on, k.ends_on::text AS ends_on, k.notes,
                k.created_at, k.created_by, u.display_name AS created_by_name
           FROM eureka.contract k LEFT JOIN eureka.app_user u ON u.id = k.created_by
          WHERE k.placement_id = $1 ORDER BY k.created_at DESC, k.id DESC`, [placementId]);
      return {
        items: rows.map(present),
        canAdd: ContractsService.canAdd(user.access, p) && !CLOSED_BEFORE_JOIN_STATUSES.has(p.status),
      };
    });
  }

  async create(user: AuthedUser, placementId: string, body: CreateContract) {
    return this.db.withUser(user.id, async (c) => {
      let id: string;
      try {
        id = (await c.query<{ id: string }>(
          "SELECT authz.create_contract($1, $2, $3, $4, $5::date, $6::date, $7) AS id",
          [placementId, body.kind, body.title, body.reference, body.startsOn, body.endsOn, body.notes])).rows[0]!.id;
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === "P0002") throw new NotFoundException();
        if (e.code === "42501") throw new ForbiddenException("Not permitted");
        if (e.code === "23514" && e.message === "placement_closed") throw new UnprocessableEntityException("placement_closed");
        if (e.code === "23514") throw new UnprocessableEntityException("invalid_contract");
        throw err;
      }
      // Rule 5: the kind and dates; never the title, reference or notes.
      await this.audit.record(c, {
        actorId: user.id, action: "contract.created", entityType: "contract", entityId: id,
        changes: { placementId, kind: body.kind, referenceSet: body.reference !== null, startsOn: body.startsOn, endsOn: body.endsOn, notesSet: body.notes !== null },
      });
      const { rows } = await c.query<ContractRow>(
        `SELECT k.id, k.placement_id, k.kind, k.title, k.reference, k.starts_on::text AS starts_on, k.ends_on::text AS ends_on, k.notes,
                k.created_at, k.created_by, u.display_name AS created_by_name
           FROM eureka.contract k LEFT JOIN eureka.app_user u ON u.id = k.created_by WHERE k.id = $1`, [id]);
      return present(rows[0]!);
    });
  }
}
