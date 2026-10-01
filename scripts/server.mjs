import { openDatabase,migrate } from '../src/database.mjs';
import { createApiServer } from '../src/server.mjs';
const db=openDatabase(); migrate(db);
const server=createApiServer(db);
server.listen(3000,'127.0.0.1',()=>console.log('SignalDesk API: http://127.0.0.1:3000'));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
