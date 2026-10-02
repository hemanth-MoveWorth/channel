import { openDatabase,migrate } from '../src/database.mjs';
import { Worker } from '../src/worker.mjs';
const db=openDatabase(); migrate(db);
const controller=new AbortController();
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>controller.abort());
try { await new Worker(db).run(controller.signal); } finally { db.close(); }
