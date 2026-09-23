-- Re-runnable: safe to execute again on the same database, and against any
-- database (e.g. the dedicated agrotrace_test database used by `./at.sh db:test`) —
-- GRANT CONNECT targets current_database() via dynamic SQL since GRANT does not
-- accept an expression for the database name.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agrotrace_app') THEN
    CREATE ROLE agrotrace_app LOGIN PASSWORD 'app_dev_pw';
  END IF;
END $$;
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO agrotrace_app', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO agrotrace_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agrotrace_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agrotrace_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agrotrace_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO agrotrace_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agrotrace_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO agrotrace_app;
