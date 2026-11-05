/** A fetch that got no response at all (offline, DNS, server down): fetch() rejects with a TypeError. */
export const CONNECTION_MESSAGE = "Can't reach the server. Check your connection and try again.";
export const GENERIC_ERROR_MESSAGE = "Something went wrong. Try again.";
/** 412 `stale`: an If-Match edit lost to someone else's save; the screen refetches (api.ts STALE_EVENT). */
export const STALE_MESSAGE = "This record changed since you opened it — reload to see the latest version, then try again.";
/** 503 (database busy, report queue full): the server asked the client to come back shortly. */
export const BUSY_MESSAGE = "The server is busy right now. Wait a few seconds and try again.";
export const RATE_LIMIT_MESSAGE = "Too many requests. Try again in a minute.";

/** 429 `detail` codes (the API's other 429s send a sentence, shown as is). */
const LIMIT_CODES: Record<string, string> = {
  too_many_restricted_opens: "You've reached the daily limit for opening restricted documents. It resets within 24 hours.",
  bulk_budget_exceeded: "You've used today's allowance for bulk-adding candidates. Try again tomorrow.",
  too_many_reveals: "Too many reveals. Wait a few minutes and try again.",
  too_many_step_ups: "Too many attempts. Wait a few minutes and try again.",
  too_many_attempts: "Too many attempts. Wait a few minutes and try again.",
  account_locked: "This account is locked for a while after too many attempts. Try again later.",
  rate_limited: "You're going too fast. Wait a minute and try again.",
};

/**
 * Readable text for a 429's `detail`: a known code, or the server's own sentence
 * ("Too many exports; try again in a few minutes" → "Too many exports. Try again in a few minutes.").
 */
export function limitText(detail?: string): string {
  return (detail && LIMIT_CODES[detail]) || serverSentence(detail, RATE_LIMIT_MESSAGE);
}

/** A problem `detail` written as a sentence, tidied for display; a bare code (no spaces) or none gives `fallback`. */
export function serverSentence(detail: string | undefined, fallback: string): string {
  if (!detail || !/\s/.test(detail)) return fallback;
  const s = detail.replace(/;\s*(\w)/g, (_, c: string) => `. ${c.toUpperCase()}`);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}
