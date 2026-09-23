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
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

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
-- Name: roles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);


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
-- Name: ix_refresh_tokens_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_refresh_tokens_user ON public.refresh_tokens USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: ix_users_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_users_org ON public.users USING btree (organization_id) WHERE (deleted_at IS NULL);


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
-- Name: users t_users_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER t_users_touch BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


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
-- PostgreSQL database dump complete
--

\unrestrict dbmate


--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20260923000001'),
    ('20260923000002'),
    ('20260923000003');
