import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Catalog } from '../../../packages/shared/src/index.js';
import { getAttemptEligibility } from '../../../packages/shared/src/index.js';
import { InterchangeSchema, SubmitSchema, type Attempt, type Evidence, type Interchange, type Judgment, type Json } from './types.js';
import { NativeStore, NativeStoreError } from './native-store.js';

export const ROOT = resolve(process.cwd());
export const DEFAULT_DB = resolve(ROOT,'runtime/study.sqlite');
export const utcNow=()=>new Date().toISOString();
export const canonical=(value:unknown):string=>JSON.stringify(value,(_key,v:unknown)=>v && typeof v==='object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
export const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const normalize=(text:string)=>text.trim().toLowerCase().replace(/\s+/g,' ').replace(/[.!?]+$/,'');
type Entity={id:string;[key:string]:unknown};
const mutableTables=new Set(['drafts','anki_links']);
const entityTables=new Set(['source_versions','review_events','objectives','statements','skills','alignments','prerequisites','mentor_texts','rubrics','tasks','attempts','judgments','evidence_events','anki_review_events']);

export class SeiStore {
  readonly db: DatabaseSync;
  readonly native: NativeStore;
  static async open(catalog:Catalog,dbPath=DEFAULT_DB,clock:()=>Date=()=>new Date()){
    let migrationPrepared=false;
    if(dbPath!==':memory:'&&existsSync(dbPath)){
      const existing=new DatabaseSync(dbPath,{readOnly:true});
      try{
        const known=existing.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
        if(known&&(!existing.prepare('SELECT version FROM schema_migrations WHERE version=2').get()||!existing.prepare('SELECT version FROM schema_migrations WHERE version=3').get())){
          const backupDir=resolve(dirname(dbPath),'backups');mkdirSync(backupDir,{recursive:true});
          await backup(existing,resolve(backupDir,`before-migration-003-${Date.now()}-${randomUUID()}.sqlite`));
          migrationPrepared=true;
        }
      }finally{existing.close();}
    }
    return new SeiStore(catalog,dbPath,migrationPrepared,clock);
  }
  constructor(readonly catalog:Catalog,dbPath=DEFAULT_DB,migrationPrepared=false,clock:()=>Date=()=>new Date()) {
    if(dbPath!==':memory:') mkdirSync(dirname(dbPath),{recursive:true});
    this.db=new DatabaseSync(dbPath);
    try{
    const known=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if(dbPath!==':memory:'&&known&&(!this.db.prepare('SELECT version FROM schema_migrations WHERE version=2').get()||!this.db.prepare('SELECT version FROM schema_migrations WHERE version=3').get())&&!migrationPrepared)throw new Error('Existing database requires a consistent pre-migration backup. Open it with await SeiStore.open().');
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(readFileSync(resolve(ROOT,'apps/server/src/migrations/001-initial.sql'),'utf8'));
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,?)').run(utcNow());
    if(!this.db.prepare('SELECT version FROM schema_migrations WHERE version=2').get())this.transaction(()=>{
      this.db.exec(readFileSync(resolve(ROOT,'apps/server/src/migrations/002-versioned-drafts.sql'),'utf8'));
      this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(2,?)').run(utcNow());
    });
    for(const table of [...entityTables,'task_skills','import_batches','handoff_packets','proposal_approvals']) {
      if(mutableTables.has(table)) continue;
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Append-only record'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Append-only record'); END;`);
    }
    this.transaction(()=>this.seedCatalog());
    this.native=new NativeStore(this.db,catalog,clock);
    }catch(error){this.db.close();throw error;}
  }
  close(){this.db.close();}
  transaction<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  insert(table:string,fields:Record<string,unknown>,entity?:unknown){
    if(!entityTables.has(table)) throw new Error('Unknown record type');
    const values=entity===undefined?fields:{...fields,entity_json:canonical(entity)};
    const columns=Object.keys(values);
    this.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values(values).map(v=>v===undefined?null:v) as (string|number|null)[]);
  }
  existing<T>(table:string,id:string,version?:string|number):T|undefined{
    if(!entityTables.has(table))throw new Error('Unknown record type');
    const row=this.db.prepare(`SELECT entity_json FROM ${table} WHERE id=?${version===undefined?'':' AND version=?'}`).get(...(version===undefined?[id]:[id,String(version)])) as {entity_json:string}|undefined;
    return row?JSON.parse(row.entity_json) as T:undefined;
  }
  entities<T>(table:string):T[]{
    if(!entityTables.has(table))throw new Error('Unknown record type');
    return (this.db.prepare(`SELECT entity_json FROM ${table} ORDER BY rowid`).all() as {entity_json:string}[]).map(row=>JSON.parse(row.entity_json) as T);
  }
  seedRecord(table:string,entity:{id:string;version?:string|number},fields:Record<string,unknown>){
    const old=this.existing(table,entity.id,['objectives','statements','skills','mentor_texts','rubrics','tasks'].includes(table)?entity.version:undefined);
    if(old){if(canonical(old)!==canonical(entity))throw new Error(`Immutable catalog conflict: ${entity.id}. Increase its version.`);return;}
    this.insert(table,fields,entity);
  }
  seedCatalog(){
    const c=this.catalog;
    for(const s of c.sources)this.seedRecord('source_versions',s,{id:s.id,source_id:s.id,url:s.url,title:s.title,retrieved_at:s.retrievedAt,effective_date_nullable:s.effectiveDate,sha256:s.sha256,excerpt:s.excerpt,review_state:s.reviewState});
    for(const o of c.objectives)this.seedRecord('objectives',o,{id:o.id,version:String(o.version),source_version_id:o.sourceVersionId,text:o.text});
    for(const s of c.statements){const objective=c.objectives.find(o=>o.id===s.objectiveId)!;this.seedRecord('statements',s,{id:s.id,version:String(s.version),objective_id:s.objectiveId,objective_version:String(objective.version),source_version_id:s.sourceVersionId,text:s.text});}
    for(const s of c.skills)this.seedRecord('skills',s,{id:s.id,version:String(s.version),title:s.title,status:s.status});
    for(const a of c.alignments)this.seedRecord('alignments',a,{id:a.id,skill_id:a.skillId,statement_id:a.statementId,framework_kind:a.frameworkKind,rationale:a.rationale,source_version_id:a.sourceVersionId});
    for(const p of c.prerequisites)this.seedRecord('prerequisites',p,{id:p.id,from_skill_id:p.fromSkillId,to_skill_id:p.toSkillId,rationale:p.rationale});
    for(const m of c.mentorTexts)this.seedRecord('mentor_texts',m,{id:m.id,version:String(m.version),title:m.title,discipline:m.discipline,text:m.text,origin_kind:m.originKind,source_version_id_nullable:null,sha256:m.sha256});
    for(const r of c.rubrics)this.seedRecord('rubrics',r,{id:r.id,version:String(r.version),source_version_id:r.sourceVersionId,criteria_json:canonical(r.criteria),scale_json:canonical(r.scale)});
    for(const t of c.tasks){this.seedRecord('tasks',t,{id:t.id,version:String(t.version),kind:t.kind,prompt_json:canonical({prompt:t.prompt,parts:t.parts??[]}),answer_key_json_nullable:t.answerKey?canonical(t.answerKey):null,review_state:t.reviewState,source_refs_json:canonical(t.sourceRefs),mentor_text_id_nullable:t.mentorTextId??null,rubric_version_id_nullable:t.rubricVersionId??null});for(const skillId of t.skillIds)this.db.prepare('INSERT OR IGNORE INTO task_skills(task_id,task_version,skill_id,skill_version) VALUES(?,?,?,?)').run(t.id,String(t.version),skillId,String(c.skills.find(s=>s.id===skillId)!.version));}
    for(const r of c.reviewEvents){const e=r as unknown as Record<string,unknown>;this.seedRecord('review_events',e as Entity,{id:e.id,entity_type:e.entityType??'source',entity_id:e.entityId??e.sourceVersionId,source_version_id:e.sourceVersionId,reviewer_kind:e.reviewerKind??'model',reviewer_label:e.reviewerLabel??'content author',checks_json:canonical(e.checks??[]),created_at:e.createdAt??utcNow()});}
  }
  task(id:string,version?:string|number){
    const t=version===undefined?this.catalog.tasks.find(t=>t.id===id):this.existing<Catalog['tasks'][number]>('tasks',id,version);
    if(!t)throw new Error('Unknown task or immutable task version');return t;
  }
  score(attempt:Attempt):Judgment {
    const task=this.task(attempt.taskId,attempt.taskVersion),key=task.answerKey;
    const answer=typeof attempt.originalAnswer==='string'?attempt.originalAnswer:null;
    let status:Judgment['result']['status']='needs_review';
    let feedback='Saved for review. An open response needs evidence-based human judgment; missing keywords alone do not make it wrong.';
    if(answer!==null && normalize(answer)==="i don't know"){status='incorrect';feedback=key?.feedback??'Use the lesson to build an explanation, then return for a new attempt.';}
    else if(key && answer!==null && ['mc','short'].includes(task.kind)){
      if(key.accepted.some(a=>normalize(a)===normalize(answer))){status='correct';feedback=key.feedback;}
      else if(task.kind==='mc'){status='incorrect';feedback=key.wrongFeedback[answer]??key.feedback;}
      else feedback=`This wording is not in the bounded answer key, so it remains unscored. Compare your reasoning with: ${key.feedback}`;
    }
    const checked=['source_checked','human_reviewed'].includes(task.reviewState)&&task.sourceRefs.length>0&&task.sourceRefs.every(id=>{const source=this.existing<Catalog['sources'][number]>('source_versions',id);return source&&['source_compared','human_reviewed'].includes(source.reviewState);});
    return {id:randomUUID(),attemptId:attempt.id,judgeKind:'authored_key',judgeVersion:'bounded-key-v1',rubricVersionId:task.rubricVersionId??null,result:{status,feedback,provisional:status==='needs_review',sourceChecked:checked},quotedEvidence:answer&&status!=='needs_review'?[answer]:[],uncertaintyReason:status==='needs_review'?'Unmatched or open response requires review':null,supersedesId:null,createdAt:attempt.submittedAt};
  }
  deriveEvidence(attempt:Attempt,judgment:Judgment,allAttempts:Attempt[]=this.entities<Attempt>('attempts'),policyVersion:1|2=2):Evidence[]{
    const task=this.task(attempt.taskId,attempt.taskVersion);
    const context=allAttempts.filter(a=>a.id!==attempt.id&&(a.taskId===attempt.taskId||a.exposureGroupId===attempt.exposureGroupId)&&Date.parse(a.submittedAt)<=Date.parse(attempt.submittedAt));
    const policy=policyVersion===2?getAttemptEligibility(attempt,context):{eligible:attempt.hintCount===0&&attempt.assistance.length===0,reason:'Hints or assistance recorded'};
    const unaided=policy.eligible;
    const eligible=unaided&&judgment.result.sourceChecked&&!judgment.result.provisional&&judgment.result.status!=='needs_review';
    return task.skillIds.map(skillId=>({id:randomUUID(),attemptId:attempt.id,judgmentId:judgment.id,skillId,evidenceKind:judgment.result.status==='correct'?'success':judgment.result.status==='incorrect'?'failure':'pending',independence:unaided?'unaided':'assisted',eligible,exclusionReason:eligible?null:!unaided?policy.reason:!judgment.result.sourceChecked?'Task or source has not been source checked':'Judgment awaits review',createdAt:judgment.createdAt,familyId:task.familyId,noveltyKind:attempt.noveltyKind,sourceChecked:judgment.result.sourceChecked,hintCount:attempt.hintCount,...(policyVersion===2?{eligibilityPolicyVersion:2 as const,eligibilityContextAttemptIds:context.map(a=>a.id).sort()}:{})}));
  }
  saveAttempt(a:Attempt){this.insert('attempts',{id:a.id,task_id:a.taskId,task_version:String(a.taskVersion),session_id:a.sessionId,original_answer_json:canonical(a.originalAnswer),started_at:a.startedAt,submitted_at:a.submittedAt,hint_count:a.hintCount,assistance_json:canonical(a.assistance),exposure_group_id:a.exposureGroupId,novelty_kind:a.noveltyKind,parent_attempt_id_nullable:a.parentAttemptId},a);}
  saveJudgment(j:Judgment){this.insert('judgments',{id:j.id,attempt_id:j.attemptId,judge_kind:j.judgeKind,judge_version:j.judgeVersion,rubric_version_id_nullable:j.rubricVersionId,result_json:canonical(j.result),quoted_evidence_json:canonical(j.quotedEvidence),uncertainty_reason_nullable:j.uncertaintyReason,supersedes_id_nullable:j.supersedesId,created_at:j.createdAt},j);}
  saveEvidence(e:Evidence){this.insert('evidence_events',{id:e.id,attempt_id:e.attemptId,judgment_id:e.judgmentId,skill_id:e.skillId,evidence_kind:e.evidenceKind,independence:e.independence,eligible:e.eligible?1:0,exclusion_reason_nullable:e.exclusionReason,created_at:e.createdAt},e);}
  submit(raw:unknown,sessionId:string){
    const body=SubmitSchema.parse(raw),task=this.task(body.taskId,body.taskVersion);
    if(String(this.task(body.taskId).version)!==String(body.taskVersion)||task.reviewState==='retired')throw new Error('Task version changed or retired. Recover your draft and review the active prompt before submitting.');
    if(task.kind==='mc'&&typeof body.answer==='string'&&!task.options?.some(o=>o.id===body.answer)&&body.answer!=="I don't know")throw new Error('Choose one of the authored options');
    const now=utcNow();
    if(body.startedAt&&Date.parse(body.startedAt)>Date.parse(now))throw new Error('Start time cannot be in the future');
    if(body.parentAttemptId){const parent=this.existing<Attempt>('attempts',body.parentAttemptId);if(!parent||parent.taskId!==task.id)throw new Error('Revision must reference an attempt on this task');}
    const mentor=this.catalog.mentorTexts.find(m=>m.id===task.mentorTextId);
    if(task.kind==='writing'){
      const obj=body.answer as Record<string,Json>;
      if(!obj||typeof obj!=='object'||Array.isArray(obj)||!mentor||obj.mentorTextId!==mentor.id||String(obj.mentorTextVersion)!==String(mentor.version)||obj.mentorTextHash!==mentor.sha256)throw new Error('Writing answer must retain the exact mentor text identity');
      validateWritingAnswer(task,body.answer,mentor);
    }
    const attempt:Attempt={id:randomUUID(),taskId:task.id,taskVersion:task.version,sessionId,originalAnswer:body.answer,startedAt:body.startedAt??now,submittedAt:now,hintCount:body.hintCount,assistance:body.assistance,exposureGroupId:task.familyId,noveltyKind:task.noveltyKind,parentAttemptId:body.parentAttemptId??null,mentorText:mentor?{id:mentor.id,version:mentor.version,sha256:mentor.sha256}:null};
    const judgment=this.score(attempt),evidenceEvents=this.deriveEvidence(attempt,judgment);
    this.transaction(()=>{this.saveAttempt(attempt);this.saveJudgment(judgment);for(const e of evidenceEvents)this.saveEvidence(e);});
    return {attempt,judgment,evidenceEvents};
  }
  state(){return {attempts:this.entities<Attempt>('attempts'),judgments:this.entities<Judgment>('judgments'),evidenceEvents:this.entities<Evidence>('evidence_events'),taskVersions:this.entities<Catalog['tasks'][number]>('tasks'),drafts:this.db.prepare('SELECT task_id AS taskId,task_version AS taskVersion,answer_json AS answerJson,updated_at AS updatedAt FROM drafts').all().map(r=>({...r,answer:JSON.parse(String(r.answerJson)),answerJson:undefined})),anki:{mode:'tsv',reviewsSynchronized:false,message:'reviews not synchronized'},models:{enabled:false,calls:0}};}
  draft(taskId:string){
    const task=this.task(taskId);
    const rows=this.db.prepare('SELECT task_version,answer_json,updated_at FROM drafts WHERE task_id=? ORDER BY updated_at DESC').all(taskId);
    const decode=(row:typeof rows[number])=>({answer:JSON.parse(String(row.answer_json)) as Json,taskVersion:String(row.task_version),updatedAt:String(row.updated_at)});
    const current=rows.find(row=>String(row.task_version)===String(task.version));
    return {...(current?decode(current):{answer:null,taskVersion:String(task.version)}),currentTaskVersion:String(task.version),olderDrafts:rows.filter(row=>String(row.task_version)!==String(task.version)).map(decode)};
  }
  saveDraft(taskId:string,taskVersion:string|number,answer:Json){
    const task=this.task(taskId);if(String(task.version)!==String(taskVersion)||task.reviewState==='retired')throw new Error('Draft task version changed or retired. Preserve the old draft and deliberately copy it into the current prompt.');
    if(task.kind==='writing'){
      const mentor=this.catalog.mentorTexts.find(m=>m.id===task.mentorTextId);
      if(!mentor)throw new Error('Writing mentor text is unavailable');
      validateWritingAnswer(task,answer,mentor,true);
    }
    const updatedAt=utcNow();this.db.prepare('INSERT INTO drafts(task_id,task_version,answer_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(task_id,task_version) DO UPDATE SET answer_json=excluded.answer_json,updated_at=excluded.updated_at').run(taskId,String(task.version),canonical(answer),updatedAt);return {saved:true,taskVersion:String(task.version),updatedAt};
  }
  exportData():Interchange {
    if(this.native.hasHistory())throw new NativeStoreError('JSON export is unavailable because it cannot preserve native flashcard history. Use npm run db:backup for a consistent SQLite backup. Native flashcard JSON interchange is not supported in this version.',400);
    return {schemaVersion:1,appVersion:'0.1.0',exportedAt:utcNow(),origin:'sei-study-lab',catalog:{tasks:this.entities<Json>('tasks'),sources:this.entities<Json>('source_versions'),mentorTexts:this.entities<Json>('mentor_texts'),rubrics:this.entities<Json>('rubrics')},attempts:this.entities<Attempt>('attempts'),judgments:this.entities<Judgment>('judgments'),evidenceEvents:this.entities<Evidence>('evidence_events')};
  }
  inspectImport(raw:unknown){
    if(Buffer.byteLength(JSON.stringify(raw),'utf8')>2_000_000)throw new Error('Import exceeds the 2 MB limit');
    const payload=InterchangeSchema.parse(raw);
    const snapshots:[keyof Interchange['catalog'],string][]=[['tasks','tasks'],['sources','source_versions'],['mentorTexts','mentor_texts'],['rubrics','rubrics']];
    for(const [key,table]of snapshots)for(const rawItem of payload.catalog[key]){const item=rawItem as Entity;const version=table==='source_versions'?undefined:item.version as string|number;const known=this.existing(table,item.id,version);if(!known||canonical(known)!==canonical(item))throw new Error(`Catalog/source version mismatch: ${item.id}`);}
    const groups:[string,{id:string}[]][]=[['attempts',payload.attempts],['judgments',payload.judgments],['evidence_events',payload.evidenceEvents]];
    let added=0,duplicates=0;
    for(const [table,items]of groups){const seen=new Set<string>();for(const item of items){if(seen.has(item.id))throw new Error('Duplicate ID within import');seen.add(item.id);const old=this.existing(table,item.id);if(old){if(canonical(old)!==canonical(item))throw new Error(`Immutable ID conflict: ${item.id}`);duplicates++;}else added++;}}
    const attempts=new Map([...this.entities<Attempt>('attempts'),...payload.attempts].map(a=>[a.id,a]));
    const judgments=new Map([...this.entities<Judgment>('judgments'),...payload.judgments].map(j=>[j.id,j]));
    for(const a of payload.attempts){
      const task=this.task(a.taskId,a.taskVersion);
      if(!payload.catalog.tasks.some(t=>t!==null&&typeof t==='object'&&!Array.isArray(t)&&t.id===task.id&&String(t.version)===String(task.version)))throw new Error('Missing referenced task snapshot');
      if(task.sourceRefs.some(id=>!payload.catalog.sources.some(s=>s!==null&&typeof s==='object'&&!Array.isArray(s)&&s.id===id)))throw new Error('Missing referenced source snapshot');
      if(Date.parse(a.submittedAt)<Date.parse(a.startedAt)||Date.parse(a.submittedAt)>Date.now()||a.exposureGroupId!==task.familyId||a.noveltyKind!==task.noveltyKind)throw new Error('Attempt metadata mismatch');
      if(a.parentAttemptId&&(a.parentAttemptId===a.id||!attempts.has(a.parentAttemptId)||attempts.get(a.parentAttemptId)?.taskId!==a.taskId||Date.parse(attempts.get(a.parentAttemptId)!.submittedAt)>Date.parse(a.submittedAt)))throw new Error('Invalid parent attempt reference');
      const visited=new Set([a.id]);let parent=a.parentAttemptId;while(parent){if(visited.has(parent))throw new Error('Cyclic attempt revision history');visited.add(parent);parent=attempts.get(parent)?.parentAttemptId??null;}
      const mentorVersion=task.mentorTextVersion;
      const mentor=task.mentorTextId&&(typeof mentorVersion==='string'||typeof mentorVersion==='number')?this.existing<Catalog['mentorTexts'][number]>('mentor_texts',task.mentorTextId,mentorVersion):undefined;
      if(task.kind==='writing'&&(!mentor||mentor.sha256!==task.mentorTextSha256||sha256(mentor.text)!==mentor.sha256))throw new Error('Writing task mentor binding is missing or mismatched');
      if(canonical(a.mentorText)!==canonical(mentor?{id:mentor.id,version:mentor.version,sha256:mentor.sha256}:null))throw new Error('Mentor text mismatch');
      if(task.kind==='writing')validateWritingAnswer(task,a.originalAnswer,mentor!);
    }
    for(const j of payload.judgments){
      const a=attempts.get(j.attemptId);if(!a)throw new Error('Unknown judgment attempt');
      if(j.supersedesId&&(j.supersedesId===j.id||!judgments.has(j.supersedesId)||judgments.get(j.supersedesId)?.attemptId!==a.id||Date.parse(judgments.get(j.supersedesId)!.createdAt)>Date.parse(j.createdAt)))throw new Error('Invalid superseded judgment');
      const visited=new Set([j.id]);let parent=j.supersedesId;while(parent){if(visited.has(parent))throw new Error('Cyclic judgment history');visited.add(parent);parent=judgments.get(parent)?.supersedesId??null;}
      const answer=answerText(a.originalAnswer);if(j.quotedEvidence.some(q=>!answer.includes(q)))throw new Error('Judgment quote does not occur in original answer');
      if(j.judgeKind==='authored_key'){const expected=this.score(a);if(canonical({...j,id:expected.id})!==canonical(expected))throw new Error('Authored judgment conflicts with immutable answer key');}
      else if(j.result.status!=='needs_review'||!j.result.provisional||j.result.sourceChecked||j.supersedesId!==null)throw new Error('External proposal cannot manufacture or replace independent evidence');
    }
    for(const e of payload.evidenceEvents){
      const a=attempts.get(e.attemptId),j=judgments.get(e.judgmentId);if(!a||!j||j.attemptId!==a.id)throw new Error('Unknown or mismatched evidence reference');
      const ids=e.eligibilityContextAttemptIds??[];
      if(new Set(ids).size!==ids.length||ids.some(id=>{const prior=attempts.get(id);return !prior||prior.id===a.id||(prior.taskId!==a.taskId&&prior.exposureGroupId!==a.exposureGroupId)||Date.parse(prior.submittedAt)>Date.parse(a.submittedAt);}))throw new Error('Invalid recorded eligibility context');
      const context=ids.map(id=>attempts.get(id)!);
      const expected=this.deriveEvidence(a,j,context,e.eligibilityPolicyVersion??1).find(x=>x.skillId===e.skillId);if(!expected||canonical({...e,id:expected.id})!==canonical(expected))throw new Error('Evidence does not match its attempt and judgment');
    }
    return {payload,added,duplicates,summary:{attempts:payload.attempts.length,judgments:payload.judgments.length,evidenceEvents:payload.evidenceEvents.length},warning:'Original answers are private data. Imported text is inert; no network or code is run. Recorded eligibility retains its original context; readiness is recomputed against the merged history and may conservatively exclude more observations.'};
  }
  importData(raw:unknown){return this.transaction(()=>{const inspected=this.inspectImport(raw);this.db.exec('PRAGMA defer_foreign_keys=ON');for(const a of inspected.payload.attempts)if(!this.existing('attempts',a.id))this.saveAttempt(a);for(const j of inspected.payload.judgments)if(!this.existing('judgments',j.id))this.saveJudgment(j);for(const e of inspected.payload.evidenceEvents)if(!this.existing('evidence_events',e.id))this.saveEvidence(e);const hash=sha256(canonical(inspected.payload));this.db.prepare('INSERT OR IGNORE INTO import_batches(id,schema_version,payload_sha256,origin,imported_at) VALUES(?,?,?,?,?)').run(randomUUID(),1,hash,'sei-study-lab',utcNow());return {added:inspected.added,duplicates:inspected.duplicates,summary:inspected.summary};});}
  async backupTo(path:string){await backup(this.db,path);}
}

export function answerText(answer:Json):string {if(typeof answer==='string')return answer;if(Array.isArray(answer))return answer.map(answerText).join('\n');if(answer&&typeof answer==='object')return Object.values(answer).map(answerText).join('\n');return '';}
function validateWritingAnswer(task:Catalog['tasks'][number],answer:Json,mentor:Catalog['mentorTexts'][number],draft=false){
  if(!answer||typeof answer!=='object'||Array.isArray(answer)||answer.mentorTextId!==mentor.id||String(answer.mentorTextVersion)!==String(mentor.version)||answer.mentorTextHash!==mentor.sha256)throw new Error('Writing answer must retain the exact mentor text identity');
  if((draft||answer.rubricVersionId!==undefined)&&answer.rubricVersionId!==task.rubricVersionId)throw new Error('Writing rubric version mismatch');
  const parts=answer.parts;if(!parts||typeof parts!=='object'||Array.isArray(parts)||(!draft&&(Object.keys(parts).length!==5||task.parts?.some(p=>typeof parts[p.id]!=='string')))||Object.entries(parts).some(([id,value])=>typeof value!=='string'||!task.parts?.some(p=>p.id===id)))throw new Error('Keep all five derived parts attached to the same mentor text');
}
export const DraftSchema=z.object({answer:z.lazy(()=>z.unknown())}).strict();
