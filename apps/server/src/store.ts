import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Catalog } from '../../../packages/shared/src/index.js';
import { InterchangeSchema, type Attempt, type Evidence, type Interchange, type Judgment, type Json } from './types.js';
import { NativeStore, NativeStoreError } from './native-store.js';
import { lookupTask, prepareStudyAttempt, scoreStudyAttempt, deriveStudyEvidence, validateStudyDraft, validateWritingAnswer, shapeStudyDraft, shapeStudyState } from './study-logic.js';

export const ROOT = resolve(process.cwd());
export const DEFAULT_DB = resolve(ROOT,'runtime/study.sqlite');
export const utcNow=()=>new Date().toISOString();
export const canonical=(value:unknown):string=>JSON.stringify(value,(_key,v:unknown)=>v && typeof v==='object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
export const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
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
        if(known&&(!existing.prepare('SELECT version FROM schema_migrations WHERE version=2').get()||!existing.prepare('SELECT version FROM schema_migrations WHERE version=3').get()||!existing.prepare('SELECT version FROM schema_migrations WHERE version=4').get())){
          const backupDir=resolve(dirname(dbPath),'backups');mkdirSync(backupDir,{recursive:true});
          await backup(existing,resolve(backupDir,`before-migration-004-${Date.now()}-${randomUUID()}.sqlite`));
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
    if(dbPath!==':memory:'&&known&&(!this.db.prepare('SELECT version FROM schema_migrations WHERE version=2').get()||!this.db.prepare('SELECT version FROM schema_migrations WHERE version=3').get()||!this.db.prepare('SELECT version FROM schema_migrations WHERE version=4').get())&&!migrationPrepared)throw new Error('Existing database requires a consistent pre-migration backup. Open it with await SeiStore.open().');
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
    if(!this.db.prepare('SELECT version FROM schema_migrations WHERE version=4').get())this.transaction(()=>{
      this.db.exec(readFileSync(resolve(ROOT,'apps/server/src/migrations/004-ai-feedback.sql'),'utf8'));
      this.db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(4,?)').run(utcNow());
    });
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
    const versions=version===undefined?[]:[this.existing<Catalog['tasks'][number]>('tasks',id,version)].filter((task):task is Catalog['tasks'][number]=>task!==undefined);
    return lookupTask(this.catalog,versions,id,version);
  }
  score(attempt:Attempt):Judgment {
    return scoreStudyAttempt(this.task(attempt.taskId,attempt.taskVersion),attempt,this.entities<Catalog['sources'][number]>('source_versions'),randomUUID());
  }
  deriveEvidence(attempt:Attempt,judgment:Judgment,allAttempts:Attempt[]=this.entities<Attempt>('attempts'),policyVersion:1|2=2):Evidence[]{
    const task=this.task(attempt.taskId,attempt.taskVersion);
    return deriveStudyEvidence(task,attempt,judgment,allAttempts,task.skillIds.map(()=>randomUUID()),policyVersion);
  }
  saveAttempt(a:Attempt){this.insert('attempts',{id:a.id,task_id:a.taskId,task_version:String(a.taskVersion),session_id:a.sessionId,original_answer_json:canonical(a.originalAnswer),started_at:a.startedAt,submitted_at:a.submittedAt,hint_count:a.hintCount,assistance_json:canonical(a.assistance),exposure_group_id:a.exposureGroupId,novelty_kind:a.noveltyKind,parent_attempt_id_nullable:a.parentAttemptId},a);}
  saveJudgment(j:Judgment){this.insert('judgments',{id:j.id,attempt_id:j.attemptId,judge_kind:j.judgeKind,judge_version:j.judgeVersion,rubric_version_id_nullable:j.rubricVersionId,result_json:canonical(j.result),quoted_evidence_json:canonical(j.quotedEvidence),uncertainty_reason_nullable:j.uncertaintyReason,supersedes_id_nullable:j.supersedesId,created_at:j.createdAt},j);}
  saveEvidence(e:Evidence){this.insert('evidence_events',{id:e.id,attempt_id:e.attemptId,judgment_id:e.judgmentId,skill_id:e.skillId,evidence_kind:e.evidenceKind,independence:e.independence,eligible:e.eligible?1:0,exclusion_reason_nullable:e.exclusionReason,created_at:e.createdAt},e);}
  submit(raw:unknown,sessionId:string){
    const attempt=prepareStudyAttempt(raw,sessionId,{catalog:this.catalog,taskVersions:this.entities<Catalog['tasks'][number]>('tasks'),attempts:this.entities<Attempt>('attempts')},utcNow(),randomUUID());
    const judgment=this.score(attempt),evidenceEvents=this.deriveEvidence(attempt,judgment);
    this.transaction(()=>{this.saveAttempt(attempt);this.saveJudgment(judgment);for(const e of evidenceEvents)this.saveEvidence(e);});
    return {attempt,judgment,evidenceEvents};
  }
  state(){return shapeStudyState({attempts:this.entities<Attempt>('attempts'),judgments:this.entities<Judgment>('judgments'),evidenceEvents:this.entities<Evidence>('evidence_events'),taskVersions:this.entities<Catalog['tasks'][number]>('tasks'),drafts:this.db.prepare('SELECT task_id AS taskId,task_version AS taskVersion,answer_json AS answerJson,updated_at AS updatedAt FROM drafts').all().map(r=>({taskId:String(r.taskId),taskVersion:String(r.taskVersion),updatedAt:String(r.updatedAt),answer:JSON.parse(String(r.answerJson)) as Json,answerJson:undefined}))});}
  draft(taskId:string){
    const task=this.task(taskId);
    const rows=this.db.prepare('SELECT task_version,answer_json,updated_at FROM drafts WHERE task_id=? ORDER BY updated_at DESC').all(taskId);
    return shapeStudyDraft(task,rows.map(row=>({answer:JSON.parse(String(row.answer_json)) as Json,taskVersion:String(row.task_version),updatedAt:String(row.updated_at)})));
  }
  saveDraft(taskId:string,taskVersion:string|number,answer:Json){
    const task=validateStudyDraft(this.catalog,taskId,taskVersion,answer);
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
export const DraftSchema=z.object({answer:z.lazy(()=>z.unknown())}).strict();
