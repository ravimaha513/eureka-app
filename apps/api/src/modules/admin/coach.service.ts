import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { resolveScope } from "@eureka/shared";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { coachUsers, teamCoaches } from "./admin-queries.js";
import { AdminTx, notSelf } from "./admin-tx.js";

/** AD-11 coach assignments: the admin path (access:manage) and the Interview Lead path (coach:assign). */
@Injectable()
export class CoachService {
  constructor(private readonly tx: AdminTx) {}

  /**
   * AD-11, coach:assign: every team (coaches support any sales team) with the
   * caller's assignable coaches on it, and those coaches: active coach-role
   * holders below the caller in the reporting hierarchy (everyone for an org grant).
   */
  async coachAssignments(user: AuthedUser) {
    const scope = resolveScope(user.access, "coach:assign");
    if (!scope) throw new ForbiddenException("not_permitted");
    const ids = scope.all ? null : user.access.subordinateUserIds;
    return this.tx.run(user, async (c) => {
      const teams = await c.query<{ id: string; name: string; lead_id: string; lead_name: string }>(
        `SELECT t.id, t.name, t.lead_id, u.display_name AS lead_name
         FROM eureka.team t JOIN eureka.app_user u ON u.id = t.lead_id ORDER BY t.name, t.id`);
      const coaches = await coachUsers(c, ids);
      const coached = await teamCoaches(c, coaches.map((u) => u.id));
      return {
        items: teams.rows.map((t) => ({
          id: t.id,
          name: t.name,
          lead: { id: t.lead_id, displayName: t.lead_name },
          coaches: coached.filter((m) => m.team_id === t.id).map((m) => ({ id: m.id, displayName: m.display_name })),
        })),
        coaches,
      };
    });
  }

  /**
   * AD-11: assign a coach to a team or end the assignment. `via` "admin":
   * access:manage, any coach; "hierarchy": coach:assign over the coaches below
   * the caller. 404 unknown team, 403 self or outside the scope; the definer
   * functions re-check everything. Audited with ids only.
   */
  async changeCoach(user: AuthedUser, via: "admin" | "hierarchy", op: "assign" | "unassign", teamId: string, coachId: string) {
    notSelf(user, coachId);
    if (via === "hierarchy") {
      const scope = resolveScope(user.access, "coach:assign");
      if (!scope) throw new ForbiddenException("not_permitted");
      if (!scope.all && !user.access.subordinateUserIds.includes(coachId)) throw new ForbiddenException("not_in_scope");
    }
    await this.tx.run(user, async (c) => {
      const team = await c.query(`SELECT 1 FROM eureka.team WHERE id = $1 AND deleted_at IS NULL`, [teamId]);
      if (team.rowCount === 0) throw new NotFoundException();
      await c.query(`SELECT authz.${op}_coach($1, $2)`, [coachId, teamId]);
      await this.tx.audit.record(c, {
        actorId: user.id, action: `${via === "admin" ? "admin." : ""}team.coach_${op}ed`, entityType: "team", entityId: teamId,
        changes: { coachId },
      });
    });
  }
}
