DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agrotrace_app') THEN
    CREATE ROLE agrotrace_app LOGIN PASSWORD 'app_dev_pw';
  END IF;
END $$;
GRANT CONNECT ON DATABASE agrotrace TO agrotrace_app;
GRANT USAGE ON SCHEMA public TO agrotrace_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agrotrace_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agrotrace_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agrotrace_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO agrotrace_app;
ALTER DEFAULT PRIVILEGES FOR ROLE agrotrace_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO agrotrace_app;
