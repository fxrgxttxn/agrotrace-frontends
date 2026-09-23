-- migrate:up
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type varchar(16) NOT NULL CHECK (type IN ('FARM','PROCESSOR','LAB','RETAILER','AUTHORITY','PLATFORM')),
  name varchar(255) NOT NULL,
  inn varchar(12) NOT NULL UNIQUE CHECK (inn ~ '^[0-9]{10}([0-9]{2})?$'),
  address varchar(500),
  region_id uuid NOT NULL REFERENCES regions(id),
  trust_rating integer NOT NULL DEFAULT 80 CHECK (trust_rating BETWEEN 0 AND 100),
  status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','MANUAL_CHECK','ACTIVE','REJECTED','SUSPENDED')),
  logo_file_id uuid REFERENCES files(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  deleted_at timestamptz
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  email citext NOT NULL UNIQUE,
  password_hash varchar(255) NOT NULL,
  full_name varchar(255) NOT NULL,
  phone varchar(32),
  is_org_admin boolean NOT NULL DEFAULT false,
  totp_secret varchar(64),
  totp_enabled boolean NOT NULL DEFAULT false,
  telegram_chat_id bigint,
  notification_channels jsonb NOT NULL DEFAULT '{"email": true, "telegram": false}'::jsonb,
  avatar_file_id uuid REFERENCES files(id),
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  status varchar(16) NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED','ACTIVE','BLOCKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz
);
ALTER TABLE organizations ADD CONSTRAINT fk_organizations_created_by FOREIGN KEY (created_by) REFERENCES users(id);
CREATE TABLE roles (
  id smallserial PRIMARY KEY,
  code varchar(16) NOT NULL UNIQUE CHECK (code IN ('FARMER','PROCESSOR','LAB','RETAILER','INSPECTOR','ADMIN')),
  name varchar(64) NOT NULL
);
CREATE TABLE user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  role_id smallint NOT NULL REFERENCES roles(id),
  UNIQUE (user_id, role_id)
);
CREATE INDEX ix_user_roles_role ON user_roles(role_id);
CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_refresh_tokens_user ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX ix_users_org ON users(organization_id) WHERE deleted_at IS NULL;
CREATE TRIGGER t_organizations_touch BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
INSERT INTO roles(code, name) VALUES
 ('FARMER','Фермер'),('PROCESSOR','Переработчик'),('LAB','Лаборант'),
 ('RETAILER','Сотрудник магазина'),('INSPECTOR','Инспектор'),('ADMIN','Администратор');
-- migrate:down
DROP TABLE refresh_tokens, user_roles, roles, users, organizations;
