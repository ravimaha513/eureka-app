-- BGC employment and address history: typed in as a number of years (1-50)
-- instead of picked from 3 / 5 / 7 / 10 (0160). Existing values all fall in
-- the new range, so no rewrite; only the table CHECKs change.
-- authz.update_bgc already maps a CHECK failure to invalid_change.

SET ROLE eureka_owner;
ALTER TABLE eureka.bgc DROP CONSTRAINT bgc_employment_years_check;
ALTER TABLE eureka.bgc DROP CONSTRAINT bgc_address_years_check;
ALTER TABLE eureka.bgc ADD CONSTRAINT bgc_employment_years_check CHECK (employment_years BETWEEN 1 AND 50);
ALTER TABLE eureka.bgc ADD CONSTRAINT bgc_address_years_check CHECK (address_years BETWEEN 1 AND 50);
RESET ROLE;
