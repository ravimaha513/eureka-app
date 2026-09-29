import { z } from "zod";

const uuid = z.string().uuid();

export const CandidateListQuery = z
  .object({
    status: z.string().max(40).optional(),
    technology: z.string().max(80).optional(),
    visibility: z.enum(["team", "all_teams"]).optional(),
    search: z.string().max(80).optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type CandidateListQuery = z.infer<typeof CandidateListQuery>;

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
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(80),
    phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/, "E.164 format, e.g. +14695550142").optional(),
    technologyId: uuid,
    locationId: uuid,
    teamId: uuid.optional(),
    recruiterId: uuid.nullable().optional(),
  })
  .strict();
export type CreateCandidate = z.infer<typeof CreateCandidate>;
