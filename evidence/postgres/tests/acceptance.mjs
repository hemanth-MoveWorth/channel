import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const root = new URL('../', import.meta.url);
export const read = path => readFile(new URL(path, root), 'utf8');
const ids = {
  owner: '00000000-0000-4000-8000-000000000001',
  admin: '00000000-0000-4000-8000-000000000002',
  member: '00000000-0000-4000-8000-000000000003',
  outsider: '00000000-0000-4000-8000-000000000004',
  workspace: '10000000-0000-4000-8000-000000000001',
  otherWorkspace: '10000000-0000-4000-8000-000000000002',
  research: '20000000-0000-4000-8000-000000000001',
  writing: '20000000-0000-4000-8000-000000000002',
  foreignEntity: '20000000-0000-4000-8000-000000000003',
  group: '30000000-0000-4000-8000-000000000001',
  otherGroup: '30000000-0000-4000-8000-000000000002',
  task: '40000000-0000-4000-8000-000000000001',
  approval: '50000000-0000-4000-8000-000000000001',
};
const tables = ['users','workspaces','workspace_members','entities','entity_credentials',
  'conversations','conversation_members','messages','tasks','task_events','permission_rules',
  'approvals','context_packages','audit_log'];

// Both drivers return a PostgreSQL result with rows. Every case is isolated by a
// savepoint, so rejected statements cannot contaminate the next role's test.
export async function acceptance(db, report = () => {}) {
  const q = (sql, params = []) => db.query(sql, params);
  const scalar = async (sql, params) => Object.values((await q(sql, params)).rows[0])[0];
  const run = async (name, role, user, fn) => {
    await q('savepoint acceptance_case');
    try {
      if (role) await q(`set local role ${role}`);
      await q("select set_config('request.jwt.claim.sub', $1, true)", [user ?? '']);
      await fn();
      report(name);
    } finally {
      await q('rollback to savepoint acceptance_case');
      await q('release savepoint acceptance_case');
    }
  };
  const denied = async (sql, params = [], code = '42501') => {
    await assert.rejects(q(sql, params), err => err.code === code, `Expected PostgreSQL ${code}`);
  };

  // Fixtures live only in the outer transaction.
  await q("insert into public.workspace_members values ($1,$2,'admin'),($1,$3,'member')", [ids.workspace, ids.admin, ids.member]);
  await q('insert into public.workspaces(id,name,owner_user_id) values ($1,$2,$3)', [ids.otherWorkspace, 'Other tenant', ids.outsider]);
  await q("insert into public.workspace_members values ($1,$2,'owner')", [ids.otherWorkspace, ids.outsider]);
  await q("insert into public.entities(id,workspace_id,name,owner_user_id,connection_type) values ($1,$2,'Private agent',$3,'A')", [ids.foreignEntity, ids.otherWorkspace, ids.outsider]);
  await q("insert into public.conversations(id,workspace_id,kind,name) values ($1,$2,'group','Other group')", [ids.otherGroup, ids.otherWorkspace]);
  await q("insert into public.tasks(id,workspace_id,conversation_id,created_by_user_id,goal,idempotency_key) values ($1,$2,$3,$4,'Test goal','fixture-task')", [ids.task, ids.workspace, ids.group, ids.owner]);
  await q("insert into public.approvals(id,workspace_id,task_id,action) values ($1,$2,$3,'{\"action\":\"research\"}')", [ids.approval, ids.workspace, ids.task]);
  await q("insert into public.permission_rules(workspace_id,entity_id,mode) values ($1,$2,'ask_every_time')", [ids.workspace, ids.research]);
  await q("insert into public.entity_credentials(entity_id,key_hash) values ($1,'test-only-hash-never-a-real-key')", [ids.research]);
  await q("insert into public.context_packages(workspace_id,task_id,recipient_entity_id,goal,facts) values ($1,$2,$3,'Private context','[\"private fact\"]')", [ids.workspace, ids.task, ids.research]);
  await q("insert into public.audit_log(workspace_id,action,decision,reason) values ($1,'fixture','allow','test')", [ids.workspace]);
  await q("insert into public.messages(workspace_id,conversation_id,author_user_id,body) values ($1,$2,$3,'Tenant A message'),($4,$5,$6,'Tenant B message')", [ids.workspace, ids.group, ids.owner, ids.otherWorkspace, ids.otherGroup, ids.outsider]);

  await run('all 14 tables exist with RLS enabled', null, null, async () => {
    const rows = (await q("select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[])", [tables])).rows;
    assert.equal(rows.length, 14);
    assert.ok(rows.every(r => r.relrowsecurity));
  });
  await run('seed creates two demo entities and one group; rerun is idempotent', null, null, async () => {
    await db.exec(await read('supabase/seed.sql').then(sql => sql.replace(/^begin;$/m, '').replace(/^commit;$/m, '')));
    assert.equal(Number(await scalar('select count(*) from public.entities where workspace_id=$1', [ids.workspace])), 2);
    assert.equal(Number(await scalar('select count(*) from public.conversations where workspace_id=$1', [ids.workspace])), 1);
    assert.equal(Number(await scalar('select count(*) from public.conversation_members where conversation_id=$1', [ids.group])), 2);
  });
  await run('seed refuses a different owner without mutating the demo workspace', null, ids.outsider, async () => {
    await q("select set_config('signaldesk.seed_user_id',$1,true)", [ids.outsider]);
    await assert.rejects(db.exec((await read('supabase/seed.sql')).replace(/^begin;$/m, '').replace(/^commit;$/m, '')), e => e.code === 'P0001');
  });
  await run('anon cannot read profiles', 'anon', null, () => denied('select * from public.entities'));
  await run('JWT without identity sees no workspace entities', 'authenticated', null, async () => {
    assert.equal(Number(await scalar('select count(*) from public.entities')), 0);
  });
  await run('member reads own tenant entities, messages, users and memberships', 'authenticated', ids.member, async () => {
    assert.equal(Number(await scalar('select count(*) from public.entities')), 2);
    assert.equal(Number(await scalar('select count(*) from public.messages')), 1);
    assert.equal(Number(await scalar('select count(*) from public.users')), 3);
    assert.equal(Number(await scalar('select count(*) from public.workspace_members')), 3);
  });
  await run('other tenant cannot see demo tasks, approvals or audit records', 'authenticated', ids.outsider, async () => {
    for (const table of ['tasks','approvals','audit_log']) assert.equal(Number(await scalar(`select count(*) from public.${table}`)), 0);
    assert.equal(Number(await scalar('select count(*) from public.entities')), 1);
  });
  await run('member cannot create entity', 'authenticated', ids.member, () => denied(
    "insert into public.entities(workspace_id,name,owner_user_id,connection_type) values ($1,'Denied',$2,'A')", [ids.workspace,ids.member]));
  await run('admin creates and updates entity', 'authenticated', ids.admin, async () => {
    await q("insert into public.entities(workspace_id,name,owner_user_id,connection_type) values ($1,'New',$2,'A')", [ids.workspace,ids.admin]);
    const r = await q("update public.entities set name='Updated' where id=$1 returning id", [ids.research]);
    assert.equal(r.rows.length, 1);
  });
  await run('member cannot update entity', 'authenticated', ids.member, async () => {
    assert.equal((await q("update public.entities set name='Denied' where id=$1 returning id", [ids.research])).rows.length, 0);
  });
  await run('admin cannot delete entity', 'authenticated', ids.admin, async () => {
    assert.equal((await q('delete from public.entities where id=$1 returning id', [ids.writing])).rows.length, 0);
  });
  await run('owner can delete an unreferenced entity', 'authenticated', ids.owner, async () => {
    const inserted = await q("insert into public.entities(workspace_id,name,owner_user_id,connection_type) values ($1,'Disposable',$2,'A') returning id", [ids.workspace,ids.owner]);
    assert.equal((await q('delete from public.entities where id=$1 returning id', [inserted.rows[0].id])).rows.length, 1);
  });
  await run('admin cannot self-grant verified permissions', 'authenticated', ids.admin, () => denied(
    "update public.entities set verified_permissions='{\"publish\":true}' where id=$1", [ids.research]));
  await run('admin cannot insert verified permissions', 'authenticated', ids.admin, () => denied(
    "insert into public.entities(workspace_id,name,owner_user_id,connection_type,verified_permissions) values ($1,'Escalation',$2,'A','{\"publish\":true}')", [ids.workspace, ids.admin]));
  await run('human cannot read credential hashes', 'authenticated', ids.owner, () => denied('select key_hash from public.entity_credentials'));
  await run('service role can read credential hashes', 'service_role', null, async () => {
    assert.equal(Number(await scalar('select count(*) from public.entity_credentials')), 1);
  });
  await run('entity cannot have two active API key hashes', 'service_role', null, () => denied(
    "insert into public.entity_credentials(entity_id,key_hash) values ($1,'another-test-only-hash')", [ids.research], '23505'));
  await run('revocation allows replacement without sharing an active key', 'service_role', null, async () => {
    await q('update public.entity_credentials set revoked_at=now() where entity_id=$1', [ids.research]);
    await q("insert into public.entity_credentials(entity_id,key_hash) values ($1,'replacement-test-only-hash')", [ids.research]);
    assert.equal(Number(await scalar('select count(*) from public.entity_credentials where entity_id=$1 and revoked_at is null', [ids.research])), 1);
  });
  await run('member creates a submitted task with stored receipt', 'authenticated', ids.member, async () => {
    const r = await q("insert into public.tasks(workspace_id,conversation_id,created_by_user_id,goal,idempotency_key) values ($1,$2,$3,'Member request','member-create') returning state,delivery_receipt", [ids.workspace,ids.group,ids.member]);
    assert.deepEqual(r.rows[0], { state:'submitted', delivery_receipt:'stored' });
  });
  await run('human cannot inject a completed state on task creation', 'authenticated', ids.member, () => denied(
    "insert into public.tasks(workspace_id,conversation_id,created_by_user_id,goal,idempotency_key,state) values ($1,$2,$3,'Bypass','bypass','completed')", [ids.workspace,ids.group,ids.member]));
  await run('human cannot impersonate another task creator', 'authenticated', ids.member, () => denied(
    "insert into public.tasks(workspace_id,conversation_id,created_by_user_id,goal,idempotency_key) values ($1,$2,$3,'Spoof','spoof')", [ids.workspace,ids.group,ids.owner]));
  await run('human cannot directly update task state', 'authenticated', ids.owner, () => denied("update public.tasks set state='working' where id=$1", [ids.task]));
  await run('service role updates task state', 'service_role', null, async () => {
    assert.equal((await q("update public.tasks set state='working' where id=$1 returning id", [ids.task])).rows.length, 1);
  });
  await run('invalid task state rejected', 'service_role', null, () => denied("update public.tasks set state='invented' where id=$1", [ids.task], '23514'));
  await run('invalid delivery receipt rejected', 'service_role', null, () => denied("update public.tasks set delivery_receipt='invented' where id=$1", [ids.task], '23514'));
  await run('duplicate task idempotency key rejected', 'service_role', null, () => denied(
    "insert into public.tasks(workspace_id,conversation_id,created_by_user_id,goal,idempotency_key) values ($1,$2,$3,'Duplicate','fixture-task')", [ids.workspace,ids.group,ids.owner], '23505'));
  await run('cross-workspace assignment rejected by FK even for service role', 'service_role', null, () => denied(
    'update public.tasks set assigned_entity_id=$1 where id=$2', [ids.foreignEntity,ids.task], '23503'));
  await run('cross-workspace conversation membership rejected by FK', 'service_role', null, () => denied(
    'insert into public.conversation_members(workspace_id,conversation_id,entity_id) values ($1,$2,$3)', [ids.workspace,ids.group,ids.foreignEntity], '23503'));
  await run('member creates chat messages', 'authenticated', ids.member, async () => {
    await q("insert into public.messages(workspace_id,conversation_id,author_user_id,body) values ($1,$2,$3,'Hello')", [ids.workspace,ids.group,ids.member]);
  });
  await run('human cannot spoof entity message sender', 'authenticated', ids.member, () => denied(
    "insert into public.messages(workspace_id,conversation_id,sender_entity_id,body) values ($1,$2,$3,'Spoof')", [ids.workspace,ids.group,ids.research]));
  await run('member cannot decide approvals', 'authenticated', ids.member, async () => {
    assert.equal((await q("update public.approvals set status='approved' where id=$1 returning id", [ids.approval])).rows.length, 0);
  });
  for (const status of ['approved','rejected']) await run(`admin can mark approval ${status}`, 'authenticated', ids.admin, async () => {
    assert.equal((await q('update public.approvals set status=$1 where id=$2 returning status', [status,ids.approval])).rows[0].status, status);
  });
  await run('member cannot manage permission rules', 'authenticated', ids.member, () => denied(
    "insert into public.permission_rules(workspace_id,mode) values ($1,'full_access_workspace')", [ids.workspace]));
  await run('admin can manage permission rules', 'authenticated', ids.admin, async () => {
    await q("insert into public.permission_rules(workspace_id,mode) values ($1,'standing_rules')", [ids.workspace]);
  });
  await run('human cannot create workspace memberships or escalate role', 'authenticated', ids.member, () => denied(
    "update public.workspace_members set role='owner' where user_id=$1", [ids.member]));
  await run('human cannot read unfiltered private context', 'authenticated', ids.owner, () => denied('select * from public.context_packages'));
  await run('human cannot append audit records', 'authenticated', ids.admin, () => denied(
    "insert into public.audit_log(workspace_id,action,decision,reason) values ($1,'spoof','allow','spoof')", [ids.workspace]));
  await run('service role can append audit records', 'service_role', null, async () => {
    await q("insert into public.audit_log(workspace_id,action,decision,reason) values ($1,'test','allow','test')", [ids.workspace]);
  });
  await run('service role cannot edit audit history', 'service_role', null, () => denied("update public.audit_log set reason='rewritten'"));
  await run('service role cannot delete audit history', 'service_role', null, () => denied('delete from public.audit_log'));
  await run('second orchestrator rejected', 'authenticated', ids.owner, () => denied(
    'update public.conversation_members set is_orchestrator=true where entity_id=$1', [ids.writing], '23505'));
  await run('type B cannot become orchestrator', 'authenticated', ids.admin, async () => {
    await q("update public.entities set connection_type='B' where id=$1", [ids.writing]);
    await q('update public.conversation_members set is_orchestrator=false where entity_id=$1', [ids.research]);
    await denied('update public.conversation_members set is_orchestrator=true where entity_id=$1', [ids.writing], '23514');
  });
  await run('active orchestrator cannot change to type B', 'authenticated', ids.admin, () => denied(
    "update public.entities set connection_type='B' where id=$1", [ids.research], '23514'));
}
