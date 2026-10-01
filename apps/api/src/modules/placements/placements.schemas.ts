import { z } from "zod";
import { PLACEMENT_STATUSES } from "@eureka/shared";
import { Cursor, QueryInstant } from "../submissions/pipeline.js";

const uuid = z.string().uuid();

/** Same limits as the table CHECKs in migration 0022. */
export const Contact = z
  .object({
    kind: z.enum(["vendor_poc", "invoicing_poc", "client_manager"]),
    name: z.string().trim().min(1).max(120).regex(/^[^\p{Cc}]+$/u, "no control characters"),
    email: z.string().trim().max(254).email().optional(),
    phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/, "E.164 format, e.g. +14695550142").optional(),
  })
  .strict();

/**
 * POST /placements body (PL-1, PL-2). Strict: snapshots, status,
 * isFirstPlacement and timestamps are set by the database and refused here.
 */
export const CreatePlacement = z
  .object({
    submissionId: uuid,
    placementType: z.enum(["c2c", "w2", "1099"]),
    rate: z.number().positive().max(1000).multipleOf(0.01).optional(),
    workMode: z.enum(["onsite", "remote", "hybrid"]),
    projectCity: z.string().trim().min(1).max(80).regex(/^[^\p{Cc}]+$/u, "no control characters").optional(),
    projectState: z.string().trim().regex(/^[A-Za-z][A-Za-z .'-]{1,39}$/, "a state name or code").optional(),
    tentativeStart: z.string().date().refine((d) => d >= "2000-01-01" && d <= "2100-12-31", "out of range"),
    implementationPartnerId: uuid.optional(),
    contacts: z.array(Contact).max(10).optional(),
  })
  .strict();
export type CreatePlacement = z.infer<typeof CreatePlacement>;

export const PlacementStatusChange = z
  .object({
    to: z.enum(PLACEMENT_STATUSES),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export type PlacementStatusChange = z.infer<typeof PlacementStatusChange>;

export const PlacementListQuery = z
  .object({
    status: z.enum(PLACEMENT_STATUSES).optional(),
    candidateId: uuid.optional(),
    recruiterId: uuid.optional(),
    from: QueryInstant.optional(),
    to: QueryInstant.optional(),
    cursor: Cursor.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type PlacementListQuery = z.infer<typeof PlacementListQuery>;

/** Idempotency-Key header: printable ASCII, as the idempotency_key CHECK. */
export const IdempotencyKey = z.string().regex(/^[\x21-\x7e]{1,200}$/);
