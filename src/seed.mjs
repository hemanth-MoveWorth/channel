import { transaction } from './database.mjs';
export const demo = Object.freeze({
  user:'00000000-0000-4000-8000-000000000001', workspace:'10000000-0000-4000-8000-000000000001',
  research:'20000000-0000-4000-8000-000000000001', writing:'20000000-0000-4000-8000-000000000002',
  group:'30000000-0000-4000-8000-000000000001',
});
export function seed(db) {
  return transaction(db, () => {
    db.prepare('INSERT INTO users VALUES (?,?) ON CONFLICT(id) DO NOTHING').run(demo.user,'Local demo owner');
    db.prepare('INSERT INTO workspaces VALUES (?,?,?) ON CONFLICT(id) DO NOTHING').run(demo.workspace,'SignalDesk local',demo.user);
    const existing = db.prepare('SELECT owner_user_id FROM workspaces WHERE id=?').get(demo.workspace);
    if (existing.owner_user_id !== demo.user) throw new Error('Demo workspace owner does not match.');
    db.prepare("INSERT INTO workspace_members VALUES (?,?,'owner') ON CONFLICT(workspace_id,user_id) DO NOTHING").run(demo.workspace,demo.user);
    for (const [id,name,skill] of [[demo.research,'Demo Research Agent','research'],[demo.writing,'Demo Writing Agent','writing']]) {
      db.prepare(`INSERT INTO entities(id,workspace_id,owner_user_id,name,description,capabilities,connection_type)
        VALUES (?,?,?,?,?,?,'A') ON CONFLICT(id) DO NOTHING`).run(id,demo.workspace,demo.user,name,'Disconnected local demonstration profile.',JSON.stringify([skill]));
    }
    db.prepare("INSERT INTO conversations VALUES (?,?,'group',?) ON CONFLICT(id) DO NOTHING").run(demo.group,demo.workspace,'Demo collaboration');
    for (const [id,orchestrator] of [[demo.research,1],[demo.writing,0]]) db.prepare(`INSERT INTO conversation_members VALUES (?,?,?,?)
      ON CONFLICT(conversation_id,entity_id) DO NOTHING`).run(demo.workspace,demo.group,id,orchestrator);
    return demo;
  });
}
