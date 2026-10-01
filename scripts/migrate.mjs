import { openDatabase,migrate } from '../src/database.mjs';
const db=openDatabase();
try { console.log(JSON.stringify({applied:migrate(db)})); } finally { db.close(); }
