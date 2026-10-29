import type { JobDefinition } from "../runner.js";
import { dueMaintenanceKeys, type DailySchedule } from "../schedule.js";

/**
 * Users & Access (migration 0280): deletes users deactivated at least
 * USER_PURGE_DAYS ago by anonymizing them (authz.purge_inactive_users), one
 * audit row per user, ids only. Admins can delete sooner (authz.admin_delete_user).
 * The database deletes at most 200 per call, so the job loops.
 */
export const USER_PURGE_JOB = "user-purge-inactive";
export const USER_PURGE_DAYS = 7;
export const USER_PURGE_SCHEDULE: DailySchedule = { hh: 5, mm: 0, timeZone: "America/New_York" };
const MAX_ROUNDS = 50;

export function userPurgeJob(days = USER_PURGE_DAYS, schedule: DailySchedule = USER_PURGE_SCHEDULE): JobDefinition {
  if (!Number.isInteger(days) || days < 7 || days > 365) throw new Error("user purge days must be 7 to 365");
  return {
    name: USER_PURGE_JOB,
    dueKeys: (now) => dueMaintenanceKeys(now, schedule),
    async run(_key, ctx) {
      let deleted = 0;
      for (let i = 0; i < MAX_ROUNDS; i++) {
        ctx.signal.throwIfAborted();
        const c = await ctx.pool.connect();
        let n: number;
        try {
          await c.query("BEGIN");
          const ids = (await c.query<{ ids: string[] }>("SELECT authz.purge_inactive_users($1) AS ids", [days])).rows[0]!.ids;
          if (ids.length) {
            await c.query(
              `INSERT INTO eureka.audit_event (action, entity_type, entity_id)
               SELECT 'system.user.purged', 'app_user', x FROM unnest($1::uuid[]) x`, [ids]);
          }
          await c.query("COMMIT");
          n = ids.length;
        } catch (err) {
          await c.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          c.release();
        }
        deleted += n;
        ctx.heartbeat?.();
        if (n < 200) break;
      }
      return { deleted, days };
    },
  };
}
