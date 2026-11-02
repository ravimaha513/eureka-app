-- A candidate may have more than one placement in progress (confirmed .. ready)
-- at a time: a second offer can be placed while the first is still open
-- (docs/interviews-settings-api.md IS-11). One active placement per
-- submission (placement_active_submission) is unchanged. authz.create_placement
-- now accepts a candidate in confirmation, and authz.transition_placement only
-- moves them back to active when no other placement is still in progress.
SET ROLE eureka_owner;
DROP INDEX eureka.placement_open_candidate;
RESET ROLE;
