import {
  ConflictException, ForbiddenException, HttpException, HttpStatus, NotFoundException, UnprocessableEntityException,
} from "@nestjs/common";

const unprocessable = (c: string) => new UnprocessableEntityException(c);

/** Coded errors raised by the migration 0170-0172 functions (message = code). */
const CODES: Record<string, (code: string) => HttpException> = {
  submission_not_found: () => new NotFoundException(),
  assessment_not_found: () => new NotFoundException(),
  candidate_not_found: () => new NotFoundException(),
  vendor_not_found: () => new NotFoundException(),
  not_permitted: () => new ForbiddenException("Not permitted"),
  stale: (c) => new HttpException(c, HttpStatus.PRECONDITION_FAILED),
  already_flagged: (c) => new ConflictException(c),
  vendor_exists: (c) => new ConflictException(c),
  submission_closed: unprocessable,
  invalid_assessment: unprocessable,
  completed_on_required: unprocessable,
  limit_reached: unprocessable,
  invalid_reason: unprocessable,
  invalid_resolution: unprocessable,
  candidate_not_marketed: unprocessable,
  not_flagged: unprocessable,
  invalid_vendor: unprocessable,
  unknown_vendor: unprocessable,
  unknown_technology: unprocessable,
  vendor_archived: unprocessable,
};

export function mapPvError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  const make = e.message !== undefined && e.code !== undefined ? CODES[e.message] : undefined;
  if (make) throw make(e.message!);
  if (e.code === "23514") throw new UnprocessableEntityException("invalid");
  if (e.code === "23505") throw new ConflictException("conflict");
  throw err;
}
