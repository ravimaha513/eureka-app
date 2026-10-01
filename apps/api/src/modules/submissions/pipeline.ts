import {
  ConflictException,
  ForbiddenException,
  type HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { z } from "zod";

/**
 * Submission state machine (design B2.6): single copy in @eureka/shared,
 * mirroring authz.transition_submission (migration 0017).
 */
export {
  SUBMISSION_STATUSES,
  TERMINAL_SUBMISSION_STATUSES,
  submissionTransitionAllowed,
  type SubmissionStatus,
} from "@eureka/shared";

/** Interview time limits, also enforced by the database (migration 0019). */
export const MAX_INTERVIEW_MS = 12 * 60 * 60 * 1000;
export const MIN_INTERVIEW_START = Date.parse("2000-01-01T00:00:00Z");
export function interviewTimesProblem(startsAt: string, endsAt: string): string | null {
  const s = Date.parse(startsAt), e = Date.parse(endsAt);
  if (!(e > s)) return "endsAt must be after startsAt";
  if (e - s > MAX_INTERVIEW_MS) return "an interview can last at most 12 hours";
  if (s < MIN_INTERVIEW_START) return "startsAt is too far in the past";
  return null;
}

export const CALL_STATUSES = ["scheduled", "in_progress", "completed", "rescheduled", "cancelled", "no_invite"] as const;

/** Query-string timestamp: a date (YYYY-MM-DD) or an ISO date-time with offset. */
export const QueryInstant = z.union([z.string().date(), z.string().datetime({ offset: true })]);

/** Keyset cursor "<epoch microseconds>.<uuid>", exact to the microsecond. */
export const Cursor = z.string().regex(/^-?\d{1,17}\.[0-9a-f-]{36}$/i, "invalid cursor");
export function splitCursor(cursor: string): [string, string] {
  const i = cursor.indexOf(".");
  return [cursor.slice(0, i), cursor.slice(i + 1)];
}
/** SQL expression turning a bigint microsecond parameter back into timestamptz. */
export const fromMicros = (p: string) => `(timestamptz 'epoch' + (${p}::bigint * interval '1 microsecond'))`;
export const toMicros = (col: string) => `(extract(epoch from ${col}) * 1000000)::bigint::text`;

const CODES: Record<string, (code: string) => HttpException> = {
  submission_not_found: () => new NotFoundException(),
  not_permitted: () => new ForbiddenException("Not permitted"),
  field_not_permitted: (c) => new UnprocessableEntityException(c),
  server_managed_field: (c) => new UnprocessableEntityException(c),
  invalid_transition: (c) => new UnprocessableEntityException(c),
  rejection_reason_required: (c) => new UnprocessableEntityException(c),
  rejection_reason_not_allowed: (c) => new UnprocessableEntityException(c),
  submission_closed: (c) => new UnprocessableEntityException(c),
};

/**
 * Maps database errors raised by the pipeline functions, triggers and
 * constraints (migration 0017) to problem details with a stable code in
 * `detail`. Conflicts never name the other record (design B3).
 */
export function mapPipelineError(err: unknown): never {
  const e = err as { message?: string; code?: string; constraint?: string };
  const make = e.message !== undefined ? CODES[e.message] : undefined;
  if (make && e.code !== undefined) throw make(e.message!);
  if (e.code === "23P01" && e.constraint === "interview_no_overlap") throw new ConflictException("interview_conflict");
  if (e.code === "23514" && e.constraint === "interview_recording_consent") throw new UnprocessableEntityException("consent_required");
  if (e.code === "23514" && e.constraint === "submission_rejection_reason") throw new UnprocessableEntityException("rejection_reason_required");
  throw err;
}
