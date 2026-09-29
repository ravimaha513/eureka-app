import {
  ConflictException,
  ForbiddenException,
  type HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

/**
 * The admin definer functions (migration 0013) raise the contract's error code
 * as the exception message. Map those to problem details with the code in
 * `detail` (docs/admin-api.md, "Error codes"). Anything else is rethrown for
 * the global filter.
 */
const CODES: Record<string, (code: string) => HttpException> = {
  not_permitted: () => new ForbiddenException("Not permitted"),
  self_change: (c) => new ForbiddenException(c),
  second_approver_required: (c) => new ForbiddenException(c),
  restricted_role: (c) => new ForbiddenException(c),
  not_in_scope: (c) => new ForbiddenException(c),
  user_not_found: () => new NotFoundException(),
  team_not_found: () => new NotFoundException(),
  request_not_found: () => new NotFoundException(),
  role_not_held: () => new NotFoundException(),
  location_required: (c) => new UnprocessableEntityException(c),
  location_not_allowed: (c) => new UnprocessableEntityException(c),
  invalid_reassign_target: (c) => new UnprocessableEntityException(c),
  cycle: (c) => new UnprocessableEntityException(c),
  unknown_role: (c) => new UnprocessableEntityException(c),
  invalid_manager: (c) => new UnprocessableEntityException(c),
  invalid_lead: (c) => new UnprocessableEntityException(c),
  user_inactive: (c) => new UnprocessableEntityException(c),
  not_a_member: (c) => new UnprocessableEntityException(c),
  same_team: (c) => new UnprocessableEntityException(c),
  lead_of_team: (c) => new UnprocessableEntityException(c),
  already_member: (c) => new ConflictException(c),
  role_already_held: (c) => new ConflictException(c),
  request_pending: (c) => new ConflictException(c),
  request_not_pending: (c) => new ConflictException(c),
  request_expired: (c) => new ConflictException(c),
  last_admin: (c) => new ConflictException(c),
};

export function mapAdminError(err: unknown): never {
  const e = err as { message?: string; code?: string; constraint?: string };
  const make = e.message !== undefined ? CODES[e.message] : undefined;
  if (make && e.code !== undefined) throw make(e.message!);
  // Concurrent inserts hitting the membership exclusion constraint.
  if (e.code === "23P01") throw new ConflictException("already_member");
  if (e.code === "23505" && e.constraint === "app_user_email_key") throw new ConflictException("email_exists");
  throw err;
}
