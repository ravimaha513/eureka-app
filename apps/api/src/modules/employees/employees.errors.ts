import { ForbiddenException, type HttpException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";

const unprocessable = (c: string) => new UnprocessableEntityException(c);
const CODES: Record<string, (code: string) => HttpException> = {
  assignment_not_found: () => new NotFoundException(),
  employee_not_found: () => new NotFoundException(),
  not_permitted: () => new ForbiddenException("Not permitted"),
  assignment_closed: unprocessable,
  invalid_reason: unprocessable,
  invalid_end_date: unprocessable,
  invalid_transition: unprocessable,
  unchanged: unprocessable,
  bgc_failed_last: unprocessable,
  candidate_not_on_bench: unprocessable,
};

/**
 * Maps errors raised by the employment definer functions (migration 0045) to
 * problem details with a stable code in `detail`.
 */
export function mapEmploymentError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  const make = e.message !== undefined ? CODES[e.message] : undefined;
  if (make && e.code !== undefined) throw make(e.message!);
  throw err;
}
