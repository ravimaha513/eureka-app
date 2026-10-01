/**
 * Commit (design B9 step 4): loads the clean rows of a batch into the live
 * tables. Every live write runs as eureka_app with eureka.user_id set to the
 * sheet row's owner, through the same RLS policies, BEFORE INSERT guards and
 * definer functions the API uses (authz.transition_candidate,
 * authz.transition_submission, authz.create_placement,
 * authz.transition_placement), and writes the same audit events. Nothing
 * here is a definer function or bypasses a guard.
 *
 * One person (a sales row plus its interviews and placements) loads in one
 * transaction: all or nothing. Without --commit the same work runs and is
 * rolled back, so the dry run exercises every real check. A real commit needs
 * the batch approved; the ledger written in the same transaction refuses
 * anything else.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { CandidateStatus } from "@eureka/shared";
import { identityHashes, sha256, type InterviewNorm, type PlacementNorm, type SalesNorm } from "./analyze.js";
import { parseMapping, type Sheet } from "./mapping.js";
import { nameKey } from "./normalize.js";

const SUBMISSION_PATH = ["submitted", "under_review", "interview_requested", "interview_scheduled", "interview_completed", "selected"];
const PLACEMENT_PATH = ["confirmed", "paperwork", "bgc", "ready", "joined"];
const MANUAL_FROM_ACTIVE = new Set<CandidateStatus>(["on_hold", "stopped", "full_of_interviews", "terminated"]);

interface Row {
  id: string; sheet: Sheet; row_no: number; row_key: string; person_key: string;
  norm: SalesNorm | InterviewNorm | PlacementNorm;
}

export interface CommitResult {
  batchId: string;
  dryRun: boolean;
  loaded: { candidates: number; submissions: number; interviews: number; placements: number };
  /** Each failed person: its rows ("sales 3", "interviews 7") and the database error. */
  failures: { rows: string[]; error: string }[];
  remainingClean: number;
}

class ImportError extends Error {}

function errorText(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return `${e.code ? `${e.code} ` : ""}${e.message ?? String(err)}`.replace(/\s+/g, " ").slice(0, 200);
}

export async function commitBatch(pool: pg.Pool, batchId: string, opts: { dryRun: boolean }): Promise<CommitResult> {
  const b = (await pool.query<{ status: string; files: { mapping: unknown }; purged_at: string | null }>(
    `SELECT status, files, purged_at FROM eureka.import_batch WHERE id = $1`, [batchId])).rows[0];
  if (!b) throw new Error(`No import batch ${batchId}`);
  if (b.purged_at) throw new Error("Batch data was purged");
  if (!opts.dryRun && b.status !== "approved") {
    throw new Error(`Batch is ${b.status}: it must be approved (sign-off by an org admin who did not stage it) before --commit`);
  }
  const cfg = parseMapping(b.files.mapping);
  const rows = (await pool.query<Row>(
    `SELECT id, sheet, row_no, row_key, person_key, norm FROM eureka.import_row
     WHERE batch_id = $1 AND state = 'clean' ORDER BY row_no`, [batchId])).rows;

  // People: each clean sales row, and earlier-imported people with new activity.
  const clusters = new Map<string, { sales?: Row; deps: Row[] }>();
  for (const r of rows) {
    const key = r.sheet === "sales" ? r.row_key : r.person_key;
    const cl = clusters.get(key) ?? { deps: [] };
    if (r.sheet === "sales") cl.sales = r; else cl.deps.push(r);
    clusters.set(key, cl);
  }

  const result: CommitResult = {
    batchId, dryRun: opts.dryRun, loaded: { candidates: 0, submissions: 0, interviews: 0, placements: 0 }, failures: [], remainingClean: 0,
  };
  for (const [key, cl] of clusters) {
    if (!cl.sales && !key.startsWith("ledger:")) continue; // cannot happen: resolveBatch holds these
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL statement_timeout = '60s'");
      const counts = await loadPerson(c, batchId, key, cl, cfg.placements.defaultBackoutReason, opts.dryRun);
      await c.query(opts.dryRun ? "ROLLBACK" : "COMMIT");
      for (const k of Object.keys(counts) as (keyof typeof counts)[]) result.loaded[k] += counts[k];
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      const all = [...(cl.sales ? [cl.sales] : []), ...cl.deps];
      const error = errorText(err);
      result.failures.push({ rows: all.map((r) => `${r.sheet} ${r.row_no}`), error });
      if (!opts.dryRun) {
        await pool.query(`UPDATE eureka.import_row SET commit_error = $2 WHERE id = ANY($1::uuid[]) AND state = 'clean'`,
          [all.map((r) => r.id), error]);
      }
    } finally {
      c.release();
    }
  }
  result.remainingClean = (await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM eureka.import_row WHERE batch_id = $1 AND state = 'clean'`, [batchId])).rows[0]!.n;
  if (!opts.dryRun && result.remainingClean === 0) {
    await pool.query(`UPDATE eureka.import_batch SET status = 'committed' WHERE id = $1 AND status = 'approved'`, [batchId]);
  }
  return result;
}

async function loadPerson(
  c: pg.PoolClient, batchId: string, key: string, cl: { sales?: Row; deps: Row[] }, backoutReason: string, dryRun: boolean,
) {
  const counts = { candidates: 0, submissions: 0, interviews: 0, placements: 0 };
  const links: { sheet: string; rowKey: string; type: string; id: string; owner: string; rowId?: string }[] = [];
  const identities: string[] = [];

  // Read import-side facts before acting as anyone.
  let candidateId: string | null = null;
  let owner: string;
  if (cl.sales) {
    owner = (cl.sales.norm as SalesNorm).ownerId!;
  } else {
    candidateId = key.slice("ledger:".length);
    const l = (await c.query<{ owner_id: string }>(
      `SELECT owner_id FROM eureka.import_identity WHERE candidate_id = $1 ORDER BY created_at LIMIT 1`, [candidateId])).rows[0];
    if (!l) throw new ImportError("ledger_candidate_missing");
    owner = l.owner_id;
  }
  const knownSubmissions = new Map((await c.query<{ row_key: string; entity_id: string; owner_id: string }>(
    `SELECT row_key, entity_id, owner_id FROM eureka.import_link WHERE sheet = 'submission'`)).rows
    .map((r) => [r.row_key, { id: r.entity_id, owner: r.owner_id }]));

  await c.query("SET LOCAL ROLE eureka_app");
  const act = (userId: string) => c.query(`SELECT set_config('eureka.user_id', $1, true)`, [userId]);
  let actor = owner;
  const as = async (userId: string) => { actor = userId; await act(userId); };
  const audit = (action: string, entityType: string, entityId: string, changes: Record<string, unknown>) =>
    c.query(`INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes) VALUES ($1,$2,$3,$4,$5)`,
      [actor, action, entityType, entityId, { ...changes, source: "import", batchId }]);
  const candidateStatus = async () => {
    const r = await c.query<{ s: string }>(`SELECT marketing_status AS s FROM eureka.candidate WHERE id = $1`, [candidateId]);
    if (!r.rows[0]) throw new ImportError("candidate_not_visible_to_owner");
    return r.rows[0].s;
  };
  const transitionCandidate = async (to: string) => {
    const from = await candidateStatus();
    await c.query(`SELECT authz.transition_candidate($1, $2)`, [candidateId, to]);
    await audit("candidate.transition", "candidate", candidateId!, { from, to });
  };
  await as(owner);

  // ---------- candidate (CandidatesService.create, then the profile, status and visibility endpoints) ----------
  const s = cl.sales?.norm as SalesNorm | undefined;
  if (cl.sales && s) {
    const team = (await c.query<{ t: string | null }>(`SELECT authz.actor_team() AS t`)).rows[0]?.t;
    if (!team) throw new ImportError("owner_has_no_team");
    const isRecruiter = (await c.query<{ r: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM eureka.user_role WHERE user_id = $1 AND role_key = 'recruiter' AND valid @> now()) AS r`,
      [owner])).rows[0]!.r;
    const personId = randomUUID();
    await c.query(`INSERT INTO eureka.person (id, first_name, last_name, phone_e164, personal_email) VALUES ($1,$2,$3,$4,$5)`,
      [personId, s.firstName, s.lastName, s.phone, s.personalEmail]);
    candidateId = (await c.query<{ id: string }>(
      `INSERT INTO eureka.candidate (person_id, technology_id, team_id, recruiter_id, location_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [personId, s.technologyId, team, isRecruiter ? owner : null, s.locationId])).rows[0]!.id;
    await audit("candidate.created", "candidate", candidateId, {});
    counts.candidates++;
    const profile: Record<string, unknown> = {};
    if (s.priority) profile.priority = s.priority;
    if (s.marketingEmail) profile.marketing_email = s.marketingEmail;
    if (s.marketingStartDate) profile.marketing_start_date = s.marketingStartDate;
    const cols = Object.keys(profile);
    if (cols.length) {
      await c.query(`UPDATE eureka.candidate SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`,
        [candidateId, ...cols.map((k) => profile[k])]);
      await audit("candidate.updated", "candidate", candidateId, { fields: cols.map((k) => (k === "marketing_email" ? "marketingEmail" : k)) });
    }
    if (s.status !== "in_training") await transitionCandidate("active");
    if (s.visibility === "all_teams") {
      // A lead (or above) changes visibility; recruiters cannot (catalog).
      const lead = (await c.query<{ lead_id: string }>(`SELECT lead_id FROM eureka.team WHERE id = $1`, [team])).rows[0]?.lead_id;
      if (!lead) throw new ImportError("team_has_no_lead");
      await as(lead);
      const u = await c.query(`UPDATE eureka.candidate SET visibility = 'all_teams' WHERE id = $1`, [candidateId]);
      if (u.rowCount !== 1) throw new ImportError("visibility_not_permitted");
      await audit("candidate.visibility", "candidate", candidateId, { visibility: "all_teams" });
      await as(owner);
    }
    links.push({ sheet: "sales", rowKey: cl.sales.row_key, type: "candidate", id: candidateId, owner, rowId: cl.sales.id });
    identities.push(...identityHashes({
      emails: [s.marketingEmail, s.personalEmail].filter((e): e is string => !!e),
      phone: s.phone, nameKey: s.firstName && s.lastName ? nameKey(s.firstName, s.lastName) : null, dob: s.dob,
    }).strong);
  }

  // ---------- submissions, interviews, placements ----------
  const groups = new Map<string, Row[]>();
  for (const d of cl.deps) {
    const n = d.norm as InterviewNorm | PlacementNorm;
    const g = sha256(`${candidateId}|${n.clientId}|${(n.jobTitle ?? "").toLowerCase()}`);
    groups.set(g, [...(groups.get(g) ?? []), d]);
  }
  for (const [subKey, deps] of groups) {
    const first = deps[0]!.norm as InterviewNorm | PlacementNorm;
    // An earlier-imported submission keeps acting as its submitter (snapshots and RLS follow the submission).
    const known = knownSubmissions.get(subKey);
    const subOwner = known?.owner ?? first.ownerId ?? owner;
    await as(subOwner);
    let subId = known?.id ?? null;
    if (!subId) {
      subId = (await c.query<{ id: string }>(
        `INSERT INTO eureka.submission (candidate_id, job_title, client_id, vendor_id) VALUES ($1,$2,$3,$4) RETURNING id`,
        [candidateId, first.jobTitle, first.clientId, first.vendorId])).rows[0]!.id;
      await audit("submission.created", "submission", subId, { candidateId, clientId: first.clientId });
      counts.submissions++;
      links.push({ sheet: "submission", rowKey: subKey, type: "submission", id: subId, owner: subOwner });
    }
    const walkSubmission = async (target: string) => {
      const cur = (await c.query<{ status: string }>(`SELECT status FROM eureka.submission WHERE id = $1`, [subId])).rows[0];
      if (!cur) throw new ImportError("submission_not_visible_to_owner");
      let i = SUBMISSION_PATH.indexOf(cur.status);
      const t = SUBMISSION_PATH.indexOf(target);
      if (i < 0) throw new ImportError(`submission_closed (${cur.status})`);
      for (; i < t; i++) {
        await c.query(`SELECT authz.transition_submission($1, $2, NULL)`, [subId, SUBMISSION_PATH[i + 1]]);
        await audit("submission.status", "submission", subId!, { from: SUBMISSION_PATH[i], to: SUBMISSION_PATH[i + 1] });
      }
    };
    const interviews = deps.filter((d) => d.sheet === "interviews")
      .sort((a, b) => ((a.norm as InterviewNorm).startLocal! < (b.norm as InterviewNorm).startLocal! ? -1 : 1));
    const placements = deps.filter((d) => d.sheet === "placements")
      // A backed-out placement frees the submission and the candidate for the next one.
      .sort((a, b) => Number((b.norm as PlacementNorm).status === "backout") - Number((a.norm as PlacementNorm).status === "backout") || a.row_no - b.row_no);

    if (interviews.length) await walkSubmission("interview_scheduled");
    for (const r of interviews) {
      const n = r.norm as InterviewNorm;
      const ins = (await c.query<{ id: string; starts_at: Date; ends_at: Date }>(
        `INSERT INTO eureka.interview (submission_id, round, starts_at, ends_at)
         VALUES ($1, $2, ($3::timestamp AT TIME ZONE $4), ($3::timestamp AT TIME ZONE $4) + make_interval(mins => $5))
         RETURNING id, starts_at, ends_at`,
        [subId, n.round, n.startLocal, n.timeZone, n.minutes])).rows[0]!;
      await audit("interview.created", "interview", ins.id, {
        submissionId: subId, round: n.round, startsAt: ins.starts_at.toISOString(), endsAt: ins.ends_at.toISOString(),
      });
      if (n.callStatus && n.callStatus !== "scheduled") {
        await c.query(`UPDATE eureka.interview SET call_status = $2 WHERE id = $1`, [ins.id, n.callStatus]);
        await audit("interview.updated", "interview", ins.id, { callStatus: "set" });
      }
      counts.interviews++;
      links.push({ sheet: "interviews", rowKey: r.row_key, type: "interview", id: ins.id, owner: subOwner, rowId: r.id });
    }
    if (placements.length) await walkSubmission("selected");
    else if (interviews.some((r) => (r.norm as InterviewNorm).callStatus === "completed")) await walkSubmission("interview_completed");

    for (const r of placements) {
      const n = r.norm as PlacementNorm;
      const p = (await c.query<{ placement_id: string; is_first_placement: boolean; candidate_from: string | null; candidate_to: string | null }>(
        `SELECT * FROM authz.create_placement($1,$2,$3,$4,$5,$6,$7::date,$8,NULL)`,
        [subId, n.placementType, n.rate, n.workMode, n.projectCity, n.projectState, n.tentativeStart, n.partnerId])).rows[0]!;
      await audit("placement.created", "placement", p.placement_id, {
        submissionId: subId, candidateId, placementType: n.placementType, workMode: n.workMode,
        tentativeStart: n.tentativeStart, isFirstPlacement: p.is_first_placement, contactCount: 0,
      });
      if (p.candidate_to) await audit("candidate.transition", "candidate", candidateId!, { from: p.candidate_from, to: p.candidate_to, via: "placement" });
      const steps = n.status === "backout" ? ["backout"]
        : PLACEMENT_PATH.slice(1, PLACEMENT_PATH.indexOf(n.status ?? "confirmed") + 1);
      for (const to of steps) {
        const reason = to === "backout" ? (n.statusReason ?? backoutReason) : null;
        const t = (await c.query<{ from_status: string; to_status: string; candidate_from: string | null; candidate_to: string | null }>(
          `SELECT * FROM authz.transition_placement($1, $2, $3)`, [p.placement_id, to, reason])).rows[0]!;
        await audit("placement.status", "placement", p.placement_id, { from: t.from_status, to: t.to_status, ...(reason ? { reasonGiven: true } : {}) });
        if (t.candidate_to) await audit("candidate.transition", "candidate", candidateId!, { from: t.candidate_from, to: t.candidate_to, via: "placement" });
      }
      counts.placements++;
      links.push({ sheet: "placements", rowKey: r.row_key, type: "placement", id: p.placement_id, owner: subOwner, rowId: r.id });
    }
  }

  // ---------- final candidate status from the sales sheet ----------
  if (s?.status) {
    await as(owner);
    const cur = await candidateStatus();
    if (cur !== s.status) {
      if (cur === "active" && MANUAL_FROM_ACTIVE.has(s.status)) await transitionCandidate(s.status);
      else throw new ImportError(`status_unreachable (${cur} -> ${s.status})`);
    }
  }

  await c.query("RESET ROLE");
  if (!dryRun) {
    for (const l of links) {
      await c.query(`INSERT INTO eureka.import_link (sheet, row_key, entity_type, entity_id, owner_id, batch_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [l.sheet, l.rowKey, l.type, l.id, l.owner, batchId]);
      if (l.rowId) {
        await c.query(`UPDATE eureka.import_row SET state = 'committed', committed_entity = $2, commit_error = NULL WHERE id = $1`, [l.rowId, l.id]);
      }
    }
    for (const h of new Set(identities)) {
      await c.query(`INSERT INTO eureka.import_identity (identity_hash, candidate_id, owner_id, batch_id) VALUES ($1,$2,$3,$4)
                     ON CONFLICT (identity_hash) DO NOTHING`, [h, candidateId, owner, batchId]);
    }
  }
  return counts;
}
