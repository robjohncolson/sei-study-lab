import {spawn} from 'node:child_process';
import net from 'node:net';
for (const port of [4317,5173]) {
 await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',()=>reject(new Error(`Port ${port} is in use. Stop the conflicting server first.`)));server.listen(port,'127.0.0.1',()=>server.close(resolve));});
}
const children=[spawn(process.execPath,['--import','tsx','apps/server/src/main.ts'],{stdio:'inherit',env:{...process.env,NODE_ENV:'development'}}),spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','apps/web/vite.config.ts'],{stdio:'inherit'})];
let stopping=false;
const stop=()=>{if(stopping)return;stopping=true;for(const child of children)child.kill();};
for(const child of children)child.on('exit',(code)=>{stop();process.exitCode=code??1;});
process.on('SIGINT',stop);process.on('SIGTERM',stop);
