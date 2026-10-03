import { deliverEvent } from "../src/worker/jobs/outbox.js";
import { silentLogger } from "../src/worker/log.js";
import type { TestDb } from "./db-harness.js";

/**
 * Writes an outbox event the way a module's SECURITY DEFINER function does
 * (as authz_definer; the outbox guard refuses every other writer). Returns its id.
 */
export async function emitEvent(
  db: TestDb, type: string, aggregateType: string, aggregateId: string, payload: Record<string, unknown>,
): Promise<string> {
  const c = await db.admin.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE authz_definer");
    const r = await c.query<{ id: string }>(
      `INSERT INTO eureka.outbox_event (type, aggregate_type, aggregate_id, payload) VALUES ($1, $2, $3, $4) RETURNING id`,
      [type, aggregateType, aggregateId, payload]);
    await c.query("COMMIT");
    return r.rows[0]!.id;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export const workerCtx = () => ({ log: silentLogger, signal: new AbortController().signal, heartbeat() {} });

/** Runs the inbox channel of an event as the worker (no mail transport). */
export function deliverInbox(db: TestDb, eventId: string) {
  return deliverEvent(db.worker, null, null, eventId, workerCtx(), { mode: "inbox" });
}

/** A random uuid (as the database makes them). */
export async function newId(db: TestDb): Promise<string> {
  return (await db.admin.query<{ id: string }>("SELECT gen_random_uuid() AS id")).rows[0]!.id;
}
