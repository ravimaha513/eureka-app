import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { AdminTx, notSelf } from "./admin-tx.js";
import type { OrgChartApply } from "./admin.schemas.js";

/** Most people GET /admin/org-chart returns, by name (`truncated` says there are more; audit C-09). */
export const ORG_CHART_CAP = 2000;

/** The org chart: reporting lines and teams, preview and batch apply (docs/roles-api.md "Org chart"). */
@Injectable()
export class OrgChartService {
  constructor(private readonly tx: AdminTx) {}

  async orgChart(user: AuthedUser) {
    return this.tx.run(user, async (c) => {
      const people = (await c.query<{
        id: string; display_name: string; designation: string | null; manager_id: string | null;
        roles: { key: string; label: string; track: string; level: number }[];
        team_id: string | null; team_name: string | null; as_lead: boolean | null;
      }>(
        `SELECT u.id, u.display_name, u.designation,
                (SELECT rl.manager_id FROM eureka.reporting_line rl WHERE rl.user_id = u.id AND rl.valid @> now()) AS manager_id,
                COALESCE((SELECT json_agg(json_build_object('key', r.key, 'label', r.label, 'track', r.track, 'level', r.level) ORDER BY r.level DESC, r.key)
                          FROM eureka.user_role ur JOIN eureka.role r ON r.key = ur.role_key
                          WHERE ur.user_id = u.id AND ur.valid @> now()), '[]') AS roles,
                t.id AS team_id, t.name AS team_name, t.lead_id = u.id AS as_lead
         FROM eureka.app_user u
         -- A lead's team is the one they lead, never one they are a member of (as authz.actor_team).
         LEFT JOIN LATERAL (
           SELECT t.id, t.name, t.lead_id FROM eureka.team t WHERE t.lead_id = u.id
           UNION ALL
           SELECT t.id, t.name, t.lead_id FROM eureka.team_member tm JOIN eureka.team t ON t.id = tm.team_id
            WHERE tm.user_id = u.id AND tm.valid @> now() AND NOT EXISTS (SELECT 1 FROM eureka.team x WHERE x.lead_id = u.id)
           LIMIT 1) t ON true
         WHERE u.status = 'active' AND u.deleted_at IS NULL
         ORDER BY u.display_name, u.id LIMIT ${ORG_CHART_CAP + 1}`)).rows;
      const teams = (await c.query<{ id: string; name: string; lead_id: string }>(`SELECT id, name, lead_id FROM eureka.team WHERE deleted_at IS NULL ORDER BY name, id`)).rows;
      return {
        people: people.slice(0, ORG_CHART_CAP).map((p) => ({
          id: p.id, displayName: p.display_name, designation: p.designation, managerId: p.manager_id, roles: p.roles,
          team: p.team_id ? { id: p.team_id, name: p.team_name!, asLead: !!p.as_lead } : null,
          canMove: p.id !== user.id,
        })),
        teams: teams.map((t) => ({ id: t.id, name: t.name, leadId: t.lead_id })),
        /** More than ORG_CHART_CAP active people: the chart stops at the first ORG_CHART_CAP by name. */
        truncated: people.length > ORG_CHART_CAP,
      };
    });
  }

  /** Managers leaving and joining the person's reporting chain if they reported to managerId. */
  async orgChartPreview(user: AuthedUser, userId: string, managerId: string | null) {
    return this.tx.run(user, async (c) => {
      const { rows } = await c.query<{ loses: { id: string; displayName: string }[]; gains: { id: string; displayName: string }[]; warnings: string[] }>(
        `WITH old AS (SELECT rc.ancestor_id AS id FROM eureka.reporting_closure rc WHERE rc.descendant_id = $1),
              new AS (SELECT $2::uuid AS id WHERE $2::uuid IS NOT NULL
                      UNION SELECT rc.ancestor_id FROM eureka.reporting_closure rc WHERE rc.descendant_id = $2::uuid),
              named AS (SELECT u.id, u.display_name FROM eureka.app_user u)
         SELECT COALESCE((SELECT json_agg(json_build_object('id', n.id, 'displayName', n.display_name) ORDER BY n.display_name)
                          FROM named n WHERE n.id IN (SELECT id FROM old) AND n.id NOT IN (SELECT id FROM new)), '[]') AS loses,
                COALESCE((SELECT json_agg(json_build_object('id', n.id, 'displayName', n.display_name) ORDER BY n.display_name)
                          FROM named n WHERE n.id IN (SELECT id FROM new) AND n.id NOT IN (SELECT id FROM old)), '[]') AS gains,
                CASE WHEN $2::uuid IS NOT NULL AND NOT authz.org_chart_ladder_ok($1, $2::uuid) THEN ARRAY['ladder_level'] ELSE '{}' END::text[] AS warnings`,
        [userId, managerId]);
      return rows[0]!;
    });
  }

  /**
   * All or nothing: each move and team add runs its own definer function and audit row.
   * The reporting closure is rebuilt once, at the end (authz.reporting_closure_defer / flush,
   * 0506); a loop is still refused on the move that closes it.
   */
  async orgChartApply(user: AuthedUser, body: OrgChartApply) {
    const ids = [...body.moves.map((m) => m.userId), ...body.teamAdds.map((t) => t.userId)];
    if (new Set(ids).size !== ids.length) throw new UnprocessableEntityException("duplicate_user");
    for (const id of ids) notSelf(user, id);
    return this.tx.run(user, async (c) => {
      await c.query(`SELECT authz.reporting_closure_defer()`);
      const warnings: { userId: string; code: string }[] = [];
      for (const m of body.moves) {
        const previous = (await c.query<{ m: string | null }>(
          `SELECT rl.manager_id AS m FROM eureka.reporting_line rl WHERE rl.user_id = $1 AND rl.valid @> now()`, [m.userId])).rows[0]?.m ?? null;
        if (previous === m.managerId) continue;
        const { rows } = await c.query<{ w: string[] }>(`SELECT authz.org_chart_move($1, $2) AS w`, [m.userId, m.managerId]);
        for (const code of rows[0]!.w) warnings.push({ userId: m.userId, code });
        await this.tx.audit.record(c, {
          actorId: user.id, action: "admin.user.manager", entityType: "app_user", entityId: m.userId,
          changes: { managerId: m.managerId, previous, warnings: rows[0]!.w, batch: true },
        });
      }
      for (const t of body.teamAdds) {
        if (!(await c.query(`SELECT 1 FROM eureka.role r JOIN eureka.user_role ur ON ur.role_key = r.key
                              WHERE ur.user_id = $1 AND ur.valid @> now() AND r.is_recruiter`, [t.userId])).rowCount) {
          throw new UnprocessableEntityException("not_a_recruiter");
        }
        await c.query(`SELECT authz.admin_add_team_member($1, $2)`, [t.teamId, t.userId]);
        await this.tx.audit.record(c, {
          actorId: user.id, action: "admin.team.member_added", entityType: "team", entityId: t.teamId, changes: { userId: t.userId, batch: true },
        });
      }
      await c.query(`SELECT authz.reporting_closure_flush()`);
      return { applied: body.moves.length + body.teamAdds.length, warnings };
    });
  }
}
