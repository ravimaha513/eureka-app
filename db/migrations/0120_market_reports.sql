-- CEO market reports (gap L3, docs/market-reports-api.md): point-in-time
-- candidate counts (in market, placed, per marketing status) grouped by
-- technology, batch, location, team, lead or recruiter, with an optional
-- "placed between" count, for planning the next batches.
--
-- authz.market_report runs as the caller (SECURITY INVOKER, eureka_app), so
-- the candidate_read, placement_read and batch_read policies still apply; on
-- top of them it narrows the candidates to the caller's `report.market:read`
-- ownership (recruiter / team / location / org; never the Open-to-all-teams
-- rule) and, for the CSV export, to `report:export` as well. The scope arrays
-- are computed once per call (MATERIALIZED CTE), not per row (rule 3).
-- It returns counts and group labels only: no candidate names, phones,
-- emails or rates leave it.
SET ROLE eureka_owner;

-- "Placed between": one probe per candidate on (candidate_id, joined_at).
CREATE INDEX placement_candidate_joined ON eureka.placement (candidate_id, joined_at) WHERE joined_at IS NOT NULL;

RESET ROLE;

SET ROLE authz_definer;

CREATE FUNCTION authz.market_report(p_group text, p_placed_from date, p_placed_to date, p_export boolean)
RETURNS TABLE (group_id uuid, group_name text, marketing_status text, candidates int, placed_in_period int)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  IF p_group IS NULL OR p_group NOT IN ('technology', 'batch', 'location', 'team', 'lead', 'recruiter') THEN
    RAISE EXCEPTION 'invalid_group' USING ERRCODE = '22023';
  END IF;
  IF p_placed_from IS NOT NULL AND p_placed_to IS NOT NULL AND p_placed_from > p_placed_to THEN
    RAISE EXCEPTION 'invalid_period' USING ERRCODE = '22023';
  END IF;
  -- $1 group, $2 placed from, $3 placed through (inclusive days, America/New_York), $4 export.
  -- Constant query text with EXECUTE ... USING: planned with the actual arguments (as 0038).
  RETURN QUERY EXECUTE $q$
  WITH s AS MATERIALIZED (
    SELECT authz.has_org('report.market:read') AS mo, authz.recruiter_ids('report.market:read') AS mr,
           authz.team_ids('report.market:read') AS mt, authz.location_ids('report.market:read') AS ml,
           authz.has_org('report:export') AS eo, authz.recruiter_ids('report:export') AS er,
           authz.team_ids('report:export') AS et, authz.location_ids('report:export') AS el
  ),
  picked AS (
    SELECT c.id, c.marketing_status,
           CASE $1::text
             WHEN 'technology' THEN c.technology_id
             WHEN 'batch'      THEN c.batch_id
             WHEN 'location'   THEN c.location_id
             WHEN 'team'       THEN c.team_id
             WHEN 'lead'       THEN tm.lead_id
             WHEN 'recruiter'  THEN c.recruiter_id
           END AS gid
    FROM eureka.candidate c
    JOIN eureka.team tm ON tm.id = c.team_id
    CROSS JOIN s
    WHERE coalesce(s.mo OR c.recruiter_id = ANY (s.mr) OR c.team_id = ANY (s.mt) OR c.location_id = ANY (s.ml), false)
      AND (NOT $4::boolean
           OR coalesce(s.eo OR c.recruiter_id = ANY (s.er) OR c.team_id = ANY (s.et) OR c.location_id = ANY (s.el), false))
  ),
  counted AS (
    SELECT p.gid, p.marketing_status, count(*)::int AS n,
           CASE WHEN $2::date IS NULL AND $3::date IS NULL THEN NULL ELSE
             (count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM eureka.placement pl
               WHERE pl.candidate_id = p.id AND pl.joined_at IS NOT NULL
                 AND ($2::date IS NULL OR pl.joined_at >= ($2::date::timestamp AT TIME ZONE 'America/New_York'))
                 AND ($3::date IS NULL OR pl.joined_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/New_York')))))::int
           END AS placed
    FROM picked p
    GROUP BY p.gid, p.marketing_status
  )
  SELECT x.gid,
         CASE WHEN x.gid IS NULL THEN NULL
              WHEN $1::text = 'technology' THEN (SELECT t.name FROM eureka.technology t WHERE t.id = x.gid)
              WHEN $1::text = 'batch' THEN (
                SELECT coalesce(b.name, bt.name || ' · ' || bl.name || ' · ' || to_char(b.start_month, 'Mon YYYY'))
                FROM eureka.batch b JOIN eureka.technology bt ON bt.id = b.technology_id JOIN eureka.location bl ON bl.id = b.location_id
                WHERE b.id = x.gid)
              WHEN $1::text = 'location' THEN (SELECT l.name FROM eureka.location l WHERE l.id = x.gid)
              WHEN $1::text = 'team' THEN (SELECT t.name FROM eureka.team t WHERE t.id = x.gid)
              ELSE (SELECT u.display_name FROM eureka.app_user u WHERE u.id = x.gid)
         END,
         x.marketing_status, x.n, x.placed
  FROM counted x
  ORDER BY x.gid NULLS LAST, x.marketing_status
  $q$ USING p_group, p_placed_from, p_placed_to, coalesce(p_export, false);
END
$fn$;

REVOKE ALL ON FUNCTION authz.market_report(text, date, date, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.market_report(text, date, date, boolean) TO eureka_app;

RESET ROLE;
