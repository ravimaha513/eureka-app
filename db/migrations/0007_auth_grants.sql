-- Sign-in needs to link Google accounts (design A6.1): the app may read and
-- set google_sub. Linking by email happens once, only while google_sub is NULL.
GRANT SELECT (google_sub) ON eureka.app_user TO eureka_app;
GRANT UPDATE (google_sub) ON eureka.app_user TO eureka_app;

-- Reference data used by candidate screens.
GRANT SELECT ON eureka.location TO eureka_app;
