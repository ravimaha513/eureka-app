import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
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
  restricted_target: (c) => new ForbiddenException(c),
  password_weak: (c) => new UnprocessableEntityException(c),
  invalid_token: (c) => new UnprocessableEntityException(c),
  not_in_scope: (c) => new ForbiddenException(c),
  user_not_found: () => new NotFoundException(),
  record_not_found: () => new NotFoundException(),
  invalid_kind: (c) => new UnprocessableEntityException(c),
  invalid_designation: (c) => new UnprocessableEntityException(c),
  team_not_found: () => new NotFoundException(),
  department_not_found: () => new NotFoundException(),
  location_not_found: () => new NotFoundException(),
  invalid_parent: (c) => new UnprocessableEntityException(c),
  request_not_found: () => new NotFoundException(),
  role_not_held: () => new NotFoundException(),
  location_required: (c) => new UnprocessableEntityException(c),
  location_not_allowed: (c) => new UnprocessableEntityException(c),
  invalid_reassign_target: (c) => new UnprocessableEntityException(c),
  cycle: (c) => new UnprocessableEntityException(c),
  unknown_role: (c) => new UnprocessableEntityException(c),
  // Role definitions (docs/roles-api.md): authz.role_* and the grant checks of request_role.
  system_role: (c) => new UnprocessableEntityException(c),
  role_archived: (c) => new UnprocessableEntityException(c),
  role_in_use: (c) => new UnprocessableEntityException(c),
  role_exists: (c) => new ConflictException(c),
  invalid_label: (c) => new UnprocessableEntityException(c),
  invalid_description: (c) => new UnprocessableEntityException(c),
  invalid_track: (c) => new UnprocessableEntityException(c),
  invalid_level: (c) => new UnprocessableEntityException(c),
  invalid_traits: (c) => new UnprocessableEntityException(c),
  invalid_grants: (c) => new UnprocessableEntityException(c),
  unknown_permission: (c) => new UnprocessableEntityException(c),
  invalid_scope: (c) => new UnprocessableEntityException(c),
  location_scope_needs_location: (c) => new UnprocessableEntityException(c),
  unknown_department: (c) => new UnprocessableEntityException(c),
  role_department_mismatch: (c) => new UnprocessableEntityException(c),
  // Admin/data separation (0500; docs/roles-api.md "Admin separation").
  admin_permission_needs_admin_role: (c) => new UnprocessableEntityException(c),
  ceo_only_permission: (c) => new UnprocessableEntityException(c),
  business_permission_on_admin_role: (c) => new UnprocessableEntityException(c),
  // Admin is only admin per user (0510): a legacy role that breaks the rule is not granted again,
  // and a custom role an admin holds takes no business permission.
  role_violates_admin_separation: (c) => new UnprocessableEntityException(c),
  role_held_by_admin: (c) => new UnprocessableEntityException(c),
  // Optional If-Match on role edits (0501): the role changed since the client read it.
  stale: (c) => new HttpException(c, HttpStatus.PRECONDITION_FAILED),
  duplicate_user: (c) => new UnprocessableEntityException(c),
  invalid_manager: (c) => new UnprocessableEntityException(c),
  invalid_lead: (c) => new UnprocessableEntityException(c),
  invalid_name: (c) => new UnprocessableEntityException(c),
  user_inactive: (c) => new UnprocessableEntityException(c),
  user_active: (c) => new UnprocessableEntityException(c),
  not_a_member: (c) => new UnprocessableEntityException(c),
  not_a_recruiter: (c) => new UnprocessableEntityException(c),
  // AD-11: coach assignments (authz.assign_coach / unassign_coach)
  not_a_coach: (c) => new UnprocessableEntityException(c),
  not_assigned: (c) => new NotFoundException(c),
  already_assigned: (c) => new ConflictException(c),
  same_team: (c) => new UnprocessableEntityException(c),
  has_hotlist_candidates: (c) => new UnprocessableEntityException(c),
  lead_of_team: (c) => new UnprocessableEntityException(c),
  has_reports: (c) => new UnprocessableEntityException(c),
  separation_of_duties: (c) => new UnprocessableEntityException(c),
  already_member: (c) => new ConflictException(c),
  role_already_held: (c) => new ConflictException(c),
  request_pending: (c) => new ConflictException(c),
  request_not_pending: (c) => new ConflictException(c),
  request_expired: (c) => new ConflictException(c),
  last_admin: (c) => new ConflictException(c),
  requester_not_admin: (c) => new ConflictException(c),
};

export function mapAdminError(err: unknown): never {
  const e = err as { message?: string; code?: string; constraint?: string };
  const make = e.message !== undefined ? CODES[e.message] : undefined;
  if (make && e.code !== undefined) throw make(e.message!);
  // Concurrent inserts hitting the membership exclusion constraint.
  if (e.code === "23P01") throw new ConflictException("already_member");
  if (e.code === "23505" && e.constraint === "app_user_email_key") throw new ConflictException("email_exists");
  if (e.code === "23505" && e.constraint === "location_name_key") throw new ConflictException("location_exists");
  if (e.code === "23505" && e.constraint === "department_name_key") throw new ConflictException("department_exists");
  throw err;
}
