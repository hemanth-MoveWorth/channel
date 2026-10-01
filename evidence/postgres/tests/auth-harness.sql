-- TEST DATABASES ONLY. Minimal stand-in for Supabase Auth, NOT a production migration.
-- The PostgreSQL CI and embedded tests need real roles, BYPASSRLS, JWT identity,
-- and an auth.users FK target without requiring a Supabase account.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to authenticated;
-- Simulate Supabase's broad default grants to ensure migration revokes them.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
