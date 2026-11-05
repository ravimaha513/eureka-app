import { ForbiddenException, HttpException, Injectable, NotFoundException } from "@nestjs/common";
import { resolveScope } from "@eureka/shared";
import type pg from "pg";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { coachUsers, departmentOf, teamCoaches } from "./admin-queries.js";
import { AdminTx, notSelf } from "./admin-tx.js";
import { mapAdminError } from "./admin.errors.js";
import type { CreateTeam, DeleteTeam, MoveMember } from "./admin.schemas.js";
import { leadTeamCovered, leadTeamReach } from "./team-scope.js";

/** Most addable recruiters GET /teams/mine returns, by name (`addableTruncated` says there are more; audit C-09). */
export const ADDABLE_CAP = 500;

/** Per-user error code of a team members bulk add, as the single add answers it; null for anything else. */
function memberAddError(err: unknown): string | null {
  try {
    mapAdminError(err);
  } catch (mapped) {
    if (!(mapped instanceof HttpException)) return null;
    const res = mapped.getResponse();
    const code = typeof res === "object" && res && "message" in res ? String((res as { message: unknown }).message) : mapped.message;
    return mapped.getStatus() === 404 ? "user_not_found" : code;
  }
  return null;
}

/** A team that is not deleted, with its lead; 404 otherwise. */
async function liveTeam(c: pg.PoolClient, teamId: string): Promise<{ lead_id: string }> {
  const team = (await c.query<{ lead_id: string }>(`SELECT lead_id FROM eureka.team WHERE id = $1 AND deleted_at IS NULL`, [teamId])).rows[0];
  if (!team) throw new NotFoundException();
  return team;
}

/**
 * Teams (docs/admin-api.md "Teams"): the admin paths (access:manage, any team)
 * and the lead paths (AD-8 team:move_member, AD-10 team:add_member, scoped by
 * team-scope.ts). The definer functions re-check every rule in the database.
 */
@Injectable()
export class TeamsService {
  constructor(private readonly tx: AdminTx) {}

  async listTeams(user: AuthedUser) {
    return this.tx.run(user, async (c) => {
      const teams = await c.query<{
        id: string; name: string; location_id: string | null; location_name: string | null; lead_id: string; lead_name: string;
        department_id: string | null; department_name: string | null; parent_id: string | null; parent_name: string | null;
      }>(
        `SELECT t.id, t.name, t.location_id, l.name AS location_name, t.lead_id, u.display_name AS lead_name,
                d.id AS department_id, d.name AS department_name, p.id AS parent_id, p.name AS parent_name
         FROM eureka.team t JOIN eureka.app_user u ON u.id = t.lead_id
         LEFT JOIN eureka.location l ON l.id = t.location_id
         LEFT JOIN eureka.department d ON d.id = u.department_id LEFT JOIN eureka.department p ON p.id = d.parent_id
         WHERE t.deleted_at IS NULL
         ORDER BY t.name, t.id`);
      const members = await c.query<{ team_id: string; id: string; display_name: string }>(
        `SELECT tm.team_id, u.id, u.display_name FROM eureka.team_member tm
         JOIN eureka.app_user u ON u.id = tm.user_id WHERE tm.valid @> now() ORDER BY u.display_name`);
      const coached = await teamCoaches(c, null);
      const coaches = await coachUsers(c, null);
      // Active users who neither lead nor belong to a team (Teams tab "Assign them" hint).
      const unassigned = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM eureka.app_user u WHERE u.status = 'active'
           AND NOT EXISTS (SELECT 1 FROM eureka.team_member tm WHERE tm.user_id = u.id AND tm.valid @> now())
           AND NOT EXISTS (SELECT 1 FROM eureka.team t WHERE t.lead_id = u.id)`);
      return {
        unassignedCount: unassigned.rows[0]!.n,
        items: teams.rows.map((t) => ({
          id: t.id,
          name: t.name,
          location: t.location_id ? { id: t.location_id, name: t.location_name } : null,
          lead: { id: t.lead_id, displayName: t.lead_name },
          // The lead's department (descriptive; Teams tab card header).
          department: departmentOf(t),
          members: members.rows.filter((m) => m.team_id === t.id).map((m) => ({ id: m.id, displayName: m.display_name })),
          coaches: coached.filter((m) => m.team_id === t.id).map((m) => ({ id: m.id, displayName: m.display_name })),
        })),
        coaches,
      };
    });
  }

  async createTeam(user: AuthedUser, body: CreateTeam) {
    notSelf(user, body.leadId);
    return this.tx.run(user, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT authz.admin_create_team($1, $2, $3) AS id`,
        [body.name, body.leadId, body.locationId ?? null]);
      const id = rows[0]!.id;
      // The name is free text: ids only (rule 5, as renameTeam).
      await this.tx.audit.record(c, {
        actorId: user.id, action: "admin.team.created", entityType: "team", entityId: id,
        changes: { leadId: body.leadId, locationId: body.locationId ?? null },
      });
      return { id };
    });
  }

  // The name is free text, so the audit row records only that it changed (rule 5).
  async renameTeam(user: AuthedUser, teamId: string, name: string) {
    await this.tx.run(user, async (c) => {
      await c.query(`SELECT authz.admin_rename_team($1, $2)`, [teamId, name]);
      await this.tx.audit.record(c, { actorId: user.id, action: "admin.team.renamed", entityType: "team", entityId: teamId });
    });
  }

  /** AD-15: what deleting the team would touch (delete dialog). */
  async teamDeleteImpact(user: AuthedUser, teamId: string) {
    return this.tx.run(user, async (c) => {
      const r = (await c.query<{ members: number; candidates: number; hotlist_candidates: number }>(
        `SELECT * FROM authz.admin_team_delete_impact($1)`, [teamId])).rows[0]!;
      return { members: r.members, candidates: r.candidates, hotlistCandidates: r.hotlist_candidates };
    });
  }

  /** AD-15: soft-deletes the team, moving its members and candidates to toTeamId or leaving them with no team. */
  async deleteTeam(user: AuthedUser, teamId: string, body: DeleteTeam) {
    return this.tx.run(user, async (c) => {
      const r = (await c.query<{ members: number; moved_candidates: number; unassigned_candidates: number }>(
        `SELECT * FROM authz.admin_delete_team($1, $2)`, [teamId, body.toTeamId ?? null])).rows[0]!;
      const result = { members: r.members, movedCandidates: r.moved_candidates, unassignedCandidates: r.unassigned_candidates };
      await this.tx.audit.record(c, {
        actorId: user.id, action: "admin.team.deleted", entityType: "team", entityId: teamId,
        changes: { toTeamId: body.toTeamId ?? null, ...result },
      });
      return result;
    });
  }

  async setLead(user: AuthedUser, teamId: string, leadId: string) {
    notSelf(user, leadId);
    await this.tx.run(user, async (c) => {
      await c.query(`SELECT authz.admin_set_team_lead($1, $2)`, [teamId, leadId]);
      await this.tx.audit.record(c, { actorId: user.id, action: "admin.team.lead", entityType: "team", entityId: teamId, changes: { leadId } });
    });
  }

  async addMember(user: AuthedUser, teamId: string, userId: string) {
    notSelf(user, userId);
    await this.tx.run(user, async (c) => {
      await c.query(`SELECT authz.admin_add_team_member($1, $2)`, [teamId, userId]);
      await this.tx.audit.record(c, { actorId: user.id, action: "admin.team.member_added", entityType: "team", entityId: teamId, changes: { userId } });
    });
  }

  /**
   * Adds several people to one team. Each add runs on its own (authz.admin_add_team_member,
   * under a savepoint of one transaction), so one person already in a team does not block
   * the rest; failures come back per user with the contract error code. 404 if the team
   * does not exist. The reporting closure (0370: members report to the lead) is rebuilt
   * once at the end (0506), not per person.
   */
  async addMembers(user: AuthedUser, teamId: string, userIds: string[]) {
    return this.tx.run(user, async (c) => {
      if ((await c.query(`SELECT 1 FROM eureka.team WHERE id = $1 AND deleted_at IS NULL`, [teamId])).rowCount !== 1) {
        throw new NotFoundException();
      }
      await c.query(`SELECT authz.reporting_closure_defer()`);
      const added: string[] = [];
      const failed: { userId: string; error: string }[] = [];
      for (const userId of [...new Set(userIds)]) {
        if (userId === user.id) { failed.push({ userId, error: "self_change" }); continue; }
        await c.query("SAVEPOINT team_member");
        try {
          await c.query(`SELECT authz.admin_add_team_member($1, $2)`, [teamId, userId]);
          await this.tx.audit.record(c, { actorId: user.id, action: "admin.team.member_added", entityType: "team", entityId: teamId, changes: { userId } });
          await c.query("RELEASE SAVEPOINT team_member");
          added.push(userId);
        } catch (err) {
          const error = memberAddError(err);
          if (error === null) throw err;
          await c.query("ROLLBACK TO SAVEPOINT team_member");
          failed.push({ userId, error });
        }
      }
      await c.query(`SELECT authz.reporting_closure_flush()`);
      return { added, failed };
    });
  }

  /**
   * AD-10: the teams the caller may add members to (the ones they lead, plus
   * any a hierarchy or org grant covers), with their members and the active
   * recruiters who are in no team yet: for team/hierarchy callers, only those
   * with no manager yet or below the caller (or a lead of one of those teams)
   * in the reporting line.
   */
  async myTeams(user: AuthedUser) {
    const { all, hierarchyTeamIds: wider } = leadTeamReach(user);
    return this.tx.run(user, async (c) => {
      const teams = await c.query<{ id: string; name: string; lead_id: string; lead_name: string }>(
        `SELECT t.id, t.name, t.lead_id, u.display_name AS lead_name
         FROM eureka.team t JOIN eureka.app_user u ON u.id = t.lead_id
         WHERE $1::boolean OR t.lead_id = $2 OR t.id = ANY ($3::uuid[]) ORDER BY t.name, t.id`, [all, user.id, wider]);
      const members = await c.query<{ team_id: string; id: string; display_name: string }>(
        `SELECT tm.team_id, u.id, u.display_name FROM eureka.team_member tm
         JOIN eureka.app_user u ON u.id = tm.user_id
         WHERE tm.valid @> now() AND tm.team_id = ANY ($1::uuid[]) ORDER BY u.display_name`, [teams.rows.map((t) => t.id)]);
      const addable = await c.query<{ id: string; display_name: string; email: string }>(
        `SELECT u.id, u.display_name, u.email FROM eureka.app_user u
         WHERE u.status = 'active' AND u.id <> $1
           AND EXISTS (SELECT 1 FROM eureka.user_role ur WHERE ur.user_id = u.id AND ur.role_key = 'recruiter' AND ur.valid @> now())
           AND NOT EXISTS (SELECT 1 FROM eureka.team_member tm WHERE tm.user_id = u.id AND tm.valid @> now())
           AND ($2::boolean
             OR NOT EXISTS (SELECT 1 FROM eureka.reporting_closure rc WHERE rc.descendant_id = u.id)
             OR EXISTS (SELECT 1 FROM eureka.reporting_closure rc
                 WHERE rc.descendant_id = u.id AND rc.ancestor_id = ANY ($3::uuid[])))
         ORDER BY u.display_name, u.id LIMIT ${ADDABLE_CAP + 1}`, [user.id, all, [user.id, ...teams.rows.map((t) => t.lead_id)]]);
      return {
        items: teams.rows.map((t) => ({
          id: t.id,
          name: t.name,
          lead: { id: t.lead_id, displayName: t.lead_name },
          members: members.rows.filter((m) => m.team_id === t.id).map((m) => ({ id: m.id, displayName: m.display_name })),
        })),
        addable: addable.rows.slice(0, ADDABLE_CAP).map((u) => ({ id: u.id, displayName: u.display_name, email: u.email })),
        /** More than ADDABLE_CAP recruiters are addable; the list stops at the first ADDABLE_CAP by name. */
        addableTruncated: addable.rows.length > ADDABLE_CAP,
      };
    });
  }

  /**
   * AD-10: add an unassigned recruiter to a team the caller leads. 404 for an
   * unknown team, 403 outside the caller's teams; authz.team_add_member
   * re-checks all of it in the database.
   */
  async leadAddMember(user: AuthedUser, teamId: string, userId: string) {
    notSelf(user, userId);
    await this.tx.run(user, async (c) => {
      const team = await liveTeam(c, teamId);
      if (!leadTeamCovered(user, teamId, team.lead_id)) throw new ForbiddenException("not_in_scope");
      await c.query(`SELECT authz.team_add_member($1, $2)`, [teamId, userId]);
      await this.tx.audit.record(c, { actorId: user.id, action: "team.member_added", entityType: "team", entityId: teamId, changes: { userId } });
    });
  }

  /**
   * AD-14: take someone out of a team. `admin` is Users & Access (access:manage, any
   * team); `team` is the AD-10 rule (team:add_member: the team's lead, or a team led
   * in the caller's hierarchy). Their candidates on the team go to its lead.
   * authz.team_remove_member re-checks all of it in the database.
   */
  async removeMember(user: AuthedUser, via: "admin" | "team", teamId: string, userId: string) {
    notSelf(user, userId);
    return this.tx.run(user, async (c) => {
      const team = await liveTeam(c, teamId);
      if (via === "team") {
        if (!leadTeamCovered(user, teamId, team.lead_id)) throw new ForbiddenException("not_in_scope");
      }
      const { rows } = await c.query<{ moved_candidates: number; reassigned_to: string }>(
        `SELECT * FROM authz.team_remove_member($1, $2)`, [teamId, userId]);
      const r = rows[0]!;
      await this.tx.audit.record(c, {
        actorId: user.id, action: via === "admin" ? "admin.team.member_removed" : "team.member_removed",
        entityType: "team", entityId: teamId,
        changes: { userId, reassignedTo: r.reassigned_to, movedCandidates: r.moved_candidates },
      });
      return { movedCandidates: r.moved_candidates, reassignedTo: { id: r.reassigned_to } };
    });
  }

  /** OD-07 / AD-8: team:move_member must cover both teams (engine here, definer function in the database). */
  async moveMember(user: AuthedUser, fromTeamId: string, body: MoveMember) {
    notSelf(user, body.userId);
    const scope = resolveScope(user.access, "team:move_member");
    if (!scope || !(scope.all || (scope.teamIds.has(fromTeamId) && scope.teamIds.has(body.toTeamId)))) {
      throw new ForbiddenException("not_in_scope");
    }
    return this.tx.run(user, async (c) => {
      const { rows } = await c.query<{ moved_candidates: number; reassigned_to: string }>(
        `SELECT * FROM authz.move_team_member($1, $2, $3, $4)`,
        [body.userId, fromTeamId, body.toTeamId, body.reassignTo ?? null]);
      const r = rows[0]!;
      const target = await c.query<{ display_name: string }>(
        `SELECT display_name FROM eureka.app_user WHERE id = $1`, [r.reassigned_to]);
      await this.tx.audit.record(c, {
        actorId: user.id, action: "team.member_moved", entityType: "team", entityId: fromTeamId,
        changes: { userId: body.userId, fromTeamId, toTeamId: body.toTeamId, reassignedTo: r.reassigned_to, movedCandidates: r.moved_candidates },
      });
      return {
        movedCandidates: r.moved_candidates,
        reassignedTo: { id: r.reassigned_to, displayName: target.rows[0]?.display_name ?? null },
      };
    });
  }
}
