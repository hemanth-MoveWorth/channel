-- Fixed IDs and no credentials. Runs inside the test transaction and is rolled back.
insert into auth.users(id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-000000000003'),
  ('00000000-0000-4000-8000-000000000004');
insert into public.users(id, display_name) select id, 'Test user' from auth.users
  where id::text like '00000000-0000-4000-8000-%' on conflict do nothing;
select set_config('signaldesk.seed_user_id', '00000000-0000-4000-8000-000000000001', false);
