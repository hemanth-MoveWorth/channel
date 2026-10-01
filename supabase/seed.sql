-- Run as postgres/service_role in a DEV database only, after the migration.
-- Supply an existing Supabase Auth user, never fabricate an auth.users row:
-- select set_config('signaldesk.seed_user_id', '<existing-auth-user-uuid>', false);
-- Deterministic IDs make a second run non-destructive and duplicate-free.
begin;
do $$
declare
  seed_user uuid := nullif(current_setting('signaldesk.seed_user_id', true), '')::uuid;
  demo_workspace constant uuid := '10000000-0000-4000-8000-000000000001';
begin
  if seed_user is null or not exists (select 1 from auth.users where id = seed_user) then
    raise exception 'Set signaldesk.seed_user_id to an existing auth.users UUID';
  end if;
  if exists (select 1 from public.workspaces where id = demo_workspace and owner_user_id <> seed_user) then
    raise exception 'Demo workspace already belongs to another user';
  end if;
  insert into public.users(id, display_name) values (seed_user, 'SignalDesk demo owner') on conflict (id) do nothing;
  insert into public.workspaces(id, name, owner_user_id)
    values (demo_workspace, 'SignalDesk development', seed_user) on conflict (id) do nothing;
  insert into public.workspace_members(workspace_id, user_id, role)
    values (demo_workspace, seed_user, 'owner') on conflict (workspace_id, user_id) do nothing;
  insert into public.entities(id, workspace_id, name, owner_user_id, description, capabilities, connection_type)
    values
      ('20000000-0000-4000-8000-000000000001', demo_workspace, 'Demo Research Agent', seed_user,
       'Demo profile only; no provider or verified permissions are configured.', '["research"]', 'A'),
      ('20000000-0000-4000-8000-000000000002', demo_workspace, 'Demo Writing Agent', seed_user,
       'Demo profile only; no provider or verified permissions are configured.', '["writing"]', 'A')
    on conflict (id) do nothing;
  insert into public.conversations(id, workspace_id, kind, name)
    values ('30000000-0000-4000-8000-000000000001', demo_workspace, 'group', 'Demo collaboration')
    on conflict (id) do nothing;
  insert into public.conversation_members(workspace_id, conversation_id, entity_id, is_orchestrator)
    values
      (demo_workspace, '30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', true),
      (demo_workspace, '30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', false)
    on conflict (conversation_id, entity_id) do nothing;
end $$;
commit;
