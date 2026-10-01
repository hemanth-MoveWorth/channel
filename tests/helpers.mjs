import { mkdtempSync,mkdirSync,rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { openDatabase,migrate } from '../src/database.mjs';
import { seed,demo } from '../src/seed.mjs';
export function fixture() {
  const root=resolve('.tmp');mkdirSync(root,{recursive:true});
  const dir=mkdtempSync(join(root,'task-')); const path=join(dir,'channel.db');
  const db=openDatabase(path); migrate(db); seed(db);
  return {db,path,dir,owner:{kind:'human',user_id:demo.user},body:{workspace_id:demo.workspace,conversation_id:demo.group,
    assigned_entity_id:demo.research,goal:'Perform the local acceptance action'},close(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
export async function listen(server) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
export async function closeServer(server) {
  if (!server.listening) return;
  const done=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await done;
}
export async function waitFor(fn,timeout=5000) {
  const start=Date.now();
  while (!fn()) {
    if (Date.now()-start>timeout) throw new Error('Timed out waiting for acceptance condition.');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}
