import { z } from "zod";

export const PAGE_MAX = 50;

/** GET /notifications query. The cursor is opaque to the client (base64url of created_at and id). */
export const ListQuery = z
  .object({
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(20),
    unread: z.enum(["true", "false"]).optional(),
  })
  .strict();
export type ListQuery = z.infer<typeof ListQuery>;

/**
 * POST /notifications/read-all. `before`: only rows created at or before this
 * instant (the newest one the user has seen), so a notification arriving
 * while the panel is open is not marked read unseen. Omitted: all.
 */
export const ReadAll = z.object({ before: z.string().datetime({ offset: true }).optional() }).strict();
export type ReadAll = z.infer<typeof ReadAll>;

export interface Cursor { at: string; id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify([c.at, c.id])).toString("base64url");

/** Null when the cursor is malformed (the caller answers 422). */
export function decodeCursor(s: string): Cursor | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== 2) return null;
    const [at, id] = v as unknown[];
    if (typeof at !== "string" || typeof id !== "string" || !UUID.test(id) || Number.isNaN(Date.parse(at))) return null;
    return { at, id };
  } catch {
    return null;
  }
}
