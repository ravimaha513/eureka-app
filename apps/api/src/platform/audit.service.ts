import { Injectable } from "@nestjs/common";
import type pg from "pg";

/**
 * Keys whose values never reach audit_event (rule 5: no phones, emails or
 * rates), in both API (camelCase) and column (snake_case) spelling.
 */
export const REDACT: ReadonlySet<string> = new Set([
  "phone", "phone_e164", "phoneE164", "vitelNumber", "vitel_number",
  "email", "personalEmail", "personal_email", "marketingEmail", "marketing_email",
  "dob", "dob_enc", "rate",
]);

/** The audit form of a change set: redacted keys keep their name, not their value. */
export function redactChanges(changes: Record<string, unknown> | undefined): Record<string, unknown> | null {
  return changes
    ? Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, REDACT.has(k) ? "[redacted]" : v]))
    : null;
}

/** Append-only audit (design A6.4). Written in the same transaction as the change. */
@Injectable()
export class AuditService {
  async record(
    c: pg.PoolClient,
    e: { actorId: string; action: string; entityType: string; entityId?: string; changes?: Record<string, unknown> },
  ): Promise<void> {
    await c.query(
      `INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes) VALUES ($1,$2,$3,$4,$5)`,
      [e.actorId, e.action, e.entityType, e.entityId ?? null, redactChanges(e.changes)],
    );
  }
}
