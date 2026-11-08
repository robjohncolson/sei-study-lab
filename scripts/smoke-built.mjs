import {spawn} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
mkdirSync('runtime/test-databases',{recursive:true});
const child=spawn(process.execPath,['dist/server/main.js'],{env:{...process.env,NODE_ENV:'production',SEI_DB_PATH:`runtime/test-databases/built-${Date.now()}.sqlite`},stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s);
try {
 let response;
 for(let n=0;n<50;n++){if(child.exitCode!==null)throw new Error('Built server exited: '+output);try{response=await fetch('http://127.0.0.1:4317/');break;}catch{await new Promise(r=>setTimeout(r,100));}}
 assert(response);assert.equal(response.status,200);assert.match(await response.text(),/SEI Study Lab/);
 const catalog=await(await fetch('http://127.0.0.1:4317/api/catalog')).json();assert.equal(catalog.objectives.length,13);
 const state=await(await fetch('http://127.0.0.1:4317/api/state')).json();assert.equal(state.attempts.length,0);
 const forbidden=await fetch('http://127.0.0.1:4317/api/state',{headers:{origin:'https://untrusted.example'}});assert.equal(forbidden.status,403);
 console.log('Built loopback entry passed: frontend200, catalog13, empty isolated DB, untrusted origin403.');
} finally {child.kill();await new Promise(r=>child.once('exit',r));}
