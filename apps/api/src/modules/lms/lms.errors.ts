import {
  ConflictException, ForbiddenException, HttpException, NotFoundException, UnprocessableEntityException,
} from "@nestjs/common";

const unprocessable = (c: string) => new UnprocessableEntityException(c);
const conflict = (c: string) => new ConflictException(c);
const CODES: Record<string, (code: string) => HttpException> = {
  not_found: () => new NotFoundException(),
  not_permitted: () => new ForbiddenException("Not permitted"),
  stale: (c) => new HttpException(c, 412),
  invalid_input: unprocessable,
  invalid_module: unprocessable,
  student_not_found: unprocessable,
  course_not_found: unprocessable,
  course_not_in_batch: unprocessable,
  course_archived: unprocessable,
  batch_has_progress: conflict,
  course_has_progress: conflict,
};

/** Maps errors raised by the LMS definer functions (migration 0082) to problem details with a stable code in `detail`. */
export function mapLmsError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  const make = e.message !== undefined ? CODES[e.message] : undefined;
  if (make && e.code !== undefined) throw make(e.message!);
  throw err;
}
