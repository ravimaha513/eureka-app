import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { AuditService } from "../../platform/audit.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import type pg from "pg";
import { CoachCalendarQuery, type SetCoachCalendarGrant } from "./coach-calendar.schemas.js";

interface GrantRow {
  id: string; grantee_role: string | null; role_label: string | null; grantee_user: string | null; user_name: string | null;
  all_coaches: boolean; coach_ids: string[]; detail: "full" | "busy"; updated_at: Date;
}

/** Maps the write functions' exceptions; anything else is a real failure and stays a 500. */
function mapWriteError(e: unknown): never {
  const message = (e as { message?: string }).message;
  if (message === "invalid_grantee" || message === "invalid_coaches" || message === "invalid_detail") throw new UnprocessableEntityException(message);
  if (message === "not_permitted") throw new ForbiddenException("Not permitted");
  if (message === "not_found") throw new NotFoundException();
  throw e;
}

/** "The CEO" is a current holder of the ceo role, not whoever holds a permission (migration 0540). */
const isCeo = async (c: pg.PoolClient) => (await c.query<{ ok: boolean }>(`SELECT authz.is_ceo() AS ok`)).rows[0]?.ok === true;
async function assertCeo(c: pg.PoolClient) {
  if (!(await isCeo(c))) throw new ForbiddenException("Not permitted");
}

@Injectable()
export class CoachCalendarService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** CC-1: the caller's coaches and their live interviews. Busy rows carry times only. */
  async calendar(user: AuthedUser, query: unknown) {
    return this.db.withUser(user.id, async (c) => {
      // Refuse first, so someone without access learns nothing from a query error.
      const ok = (await c.query<{ ok: boolean }>(`SELECT authz.coach_calendar_can_view() AS ok`)).rows[0]?.ok;
      if (!ok) throw new ForbiddenException("Not permitted");
      const { from, to } = CoachCalendarQuery.parse(query);
      const coaches = await c.query<{ coach_id: string; coach_name: string; detail: "full" | "busy" }>(
        `SELECT coach_id, coach_name, detail FROM authz.coach_calendar_visible() ORDER BY coach_name, coach_id`);
      const events = await c.query<{
        coach_id: string; starts_at: Date; ends_at: Date; interview_id: string | null;
        candidate_name: string | null; round: string | null; call_status: string | null;
      }>(`SELECT coach_id, starts_at, ends_at, interview_id, candidate_name, round, call_status
            FROM authz.coach_calendar_events($1, $2)`, [from, to]);
      return {
        canManage: await isCeo(c),
        coaches: coaches.rows.map((r) => ({ id: r.coach_id, name: r.coach_name, detail: r.detail })),
        events: events.rows.map((r) => ({
          coachId: r.coach_id, startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString(),
          interviewId: r.interview_id, candidateName: r.candidate_name, round: r.round, callStatus: r.call_status,
        })),
      };
    });
  }

  /** CC-2: every grant, plus what the form offers. */
  async grants(user: AuthedUser) {
    return this.db.withUser(user.id, async (c) => {
      await assertCeo(c);
      const grants = await c.query<GrantRow>(
        `SELECT g.id, g.grantee_role, r.label AS role_label, g.grantee_user, u.display_name AS user_name,
                g.all_coaches, g.coach_ids, g.detail, g.updated_at
           FROM eureka.coach_calendar_grant g
           LEFT JOIN eureka.role r ON r.key = g.grantee_role
           LEFT JOIN eureka.app_user u ON u.id = g.grantee_user
          ORDER BY g.grantee_role IS NULL, r.label, u.display_name, g.id`);
      const coaches = await c.query<{ id: string; name: string }>(
        `SELECT DISTINCT u.id, u.display_name AS name
           FROM eureka.app_user u JOIN eureka.user_role ur ON ur.user_id = u.id
          WHERE u.status = 'active' AND ur.role_key = 'interview_coach' AND ur.valid @> now()
          ORDER BY name, u.id`);
      const roles = await c.query<{ key: string; label: string }>(
        `SELECT key, label FROM eureka.role WHERE key <> 'ceo' AND NOT is_admin AND archived_at IS NULL ORDER BY label, key`);
      const names = new Map(coaches.rows.map((x) => [x.id, x.name]));
      return {
        items: grants.rows.map((g) => ({
          id: g.id,
          grantee: g.grantee_role !== null
            ? { type: "role" as const, role: g.grantee_role, name: g.role_label ?? g.grantee_role }
            : { type: "user" as const, id: g.grantee_user!, name: g.user_name ?? "Former colleague" },
          allCoaches: g.all_coaches,
          // A coach who has since left the role drops off the list; the grant keeps the rest.
          coaches: g.coach_ids.flatMap((id) => { const name = names.get(id); return name ? [{ id, name }] : []; }),
          detail: g.detail,
          updatedAt: g.updated_at.toISOString(),
        })),
        coaches: coaches.rows,
        roles: roles.rows,
      };
    });
  }

  /** CC-3: search for the person a grant names. Names only: no email or role metadata. */
  async people(user: AuthedUser, q: string) {
    return this.db.withUser(user.id, async (c) => {
      await assertCeo(c);
      return {
        items: (await c.query<{ id: string; name: string }>(
          `SELECT u.id, u.display_name AS name FROM eureka.app_user u
            WHERE u.status = 'active' AND u.display_name ILIKE '%' || $1 || '%' ESCAPE '\\'
              AND NOT authz.user_has_trait(u.id, 'admin')
            ORDER BY u.display_name, u.id LIMIT 20`, [q.replace(/[\\%_]/g, "\\$&")])).rows,
      };
    });
  }

  /** CC-4: grant, or replace what this grantee had. */
  async setGrant(user: AuthedUser, b: SetCoachCalendarGrant) {
    return this.db.withUser(user.id, async (c) => {
      await assertCeo(c);
      const id = await c.query<{ id: string }>(
        `SELECT authz.coach_calendar_grant_set($1, $2, $3, $4::uuid[], $5) AS id`,
        [b.granteeRole ?? null, b.granteeUserId ?? null, b.allCoaches, b.coachIds ?? [], b.detail],
      ).then((r) => r.rows[0]!.id, mapWriteError);
      await this.audit.record(c, {
        actorId: user.id, action: "coach_calendar.granted", entityType: "coach_calendar_grant", entityId: id,
        changes: {
          granteeType: b.granteeRole ? "role" : "user", granteeRole: b.granteeRole ?? null, granteeUserId: b.granteeUserId ?? null,
          allCoaches: b.allCoaches, coachIds: b.coachIds ? [...new Set(b.coachIds)] : null, detail: b.detail,
        },
      });
      return { id };
    });
  }

  /** CC-5 */
  async removeGrant(user: AuthedUser, id: string) {
    await this.db.withUser(user.id, async (c) => {
      await assertCeo(c);
      const removed = await c.query<{ grantee_role: string | null; grantee_user: string | null; all_coaches: boolean; coach_ids: string[]; detail: string }>(
        `SELECT * FROM authz.coach_calendar_grant_delete($1)`, [id],
      ).then((r) => r.rows[0]!, mapWriteError);
      await this.audit.record(c, {
        actorId: user.id, action: "coach_calendar.revoked", entityType: "coach_calendar_grant", entityId: id,
        changes: {
          granteeType: removed.grantee_role ? "role" : "user", granteeRole: removed.grantee_role, granteeUserId: removed.grantee_user,
          allCoaches: removed.all_coaches, coachIds: removed.all_coaches ? null : removed.coach_ids, detail: removed.detail,
        },
      });
    });
  }
}
