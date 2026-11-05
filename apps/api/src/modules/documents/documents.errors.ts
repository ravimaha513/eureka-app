import { HttpException, HttpStatus, Logger } from "@nestjs/common";

/**
 * Restricted files (candidate documents and restricted DataHub folders) open without step-up (owner decision on
 * security review B-01). Compensating controls: the per-user cap on restricted opens in any 24 hours, enforced in
 * authz.document_download / authz.datahub_download (migration 0474, policy_setting restricted_opens_per_day), the
 * 60-second presigned link, and the warnings below (ids and counts only) for alerting.
 */
export const RESTRICTED_OPENS_HIGH_WATER = 0.8;

const log = new Logger("RestrictedOpens");

/**
 * For `.catch()` on a download function call: `too_many_restricted_opens` becomes 429 and one structured warning
 * `restricted_open_cap_reached {"userId"}`; anything else is rethrown unchanged (for the module's own mapper).
 */
export const restrictedOpenError = (userId: string) => (err: unknown): never => {
  const e = err as { message?: string; code?: string };
  if (e.code !== undefined && e.message === "too_many_restricted_opens") {
    log.warn(`restricted_open_cap_reached ${JSON.stringify({ userId })}`);
    throw new HttpException("too_many_restricted_opens", HttpStatus.TOO_MANY_REQUESTS);
  }
  throw err;
};

/** Warns once, when this open is the one that reaches the high-water mark (80 % of the cap); ids and counts only. */
export function noteRestrictedOpen(userId: string, opens: number | null, cap: number | null) {
  if (opens === null || cap === null) return;
  if (opens === Math.ceil(cap * RESTRICTED_OPENS_HIGH_WATER)) {
    log.warn(`restricted_open_high_water ${JSON.stringify({ userId, opens, cap })}`);
  }
}
