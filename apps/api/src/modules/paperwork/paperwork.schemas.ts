import { z } from "zod";
import { BGC_STATUSES, CHECKLIST_ITEM_STATUSES, PLACEMENT_STATUSES, ROLES } from "@eureka/shared";
import { Cursor } from "../submissions/pipeline.js";

const uuid = z.string().uuid();
const day = z.string().date().refine((d) => d >= "2000-01-01" && d <= "2100-12-31", "out of range");
const noControl = /^[^\p{Cc}]+$/u;
/** Notes may span lines; other control characters are refused. */
const notes = z.string().trim().max(1000).regex(/^[^\x00-\x09\x0b-\x1f\x7f]*$/, "no control characters");
const reason = z.string().trim().max(500).regex(/^[^\x00-\x09\x0b-\x1f\x7f]*$/, "no control characters");

/**
 * PATCH /paperwork/items/:id (docs/paperwork-api.md PW-2..PW-5). Strict: the
 * placement, snapshots, version, timestamps and who-changed-it are the
 * server's. Only the keys present are changed; `null` clears a field.
 */
export const UpdateChecklistItem = z
  .object({
    status: z.enum(CHECKLIST_ITEM_STATUSES).optional(),
    reason: reason.optional(),
    ownerRole: z.enum(ROLES).optional(),
    assigneeId: uuid.nullable().optional(),
    dueOn: day.nullable().optional(),
    notes: notes.nullable().optional(),
    documentId: uuid.nullable().optional(),
    /** Optimistic concurrency: the item `version` the caller last read. */
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((b) => ["status", "ownerRole", "assigneeId", "dueOn", "notes", "documentId"].some((k) => k in b), "nothing to change")
  .refine((b) => b.reason === undefined || b.status !== undefined, { message: "reason goes with a status change", path: ["reason"] });
export type UpdateChecklistItem = z.infer<typeof UpdateChecklistItem>;

/** PATCH /paperwork/placements/:id/bgc (PW-6..PW-9). Same limits as the table CHECKs (migration 0044). */
export const UpdateBgc = z
  .object({
    status: z.enum(BGC_STATUSES).optional(),
    reason: reason.optional(),
    bgcCompany: z.string().trim().min(1).max(120).regex(noControl, "no control characters").nullable().optional(),
    initiatedOn: day.nullable().optional(),
    completedOn: day.nullable().optional(),
    helpedBy: uuid.nullable().optional(),
    educationLevel: z.string().trim().min(1).max(60).regex(noControl, "no control characters").nullable().optional(),
    employmentYears: z.number().int().min(0).max(50).nullable().optional(),
    addressYears: z.number().int().min(0).max(50).nullable().optional(),
    notes: notes.nullable().optional(),
    /** Also move the placement to bgc_failed (authz.transition_placement rules apply). */
    failPlacement: z.boolean().optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).some((k) => k !== "expectedVersion" && k !== "reason"), "nothing to change")
  .refine((b) => b.reason === undefined || b.status !== undefined, { message: "reason goes with a status change", path: ["reason"] })
  .refine((b) => !b.failPlacement || b.status === undefined || b.status === "failed", {
    message: "failPlacement needs the check to be failed", path: ["failPlacement"],
  });
export type UpdateBgc = z.infer<typeof UpdateBgc>;

export const TemplateItem = z
  .object({
    docType: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/, "snake_case, up to 60 characters"),
    ownerRole: z.enum(ROLES),
    required: z.boolean().optional(),
  })
  .strict();

/** POST /paperwork/templates (PW-10): a new version; content is product data (no defaults ship). */
export const PublishTemplate = z
  .object({
    kind: z.enum(["paperwork", "onboarding"]),
    placementType: z.enum(["c2c", "w2", "1099"]),
    items: z.array(TemplateItem).max(50)
      .refine((items) => new Set(items.map((i) => i.docType)).size === items.length, "document types must be unique"),
    /** The current version the editor started from (0 when there is none). */
    expectedVersion: z.number().int().min(0),
  })
  .strict();
export type PublishTemplate = z.infer<typeof PublishTemplate>;

const flag = z.enum(["true", "false"]).transform((v) => v === "true");

/** GET /paperwork (the work queue, PW-1). */
export const PaperworkQueueQuery = z
  .object({
    view: z.enum(["outstanding", "overdue", "all"]).default("outstanding"),
    ownerRole: z.enum(ROLES).optional(),
    /** Items assigned to the caller. */
    mine: flag.optional(),
    bgcStatus: z.enum(BGC_STATUSES).optional(),
    placementStatus: z.enum(PLACEMENT_STATUSES).optional(),
    placementType: z.enum(["c2c", "w2", "1099"]).optional(),
    cursor: Cursor.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type PaperworkQueueQuery = z.infer<typeof PaperworkQueueQuery>;
