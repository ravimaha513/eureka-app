import { HttpException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import type pg from "pg";
import {
  explainActivity,
  explainCandidate,
  type AccessPath,
  type CandidateRef,
  type CandidateVisibility,
  type Explanation,
  type ExplainKind,
  type UserAccess,
} from "@eureka/shared";
import { AccessService } from "../../platform/access.service.js";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { pgCodeOf } from "../../platform/errors.js";
import { apiLog, errorFields } from "../../platform/logger.js";
import type { AccessExplainQuery } from "./admin.schemas.js";
import { AdminTx } from "./admin-tx.js";

interface RecordFacts {
  candidate_id: string;
  actor_recruiter_id: string | null;
  actor_team_id: string | null;
  actor_location_id: string | null;
  recruiter_id: string | null;
  team_id: string | null;
  location_id: string | null;
  visibility: CandidateVisibility;
  marketing_status: string;
}

/** Fixed table per kind for the RLS probe; never built from input. */
const TABLE: Record<ExplainKind, string> = {
  candidate: "eureka.candidate",
  submission: "eureka.submission",
  interview: "eureka.interview",
  placement: "eureka.placement",
};

/**
 * AD-16: why can (or can't) a user see a record. Three steps:
 *  1. As the admin: the record's ownership facts through authz.admin_explain_record (ids only;
 *     admins cannot read these tables) and the target user's existence.
 *  2. As the target user, in a READ ONLY transaction: their access facts (AccessService.load, the
 *     reference loader) and one RLS probe, `EXISTS (SELECT 1 FROM <table> WHERE id = $1)`. Only the
 *     boolean leaves the transaction; no row is read into the API.
 *  3. The engine's explanation (packages/shared explain.ts), checked against the probe: a
 *     disagreement means the API and the database decide differently (a bug either way).
 * Audited as admin.access.explained with ids and verdicts only (rule 5).
 */
@Injectable()
export class AccessExplainService {
  constructor(private readonly tx: AdminTx, private readonly db: DbService, private readonly access: AccessService) {}

  async explain(user: AuthedUser, q: AccessExplainQuery) {
    // Three transactions in sequence, never two connections at once (a nested probe could
    // exhaust the pool under parallel calls). The admin check runs first and gates the probe.
    const { target, facts } = await this.tx.run(user, async (c) => {
      const t = (await c.query<{ id: string; display_name: string; status: string }>(
        `SELECT id, display_name, status FROM eureka.app_user WHERE id = $1 AND deleted_at IS NULL`, [q.userId])).rows[0];
      const f = (await c.query<RecordFacts>(`SELECT * FROM authz.admin_explain_record($1, $2)`, [q.kind, q.id])).rows[0]!;
      if (!t) throw new NotFoundException("user_not_found");
      return { target: t, facts: f };
    });

    const { access, rlsVisible } = await this.probe(q);

    const candidate: CandidateRef = {
      id: facts.candidate_id, recruiterId: facts.recruiter_id, teamId: facts.team_id, locationId: facts.location_id,
      visibility: facts.visibility, marketingStatus: facts.marketing_status,
    };
    const e: Explanation = q.kind === "candidate"
      ? explainCandidate(access, candidate)
      : explainActivity(access, q.kind, {
        recruiterId: facts.actor_recruiter_id!, teamId: facts.actor_team_id, locationId: facts.actor_location_id, candidate,
      });

    return this.tx.run(user, async (c) => {
      await this.tx.audit.record(c, {
        actorId: user.id, action: "admin.access.explained", entityType: q.kind, entityId: q.id,
        changes: { userId: q.userId, allowed: e.allowed, rlsAllowed: rlsVisible },
      });
      const names = await nameLookup(c, e, facts, access);
      const record = {
        kind: q.kind,
        id: q.id,
        candidateId: facts.candidate_id,
        ...(q.kind === "candidate" ? {} : {
          actor: { recruiter: names.user(facts.actor_recruiter_id), team: names.team(facts.actor_team_id), location: names.location(facts.actor_location_id) },
        }),
        owner: { recruiter: names.user(facts.recruiter_id), team: names.team(facts.team_id), location: names.location(facts.location_id) },
        visibility: facts.visibility,
        marketingStatus: facts.marketing_status,
      };
      return {
        user: { id: target.id, displayName: target.display_name, status: target.status },
        record,
        permission: e.permission,
        allowed: e.allowed,
        rls: { allowed: rlsVisible, agrees: rlsVisible === e.allowed },
        ...(e.phone ? { phone: e.phone } : {}),
        roles: e.roles.map((r) => ({
          role: r.role,
          label: r.label ?? r.role,
          location: names.location(r.locationId ?? null),
          scope: r.scope,
          paths: r.paths.map((p) => describePath(p, names)),
          ...(r.miss ? { miss: r.miss } : {}),
        })),
        facts: {
          teams: access.teamIds.map((id) => names.team(id)),
          subtreeTeams: access.subtreeTeamIds.map((id) => names.team(id)),
          coachedTeams: access.subtreeCoachedTeamIds.map((id) => names.team(id)),
          reports: access.subordinateUserIds.length,
        },
      };
    });
  }

  /**
   * As the target user, READ ONLY: their access facts and one RLS probe. Only a boolean leaves.
   * Errors here are not the admin's: logged with its pg code, then a 500, never mapped to 403/404.
   */
  private async probe(q: AccessExplainQuery): Promise<{ access: UserAccess; rlsVisible: boolean }> {
    try {
      return await this.db.withUser(q.userId, async (t) => {
        await t.query("SET LOCAL transaction_read_only = on");
        const loaded = await this.access.load(t, q.userId);
        const { rows: [r] } = await t.query<{ v: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM ${TABLE[q.kind]} WHERE id = $1) AS v`, [q.id]);
        return { access: loaded, rlsVisible: r!.v };
      });
    } catch (err) {
      if (err instanceof HttpException) throw err; // e.g. 503 database_busy from the pool
      apiLog.error("access explain probe failed", { pgCode: pgCodeOf(err), ...errorFields(err) });
      throw new InternalServerErrorException("access_probe_failed", { cause: err });
    }
  }
}

type Ref = { id: string; name: string } | null;
interface Names { user(id: string | null): Ref; team(id: string | null): Ref; location(id: string | null): Ref }

function describePath(p: AccessPath, n: Names) {
  switch (p.via) {
    case "report": return { via: p.via, on: p.on, user: n.user(p.userId) };
    case "team": return { via: p.via, on: p.on, team: n.team(p.teamId) };
    case "location": return { via: p.via, on: p.on, location: n.location(p.locationId) };
    default: return p;
  }
}

/** Names for every id the answer shows (users, teams, locations are org data admins read; not candidate data). */
async function nameLookup(c: pg.PoolClient, e: Explanation, f: RecordFacts, a: UserAccess): Promise<Names> {
  const users = new Set<string>(), teams = new Set<string>(), locs = new Set<string>();
  const add = (s: Set<string>, v: string | null | undefined) => { if (v) s.add(v); };
  add(users, f.actor_recruiter_id); add(users, f.recruiter_id);
  add(teams, f.actor_team_id); add(teams, f.team_id);
  add(locs, f.actor_location_id); add(locs, f.location_id);
  a.roles.forEach((r) => add(locs, r.locationId));
  [...a.teamIds, ...a.subtreeTeamIds, ...a.subtreeCoachedTeamIds].forEach((t) => add(teams, t));
  for (const r of e.roles) for (const p of r.paths) {
    if (p.via === "report") add(users, p.userId);
    if (p.via === "team") add(teams, p.teamId);
    if (p.via === "location") add(locs, p.locationId);
  }
  const { rows } = await c.query<{ k: string; id: string; name: string }>(
    `SELECT 'u' AS k, id::text, display_name AS name FROM eureka.app_user WHERE id = ANY($1::uuid[])
     UNION ALL SELECT 't', id::text, name FROM eureka.team WHERE id = ANY($2::uuid[])
     UNION ALL SELECT 'l', id::text, name FROM eureka.location WHERE id = ANY($3::uuid[])`,
    [[...users], [...teams], [...locs]]);
  const m = new Map(rows.map((r) => [`${r.k}:${r.id}`, r.name]));
  const ref = (k: string) => (id: string | null): Ref => (id ? { id, name: m.get(`${k}:${id}`) ?? id } : null);
  return { user: ref("u"), team: ref("t"), location: ref("l") };
}
