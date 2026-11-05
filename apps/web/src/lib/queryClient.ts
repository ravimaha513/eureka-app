import type { QueryClient } from "@tanstack/react-query";
import { ApiError, STALE_EVENT } from "../api";

/**
 * Queries retry once on a network or server error; a 4xx answer (no access, not found, invalid) is final.
 * A 503 with Retry-After is not retried here: apiFetch already waited it out and tried once more for a GET
 * (or the wait was too long to be worth it), so a second retry would only add load to a busy server.
 */
export function queryRetry(failures: number, e: unknown): boolean {
  if (failures >= 1) return false;
  if (!(e instanceof ApiError)) return true;
  if (e.status >= 400 && e.status < 500) return false;
  return !(e.retried || (e.status === 503 && e.retryAfter !== undefined));
}

/**
 * After a 412 `stale` (an If-Match edit lost to another save) the screens on view refetch, so the
 * record the user is told to reload is already the latest. Returns the unsubscribe function.
 */
export function refetchOnStale(client: QueryClient): () => void {
  const onStale = () => { void client.invalidateQueries(); };
  window.addEventListener(STALE_EVENT, onStale);
  return () => window.removeEventListener(STALE_EVENT, onStale);
}
