-- migrate:up
CREATE TABLE fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name varchar(160) NOT NULL,
  area_ha numeric(10,2) NOT NULL CHECK (area_ha > 0),
  geometry jsonb,
  region_id uuid NOT NULL REFERENCES regions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz
);
CREATE TABLE treatments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id uuid NOT NULL REFERENCES fields(id),
  substance_id uuid NOT NULL REFERENCES substances(id),
  dose numeric(10,3) NOT NULL CHECK (dose > 0),
  dose_unit varchar(16) NOT NULL DEFAULT 'л/га',
  applied_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz
);
CREATE INDEX ix_treatments_field_applied ON treatments(field_id, applied_at);

CREATE SEQUENCE batch_code_seq;
CREATE FUNCTION next_batch_code() RETURNS varchar LANGUAGE sql VOLATILE AS $$
  SELECT 'AT-' || extract(year FROM now() AT TIME ZONE 'UTC')::int || '-' || lpad(nextval('batch_code_seq')::text, 6, '0')
$$;
CREATE SEQUENCE waybill_number_seq;
CREATE FUNCTION next_waybill_number() RETURNS varchar LANGUAGE sql VOLATILE AS $$
  SELECT 'WB-' || extract(year FROM now() AT TIME ZONE 'UTC')::int || '-' || lpad(nextval('waybill_number_seq')::text, 6, '0')
$$;

CREATE TABLE batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_code varchar(32) NOT NULL UNIQUE,
  product_id uuid NOT NULL REFERENCES products(id),
  origin_org_id uuid NOT NULL REFERENCES organizations(id),
  holder_org_id uuid REFERENCES organizations(id),
  field_id uuid REFERENCES fields(id),
  kind varchar(8) NOT NULL CHECK (kind IN ('RAW','DERIVED')),
  mass_kg numeric(12,3) NOT NULL CHECK (mass_kg > 0),
  harvested_at timestamptz,
  produced_at timestamptz,
  status varchar(16) NOT NULL DEFAULT 'Created' CHECK (status IN
    ('Created','OnTest','Approved','InTransit','Accepted','Processed','OnSale','Sold','Blocked','Recalled','WrittenOff')),
  test_required boolean NOT NULL DEFAULT false,
  test_reason varchar(24) CHECK (test_reason IN ('NEW_FARM','LOW_RATING','RECENT_PESTICIDE','SAMPLED','NONE')),
  qr_generated_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz,
  CHECK ((kind = 'RAW' AND harvested_at IS NOT NULL) OR (kind = 'DERIVED' AND produced_at IS NOT NULL))
);
CREATE INDEX ix_batches_status ON batches(status) WHERE deleted_at IS NULL;
CREATE INDEX ix_batches_holder ON batches(holder_org_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_batches_origin ON batches(origin_org_id);

CREATE TABLE batch_links (
  parent_batch_id uuid NOT NULL REFERENCES batches(id),
  child_batch_id uuid NOT NULL REFERENCES batches(id),
  mass_used_kg numeric(12,3) NOT NULL CHECK (mass_used_kg > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_batch_id, child_batch_id),
  CHECK (parent_batch_id <> child_batch_id)
);
CREATE INDEX ix_batch_links_child ON batch_links(child_batch_id);

CREATE TABLE batch_status_history (
  id bigserial PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES batches(id),
  from_status varchar(16),
  to_status varchar(16) NOT NULL,
  changed_by uuid REFERENCES users(id),
  reason varchar(500),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_bsh_batch ON batch_status_history(batch_id, changed_at);

CREATE TABLE waybills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number varchar(32) NOT NULL UNIQUE,
  sender_org_id uuid NOT NULL REFERENCES organizations(id),
  receiver_org_id uuid NOT NULL REFERENCES organizations(id),
  status varchar(16) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','ACCEPTED','REJECTED')),
  reject_reason varchar(500),
  sent_at timestamptz,
  accepted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz,
  CHECK (sender_org_id <> receiver_org_id)
);
CREATE INDEX ix_waybills_receiver ON waybills(receiver_org_id, status);
CREATE INDEX ix_waybills_sender ON waybills(sender_org_id, status);
CREATE TABLE waybill_items (
  waybill_id uuid NOT NULL REFERENCES waybills(id),
  batch_id uuid NOT NULL REFERENCES batches(id),
  mass_declared_kg numeric(12,3) NOT NULL CHECK (mass_declared_kg > 0),
  mass_actual_kg numeric(12,3) CHECK (mass_actual_kg >= 0),
  discrepancy_act varchar(2000),
  PRIMARY KEY (waybill_id, batch_id)
);
CREATE TRIGGER t_fields_touch BEFORE UPDATE ON fields FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_treatments_touch BEFORE UPDATE ON treatments FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_batches_touch BEFORE UPDATE ON batches FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_waybills_touch BEFORE UPDATE ON waybills FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
-- migrate:down
DROP TABLE waybill_items, waybills, batch_status_history, batch_links, batches, treatments, fields;
DROP FUNCTION next_waybill_number(); DROP SEQUENCE waybill_number_seq;
DROP FUNCTION next_batch_code(); DROP SEQUENCE batch_code_seq;
