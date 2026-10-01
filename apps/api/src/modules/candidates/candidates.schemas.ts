import { z } from "zod";
import { normalizeEmail, normalizePhoneE164 } from "@eureka/shared";

const uuid = z.string().uuid();

export const CandidateListQuery = z
  .object({
    status: z.string().max(40).optional(),
    technology: z.string().max(80).optional(),
    visibility: z.enum(["team", "all_teams"]).optional(),
    search: z.string().max(80).optional(),
    /** Candidates list only (FR-CAN-02); the Hot List has no batch filter. */
    batchId: uuid.optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type CandidateListQuery = z.infer<typeof CandidateListQuery>;
export const HotlistQuery = CandidateListQuery.omit({ batchId: true });

/**
 * A phone number as typed, normalized to E.164 (country code required; see
 * normalizePhoneE164). Stored and compared only in normalized form.
 */
const Phone = z.string().max(40).transform((v, ctx) => {
  const p = normalizePhoneE164(v);
  if (!p) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Use international format with the country code, e.g. +14695550142" });
    return z.NEVER;
  }
  return p;
});
const Email = z.string().max(254).transform(normalizeEmail).pipe(z.string().email());

/**
 * Write schema for candidate:update (design B4.7). Strict: any other field
 * (team, recruiter, visibility, rating, status, location) is rejected with 422,
 * never silently ignored. Those have their own endpoints and permissions.
 */
export const ProfileUpdate = z
  .object({
    priority: z.enum(["P1", "P2", "P3"]).optional(),
    marketingEmail: z.string().email().optional(),
    vitelNumber: z.string().max(20).optional(),
    marketingStartDate: z.string().date().optional(),
    inPersonOk: z.boolean().optional(),
    technologyId: uuid.optional(),
    /** null removes the candidate from its batch. */
    batchId: uuid.nullable().optional(),
  })
  .strict();
export type ProfileUpdate = z.infer<typeof ProfileUpdate>;

export const VisibilityUpdate = z.object({ visibility: z.enum(["team", "all_teams"]) }).strict();
export const RatingUpdate = z.object({ rating: z.number().int().min(1).max(5) }).strict();
export const Transition = z
  .object({ to: z.enum(["active", "on_hold", "stopped", "full_of_interviews", "confirmation", "terminated"]) })
  .strict();

export const CreateCandidate = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    phone: Phone.optional(),
    /** Personal email; used for the duplicate check. */
    email: Email.optional(),
    technologyId: uuid,
    locationId: uuid,
    teamId: uuid.optional(),
    recruiterId: uuid.nullable().optional(),
    batchId: uuid.optional(),
    /** Create even though the duplicate check found a likely duplicate (409 possible_duplicate). */
    confirmDuplicate: z.boolean().optional(),
  })
  .strict();
export type CreateCandidate = z.infer<typeof CreateCandidate>;

/** Duplicate check (design B3, N11): name plus email or phone. */
export const DuplicateCheck = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    phone: Phone.optional(),
    email: Email.optional(),
  })
  .strict()
  .refine((b) => b.phone !== undefined || b.email !== undefined, { message: "Enter an email or a phone number", path: ["email"] });
export type DuplicateCheck = z.infer<typeof DuplicateCheck>;

export const TimelineQuery = z
  .object({
    /** Opaque keyset cursor: the last event id of the previous page. */
    cursor: z.string().regex(/^[1-9][0-9]{0,17}$/).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type TimelineQuery = z.infer<typeof TimelineQuery>;

export const BATCH_STATUSES = ["planned", "in_training", "completed", "cancelled"] as const;

export const BatchListQuery = z
  .object({
    locationId: uuid.optional(),
    technologyId: uuid.optional(),
    status: z.enum(BATCH_STATUSES).optional(),
  })
  .strict();
export type BatchListQuery = z.infer<typeof BatchListQuery>;

export const CreateBatch = z
  .object({
    locationId: uuid,
    technologyId: uuid,
    /** First month of training, "YYYY-MM". */
    startMonth: z.string().regex(/^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])$/, "Use YYYY-MM"),
    sizePlanned: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export type CreateBatch = z.infer<typeof CreateBatch>;
