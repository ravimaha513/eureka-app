import { z } from "zod";
import {
  CANDIDATE_VISIBILITIES,
  DOCUMENTS_FILTERS,
  DOCUMENTS_STATUS_LIST,
  ELIGIBILITY_LIST,
  MARKETING_LOCATIONS_MAX,
  PHONE_PROBLEM_MESSAGES,
  STAY_FILTERS,
  VISA_CATEGORY_LIST,
  normalizeEmail,
  normalizePhoneE164,
  phoneProblem,
} from "@eureka/shared";

const uuid = z.string().uuid();

/**
 * Hot List filters added for the Eureka App 4 spec (also on the Candidates
 * list): office location, marketed visa, documents status ("none" = not
 * recorded), resume on file (an uploaded current resume or a resume link) and
 * stay (guest house or remote).
 */
export const ExtraListFilters = {
  locationId: uuid.optional(),
  visa: z.enum(VISA_CATEGORY_LIST as [string, ...string[]]).optional(),
  documents: z.enum(DOCUMENTS_FILTERS).optional(),
  resume: z.enum(["yes", "no"]).optional(),
  stay: z.enum(STAY_FILTERS).optional(),
};

export const CandidateListQuery = z
  .object({
    status: z.string().max(40).optional(),
    technology: z.string().max(80).optional(),
    visibility: z.enum(CANDIDATE_VISIBILITIES).optional(),
    search: z.string().max(80).optional(),
    ...ExtraListFilters,
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
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: PHONE_PROBLEM_MESSAGES[phoneProblem(v) ?? "invalid"] });
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
    /** Guest house location (a location id), "remote", or null when not recorded. */
    ghLocation: z.union([uuid, z.literal("remote")]).nullable().optional(),
    /** "City, ST" entries the candidate is marketed in; [] or null clears them. */
    marketingLocations: z
      .array(z.string().trim().min(1).max(60).regex(/^[^\p{Cc}|]+$/u, "No control characters or |"))
      .max(MARKETING_LOCATIONS_MAX)
      .refine((a) => new Set(a.map((x) => x.toLowerCase())).size === a.length, { message: "Duplicate location" })
      .nullable()
      .optional(),
    linkedinUrl: z.string().trim().max(300)
      .regex(/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/\S+$/, "Use an https://linkedin.com/... link")
      .nullable().optional(),
    /** A link to the marketing resume (e.g. a shared drive); uploaded files use /resumes. */
    resumeUrl: z.string().trim().max(500).regex(/^https:\/\/\S+$/, "Use an https:// link").nullable().optional(),
    /** [] or null clears it. */
    eligibility: z.array(z.enum(ELIGIBILITY_LIST as [string, ...string[]])).max(ELIGIBILITY_LIST.length)
      .refine((a) => new Set(a).size === a.length, { message: "Duplicate value" })
      .nullable().optional(),
    visaCategory: z.enum(VISA_CATEGORY_LIST as [string, ...string[]]).nullable().optional(),
  })
  .strict();
export type ProfileUpdate = z.infer<typeof ProfileUpdate>;

/**
 * PUT /candidates/:id/compliance (candidate.compliance:update). Omitted keys
 * keep their value; null clears a link.
 */
export const ComplianceUpdate = z
  .object({
    everifyCompanyId: uuid.nullable().optional(),
    offerLetterCompanyId: uuid.nullable().optional(),
    form1099CompanyId: uuid.nullable().optional(),
    documentsStatus: z.enum(DOCUMENTS_STATUS_LIST as [string, ...string[]]).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to change" });
export type ComplianceUpdate = z.infer<typeof ComplianceUpdate>;

/** "Selected teams" picks (0240): 1-50 distinct teams; the candidate's own team is ignored. */
export const ShareTeamIds = z.array(uuid).min(1).max(50)
  .refine((ids) => new Set(ids).size === ids.length, { message: "Duplicate ids" });

export const VisibilityUpdate = z
  .object({ visibility: z.enum(CANDIDATE_VISIBILITIES), teamIds: ShareTeamIds.optional() })
  .strict()
  .refine((b) => (b.visibility === "selected_teams") === (b.teamIds !== undefined), { message: "teamIds goes with selected_teams" });
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
export type BatchStatus = (typeof BATCH_STATUSES)[number];
/** Target of PUT /batches/:id/status ("planned" is only ever the starting state). */
export const BatchStatusChange = z.object({ to: z.enum(["in_training", "completed", "cancelled"]) }).strict();

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
