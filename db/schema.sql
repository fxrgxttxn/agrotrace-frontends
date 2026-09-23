--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: next_batch_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_batch_code() RETURNS character varying
    LANGUAGE sql
    AS $$
  SELECT 'AT-' || extract(year FROM now() AT TIME ZONE 'UTC')::int || '-' || lpad(nextval('batch_code_seq')::text, 6, '0')
$$;


--
-- Name: next_waybill_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_waybill_number() RETURNS character varying
    LANGUAGE sql
    AS $$
  SELECT 'WB-' || extract(year FROM now() AT TIME ZONE 'UTC')::int || '-' || lpad(nextval('waybill_number_seq')::text, 6, '0')
$$;


--
-- Name: notify_notification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_notification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.channel = 'IN_APP' THEN
    PERFORM pg_notify('notifications', json_build_object('id', NEW.id, 'user_id', NEW.user_id)::text);
  END IF;
  RETURN NEW;
END $$;


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    actor_id uuid,
    action character varying(64) NOT NULL,
    entity_type character varying(64) NOT NULL,
    entity_id uuid,
    diff jsonb DEFAULT '{}'::jsonb NOT NULL,
    ip inet,
    backend character varying(8) NOT NULL,
    request_id character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT audit_log_backend_check CHECK (((backend)::text = ANY ((ARRAY['express'::character varying, 'django'::character varying, 'laravel'::character varying, 'seed'::character varying, 'system'::character varying])::text[])))
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;


--
-- Name: batch_code_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.batch_code_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: batch_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.batch_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    parent_batch_id uuid NOT NULL,
    child_batch_id uuid NOT NULL,
    mass_used_kg numeric(12,3) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT batch_links_check CHECK ((parent_batch_id <> child_batch_id)),
    CONSTRAINT batch_links_mass_used_kg_check CHECK ((mass_used_kg > (0)::numeric))
);


--
-- Name: batch_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.batch_status_history (
    id bigint NOT NULL,
    batch_id uuid NOT NULL,
    from_status character varying(16),
    to_status character varying(16) NOT NULL,
    changed_by uuid,
    reason character varying(500),
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT batch_status_history_from_status_check CHECK (((from_status)::text = ANY ((ARRAY['Created'::character varying, 'OnTest'::character varying, 'Approved'::character varying, 'InTransit'::character varying, 'Accepted'::character varying, 'Processed'::character varying, 'OnSale'::character varying, 'Sold'::character varying, 'Blocked'::character varying, 'Recalled'::character varying, 'WrittenOff'::character varying])::text[]))),
    CONSTRAINT batch_status_history_to_status_check CHECK (((to_status)::text = ANY ((ARRAY['Created'::character varying, 'OnTest'::character varying, 'Approved'::character varying, 'InTransit'::character varying, 'Accepted'::character varying, 'Processed'::character varying, 'OnSale'::character varying, 'Sold'::character varying, 'Blocked'::character varying, 'Recalled'::character varying, 'WrittenOff'::character varying])::text[])))
);


--
-- Name: batch_status_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.batch_status_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: batch_status_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.batch_status_history_id_seq OWNED BY public.batch_status_history.id;


--
-- Name: batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    public_code character varying(32) NOT NULL,
    product_id uuid NOT NULL,
    origin_org_id uuid NOT NULL,
    holder_org_id uuid,
    field_id uuid,
    kind character varying(8) NOT NULL,
    mass_kg numeric(12,3) NOT NULL,
    harvested_at timestamp with time zone,
    produced_at timestamp with time zone,
    status character varying(16) DEFAULT 'Created'::character varying NOT NULL,
    test_required boolean DEFAULT false NOT NULL,
    test_reason character varying(24),
    qr_generated_at timestamp with time zone,
    qr_png_file_id uuid,
    qr_pdf_file_id uuid,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    deleted_at timestamp with time zone,
    CONSTRAINT batches_check CHECK (((((kind)::text = 'RAW'::text) AND (harvested_at IS NOT NULL)) OR (((kind)::text = 'DERIVED'::text) AND (produced_at IS NOT NULL)))),
    CONSTRAINT batches_kind_check CHECK (((kind)::text = ANY ((ARRAY['RAW'::character varying, 'DERIVED'::character varying])::text[]))),
    CONSTRAINT batches_mass_kg_check CHECK ((mass_kg > (0)::numeric)),
    CONSTRAINT batches_status_check CHECK (((status)::text = ANY ((ARRAY['Created'::character varying, 'OnTest'::character varying, 'Approved'::character varying, 'InTransit'::character varying, 'Accepted'::character varying, 'Processed'::character varying, 'OnSale'::character varying, 'Sold'::character varying, 'Blocked'::character varying, 'Recalled'::character varying, 'WrittenOff'::character varying])::text[]))),
    CONSTRAINT batches_test_reason_check CHECK (((test_reason)::text = ANY ((ARRAY['NEW_FARM'::character varying, 'LOW_RATING'::character varying, 'RECENT_PESTICIDE'::character varying, 'SAMPLED'::character varying, 'NONE'::character varying])::text[])))
);


--
-- Name: complaints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.complaints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    batch_id uuid NOT NULL,
    text character varying(2000) NOT NULL,
    contact character varying(255),
    status character varying(16) DEFAULT 'NEW'::character varying NOT NULL,
    decision character varying(16),
    decision_comment character varying(1000),
    inspector_id uuid,
    ip inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT complaints_check CHECK ((((status)::text = 'DECIDED'::text) = (decision IS NOT NULL))),
    CONSTRAINT complaints_decision_check CHECK (((decision)::text = ANY ((ARRAY['REJECT'::character varying, 'LAB_TEST'::character varying, 'RECALL'::character varying])::text[]))),
    CONSTRAINT complaints_status_check CHECK (((status)::text = ANY ((ARRAY['NEW'::character varying, 'IN_REVIEW'::character varying, 'DECIDED'::character varying])::text[]))),
    CONSTRAINT complaints_text_check CHECK ((length((text)::text) >= 10))
);


--
-- Name: fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    name character varying(160) NOT NULL,
    area_ha numeric(10,2) NOT NULL,
    geometry jsonb,
    region_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    deleted_at timestamp with time zone,
    CONSTRAINT fields_area_ha_check CHECK ((area_ha > (0)::numeric))
);


--
-- Name: files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket character varying(63) NOT NULL,
    object_key character varying(512) NOT NULL,
    original_name character varying(255) NOT NULL,
    mime character varying(127) NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 character(64) NOT NULL,
    variants jsonb DEFAULT '{}'::jsonb NOT NULL,
    kind character varying(24) NOT NULL,
    owner_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT files_kind_check CHECK (((kind)::text = ANY ((ARRAY['AVATAR'::character varying, 'LOGO'::character varying, 'PRODUCT_IMAGE'::character varying, 'LAB_PROTOCOL'::character varying, 'QR'::character varying, 'REPORT'::character varying])::text[]))),
    CONSTRAINT files_size_bytes_check CHECK ((size_bytes >= 0))
);


--
-- Name: indicators; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.indicators (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(160) NOT NULL,
    unit character varying(24) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: lab_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lab_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lab_test_id uuid NOT NULL,
    indicator_id uuid NOT NULL,
    value numeric(14,6) NOT NULL,
    norm_value_snapshot numeric(14,6),
    is_exceeded boolean NOT NULL,
    CONSTRAINT lab_results_value_check CHECK ((value >= (0)::numeric))
);


--
-- Name: lab_tests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lab_tests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    batch_id uuid NOT NULL,
    lab_org_id uuid NOT NULL,
    reason character varying(16) NOT NULL,
    status character varying(16) DEFAULT 'QUEUED'::character varying NOT NULL,
    conclusion character varying(8),
    sampled_at timestamp with time zone,
    completed_at timestamp with time zone,
    due_at timestamp with time zone NOT NULL,
    escalated_at timestamp with time zone,
    protocol_file_id uuid,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    deleted_at timestamp with time zone,
    CONSTRAINT lab_tests_check CHECK ((((status)::text = 'DONE'::text) = (conclusion IS NOT NULL))),
    CONSTRAINT lab_tests_conclusion_check CHECK (((conclusion)::text = ANY ((ARRAY['PASS'::character varying, 'FAIL'::character varying])::text[]))),
    CONSTRAINT lab_tests_reason_check CHECK (((reason)::text = ANY ((ARRAY['PLANNED'::character varying, 'RISK'::character varying, 'COMPLAINT'::character varying, 'INSPECTOR'::character varying])::text[]))),
    CONSTRAINT lab_tests_status_check CHECK (((status)::text = ANY ((ARRAY['QUEUED'::character varying, 'SAMPLED'::character varying, 'DONE'::character varying, 'ESCALATED'::character varying, 'CANCELLED'::character varying])::text[])))
);


--
-- Name: norms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.norms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    product_id uuid NOT NULL,
    indicator_id uuid NOT NULL,
    max_value numeric(14,6) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT norms_max_value_check CHECK ((max_value >= (0)::numeric))
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type character varying(32) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    channel character varying(16) DEFAULT 'IN_APP'::character varying NOT NULL,
    delivery_status character varying(16) DEFAULT 'DELIVERED'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    seq bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notifications_channel_check CHECK (((channel)::text = ANY ((ARRAY['IN_APP'::character varying, 'EMAIL'::character varying, 'TELEGRAM'::character varying])::text[]))),
    CONSTRAINT notifications_delivery_status_check CHECK (((delivery_status)::text = ANY ((ARRAY['PENDING'::character varying, 'DELIVERED'::character varying, 'FAILED'::character varying, 'NOT_CONFIGURED'::character varying])::text[]))),
    CONSTRAINT notifications_type_check CHECK (((type)::text = ANY ((ARRAY['LAB_ASSIGNED'::character varying, 'LAB_RESULT'::character varying, 'WAYBILL_INCOMING'::character varying, 'RECALL'::character varying, 'RECALL_TASK'::character varying, 'OVERDUE'::character varying, 'COMPLAINT'::character varying, 'LAB_OVERDUE'::character varying])::text[])))
);


--
-- Name: notifications_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notifications_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notifications_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notifications_seq_seq OWNED BY public.notifications.seq;


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type character varying(16) NOT NULL,
    name character varying(255) NOT NULL,
    inn character varying(12) NOT NULL,
    address character varying(500),
    region_id uuid NOT NULL,
    trust_rating integer DEFAULT 80 NOT NULL,
    status character varying(16) DEFAULT 'PENDING'::character varying NOT NULL,
    logo_file_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    deleted_at timestamp with time zone,
    CONSTRAINT organizations_inn_check CHECK (((inn)::text ~ '^[0-9]{10}([0-9]{2})?$'::text)),
    CONSTRAINT organizations_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'MANUAL_CHECK'::character varying, 'ACTIVE'::character varying, 'REJECTED'::character varying, 'SUSPENDED'::character varying])::text[]))),
    CONSTRAINT organizations_trust_rating_check CHECK (((trust_rating >= 0) AND (trust_rating <= 100))),
    CONSTRAINT organizations_type_check CHECK (((type)::text = ANY ((ARRAY['FARM'::character varying, 'PROCESSOR'::character varying, 'LAB'::character varying, 'RETAILER'::character varying, 'AUTHORITY'::character varying, 'PLATFORM'::character varying])::text[])))
);


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(160) NOT NULL,
    category character varying(24) NOT NULL,
    loss_norm_percent numeric(5,2) NOT NULL,
    image_file_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT products_category_check CHECK (((category)::text = ANY ((ARRAY['GRAIN'::character varying, 'VEGETABLE'::character varying, 'FRUIT'::character varying, 'DAIRY'::character varying, 'MEAT'::character varying, 'OILSEED'::character varying, 'PROCESSED'::character varying])::text[]))),
    CONSTRAINT products_loss_norm_percent_check CHECK (((loss_norm_percent >= (0)::numeric) AND (loss_norm_percent <= (100)::numeric)))
);


--
-- Name: recall_batches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recall_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recall_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    direction character varying(8) NOT NULL,
    depth integer NOT NULL,
    status_before character varying(16) NOT NULL,
    CONSTRAINT recall_batches_depth_check CHECK ((depth >= 0)),
    CONSTRAINT recall_batches_direction_check CHECK (((direction)::text = ANY ((ARRAY['SOURCE'::character varying, 'DOWN'::character varying, 'UP'::character varying])::text[]))),
    CONSTRAINT recall_batches_status_before_check CHECK (((status_before)::text = ANY ((ARRAY['Created'::character varying, 'OnTest'::character varying, 'Approved'::character varying, 'InTransit'::character varying, 'Accepted'::character varying, 'Processed'::character varying, 'OnSale'::character varying, 'Sold'::character varying, 'Blocked'::character varying, 'Recalled'::character varying, 'WrittenOff'::character varying])::text[])))
);


--
-- Name: recall_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recall_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    recall_id uuid NOT NULL,
    holder_org_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    due_at timestamp with time zone NOT NULL,
    status character varying(12) DEFAULT 'OPEN'::character varying NOT NULL,
    confirmed_by uuid,
    confirmed_at timestamp with time zone,
    escalated_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recall_tasks_check CHECK ((((status)::text = 'CONFIRMED'::text) = (confirmed_at IS NOT NULL))),
    CONSTRAINT recall_tasks_status_check CHECK (((status)::text = ANY ((ARRAY['OPEN'::character varying, 'CONFIRMED'::character varying, 'OVERDUE'::character varying])::text[])))
);


--
-- Name: recalls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recalls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_batch_id uuid NOT NULL,
    trigger character varying(16) NOT NULL,
    reason character varying(1000) NOT NULL,
    status character varying(8) DEFAULT 'OPEN'::character varying NOT NULL,
    lab_test_id uuid,
    complaint_id uuid,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    deleted_at timestamp with time zone,
    CONSTRAINT recalls_check CHECK ((((status)::text = 'CLOSED'::text) = (closed_at IS NOT NULL))),
    CONSTRAINT recalls_status_check CHECK (((status)::text = ANY ((ARRAY['OPEN'::character varying, 'CLOSED'::character varying])::text[]))),
    CONSTRAINT recalls_trigger_check CHECK (((trigger)::text = ANY ((ARRAY['LAB'::character varying, 'INSPECTOR'::character varying, 'COMPLAINT'::character varying])::text[])))
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash character(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    replaced_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: regions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.regions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(120) NOT NULL,
    code character varying(8) NOT NULL
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id smallint NOT NULL,
    code character varying(16) NOT NULL,
    name character varying(64) NOT NULL,
    CONSTRAINT roles_code_check CHECK (((code)::text = ANY ((ARRAY['FARMER'::character varying, 'PROCESSOR'::character varying, 'LAB'::character varying, 'RETAILER'::character varying, 'INSPECTOR'::character varying, 'ADMIN'::character varying])::text[])))
);


--
-- Name: roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.roles_id_seq
    AS smallint
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: substances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.substances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(160) NOT NULL,
    type character varying(16) NOT NULL,
    waiting_period_days integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT substances_type_check CHECK (((type)::text = ANY ((ARRAY['PESTICIDE'::character varying, 'FERTILIZER'::character varying])::text[]))),
    CONSTRAINT substances_waiting_period_days_check CHECK ((waiting_period_days >= 0))
);


--
-- Name: treatments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.treatments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    field_id uuid NOT NULL,
    substance_id uuid NOT NULL,
    dose numeric(10,3) NOT NULL,
    dose_unit character varying(16) DEFAULT 'л/га'::character varying NOT NULL,
    applied_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    deleted_at timestamp with time zone,
    CONSTRAINT treatments_dose_check CHECK ((dose > (0)::numeric))
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role_id smallint NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    email public.citext NOT NULL,
    password_hash character varying(255) NOT NULL,
    full_name character varying(255) NOT NULL,
    phone character varying(32),
    is_org_admin boolean DEFAULT false NOT NULL,
    totp_secret character varying(64),
    totp_enabled boolean DEFAULT false NOT NULL,
    telegram_chat_id bigint,
    notification_channels jsonb DEFAULT '{"email": true, "telegram": false}'::jsonb NOT NULL,
    avatar_file_id uuid,
    failed_logins integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    status character varying(16) DEFAULT 'INVITED'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    deleted_at timestamp with time zone,
    CONSTRAINT users_status_check CHECK (((status)::text = ANY ((ARRAY['INVITED'::character varying, 'ACTIVE'::character varying, 'BLOCKED'::character varying])::text[])))
);


--
-- Name: waybill_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.waybill_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    waybill_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    mass_declared_kg numeric(12,3) NOT NULL,
    mass_actual_kg numeric(12,3),
    discrepancy_act character varying(2000),
    CONSTRAINT waybill_items_mass_actual_kg_check CHECK ((mass_actual_kg >= (0)::numeric)),
    CONSTRAINT waybill_items_mass_declared_kg_check CHECK ((mass_declared_kg > (0)::numeric))
);


--
-- Name: waybill_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.waybill_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: waybills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.waybills (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    number character varying(32) NOT NULL,
    sender_org_id uuid NOT NULL,
    receiver_org_id uuid NOT NULL,
    status character varying(16) DEFAULT 'DRAFT'::character varying NOT NULL,
    reject_reason character varying(500),
    sent_at timestamp with time zone,
    accepted_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    deleted_at timestamp with time zone,
    CONSTRAINT waybills_check CHECK ((sender_org_id <> receiver_org_id)),
    CONSTRAINT waybills_status_check CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, 'SENT'::character varying, 'ACCEPTED'::character varying, 'REJECTED'::character varying])::text[])))
);


--
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);


--
-- Name: batch_status_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batch_status_history ALTER COLUMN id SET DEFAULT nextval('public.batch_status_history_id_seq'::regclass);


--
-- Name: notifications seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications ALTER COLUMN seq SET DEFAULT nextval('public.notifications_seq_seq'::regclass);


--
-- Name: roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: batch_links batch_links_parent_batch_id_child_batch_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batch_links
    ADD CONSTRAINT batch_links_parent_batch_id_child_batch_id_key UNIQUE (parent_batch_id, child_batch_id);


--
-- Name: batch_links batch_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batch_links
    ADD CONSTRAINT batch_links_pkey PRIMARY KEY (id);


--
-- Name: batch_status_history batch_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batch_status_history
    ADD CONSTRAINT batch_status_history_pkey PRIMARY KEY (id);


--
-- Name: batches batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_pkey PRIMARY KEY (id);


--
-- Name: batches batches_public_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_public_code_key UNIQUE (public_code);


--
-- Name: complaints complaints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.complaints
    ADD CONSTRAINT complaints_pkey PRIMARY KEY (id);


--
-- Name: fields fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fields
    ADD CONSTRAINT fields_pkey PRIMARY KEY (id);


--
-- Name: files files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);


--
-- Name: indicators indicators_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.indicators
    ADD CONSTRAINT indicators_name_key UNIQUE (name);


--
-- Name: indicators indicators_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.indicators
    ADD CONSTRAINT indicators_pkey PRIMARY KEY (id);


--
-- Name: lab_results lab_results_lab_test_id_indicator_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_results
    ADD CONSTRAINT lab_results_lab_test_id_indicator_id_key UNIQUE (lab_test_id, indicator_id);


--
-- Name: lab_results lab_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_results
    ADD CONSTRAINT lab_results_pkey PRIMARY KEY (id);


--
-- Name: lab_tests lab_tests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_tests
    ADD CONSTRAINT lab_tests_pkey PRIMARY KEY (id);


--
-- Name: norms norms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.norms
    ADD CONSTRAINT norms_pkey PRIMARY KEY (id);


--
-- Name: norms norms_product_id_indicator_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.norms
    ADD CONSTRAINT norms_product_id_indicator_id_key UNIQUE (product_id, indicator_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_seq_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_seq_key UNIQUE (seq);


--
-- Name: organizations organizations_inn_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_inn_key UNIQUE (inn);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: recall_batches recall_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_batches
    ADD CONSTRAINT recall_batches_pkey PRIMARY KEY (id);


--
-- Name: recall_batches recall_batches_recall_id_batch_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_batches
    ADD CONSTRAINT recall_batches_recall_id_batch_id_key UNIQUE (recall_id, batch_id);


--
-- Name: recall_tasks recall_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_pkey PRIMARY KEY (id);


--
-- Name: recall_tasks recall_tasks_recall_id_batch_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_recall_id_batch_id_key UNIQUE (recall_id, batch_id);


--
-- Name: recalls recalls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: regions regions_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_code_key UNIQUE (code);


--
-- Name: regions regions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_pkey PRIMARY KEY (id);


--
-- Name: roles roles_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_code_key UNIQUE (code);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: substances substances_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substances
    ADD CONSTRAINT substances_name_key UNIQUE (name);


--
-- Name: substances substances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substances
    ADD CONSTRAINT substances_pkey PRIMARY KEY (id);


--
-- Name: treatments treatments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatments
    ADD CONSTRAINT treatments_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_user_id_role_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_role_id_key UNIQUE (user_id, role_id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: waybill_items waybill_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waybill_items
    ADD CONSTRAINT waybill_items_pkey PRIMARY KEY (id);


--
-- Name: waybill_items waybill_items_waybill_id_batch_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waybill_items
    ADD CONSTRAINT waybill_items_waybill_id_batch_id_key UNIQUE (waybill_id, batch_id);


--
-- Name: waybills waybills_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waybills
    ADD CONSTRAINT waybills_number_key UNIQUE (number);


--
-- Name: waybills waybills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waybills
    ADD CONSTRAINT waybills_pkey PRIMARY KEY (id);


--
-- Name: ix_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_created ON public.audit_log USING btree (created_at DESC);


--
-- Name: ix_audit_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audit_entity ON public.audit_log USING btree (entity_type, entity_id);


--
-- Name: ix_batch_links_child; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_batch_links_child ON public.batch_links USING btree (child_batch_id);


--
-- Name: ix_batches_holder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_batches_holder ON public.batches USING btree (holder_org_id) WHERE (deleted_at IS NULL);


--
-- Name: ix_batches_origin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_batches_origin ON public.batches USING btree (origin_org_id);


--
-- Name: ix_batches_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_batches_status ON public.batches USING btree (status) WHERE (deleted_at IS NULL);


--
-- Name: ix_bsh_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_bsh_batch ON public.batch_status_history USING btree (batch_id, changed_at);


--
-- Name: ix_complaints_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_complaints_batch ON public.complaints USING btree (batch_id);


--
-- Name: ix_fields_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_fields_org ON public.fields USING btree (organization_id);


--
-- Name: ix_lab_tests_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_lab_tests_batch ON public.lab_tests USING btree (batch_id);


--
-- Name: ix_lab_tests_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_lab_tests_queue ON public.lab_tests USING btree (lab_org_id, status, due_at);


--
-- Name: ix_notifications_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_notifications_user ON public.notifications USING btree (user_id, is_read, created_at DESC) WHERE ((channel)::text = 'IN_APP'::text);


--
-- Name: ix_recall_batches_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_recall_batches_batch ON public.recall_batches USING btree (batch_id);


--
-- Name: ix_recall_tasks_holder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_recall_tasks_holder ON public.recall_tasks USING btree (holder_org_id, status);


--
-- Name: ix_recall_tasks_status_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_recall_tasks_status_due ON public.recall_tasks USING btree (status, due_at);


--
-- Name: ix_recalls_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_recalls_source ON public.recalls USING btree (source_batch_id);


--
-- Name: ix_refresh_tokens_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_refresh_tokens_user ON public.refresh_tokens USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: ix_treatments_field_applied; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_treatments_field_applied ON public.treatments USING btree (field_id, applied_at);


--
-- Name: ix_user_roles_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_roles_role ON public.user_roles USING btree (role_id);


--
-- Name: ix_users_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_users_org ON public.users USING btree (organization_id) WHERE (deleted_at IS NULL);


--
-- Name: ix_waybill_items_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_waybill_items_batch ON public.waybill_items USING btree (batch_id);


--
-- Name: ix_waybills_receiver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_waybills_receiver ON public.waybills USING btree (receiver_org_id, status);


--
-- Name: ix_waybills_sender; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_waybills_sender ON public.waybills USING btree (sender_org_id, status);


--
-- Name: ux_recalls_open_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_recalls_open_source ON public.recalls USING btree (source_batch_id) WHERE ((status)::text = 'OPEN'::text);


--
-- Name: batches t_batches_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_batches_touch BEFORE UPDATE ON public.batches FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: complaints t_complaints_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_complaints_touch BEFORE UPDATE ON public.complaints FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: fields t_fields_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_fields_touch BEFORE UPDATE ON public.fields FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: indicators t_indicators_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_indicators_touch BEFORE UPDATE ON public.indicators FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: lab_tests t_lab_tests_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_lab_tests_touch BEFORE UPDATE ON public.lab_tests FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: norms t_norms_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_norms_touch BEFORE UPDATE ON public.norms FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: notifications t_notifications_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_notifications_notify AFTER INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.notify_notification();


--
-- Name: organizations t_organizations_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_organizations_touch BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: products t_products_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_products_touch BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: recall_tasks t_recall_tasks_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_recall_tasks_touch BEFORE UPDATE ON public.recall_tasks FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: recalls t_recalls_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_recalls_touch BEFORE UPDATE ON public.recalls FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: substances t_substances_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_substances_touch BEFORE UPDATE ON public.substances FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: treatments t_treatments_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_treatments_touch BEFORE UPDATE ON public.treatments FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: users t_users_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_users_touch BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: waybills t_waybills_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_waybills_touch BEFORE UPDATE ON public.waybills FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: batch_links batch_links_child_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batch_links
    ADD CONSTRAINT batch_links_child_batch_id_fkey FOREIGN KEY (child_batch_id) REFERENCES public.batches(id);


--
-- Name: batch_links batch_links_parent_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batch_links
    ADD CONSTRAINT batch_links_parent_batch_id_fkey FOREIGN KEY (parent_batch_id) REFERENCES public.batches(id);


--
-- Name: batch_status_history batch_status_history_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batch_status_history
    ADD CONSTRAINT batch_status_history_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: batch_status_history batch_status_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batch_status_history
    ADD CONSTRAINT batch_status_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id);


--
-- Name: batches batches_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: batches batches_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_field_id_fkey FOREIGN KEY (field_id) REFERENCES public.fields(id);


--
-- Name: batches batches_holder_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_holder_org_id_fkey FOREIGN KEY (holder_org_id) REFERENCES public.organizations(id);


--
-- Name: batches batches_origin_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_origin_org_id_fkey FOREIGN KEY (origin_org_id) REFERENCES public.organizations(id);


--
-- Name: batches batches_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: batches batches_qr_pdf_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_qr_pdf_file_id_fkey FOREIGN KEY (qr_pdf_file_id) REFERENCES public.files(id);


--
-- Name: batches batches_qr_png_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batches
    ADD CONSTRAINT batches_qr_png_file_id_fkey FOREIGN KEY (qr_png_file_id) REFERENCES public.files(id);


--
-- Name: complaints complaints_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.complaints
    ADD CONSTRAINT complaints_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: complaints complaints_inspector_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.complaints
    ADD CONSTRAINT complaints_inspector_id_fkey FOREIGN KEY (inspector_id) REFERENCES public.users(id);


--
-- Name: fields fields_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fields
    ADD CONSTRAINT fields_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: fields fields_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fields
    ADD CONSTRAINT fields_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: fields fields_region_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fields
    ADD CONSTRAINT fields_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.regions(id);


--
-- Name: organizations fk_organizations_created_by; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT fk_organizations_created_by FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: recalls fk_recalls_complaint; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT fk_recalls_complaint FOREIGN KEY (complaint_id) REFERENCES public.complaints(id);


--
-- Name: lab_results lab_results_indicator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_results
    ADD CONSTRAINT lab_results_indicator_id_fkey FOREIGN KEY (indicator_id) REFERENCES public.indicators(id);


--
-- Name: lab_results lab_results_lab_test_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_results
    ADD CONSTRAINT lab_results_lab_test_id_fkey FOREIGN KEY (lab_test_id) REFERENCES public.lab_tests(id);


--
-- Name: lab_tests lab_tests_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_tests
    ADD CONSTRAINT lab_tests_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: lab_tests lab_tests_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_tests
    ADD CONSTRAINT lab_tests_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: lab_tests lab_tests_lab_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_tests
    ADD CONSTRAINT lab_tests_lab_org_id_fkey FOREIGN KEY (lab_org_id) REFERENCES public.organizations(id);


--
-- Name: lab_tests lab_tests_protocol_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lab_tests
    ADD CONSTRAINT lab_tests_protocol_file_id_fkey FOREIGN KEY (protocol_file_id) REFERENCES public.files(id);


--
-- Name: norms norms_indicator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.norms
    ADD CONSTRAINT norms_indicator_id_fkey FOREIGN KEY (indicator_id) REFERENCES public.indicators(id);


--
-- Name: norms norms_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.norms
    ADD CONSTRAINT norms_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: organizations organizations_logo_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_logo_file_id_fkey FOREIGN KEY (logo_file_id) REFERENCES public.files(id);


--
-- Name: organizations organizations_region_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.regions(id);


--
-- Name: products products_image_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_image_file_id_fkey FOREIGN KEY (image_file_id) REFERENCES public.files(id);


--
-- Name: recall_batches recall_batches_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_batches
    ADD CONSTRAINT recall_batches_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: recall_batches recall_batches_recall_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_batches
    ADD CONSTRAINT recall_batches_recall_id_fkey FOREIGN KEY (recall_id) REFERENCES public.recalls(id);


--
-- Name: recall_tasks recall_tasks_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: recall_tasks recall_tasks_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.users(id);


--
-- Name: recall_tasks recall_tasks_holder_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_holder_org_id_fkey FOREIGN KEY (holder_org_id) REFERENCES public.organizations(id);


--
-- Name: recall_tasks recall_tasks_recall_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recall_tasks
    ADD CONSTRAINT recall_tasks_recall_id_fkey FOREIGN KEY (recall_id) REFERENCES public.recalls(id);


--
-- Name: recalls recalls_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: recalls recalls_lab_test_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_lab_test_id_fkey FOREIGN KEY (lab_test_id) REFERENCES public.lab_tests(id);


--
-- Name: recalls recalls_source_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recalls
    ADD CONSTRAINT recalls_source_batch_id_fkey FOREIGN KEY (source_batch_id) REFERENCES public.batches(id);


--
-- Name: refresh_tokens refresh_tokens_replaced_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_replaced_by_fkey FOREIGN KEY (replaced_by) REFERENCES public.refresh_tokens(id);


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: treatments treatments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatments
    ADD CONSTRAINT treatments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: treatments treatments_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatments
    ADD CONSTRAINT treatments_field_id_fkey FOREIGN KEY (field_id) REFERENCES public.fields(id);


--
-- Name: treatments treatments_substance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.treatments
    ADD CONSTRAINT treatments_substance_id_fkey FOREIGN KEY (substance_id) REFERENCES public.substances(id);


--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: users users_avatar_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_avatar_file_id_fkey FOREIGN KEY (avatar_file_id) REFERENCES public.files(id);


--
-- Name: users users_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: users users_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);


--
-- Name: waybill_items waybill_items_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waybill_items
    ADD CONSTRAINT waybill_items_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.batches(id);


--
-- Name: waybill_items waybill_items_waybill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waybill_items
    ADD CONSTRAINT waybill_items_waybill_id_fkey FOREIGN KEY (waybill_id) REFERENCES public.waybills(id);


--
-- Name: waybills waybills_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waybills
    ADD CONSTRAINT waybills_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: waybills waybills_receiver_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waybills
    ADD CONSTRAINT waybills_receiver_org_id_fkey FOREIGN KEY (receiver_org_id) REFERENCES public.organizations(id);


--
-- Name: waybills waybills_sender_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waybills
    ADD CONSTRAINT waybills_sender_org_id_fkey FOREIGN KEY (sender_org_id) REFERENCES public.organizations(id);


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO agrotrace_app;


--
-- Name: FUNCTION citextin(cstring); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citextin(cstring) TO agrotrace_app;


--
-- Name: FUNCTION citextout(public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citextout(public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citextrecv(internal); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citextrecv(internal) TO agrotrace_app;


--
-- Name: FUNCTION citextsend(public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citextsend(public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext(boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext(boolean) TO agrotrace_app;


--
-- Name: FUNCTION citext(character); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext(character) TO agrotrace_app;


--
-- Name: FUNCTION citext(inet); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext(inet) TO agrotrace_app;


--
-- Name: FUNCTION citext_cmp(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_cmp(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext_eq(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_eq(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext_ge(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_ge(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext_gt(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_gt(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext_hash(public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_hash(public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext_hash_extended(public.citext, bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_hash_extended(public.citext, bigint) TO agrotrace_app;


--
-- Name: FUNCTION citext_larger(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_larger(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext_le(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_le(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext_lt(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_lt(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext_ne(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_ne(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext_pattern_cmp(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_pattern_cmp(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext_pattern_ge(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_pattern_ge(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext_pattern_gt(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_pattern_gt(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext_pattern_le(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_pattern_le(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext_pattern_lt(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_pattern_lt(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION citext_smaller(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.citext_smaller(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION next_batch_code(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.next_batch_code() TO agrotrace_app;


--
-- Name: FUNCTION next_waybill_number(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.next_waybill_number() TO agrotrace_app;


--
-- Name: FUNCTION notify_notification(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notify_notification() TO agrotrace_app;


--
-- Name: FUNCTION regexp_match(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.regexp_match(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION regexp_match(public.citext, public.citext, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.regexp_match(public.citext, public.citext, text) TO agrotrace_app;


--
-- Name: FUNCTION regexp_matches(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.regexp_matches(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION regexp_matches(public.citext, public.citext, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.regexp_matches(public.citext, public.citext, text) TO agrotrace_app;


--
-- Name: FUNCTION regexp_replace(public.citext, public.citext, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.regexp_replace(public.citext, public.citext, text) TO agrotrace_app;


--
-- Name: FUNCTION regexp_replace(public.citext, public.citext, text, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.regexp_replace(public.citext, public.citext, text, text) TO agrotrace_app;


--
-- Name: FUNCTION regexp_split_to_array(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.regexp_split_to_array(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION regexp_split_to_array(public.citext, public.citext, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.regexp_split_to_array(public.citext, public.citext, text) TO agrotrace_app;


--
-- Name: FUNCTION regexp_split_to_table(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.regexp_split_to_table(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION regexp_split_to_table(public.citext, public.citext, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.regexp_split_to_table(public.citext, public.citext, text) TO agrotrace_app;


--
-- Name: FUNCTION replace(public.citext, public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.replace(public.citext, public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION split_part(public.citext, public.citext, integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.split_part(public.citext, public.citext, integer) TO agrotrace_app;


--
-- Name: FUNCTION strpos(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.strpos(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION texticlike(public.citext, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.texticlike(public.citext, text) TO agrotrace_app;


--
-- Name: FUNCTION texticlike(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.texticlike(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION texticnlike(public.citext, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.texticnlike(public.citext, text) TO agrotrace_app;


--
-- Name: FUNCTION texticnlike(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.texticnlike(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION texticregexeq(public.citext, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.texticregexeq(public.citext, text) TO agrotrace_app;


--
-- Name: FUNCTION texticregexeq(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.texticregexeq(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION texticregexne(public.citext, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.texticregexne(public.citext, text) TO agrotrace_app;


--
-- Name: FUNCTION texticregexne(public.citext, public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.texticregexne(public.citext, public.citext) TO agrotrace_app;


--
-- Name: FUNCTION touch_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.touch_updated_at() TO agrotrace_app;


--
-- Name: FUNCTION translate(public.citext, public.citext, text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.translate(public.citext, public.citext, text) TO agrotrace_app;


--
-- Name: FUNCTION max(public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.max(public.citext) TO agrotrace_app;


--
-- Name: FUNCTION min(public.citext); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.min(public.citext) TO agrotrace_app;


--
-- Name: TABLE audit_log; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.audit_log TO agrotrace_app;


--
-- Name: SEQUENCE audit_log_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.audit_log_id_seq TO agrotrace_app;


--
-- Name: SEQUENCE batch_code_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.batch_code_seq TO agrotrace_app;


--
-- Name: TABLE batch_links; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.batch_links TO agrotrace_app;


--
-- Name: TABLE batch_status_history; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.batch_status_history TO agrotrace_app;


--
-- Name: SEQUENCE batch_status_history_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.batch_status_history_id_seq TO agrotrace_app;


--
-- Name: TABLE batches; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.batches TO agrotrace_app;


--
-- Name: TABLE complaints; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.complaints TO agrotrace_app;


--
-- Name: TABLE fields; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.fields TO agrotrace_app;


--
-- Name: TABLE files; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.files TO agrotrace_app;


--
-- Name: TABLE indicators; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.indicators TO agrotrace_app;


--
-- Name: TABLE lab_results; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lab_results TO agrotrace_app;


--
-- Name: TABLE lab_tests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lab_tests TO agrotrace_app;


--
-- Name: TABLE norms; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.norms TO agrotrace_app;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notifications TO agrotrace_app;


--
-- Name: SEQUENCE notifications_seq_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.notifications_seq_seq TO agrotrace_app;


--
-- Name: TABLE organizations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organizations TO agrotrace_app;


--
-- Name: TABLE products; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.products TO agrotrace_app;


--
-- Name: TABLE recall_batches; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.recall_batches TO agrotrace_app;


--
-- Name: TABLE recall_tasks; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.recall_tasks TO agrotrace_app;


--
-- Name: TABLE recalls; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.recalls TO agrotrace_app;


--
-- Name: TABLE refresh_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.refresh_tokens TO agrotrace_app;


--
-- Name: TABLE regions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.regions TO agrotrace_app;


--
-- Name: TABLE roles; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.roles TO agrotrace_app;


--
-- Name: SEQUENCE roles_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.roles_id_seq TO agrotrace_app;


--
-- Name: TABLE schema_migrations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.schema_migrations TO agrotrace_app;


--
-- Name: TABLE substances; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.substances TO agrotrace_app;


--
-- Name: TABLE treatments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.treatments TO agrotrace_app;


--
-- Name: TABLE user_roles; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_roles TO agrotrace_app;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO agrotrace_app;


--
-- Name: TABLE waybill_items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.waybill_items TO agrotrace_app;


--
-- Name: SEQUENCE waybill_number_seq; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,USAGE ON SEQUENCE public.waybill_number_seq TO agrotrace_app;


--
-- Name: TABLE waybills; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.waybills TO agrotrace_app;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE agrotrace_owner IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO agrotrace_app;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE agrotrace_owner IN SCHEMA public GRANT ALL ON FUNCTIONS TO agrotrace_app;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE agrotrace_owner IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO agrotrace_app;


--
-- PostgreSQL database dump complete
--



--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20260923000001'),
    ('20260923000002'),
    ('20260923000003'),
    ('20260923000004'),
    ('20260923000005'),
    ('20260923000006');
