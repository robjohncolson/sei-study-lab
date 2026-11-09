import { isAbsolute, relative, resolve } from 'node:path';
import { HostedConfigError, readStorageMode } from './hosted-config.js';
try {
  const mode=readStorageMode();
  const app=await (async()=>{
    if(mode==='postgres'){
      const {createHostedSeiServer}=await import('./hosted-app.js');
      return createHostedSeiServer();
    }
    const {createSeiServer}=await import('./app.js');
    const dbPath=process.env.SEI_DB_PATH?resolve(process.env.SEI_DB_PATH):undefined;
    if(dbPath){const within=relative(resolve('runtime'),dbPath);if(within.startsWith('..')||isAbsolute(within))throw new Error('Runtime database must stay under runtime/');}
    return createSeiServer({dbPath,serveWeb:process.env.NODE_ENV!=='development'});
  })();
  await app.listen({host:'127.0.0.1',port:4317});
  console.log(mode==='sqlite'?'SEI Study Lab: http://127.0.0.1:4317 (local only)':'SEI hosted flashcard API: http://127.0.0.1:4317 (loopback listener)');
  const shutdown=async()=>{await app.close();process.exit(0);};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
} catch(error) {
  const code=(error as NodeJS.ErrnoException).code;
  console.error(error instanceof HostedConfigError?error.message:code==='EADDRINUSE'?'Port 4317 is already in use. Stop the other local process and retry.':'SEI Study Lab could not start. Check the content validation, runtime permissions, and build output.');
  process.exitCode=1;
}
