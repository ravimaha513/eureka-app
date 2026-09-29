-- authz_definer has no BYPASSRLS (it cannot be created by a non-superuser such
-- as the Amazon RDS admin, and a role-wide bypass is broader than needed).
-- Instead it gets explicit policies on exactly the tables its functions read
-- or write. Functions owned by authz_definer are the only code running as it.
SET search_path = eureka, public;

CREATE POLICY definer_read ON candidate  FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_read ON submission FOR SELECT TO authz_definer USING (true);
CREATE POLICY definer_read ON interview  FOR SELECT TO authz_definer USING (true);
-- authz.transition_candidate changes status columns only (column grant in 0003).
CREATE POLICY definer_transition ON candidate FOR UPDATE TO authz_definer USING (true) WITH CHECK (true);
