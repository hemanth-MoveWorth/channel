-- WP-E1-01; ARCHITECTURE.md sections 2/3 and ADR-001.
-- Requires the standard Supabase auth.users table, auth.uid() function and roles.
-- Uses plain PostgreSQL SQL, with no Supabase-specific extension dependency.
-- Human requests use JWT identity + RLS. Entity requests use the backend's
-- service_role connection; that backend MUST enforce ADR-001 section 6.
-- RLS does not enforce the entity path when service_role bypasses RLS.
begin;

create schema signaldesk_private;
revoke all on schema signaldesk_private from public;

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid not null references public.users(id),
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  primary key (workspace_id, user_id)
);

create table public.entities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  name text not null,
  owner_user_id uuid not null,
  description text not null default '',
  capabilities jsonb not null default '[]'::jsonb check (jsonb_typeof(capabilities) = 'array'),
  connection_type text not null check (connection_type in ('A', 'B', 'C')),
  webhook_url text,
  verified_permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(verified_permissions) = 'object'),
  availability text not null default 'unknown',
  last_check timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, owner_user_id) references public.workspace_members(workspace_id, user_id)
);

create table public.entity_credentials (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index entity_one_active_credential
  on public.entity_credentials(entity_id) where revoked_at is null;

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  kind text not null check (kind in ('dm', 'group')),
  name text not null default '',
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

create table public.conversation_members (
  workspace_id uuid not null,
  conversation_id uuid not null,
  entity_id uuid not null,
  is_orchestrator boolean not null default false,
  primary key (conversation_id, entity_id),
  foreign key (workspace_id, conversation_id) references public.conversations(workspace_id, id) on delete cascade,
  foreign key (workspace_id, entity_id) references public.entities(workspace_id, id)
);
create unique index conversation_one_orchestrator
  on public.conversation_members(conversation_id) where is_orchestrator;

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  conversation_id uuid not null,
  requester_entity_id uuid,
  assigned_entity_id uuid,
  created_by_user_id uuid,
  goal text not null,
  state text not null default 'submitted' check (state in
    ('submitted', 'queued', 'working', 'input_required', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
  delivery_receipt text not null default 'stored' check (delivery_receipt in
    ('stored', 'delivered', 'accepted_for_execution')),
  idempotency_key text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key),
  check (num_nonnulls(requester_entity_id, created_by_user_id) = 1),
  foreign key (workspace_id, conversation_id) references public.conversations(workspace_id, id),
  foreign key (workspace_id, requester_entity_id) references public.entities(workspace_id, id),
  foreign key (workspace_id, assigned_entity_id) references public.entities(workspace_id, id),
  foreign key (workspace_id, created_by_user_id) references public.workspace_members(workspace_id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  conversation_id uuid not null,
  task_id uuid,
  sender_entity_id uuid,
  author_user_id uuid,
  body text not null,
  created_at timestamptz not null default now(),
  check (num_nonnulls(sender_entity_id, author_user_id) = 1),
  foreign key (workspace_id, conversation_id) references public.conversations(workspace_id, id),
  foreign key (workspace_id, task_id) references public.tasks(workspace_id, id),
  foreign key (workspace_id, sender_entity_id) references public.entities(workspace_id, id),
  foreign key (workspace_id, author_user_id) references public.workspace_members(workspace_id, user_id)
);

create table public.task_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null,
  event_type text not null,
  from_state text check (from_state in ('submitted', 'queued', 'working', 'input_required', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
  to_state text check (to_state in ('submitted', 'queued', 'working', 'input_required', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, task_id) references public.tasks(workspace_id, id)
);

create table public.permission_rules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  entity_id uuid,
  mode text not null check (mode in ('ask_every_time', 'standing_rules', 'full_access_workspace')),
  rules jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (workspace_id, entity_id) references public.entities(workspace_id, id)
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null,
  action jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by_user_id uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, task_id) references public.tasks(workspace_id, id),
  foreign key (workspace_id, decided_by_user_id) references public.workspace_members(workspace_id, user_id)
);

create table public.context_packages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null,
  recipient_entity_id uuid not null,
  goal text not null,
  facts jsonb not null default '[]'::jsonb,
  history_slice jsonb not null default '[]'::jsonb,
  source_refs jsonb not null default '[]'::jsonb,
  constraints jsonb not null default '[]'::jsonb,
  expected_output jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, task_id) references public.tasks(workspace_id, id),
  foreign key (workspace_id, recipient_entity_id) references public.entities(workspace_id, id)
);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  actor_user_id uuid,
  actor_entity_id uuid,
  task_id uuid,
  action text not null,
  decision text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, actor_user_id) references public.workspace_members(workspace_id, user_id),
  foreign key (workspace_id, actor_entity_id) references public.entities(workspace_id, id),
  foreign key (workspace_id, task_id) references public.tasks(workspace_id, id)
);

-- SECURITY DEFINER avoids recursively invoking workspace_members RLS.
-- No caller-controlled dynamic SQL, qualified references, fixed search_path.
create function signaldesk_private.has_workspace_role(target_workspace uuid, allowed_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = target_workspace and m.user_id = auth.uid()
      and m.role = any(allowed_roles)
  );
$$;
create function signaldesk_private.shares_workspace(target_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members mine
    join public.workspace_members theirs on theirs.workspace_id = mine.workspace_id
    where mine.user_id = auth.uid() and theirs.user_id = target_user
  );
$$;
revoke all on function signaldesk_private.has_workspace_role(uuid, text[]) from public;
revoke all on function signaldesk_private.shares_workspace(uuid) from public;
grant usage on schema signaldesk_private to authenticated;
grant execute on function signaldesk_private.has_workspace_role(uuid, text[]) to authenticated;
grant execute on function signaldesk_private.shares_workspace(uuid) to authenticated;

-- RLS and explicit ACLs are both needed: Supabase may have broad default ACLs.
do $$
declare table_name text;
begin
  foreach table_name in array array['users', 'workspaces', 'workspace_members', 'entities',
    'entity_credentials', 'conversations', 'conversation_members', 'messages', 'tasks',
    'task_events', 'permission_rules', 'approvals', 'context_packages', 'audit_log']
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', table_name);
    execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
  end loop;
end $$;
-- Credential hashes are never granted to authenticated or anon.
-- Identity/membership provisioning is service-only; ADR-001 grants no human
-- mutation rights for those tables. Context delivery stays service-only until
-- WP-E1-03 implements per-recipient filtering (group membership is not a grant).

grant select on public.users, public.workspaces, public.workspace_members,
  public.entities, public.conversations, public.conversation_members, public.messages,
  public.tasks, public.task_events, public.permission_rules, public.approvals, public.audit_log to authenticated;
grant insert (id, workspace_id, name, owner_user_id, description, capabilities, connection_type, webhook_url),
  update (name, owner_user_id, description, capabilities, connection_type, webhook_url), delete on public.entities to authenticated;
grant insert, update, delete on public.conversations, public.conversation_members to authenticated;
grant insert (id, workspace_id, conversation_id, task_id, author_user_id, body),
  update (body), delete on public.messages to authenticated;
-- Members can create tasks, but cannot set state/result/receipt or impersonate
-- an entity. Only the task service can mutate execution-owned fields.
grant insert (id, workspace_id, conversation_id, assigned_entity_id, created_by_user_id, goal, idempotency_key)
  on public.tasks to authenticated;
grant insert, update, delete on public.permission_rules to authenticated;
grant update (status) on public.approvals to authenticated;

create policy users_read on public.users for select to authenticated
  using (signaldesk_private.shares_workspace(id));
create policy workspaces_read on public.workspaces for select to authenticated
  using (signaldesk_private.has_workspace_role(id, array['owner','admin','member']));
create policy workspace_members_read on public.workspace_members for select to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']));
create policy entities_read on public.entities for select to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']));
create policy entities_insert on public.entities for insert to authenticated
  with check (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy entities_update on public.entities for update to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin']))
  with check (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy entities_delete on public.entities for delete to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner']));
create policy conversations_access on public.conversations for all to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']))
  with check (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']));
create policy conversation_members_access on public.conversation_members for all to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']))
  with check (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']));
create policy messages_read on public.messages for select to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']));
create policy messages_insert on public.messages for insert to authenticated
  with check (author_user_id = auth.uid() and signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']));
create policy messages_update on public.messages for update to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']))
  with check (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']));
create policy messages_delete on public.messages for delete to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']));
create policy tasks_read on public.tasks for select to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (created_by_user_id = auth.uid() and signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']));
create policy task_events_read on public.task_events for select to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']));
create policy permission_rules_access on public.permission_rules for all to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin']))
  with check (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy approvals_read on public.approvals for select to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']));
create policy approvals_decide on public.approvals for update to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin']))
  with check (status in ('approved','rejected') and signaldesk_private.has_workspace_role(workspace_id, array['owner','admin']));
create policy audit_log_read on public.audit_log for select to authenticated
  using (signaldesk_private.has_workspace_role(workspace_id, array['owner','admin','member']));

-- Append-only applies to service_role as well as the human path.
revoke update, delete on public.audit_log from service_role;

-- Only type A entities can orchestrate. The composite FKs enforce tenancy.
create function signaldesk_private.check_orchestrator()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.is_orchestrator and not exists (
    select 1 from public.entities e
    where e.id = new.entity_id and e.workspace_id = new.workspace_id and e.connection_type = 'A'
  ) then
    raise exception 'Only connection type A can orchestrate' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger check_orchestrator before insert or update on public.conversation_members
  for each row execute function signaldesk_private.check_orchestrator();
create function signaldesk_private.protect_orchestrator_type()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.connection_type <> 'A' and exists (
    select 1 from public.conversation_members m where m.entity_id = new.id and m.is_orchestrator
  ) then
    raise exception 'Remove orchestrator assignment before changing connection type' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger protect_orchestrator_type before update of connection_type on public.entities
  for each row execute function signaldesk_private.protect_orchestrator_type();
revoke all on function signaldesk_private.check_orchestrator() from public;
revoke all on function signaldesk_private.protect_orchestrator_type() from public;

create index workspace_members_user_idx on public.workspace_members(user_id, workspace_id);
create index entities_workspace_idx on public.entities(workspace_id);
create index conversations_workspace_idx on public.conversations(workspace_id);
create index conversation_members_workspace_idx on public.conversation_members(workspace_id);
create index messages_conversation_idx on public.messages(workspace_id, conversation_id, created_at);
create index tasks_workspace_idx on public.tasks(workspace_id, state);
create index task_events_task_idx on public.task_events(workspace_id, task_id, created_at);
create index permission_rules_workspace_idx on public.permission_rules(workspace_id, entity_id);
create index approvals_workspace_idx on public.approvals(workspace_id, status);
create index context_packages_task_idx on public.context_packages(workspace_id, task_id, recipient_entity_id);
create index audit_log_workspace_idx on public.audit_log(workspace_id, created_at);

commit;
