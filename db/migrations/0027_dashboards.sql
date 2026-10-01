-- Dashboards (docs/dashboards-api.md; design B7). Indexes only: the dashboard
-- queries run as eureka_app under the callers' RLS, like the list endpoints,
-- so no function, policy or grant changes are needed.
--
-- Activity counts filter each table by a period column; "needs attention"
-- reads only open rows. Partial indexes keep both cheap at org scope (CEO,
-- Offshore Manager), where the scope predicate is `true` and nothing else
-- narrows the scan. The expressions and WHERE clauses must match
-- apps/api/src/modules/dashboard/dashboard.service.ts exactly.
SET ROLE eureka_owner;

-- Activity counts by period.
CREATE INDEX submission_submitted_at ON eureka.submission (submitted_at);
CREATE INDEX interview_starts_at ON eureka.interview (starts_at);
CREATE INDEX interview_cleared_at ON eureka.interview (cleared_at) WHERE cleared;
CREATE INDEX candidate_created_at ON eureka.candidate (created_at);
CREATE INDEX placement_joined_at ON eureka.placement (joined_at) WHERE joined_at IS NOT NULL;
-- placement (created_at, id) exists since 0022.

-- Needs attention: stale open submissions, interviews past their end without
-- staff feedback, and open (pre-join) placements.
CREATE INDEX submission_open_since ON eureka.submission ((coalesce(status_changed_at, submitted_at)))
  WHERE status IN ('submitted', 'under_review', 'interview_requested', 'interview_scheduled', 'interview_completed');
CREATE INDEX interview_live_ends_at ON eureka.interview (ends_at)
  WHERE call_status NOT IN ('cancelled', 'rescheduled', 'no_invite');
CREATE INDEX placement_open_since ON eureka.placement ((coalesce(status_changed_at, created_at)))
  WHERE status IN ('confirmed', 'paperwork', 'bgc', 'ready');

RESET ROLE;
