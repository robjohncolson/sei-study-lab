import { createSeiServer } from './app.js';
import { isAbsolute, relative, resolve } from 'node:path';
try {
  const dbPath=process.env.SEI_DB_PATH?resolve(process.env.SEI_DB_PATH):undefined;
  if(dbPath){const within=relative(resolve('runtime'),dbPath);if(within.startsWith('..')||isAbsolute(within))throw new Error('Runtime database must stay under runtime/');}
  const app=await createSeiServer({dbPath,serveWeb:process.env.NODE_ENV!=='development'});
  await app.listen({host:'127.0.0.1',port:4317});
  console.log('SEI Study Lab: http://127.0.0.1:4317 (local only)');
  const shutdown=async()=>{await app.close();process.exit(0);};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
} catch(error) {
  const code=(error as NodeJS.ErrnoException).code;
  console.error(code==='EADDRINUSE'?'Port 4317 is already in use. Stop the other local process and retry.':'SEI Study Lab could not start. Check the content validation, runtime permissions, and build output.');
  process.exitCode=1;
}
