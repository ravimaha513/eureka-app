import { Body, Controller, Get, Injectable, NotFoundException, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { activityVisible, candidateVisible, resolveScope } from "@eureka/shared";
import { AuditService } from "../../platform/audit.service.js";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { scopePredicate } from "../candidates/candidates.service.js";

const CreateSubmission = z
  .object({
    candidateId: z.string().uuid(),
    jobTitle: z.string().min(1).max(160),
    clientId: z.string().uuid(),
    vendorId: z.string().uuid().optional(),
    rate: z.number().positive().max(1000).optional(),
  })
  .strict(); // recruiter, team and location snapshots are set by the database

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();

@Injectable()
export class SubmissionsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async create(user: AuthedUser, body: z.infer<typeof CreateSubmission>) {
    const scope = resolveScope(user.access, "submission:create");
    return this.db.withUser(user.id, async (c) => {
      // Read-before-write: the candidate must be visible for submission:create.
      const { rows } = await c.query(
        `SELECT recruiter_id, team_id, location_id, visibility, marketing_status FROM eureka.candidate WHERE id = $1`,
        [body.candidateId]);
      const r = rows[0];
      if (!r || !candidateVisible(scope, {
        recruiterId: r.recruiter_id, teamId: r.team_id, locationId: r.location_id,
        visibility: r.visibility, marketingStatus: r.marketing_status,
      })) throw new NotFoundException();

      const dup = await c.query<{ d: boolean }>(`SELECT authz.recent_submission_exists($1,$2) AS d`, [body.candidateId, body.clientId]);
      const ins = await c.query<{ id: string; team_id: string }>(
        `INSERT INTO eureka.submission (candidate_id, job_title, client_id, vendor_id, rate)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, team_id`,
        [body.candidateId, body.jobTitle, body.clientId, body.vendorId ?? null, body.rate ?? null]);
      await this.audit.record(c, { actorId: user.id, action: "submission.created", entityType: "submission", entityId: ins.rows[0]!.id });
      return { id: ins.rows[0]!.id, duplicateWarning: dup.rows[0]!.d };
    });
  }

  async list(user: AuthedUser, limit: number) {
    const scope = resolveScope(user.access, "submission:read");
    if (!scope) return { items: [] };
    const params: unknown[] = [];
    // Actor-based OR owner-based visibility (design B4.4); the owner branch uses the candidate row.
    const actor = scopePredicate({ ...scope, allTeams: false }, params, "s");
    const owner = scopePredicate({ ...scope, allTeams: false }, params, "c");
    params.push(limit);
    const rows = await this.db.withUser(user.id, async (c) => (await c.query(
      `SELECT s.id, s.candidate_id, s.recruiter_id, s.team_id, s.location_id, s.job_title, s.status, s.submitted_at,
              c.recruiter_id AS c_recruiter, c.team_id AS c_team, c.location_id AS c_location,
              c.visibility, c.marketing_status, cl.name AS client
       FROM eureka.submission s
       LEFT JOIN eureka.candidate c ON c.id = s.candidate_id
       JOIN eureka.client cl ON cl.id = s.client_id
       WHERE ${actor} OR ${owner}
       ORDER BY s.submitted_at DESC LIMIT $${params.length}`, params)).rows);
    // Defense in depth: re-check each row with the engine before returning it.
    const items = rows.filter((r) => activityVisible(scope, {
      recruiterId: r.recruiter_id, teamId: r.team_id, locationId: r.location_id,
      candidate: { recruiterId: r.c_recruiter, teamId: r.c_team, locationId: r.c_location, visibility: r.visibility, marketingStatus: r.marketing_status },
    }));
    return {
      items: items.map((r) => ({
        id: r.id, candidateId: r.candidate_id, recruiterId: r.recruiter_id, teamId: r.team_id,
        jobTitle: r.job_title, client: r.client, status: r.status, submittedAt: r.submitted_at,
      })),
    };
  }
}

@Controller("api/v1/submissions")
export class SubmissionsController {
  constructor(private readonly svc: SubmissionsService) {}

  @Post()
  @RequirePermission("submission:create")
  create(@CurrentUser() user: AuthedUser, @Body() body: unknown) {
    return this.svc.create(user, CreateSubmission.parse(body));
  }

  @Get()
  @RequirePermission("submission:read")
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.list(user, ListQuery.parse(q).limit);
  }
}
