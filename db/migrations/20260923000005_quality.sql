-- migrate:up
CREATE TABLE lab_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id),
  lab_org_id uuid NOT NULL REFERENCES organizations(id),
  reason varchar(16) NOT NULL CHECK (reason IN ('PLANNED','RISK','COMPLAINT','INSPECTOR')),
  status varchar(16) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SAMPLED','DONE','ESCALATED','CANCELLED')),
  conclusion varchar(8) CHECK (conclusion IN ('PASS','FAIL')),
  sampled_at timestamptz,
  completed_at timestamptz,
  due_at timestamptz NOT NULL,
  escalated_at timestamptz,
  protocol_file_id uuid REFERENCES files(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz,
  CHECK ((status = 'DONE') = (conclusion IS NOT NULL))
);
CREATE INDEX ix_lab_tests_queue ON lab_tests(lab_org_id, status, due_at);
CREATE INDEX ix_lab_tests_batch ON lab_tests(batch_id);
CREATE TABLE lab_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_test_id uuid NOT NULL REFERENCES lab_tests(id),
  indicator_id uuid NOT NULL REFERENCES indicators(id),
  value numeric(14,6) NOT NULL CHECK (value >= 0),
  norm_value_snapshot numeric(14,6),
  is_exceeded boolean NOT NULL,
  UNIQUE (lab_test_id, indicator_id)
);
CREATE TABLE recalls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_batch_id uuid NOT NULL REFERENCES batches(id),
  trigger varchar(16) NOT NULL CHECK (trigger IN ('LAB','INSPECTOR','COMPLAINT')),
  reason varchar(1000) NOT NULL,
  status varchar(8) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  block_upstream boolean NOT NULL DEFAULT false,
  lab_test_id uuid REFERENCES lab_tests(id),
  complaint_id uuid,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  deleted_at timestamptz,
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX ux_recalls_open_source ON recalls(source_batch_id) WHERE status = 'OPEN';
CREATE INDEX ix_recalls_source ON recalls(source_batch_id);
CREATE TABLE recall_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recall_id uuid NOT NULL REFERENCES recalls(id),
  batch_id uuid NOT NULL REFERENCES batches(id),
  direction varchar(8) NOT NULL CHECK (direction IN ('SOURCE','DOWN','UP')),
  depth integer NOT NULL CHECK (depth >= 0),
  status_before varchar(16) NOT NULL CHECK (status_before IN
    ('Created','OnTest','Approved','InTransit','Accepted','Processed','OnSale','Sold','Blocked','Recalled','WrittenOff')),
  UNIQUE (recall_id, batch_id)
);
CREATE INDEX ix_recall_batches_batch ON recall_batches(batch_id);
CREATE TABLE recall_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recall_id uuid NOT NULL REFERENCES recalls(id),
  holder_org_id uuid NOT NULL REFERENCES organizations(id),
  batch_id uuid NOT NULL REFERENCES batches(id),
  due_at timestamptz NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONFIRMED','OVERDUE')),
  confirmed_by uuid REFERENCES users(id),
  confirmed_at timestamptz,
  escalated_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recall_id, batch_id),
  CHECK ((status = 'CONFIRMED') = (confirmed_at IS NOT NULL))
);
CREATE INDEX ix_recall_tasks_status_due ON recall_tasks(status, due_at);
CREATE INDEX ix_recall_tasks_holder ON recall_tasks(holder_org_id, status);
CREATE TABLE complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batches(id),
  text varchar(2000) NOT NULL CHECK (length(text) >= 10),
  contact varchar(255),
  status varchar(16) NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','IN_REVIEW','DECIDED')),
  decision varchar(16) CHECK (decision IN ('REJECT','LAB_TEST','RECALL')),
  decision_comment varchar(1000),
  inspector_id uuid REFERENCES users(id),
  lab_test_id uuid REFERENCES lab_tests(id),
  recall_id uuid REFERENCES recalls(id),
  decided_at timestamptz,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((status = 'DECIDED') = (decision IS NOT NULL)),
  CHECK ((status = 'DECIDED') = (decided_at IS NOT NULL)),
  CHECK ((decision IS NOT DISTINCT FROM 'LAB_TEST') = (lab_test_id IS NOT NULL)),
  CHECK ((decision IS NOT DISTINCT FROM 'RECALL') = (recall_id IS NOT NULL))
);
CREATE INDEX ix_complaints_batch ON complaints(batch_id);
ALTER TABLE recalls ADD CONSTRAINT fk_recalls_complaint FOREIGN KEY (complaint_id) REFERENCES complaints(id);
CREATE TRIGGER t_lab_tests_touch BEFORE UPDATE ON lab_tests FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_recalls_touch BEFORE UPDATE ON recalls FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_recall_tasks_touch BEFORE UPDATE ON recall_tasks FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER t_complaints_touch BEFORE UPDATE ON complaints FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
-- migrate:down
ALTER TABLE recalls DROP CONSTRAINT fk_recalls_complaint;
DROP TABLE complaints, recall_tasks, recall_batches, recalls, lab_results, lab_tests;
