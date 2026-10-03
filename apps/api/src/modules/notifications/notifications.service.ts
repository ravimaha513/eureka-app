import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { AuthedUser } from "../../platform/auth.guard.js";
import { DbService } from "../../platform/db.service.js";
import { decodeCursor, encodeCursor, type ListQuery, type ReadAll } from "./notifications.schemas.js";

/** Unread rows counted at most (the bell shows "99+" well before this). */
export const UNREAD_COUNT_CAP = 1000;

interface Row {
  id: string;
  type: string;
  title: string;
  body: string;
  entity_type: "placement" | "candidate";
  entity_id: string;
  created_at: Date;
  read_at: Date | null;
  /** created_at with microseconds, for the keyset cursor. */
  at: string;
}

const present = (r: Row) => ({
  id: r.id, type: r.type, title: r.title, body: r.body,
  entity: { type: r.entity_type, id: r.entity_id },
  createdAt: r.created_at.toISOString(), readAt: r.read_at?.toISOString() ?? null,
});

/**
 * In-app inbox (design A4 notifications, B2.5; migration 0046). Every query
 * names the caller as recipient and RLS (notification_own_read/_mark) enforces
 * the same independently: a user reads and marks only their own rows. Rows are
 * written only by the worker; the API changes nothing but the read mark, whose
 * time the database sets.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly db: DbService) {}

  async list(user: AuthedUser, q: ListQuery) {
    const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
    if (q.cursor !== undefined && !cursor) throw new UnprocessableEntityException("Invalid cursor");
    const rows = await this.db.withUser(user.id, async (c) => (await c.query<Row>(
      `SELECT id, type, title, body, entity_type, entity_id, created_at, read_at,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM eureka.notification
        WHERE recipient_id = $1
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          AND (NOT $4 OR read_at IS NULL)
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [user.id, cursor?.at ?? null, cursor?.id ?? null, q.unread === "true", q.limit + 1])).rows);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(present),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ at: last.at, id: last.id }) : null,
    };
  }

  async unreadCount(user: AuthedUser) {
    const n = await this.db.withUser(user.id, async (c) => (await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT 1 FROM eureka.notification WHERE recipient_id = $1 AND read_at IS NULL LIMIT ${UNREAD_COUNT_CAP}) x`,
      [user.id])).rows[0]!.n);
    return { unread: n, capped: n >= UNREAD_COUNT_CAP };
  }

  /** Marks one of the caller's notifications read (keeps the first read time) or unread. 404 when not theirs. */
  async mark(user: AuthedUser, id: string, read: boolean): Promise<void> {
    const r = await this.db.withUser(user.id, (c) => c.query(
      `UPDATE eureka.notification SET read_at = CASE WHEN $3 THEN now() END
        WHERE id = $1 AND recipient_id = $2`, [id, user.id, read]));
    if (r.rowCount !== 1) throw new NotFoundException();
  }

  async readAll(user: AuthedUser, body: ReadAll) {
    const r = await this.db.withUser(user.id, (c) => c.query(
      `UPDATE eureka.notification SET read_at = now()
        WHERE recipient_id = $1 AND read_at IS NULL
          AND ($2::timestamptz IS NULL OR date_trunc('milliseconds', created_at) <= $2::timestamptz)`,
      [user.id, body.before ?? null]));
    return { updated: r.rowCount ?? 0 };
  }
}
