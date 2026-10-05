import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

const unprocessable = (c: string) => new UnprocessableEntityException(c);

const CODES: Record<string, (code: string) => HttpException> = {
  batch_not_found: () => new NotFoundException(),
  not_permitted: () => new ForbiddenException("Not permitted"),
  location_not_in_scope: (c) => new ForbiddenException(c),
  batch_exists: (c) => new ConflictException(c),
  batch_has_students: (c) => new ConflictException(c),
  course_shared: (c) => new ConflictException(c),
  stale: (c) => new HttpException(c, HttpStatus.PRECONDITION_FAILED),
  invalid_batch: unprocessable,
  invalid_dates: unprocessable,
  invalid_trainer: unprocessable,
  invalid_transition: unprocessable,
  invalid_change: unprocessable,
  batch_closed: unprocessable,
  batch_not_allowed: unprocessable,
  course_archived: unprocessable,
  candidate_not_eligible: unprocessable,
  not_in_batch: unprocessable,
  module_not_in_batch: unprocessable,
};

/** Maps the coded errors of the migration 0065 functions and guards to problem details (code in `detail`). */
export function mapTrainingError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  const make = e.message !== undefined && e.code !== undefined ? CODES[e.message] : undefined;
  if (make) throw make(e.message!);
  // Table limits that a request can reach (position CHECKs, lost races on UNIQUE): never a 500.
  if (e.code === "23514") throw new UnprocessableEntityException("limit_reached");
  if (e.code === "23505") throw new ConflictException("conflict");
  throw err;
}

/** A foreign key still references the row (a course in a batch, a module with completions): 409 with `code`. */
export function inUse(code: string) {
  return (err: unknown): never => {
    if ((err as { code?: string }).code === "23503") throw new ConflictException(code);
    return mapTrainingError(err);
  };
}
