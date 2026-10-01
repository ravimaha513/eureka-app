import { z } from "zod";
import { HOTLIST_STATUSES } from "@eureka/shared";

/** The Hot List filters a saved view or an export carries (same names as GET /hotlist). */
export const HotlistFilters = z
  .object({
    status: z.enum(HOTLIST_STATUSES).optional(),
    technology: z.string().trim().min(1).max(80).optional(),
    visibility: z.enum(["team", "all_teams"]).optional(),
    search: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type HotlistFilters = z.infer<typeof HotlistFilters>;

const ViewName = z.string().trim().min(1).max(80);

export const CreateView = z.object({ name: ViewName, filters: HotlistFilters }).strict();
export type CreateView = z.infer<typeof CreateView>;

export const UpdateView = z
  .object({ name: ViewName.optional(), filters: HotlistFilters.optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.filters !== undefined, { message: "Nothing to change" });
export type UpdateView = z.infer<typeof UpdateView>;

/** Most candidates one bulk request may touch; every record is checked on its own. */
export const BULK_MAX = 100;
const Ids = z.array(z.string().uuid()).min(1).max(BULK_MAX)
  .refine((ids) => new Set(ids).size === ids.length, { message: "Duplicate ids" });

export const BulkVisibility = z.object({ ids: Ids, visibility: z.enum(["team", "all_teams"]) }).strict();
export type BulkVisibility = z.infer<typeof BulkVisibility>;

/**
 * Status changes offered in bulk. Deliberately narrower than the single-record
 * transition: `terminated` cannot be undone and `confirmation` is driven by
 * placements, so both stay one record at a time.
 */
export const BULK_STATUSES = ["active", "on_hold", "full_of_interviews", "stopped"] as const;
export const BulkStatus = z.object({ ids: Ids, to: z.enum(BULK_STATUSES) }).strict();
export type BulkStatus = z.infer<typeof BulkStatus>;
