import { openDatabase,migrate } from '../src/database.mjs';
import { seed } from '../src/seed.mjs';
const db=openDatabase();
try { migrate(db); console.log(JSON.stringify({seed:seed(db)})); } finally { db.close(); }
