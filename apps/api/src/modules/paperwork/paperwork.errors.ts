import {
  ConflictException,
  ForbiddenException,
  type HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

const unprocessable = (c: string) => new UnprocessableEntityException(c);

const CODES: Record<string, (code: string) => HttpException> = {
  item_not_found: () => new NotFoundException(),
  placement_not_found: () => new NotFoundException(),
  not_permitted: () => new ForbiddenException("Not permitted"),
  version_mismatch: (c) => new ConflictException(c),
  invalid_transition: unprocessable,
  reason_required: unprocessable,
  invalid_change: unprocessable,
  invalid_assignee: unprocessable,
  invalid_owner_role: unprocessable,
  invalid_due_date: unprocessable,
  invalid_helper: unprocessable,
  invalid_document: unprocessable,
  placement_closed: unprocessable,
  invalid_checklist_template: unprocessable,
};

/**
 * Maps errors raised by the migration 0044 functions (and by
 * authz.transition_placement when failPlacement is used) to problem details
 * with a stable code in `detail`.
 */
export function mapPaperworkError(err: unknown): never {
  const e = err as { message?: string; code?: string };
  const make = e.message !== undefined ? CODES[e.message] : undefined;
  if (make && e.code !== undefined) throw make(e.message!);
  throw err;
}
