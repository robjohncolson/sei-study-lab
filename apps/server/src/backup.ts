import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const dbPath=resolve('runtime/study.sqlite');
if(!existsSync(dbPath)){console.error('No runtime database yet. Start the app before backing up.');process.exitCode=1;}
else {
  const targetDir=resolve('runtime/backups');mkdirSync(targetDir,{recursive:true});
  const target=resolve(targetDir,`study-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
  const db=new DatabaseSync(dbPath,{readOnly:true});
  try{await backup(db,target);console.log(`Consistent SQLite backup created in runtime/backups.`);}finally{db.close();}
}
