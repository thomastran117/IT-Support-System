-- Run once per cluster as the DBA. These roles carry permissions, never own objects.
DO $service_roles$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'smartdesk_ticket', 'smartdesk_notifications', 'smartdesk_analytics',
    'smartdesk_knowledge', 'smartdesk_identity', 'smartdesk_search', 'smartdesk_legacy_search'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles AS r WHERE r.rolname = name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT', name);
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles AS r WHERE r.rolname = name AND (
        r.rolcanlogin OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR
        r.rolreplication OR r.rolbypassrls OR r.rolinherit OR
        EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members AS m WHERE m.member = r.oid) OR
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_shdepend AS d
          WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass
            AND d.refobjid = r.oid AND d.deptype = 'o'
        )
      )
    ) THEN
      RAISE EXCEPTION 'Role % conflicts with the SmartDesk service access configuration', name;
    END IF;
  END LOOP;
END
$service_roles$;
