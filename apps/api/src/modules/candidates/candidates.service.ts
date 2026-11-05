/**
 * Candidates module entry point (R-17). The work is split by sub-domain:
 *   candidate-common.ts           rows, scope predicate, presentation, read-before-write helpers
 *   candidate-list.service.ts     Candidates list and Hot List
 *   candidate-profile.service.ts  one candidate: profile, compliance, team, visibility, recruiter, rating, transitions, delete
 *   candidate-create.service.ts   new candidates and the duplicate check
 *   candidate-batches.service.ts  batches and the bulk add to a batch
 *   candidate-timeline.service.ts the timeline
 * Other modules keep importing the shared helpers from here.
 */
import { Injectable } from "@nestjs/common";
import type pg from "pg";
import type { AuthedUser } from "../../platform/auth.guard.js";
import type { CreateCandidate } from "./candidates.schemas.js";
import { CandidateCreateService } from "./candidate-create.service.js";

export {
  auditSafeProfile,
  batchLabel,
  dobReadable,
  profileExtras,
  scopePredicate,
} from "./candidate-common.js";
export { HOTLIST_PAGES_PER_MINUTE, sortKey } from "./candidate-list.service.js";
// List filters are shared by the Candidates list, the Hot List and saved views.
export { filterPredicates, filterSummary, hotlistMore } from "./list-filters.js";
export { DUPLICATE_CHECKS_PER_MINUTE } from "./candidate-create.service.js";
export { BULK_CANDIDATE_CALLS_PER_MINUTE, BULK_CANDIDATE_ROWS_PER_DAY } from "./candidate-batches.service.js";

/** What other modules call on candidates (applications: create in the caller's transaction). */
@Injectable()
export class CandidatesService {
  constructor(private readonly creator: CandidateCreateService) {}

  /**
   * `then` runs in the same transaction after the candidate row exists (jobs-portal:
   * linking the hired application), so both commit or neither does.
   */
  create(user: AuthedUser, body: CreateCandidate, then?: (c: pg.PoolClient, candidateId: string) => Promise<void>) {
    return this.creator.create(user, body, then);
  }
}
