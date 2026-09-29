import { Injectable } from "@nestjs/common";
import type pg from "pg";

const REDACT = new Set(["phone", "phone_e164", "dob", "dob_enc", "personal_email", "rate"]);

/** Append-only audit (design A6.4). Written in the same transaction as the change. */
@Injectable()
export class AuditService {
  async record(
    c: pg.PoolClient,
    e: { actorId: string; action: string; entityType: string; entityId?: string; changes?: Record<string, unknown> },
  ): Promise<void> {
    const changes = e.changes
      ? Object.fromEntries(Object.entries(e.changes).map(([k, v]) => [k, REDACT.has(k) ? "[redacted]" : v]))
      : null;
    await c.query(
      `INSERT INTO eureka.audit_event (actor_id, action, entity_type, entity_id, changes) VALUES ($1,$2,$3,$4,$5)`,
      [e.actorId, e.action, e.entityType, e.entityId ?? null, changes],
    );
  }
}
