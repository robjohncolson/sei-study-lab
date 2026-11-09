import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CatalogSchema, validateCatalog, type Catalog } from '../../../packages/shared/src/index.js';
import { SeiStore, ROOT } from './store.js';
import { JsonSchema } from './types.js';
import { approveProposal, createHandoff, inspectProposal } from './handoff.js';
import { NativeStoreError } from './native-store.js';
import { exportAnkiTsv } from './anki.js';
import { readAiConfig } from './ai/ai-config.js';
import { registerAiRoutes, type AiServerOptions } from './ai/ai-routes.js';
import { SqliteAiStorage } from './ai/sqlite-ai-storage.js';
import { AuthError, parseSignupSetting, validateSessionSecret } from './auth/core.js';
import { AuthService, isPublicAuthRoute } from './auth/service.js';
import { registerPasswordRoutes } from './auth/routes.js';
import { SqliteAuthStore } from './auth/sqlite-auth-store.js';
export { exportAnkiTsv } from './anki.js';

const ImportBody=z.object({payload:z.unknown(),confirm:z.literal(true).optional()}).strict();
const ProposalBody=z.object({proposal:z.unknown(),confirm:z.literal(true).optional()}).strict();
export async function createSeiServer(options:{dbPath?:string;catalog?:Catalog;serveWeb?:boolean;testPorts?:{api:number;web:number};clock?:()=>Date;ai?:AiServerOptions;env?:NodeJS.ProcessEnv}={}){
  const env=options.env??process.env;
  if(env.LOCAL_AUTH!==undefined&&env.LOCAL_AUTH!=='password')throw new Error('LOCAL_AUTH');
  const authConfig=env.LOCAL_AUTH==='password'?{
    sessionSecret:validateSessionSecret(env.SEI_SESSION_SECRET),
    allowSignup:parseSignupSetting(env.LOCAL_ALLOW_SIGNUP,'LOCAL_ALLOW_SIGNUP'),firstOwner:randomUUID(),
  }:null;
  const aiConfig=readAiConfig(options.ai?.env);
  const ports=z.object({api:z.number().int().min(1024).max(65535),web:z.number().int().min(1024).max(65535)}).strict().refine(p=>p.api!==p.web,'Test API and web ports must differ').parse(options.testPorts??{api:4317,web:5173});
  if(options.testPorts&&!options.dbPath)throw new Error('Alternate test ports require an explicit isolated test database');
  const hosts=new Set([`127.0.0.1:${ports.api}`,`127.0.0.1:${ports.web}`,`localhost:${ports.api}`,`localhost:${ports.web}`]);
  const origins=new Set([...hosts].map(h=>`http://${h}`));
  const catalog=CatalogSchema.parse(options.catalog??JSON.parse(readFileSync(resolve(ROOT,'content/catalog.json'),'utf8')));
  const errors=validateCatalog(catalog);if(errors.length)throw new Error(`Invalid content catalog: ${errors.join('; ')}`);
  const store=await SeiStore.open(catalog,options.dbPath,options.clock);
  const auth=authConfig?new AuthService(new SqliteAuthStore(store.db),{...authConfig,origins},options.clock):null;
  // Password sessions persist in SQLite; the existing process-local CSRF session
  // keeps its independent lifetime and study-session label.
  const csrfCookieName=auth?'sei_csrf':'sei_session';
  const csrfCookie=(cookie:string|undefined)=>cookie?.match(new RegExp(`(?:^|;\\s*)${csrfCookieName}=([a-f0-9]{64})(?:;|$)`))?.[1];
  const app=Fastify({logger:false,bodyLimit:2_000_000,requestTimeout:15000,connectionTimeout:10000,trustProxy:false});
  const sessions=new Map<string,{token:string;expires:number;studySessionId:string}>();
  app.addHook('onClose',async()=>{store.close();});
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('X-Frame-Options','DENY').header('Cache-Control','no-store').header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(!hosts.has(req.headers.host??''))return reply.code(403).send({error:'Untrusted Host'});
    const origin=req.headers.origin;
    if(origin&&!origins.has(origin))return reply.code(403).send({error:'Untrusted Origin'});
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){
      const cookie=csrfCookie(req.headers.cookie);
      const session=cookie?sessions.get(cookie):undefined;
      if(!origin||!session||session.expires<Date.now()||req.headers['x-csrf-token']!==session.token)return reply.code(403).send({error:'A trusted origin and current session CSRF token are required'});
    }
  });
  app.setErrorHandler((error,_req,reply)=>{
    if(error instanceof AuthError)return reply.code(error.statusCode).send({error:error.message});
    if(auth&&_req.url.startsWith('/api/auth/')){
      const status=(error as {statusCode?:number}).statusCode;
      return reply.code(status&&status>=400&&status<500?status:500).send({error:status&&status<500?'Invalid sign-in data':'The sign-in operation could not be completed'});
    }
    if(error instanceof NativeStoreError)return reply.code(error.statusCode).send({error:error.message});
    if(error instanceof z.ZodError)return reply.code(400).send({error:'Invalid data schema',issues:error.issues.map(i=>({path:i.path,message:i.message}))});
    const failure=error as Error&{code?:string};
    if(failure.code==='FST_ERR_CTP_BODY_TOO_LARGE')return reply.code(413).send({error:'Request exceeds the 2 MB limit'});
    if(failure.code||/SQLITE|ENOENT|EACCES|constraint|database|syntax error/i.test(failure.message??''))return reply.code(400).send({error:'The operation could not be completed. No partial import was saved.'});
    return reply.code(400).send({error:(failure.message??'The operation could not be completed').slice(0,1000)});
  });
  app.addHook('preValidation',async(req)=>{
    const queue:{value:unknown;depth:number}[]=[{value:req.body,depth:0}];
    let count=0;
    while(queue.length){const {value,depth}=queue.pop()!;if(++count>100000||depth>40)throw new Error('JSON structure exceeds the safe nesting or item limit');if(value&&typeof value==='object')for(const child of Object.values(value))queue.push({value:child,depth:depth+1});}
  });
  if(auth){
    app.addHook('preHandler',async(req,reply)=>{
      const apiRoute=req.routeOptions.url?.startsWith('/api/')||req.url.startsWith('/api/');
      if(apiRoute&&!isPublicAuthRoute(req.url)&&!await auth.identity(req.headers.cookie)){
        return reply.code(401).send({error:'Sign in required'});
      }
    });
    registerPasswordRoutes(app,auth);
  }
  app.get('/api/session',async(req,reply)=>{
    for(const [id,s]of sessions)if(s.expires<Date.now())sessions.delete(id);
    const old=csrfCookie(req.headers.cookie);
    const authStatus=auth?{storageMode:'sqlite',authMode:'password',...await auth.status(req.headers.cookie)}:{};
    if(old&&sessions.has(old))return {csrfToken:sessions.get(old)!.token,...authStatus};
    if(sessions.size>1000)return reply.code(429).send({error:'Too many local sessions'});
    const id=randomBytes(32).toString('hex'),token=randomBytes(32).toString('hex');sessions.set(id,{token,expires:Date.now()+86400000,studySessionId:randomUUID()});
    reply.header('Set-Cookie',`${csrfCookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
    return {csrfToken:token,...authStatus};
  });
  app.get('/api/catalog',async()=>catalog);
  app.get('/api/state',async()=>store.state());
  app.get('/api/native-flashcards',async()=>store.native.queue());
  app.post('/api/native-flashcards/initialize',async()=>store.native.initialize());
  app.post('/api/native-flashcards/reviews',async(req)=>store.native.review(req.body));
  app.post('/api/native-flashcards/controls',async(req)=>store.native.control(req.body));
  app.post('/api/attempts',async(req)=>store.submit(req.body,sessions.get(csrfCookie(req.headers.cookie)!)!.studySessionId));
  app.get<{Params:{taskId:string}}>('/api/drafts/:taskId',async(req)=>store.draft(req.params.taskId));
  app.put<{Params:{taskId:string}}>('/api/drafts/:taskId',async(req)=>{const body=z.object({taskVersion:z.union([z.string().min(1),z.number().int().positive()]),answer:JsonSchema}).strict().parse(req.body);return store.saveDraft(req.params.taskId,body.taskVersion,body.answer);});
  app.get('/api/export',async(_req,reply)=>{reply.header('Content-Disposition','attachment; filename="sei-study-lab-export.json"');return store.exportData();});
  app.post('/api/import/preview',async(req)=>{const {payload}=ImportBody.parse(req.body);const p=store.inspectImport(payload);return {valid:true,added:p.added,duplicates:p.duplicates,summary:p.summary,warning:p.warning};});
  app.post('/api/import',async(req)=>{const body=ImportBody.parse(req.body);if(body.confirm!==true)throw new Error('Explicit confirmation is required');return store.importData(body.payload);});
  app.get('/api/anki.tsv',async(_req,reply)=>reply.type('text/tab-separated-values; charset=utf-8').header('Content-Disposition','attachment; filename="sei-study-lab-anki.tsv"').send(exportAnkiTsv(catalog)));
  app.post('/api/handoff',async(req)=>createHandoff(store,req.body));
  app.post('/api/proposals/preview',async(req)=>{const body=ProposalBody.parse(req.body);const p=inspectProposal(store,body.proposal);return {valid:true,proposal:p.proposal,warning:p.warning};});
  app.post('/api/proposals/approve',async(req)=>{const body=ProposalBody.parse(req.body);if(body.confirm!==true)throw new Error('Explicit local approval is required');return approveProposal(store,body.proposal);});
  registerAiRoutes(app,{config:aiConfig,storage:()=>new SqliteAiStorage(store,options.clock),local:true,fetch:options.ai?.fetch,clock:options.clock});
  if(options.serveWeb){await app.register(fastifyStatic,{root:resolve(ROOT,'dist/web'),index:'index.html'});app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'Unknown API route'}):reply.sendFile('index.html'));}
  await app.ready();return app;
}
