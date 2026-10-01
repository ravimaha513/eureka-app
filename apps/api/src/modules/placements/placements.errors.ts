import {
  ConflictException,
  ForbiddenException,
  type HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

const CODES: Record<string, (code: string) => HttpException> = {
  submission_not_found: () => new NotFoundException(),
  placement_not_found: () => new NotFoundException(),
  not_permitted: () => new ForbiddenException("Not permitted"),
  submission_not_selected: (c) => new UnprocessableEntityException(c),
  candidate_not_available: (c) => new UnprocessableEntityException(c),
  invalid_transition: (c) => new UnprocessableEntityException(c),
  reason_required: (c) => new UnprocessableEntityException(c),
  invalid_placement: (c) => new UnprocessableEntityException(c),
  placement_exists: (c) => new ConflictException(c),
};

const PLACEMENT_UNIQUE = new Set(["placement_active_submission", "placement_open_candidate"]);

/**
 * Maps errors raised by authz.create_placement / authz.transition_placement
 * (migration 0022) to problem details with a stable code in `detail`.
 * Conflicts never name the other record (design B3).
 */
export function mapPlacementError(err: unknown): never {
  const e = err as { message?: string; code?: string; constraint?: string };
  const make = e.message !== undefined ? CODES[e.message] : undefined;
  if (make && e.code !== undefined) throw make(e.message!);
  if (e.code === "23505" && e.constraint !== undefined && PLACEMENT_UNIQUE.has(e.constraint)) {
    throw new ConflictException("placement_exists");
  }
  throw err;
}
