import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { decodeCursor, encodeCursor } from "../facilities/facilities.common.js";
import { roleLabels } from "./admin-queries.js";
import { AdminTx, notSelf } from "./admin-tx.js";
import type { CreateRoleRequest, RoleRequestListQuery } from "./admin.schemas.js";

/** Most role requests one GET /admin/role-requests page returns (`truncated` / `nextCursor` reach the rest; audit C-09). */
export const ROLE_REQUEST_PAGE = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Granting and revoking roles: requests, second-approver decisions, revocation (docs/admin-api.md "Roles"). */
@Injectable()
export class RoleRequestsService {
  constructor(private readonly tx: AdminTx) {}

  async requestRole(user: AuthedUser, body: CreateRoleRequest) {
    notSelf(user, body.userId);
    return this.tx.run(user, async (c) => {
      // authz.request_role raises unknown_role, location_required and location_not_allowed itself.
      const { rows } = await c.query<{ request_id: string; request_status: "applied" | "pending_approval" }>(
        `SELECT * FROM authz.request_role($1, $2, $3)`, [body.userId, body.role, body.locationId ?? null]);
      const r = rows[0]!;
      await this.tx.audit.record(c, {
        actorId: user.id,
        action: r.request_status === "applied" ? "admin.role.granted" : "admin.role.requested",
        entityType: "app_user", entityId: body.userId,
        changes: { requestId: r.request_id, role: body.role, locationId: body.locationId ?? null },
      });
      return { id: r.request_id, status: r.request_status };
    });
  }

  /**
   * Newest first, ROLE_REQUEST_PAGE per page. `truncated` / `nextCursor` (keyset on
   * requested_at in microseconds, id) reach requests past the page (audit C-09).
   */
  async listRoleRequests(user: AuthedUser, q: RoleRequestListQuery) {
    const params: unknown[] = [q.status ?? null];
    let after = "";
    const cur = decodeCursor(q.cursor, 2);
    if (cur) {
      if (!/^\d{1,20}$/.test(cur[0]!) || !UUID.test(cur[1]!)) throw new UnprocessableEntityException("invalid_cursor");
      params.push(cur[0], cur[1]);
      after = ` AND (s.k < $2::bigint OR (s.k = $2::bigint AND s.id > $3::uuid))`;
    }
    params.push(ROLE_REQUEST_PAGE + 1);
    return this.tx.run(user, async (c) => {
      const { rows: fetched } = await c.query<{
        k: string; id: string; user_id: string; user_name: string; user_email: string; role_key: string; location_id: string | null;
        requested_by: string; requested_by_name: string; requested_at: Date; status: string;
        decided_by: string | null; decided_by_name: string | null; decided_at: Date | null;
      }>(
        `SELECT * FROM (
           SELECT q.id, q.user_id, u.display_name AS user_name, u.email::text AS user_email, q.role_key, q.location_id,
                  q.requested_by, rb.display_name AS requested_by_name, q.requested_at,
                  CASE WHEN q.status = 'pending' AND q.expires_at <= now() THEN 'expired' ELSE q.status END AS status,
                  q.decided_by, d.display_name AS decided_by_name, q.decided_at,
                  (extract(epoch FROM q.requested_at) * 1000000)::bigint AS k
           FROM eureka.role_request q
           JOIN eureka.app_user u ON u.id = q.user_id
           JOIN eureka.app_user rb ON rb.id = q.requested_by
           LEFT JOIN eureka.app_user d ON d.id = q.decided_by) s
         WHERE ($1::text IS NULL OR s.status = $1)${after}
         ORDER BY s.requested_at DESC, s.id LIMIT $${params.length}`, params);
      const truncated = fetched.length > ROLE_REQUEST_PAGE;
      const rows = fetched.slice(0, ROLE_REQUEST_PAGE);
      const last = rows[rows.length - 1];
      const labels = await roleLabels(c);
      return {
        items: rows.map((r) => ({
          id: r.id,
          user: { id: r.user_id, displayName: r.user_name, email: r.user_email },
          role: r.role_key,
          roleLabel: labels.get(r.role_key) ?? r.role_key,
          locationId: r.location_id,
          requestedBy: { id: r.requested_by, displayName: r.requested_by_name },
          requestedAt: r.requested_at,
          status: r.status,
          decidedBy: r.decided_by ? { id: r.decided_by, displayName: r.decided_by_name } : null,
          decidedAt: r.decided_at,
        })),
        truncated,
        nextCursor: truncated && last ? encodeCursor([last.k, last.id]) : null,
      };
    });
  }

  async decide(user: AuthedUser, id: string, decision: "approve" | "reject") {
    return this.tx.run(user, async (c) => {
      const fn = decision === "approve" ? "authz.approve_role_request" : "authz.reject_role_request";
      const { rows } = await c.query<{ s: "approved" | "rejected" }>(`SELECT ${fn}($1) AS s`, [id]);
      await this.tx.audit.record(c, {
        actorId: user.id, action: `admin.role_request.${rows[0]!.s}`, entityType: "role_request", entityId: id,
      });
      return { status: rows[0]!.s };
    });
  }

  async revokeRole(user: AuthedUser, userId: string, role: string, locationId: string | undefined) {
    notSelf(user, userId);
    await this.tx.run(user, async (c) => {
      const bound = (await c.query<{ b: boolean }>(`SELECT is_location_bound AS b FROM eureka.role WHERE key = $1`, [role])).rows[0]?.b;
      if (bound === undefined) throw new UnprocessableEntityException("unknown_role");
      if (locationId && !bound) throw new UnprocessableEntityException("location_not_allowed");
      await c.query(`SELECT authz.revoke_role($1, $2, $3)`, [userId, role, locationId ?? null]);
      await this.tx.audit.record(c, {
        actorId: user.id, action: "admin.role.revoked", entityType: "app_user", entityId: userId,
        changes: { role, locationId: locationId ?? null },
      });
    });
  }
}
