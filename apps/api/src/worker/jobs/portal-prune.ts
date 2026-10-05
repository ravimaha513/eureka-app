import type { JobDefinition } from "../runner.js";
import { dueMaintenanceKeys, type DailySchedule } from "../schedule.js";

/**
 * jobs-portal (migration 0061): deletes applicants who never confirmed their
 * mailbox (no verified email, no application, no open sign-in link) after
 * `days` days, with their links and sessions. Abuse sign-ups would otherwise
 * stay forever. The database refuses fewer than 30 days and deletes at most
 * 1000 rows per call, so the job loops; only counts reach the job log.
 */
export const PORTAL_PRUNE_JOB = "portal-prune-unverified";
export const PORTAL_PRUNE_SCHEDULE: DailySchedule = { hh: 4, mm: 45, timeZone: "America/New_York" };
const MAX_ROUNDS = 50;

export function portalPruneJob(days = 30, schedule: DailySchedule = PORTAL_PRUNE_SCHEDULE): JobDefinition {
  if (!Number.isInteger(days) || days < 30 || days > 365) throw new Error("portal prune days must be 30 to 365");
  return {
    name: PORTAL_PRUNE_JOB,
    dueKeys: (now) => dueMaintenanceKeys(now, schedule),
    async run(_key, ctx) {
      let deleted = 0;
      for (let i = 0; i < MAX_ROUNDS; i++) {
        ctx.signal.throwIfAborted();
        const r = await ctx.pool.query<{ n: number }>("SELECT authz.portal_prune_unverified($1) AS n", [days]);
        const n = r.rows[0]!.n;
        deleted += n;
        ctx.heartbeat?.();
        if (n < 1000) break;
      }
      return { deleted, days };
    },
  };
}
