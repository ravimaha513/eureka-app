/** A candidate's timeline (FR-CAN-10). */
import { Injectable, NotFoundException } from "@nestjs/common";
import { ownsCandidate, resolveScope, type Permission } from "@eureka/shared";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import type { TimelineQuery } from "./candidates.schemas.js";
import { CANDIDATE_SELECT, batchLabel, scopePredicate, toRef, type CandidateRow } from "./candidate-common.js";

@Injectable()
export class CandidateTimelineService {
  constructor(private readonly db: DbService) {}

  /**
   * Timeline (FR-CAN-10). The candidate must be readable (404 otherwise).
   * Events about a submission, interview or placement are listed only when
   * that record is readable too; the query applies the engine's rule and RLS
   * (candidate_event_read, migration 0026) applies it again.
   */
  async timeline(user: AuthedUser, id: string, q: TimelineQuery) {
    const readScope = resolveScope(user.access, "candidate:read");
    if (!readScope) throw new NotFoundException();
    return this.db.withUser(user.id, async (c) => {
      const params: unknown[] = [id];
      const row = (await c.query<CandidateRow>(`${CANDIDATE_SELECT} WHERE c.id = $1 AND ${scopePredicate(readScope, params)}`, params)).rows[0];
      if (!row) throw new NotFoundException();
      const ref = toRef(row);
      // A viewer who sees the candidate only through Open to all teams (another
      // team, D-02) gets no actor names and nothing from before the candidate
      // was last opened to all teams.
      const owner = ownsCandidate(readScope, ref);
      let since: string | null = null;
      if (!owner) {
        since = (await c.query<{ id: string | null }>(
          `SELECT max(id)::text AS id FROM eureka.candidate_event
           WHERE candidate_id = $1 AND type = 'candidate.visibility_changed' AND to_value IN ('all_teams', 'selected_teams')`, [id])).rows[0]?.id ?? null;
      }
      const ep: unknown[] = [id, q.cursor ?? null, q.limit + 1, since];
      const activity = (table: string, alias: string, perm: Permission) => {
        const s = resolveScope(user.access, perm);
        if (!s) return "false";
        if (s.all || ownsCandidate(s, ref)) return "true";
        const p = (v: unknown) => { ep.push(v); return `$${ep.length}`; };
        return `EXISTS (SELECT 1 FROM eureka.${table} ${alias} WHERE ${alias}.id = e.ref_id AND (
          ${alias}.recruiter_id = ANY(${p([...s.recruiterIds])}::uuid[])
          OR ${alias}.team_id = ANY(${p([...s.teamIds])}::uuid[])
          OR ${alias}.location_id = ANY(${p([...s.locationIds])}::uuid[])))`;
      };
      const visible = `CASE e.ref_type
        WHEN 'submission' THEN ${activity("submission", "s", "submission:read")}
        WHEN 'interview' THEN ${activity("interview", "i", "interview:read")}
        WHEN 'placement' THEN ${activity("placement", "pl", "placement:read")}
        ELSE true END`;
      const { rows } = await c.query<{
        id: string; type: string; at: Date; actor_id: string | null; actor_name: string | null;
        ref_type: string | null; ref_id: string | null; from_value: string | null; to_value: string | null;
        team_name: string | null; batch_name: string | null; batch_month: string | null; batch_technology: string | null; batch_location: string | null;
      }>(
        `SELECT e.id::text, e.type, e.at, e.actor_id, u.display_name AS actor_name, e.ref_type, e.ref_id,
                e.from_value, e.to_value, tm.name AS team_name,
                b.name AS batch_name, b.start_month::text AS batch_month, bt.name AS batch_technology, bl.name AS batch_location
         FROM eureka.candidate_event e
         LEFT JOIN eureka.app_user u ON u.id = e.actor_id
         LEFT JOIN eureka.team tm ON e.ref_type = 'team' AND tm.id = e.ref_id
         LEFT JOIN eureka.batch b ON e.ref_type = 'batch' AND b.id = e.ref_id
         LEFT JOIN eureka.technology bt ON bt.id = b.technology_id
         LEFT JOIN eureka.location bl ON bl.id = b.location_id
         WHERE e.candidate_id = $1 AND ($2::bigint IS NULL OR e.id < $2::bigint)
           AND ($4::bigint IS NULL OR e.id >= $4::bigint) AND ${visible}
         ORDER BY e.id DESC LIMIT $3`, ep);
      const page = rows.slice(0, q.limit);
      return {
        items: page.map((e) => ({
          id: e.id,
          type: e.type,
          at: e.at.toISOString(),
          actor: owner && e.actor_id ? { id: e.actor_id, name: e.actor_name } : null,
          ref: e.ref_type ? {
            type: e.ref_type,
            id: e.ref_id,
            label: e.ref_type === "team" ? e.team_name
              : e.ref_type === "batch" && e.batch_month ? batchLabel(e.batch_technology ?? "", e.batch_location ?? "", e.batch_month, e.batch_name)
              : null,
          } : null,
          from: e.from_value,
          to: e.to_value,
        })),
        nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
      };
    });
  }
}
