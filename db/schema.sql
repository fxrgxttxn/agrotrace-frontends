\restrict dbmate

-- Dumped from database version 16.15
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
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
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


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
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;


--
-- Name: batch_code_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.batch_code_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: batch_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.batch_links (
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
    changed_at timestamp with time zone DEFAULT now() NOT NULL
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
-- Name: batch_status_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batch_status_history ALTER COLUMN id SET DEFAULT nextval('public.batch_status_history_id_seq'::regclass);


--
-- Name: roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);


--
-- Name: batch_links batch_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.batch_links
    ADD CONSTRAINT batch_links_pkey PRIMARY KEY (parent_batch_id, child_batch_id);


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
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id);


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
    ADD CONSTRAINT waybill_items_pkey PRIMARY KEY (waybill_id, batch_id);


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
-- Name: ix_refresh_tokens_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_refresh_tokens_user ON public.refresh_tokens USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: ix_treatments_field_applied; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_treatments_field_applied ON public.treatments USING btree (field_id, applied_at);


--
-- Name: ix_users_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_users_org ON public.users USING btree (organization_id) WHERE (deleted_at IS NULL);


--
-- Name: ix_waybills_receiver; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_waybills_receiver ON public.waybills USING btree (receiver_org_id, status);


--
-- Name: ix_waybills_sender; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_waybills_sender ON public.waybills USING btree (sender_org_id, status);


--
-- Name: batches t_batches_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_batches_touch BEFORE UPDATE ON public.batches FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: fields t_fields_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_fields_touch BEFORE UPDATE ON public.fields FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: indicators t_indicators_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_indicators_touch BEFORE UPDATE ON public.indicators FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: norms t_norms_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_norms_touch BEFORE UPDATE ON public.norms FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: organizations t_organizations_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_organizations_touch BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: products t_products_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_products_touch BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


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
-- PostgreSQL database dump complete
--

\unrestrict dbmate


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20260923000001'),
    ('20260923000002'),
    ('20260923000003'),
    ('20260923000004');
