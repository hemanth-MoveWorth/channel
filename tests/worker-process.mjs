// Separate process so the acceptance test can genuinely kill a worker, not
// simulate a restart by re-instantiating an object.
import { openDatabase } from '../src/database.mjs';
import { Worker } from '../src/worker.mjs';
const db=openDatabase(process.env.SIGNALDESK_DB_PATH);
const abort=new AbortController();
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>abort.abort());
try { await new Worker(db,{replyBase:process.argv[2],leaseMs:500,timeoutMs:350,pollMs:20,backoffMs:40}).run(abort.signal); }
finally { db.close(); }
