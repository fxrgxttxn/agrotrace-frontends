-- migrate:up
CREATE TABLE regions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  code varchar(8) NOT NULL UNIQUE
);
CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket varchar(63) NOT NULL,
  object_key varchar(512) NOT NULL,
  original_name varchar(255) NOT NULL,
  mime varchar(127) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 char(64) NOT NULL,
  variants jsonb NOT NULL DEFAULT '{}'::jsonb,
  kind varchar(24) NOT NULL CHECK (kind IN ('AVATAR','LOGO','PRODUCT_IMAGE','LAB_PROTOCOL','QR','REPORT')),
  owner_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  category varchar(24) NOT NULL CHECK (category IN ('GRAIN','VEGETABLE','FRUIT','DAIRY','MEAT','OILSEED','PROCESSED')),
  loss_norm_percent numeric(5,2) NOT NULL CHECK (loss_norm_percent BETWEEN 0 AND 100),
  image_file_id uuid REFERENCES files(id),
  -- R81: product code of ФГИС «Меркурий» (OKPD2-style, e.g. 10.51.11) used by the VSD import; NULL — no code.
  mercury_code varchar(16) CHECK (mercury_code ~ '^[0-9]{2}(\.[0-9]{1,3}){1,3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE substances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL UNIQUE,
  type varchar(16) NOT NULL CHECK (type IN ('PESTICIDE','FERTILIZER')),
  waiting_period_days integer NOT NULL CHECK (waiting_period_days >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE indicators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL UNIQUE,
  unit varchar(24) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE norms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id),
  indicator_id uuid NOT NULL REFERENCES indicators(id),
  max_value numeric(14,6) NOT NULL CHECK (max_value >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, indicator_id)
);
CREATE UNIQUE INDEX ux_products_name ON products(name);
CREATE TRIGGER t_products_touch BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_substances_touch BEFORE UPDATE ON substances FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_indicators_touch BEFORE UPDATE ON indicators FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_norms_touch BEFORE UPDATE ON norms FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
INSERT INTO regions(name, code) VALUES
 ('Владимирская область','33'),('Московская область','50'),('Ивановская область','37'),
 ('Нижегородская область','52'),('Ярославская область','76'),('Рязанская область','62');
-- migrate:down
DROP TABLE norms, indicators, substances, products, files, regions;
