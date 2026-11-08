import {createServer} from 'vite';
import {createSeiServer} from '../apps/server/src/app.js';
import {resolve} from 'node:path';

// Test-only ports and database: never attach browser tests to the user's app.
const apiPort=4318,webPort=5174;
const backend=await createSeiServer({dbPath:resolve(`runtime/test-databases/e2e-${Date.now()}.sqlite`),testPorts:{api:apiPort,web:webPort}});
let web:Awaited<ReturnType<typeof createServer>>|undefined;
try {
  await backend.listen({host:'127.0.0.1',port:apiPort});
  web=await createServer({configFile:resolve('apps/web/vite.config.ts'),server:{host:'127.0.0.1',port:webPort,strictPort:true,proxy:{'/api':{target:`http://127.0.0.1:${apiPort}`,changeOrigin:true}}}});
  await web.listen();
  console.log(`Isolated browser test server: http://127.0.0.1:${webPort}`);
}catch(error){await web?.close();await backend.close();throw error;}
let stopping=false;
async function shutdown(){if(stopping)return;stopping=true;await web?.close();await backend.close();process.exit(0);}
process.on('SIGINT',()=>{void shutdown();});process.on('SIGTERM',()=>{void shutdown();});
