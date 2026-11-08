import { z } from 'zod';
const Id=z.string().min(1).max(200);
const Version=z.union([z.string(),z.number()]);
const Ref=z.array(Id);
export const CatalogSchema=z.object({
 schemaVersion:z.literal(1),
 sources:z.array(z.object({id:Id,url:z.string().url(),title:z.string(),retrievedAt:z.string().nullable(),effectiveDate:z.string().nullable().optional(),sha256:z.string().nullable(),excerpt:z.string(),reviewState:z.enum(['unverified','source_compared','human_reviewed','superseded']),version:Version}).passthrough()),
 objectives:z.array(z.object({id:Id,version:Version,sourceVersionId:Id,text:z.string()})),
 statements:z.array(z.object({id:Id,version:Version,objectiveId:Id,sourceVersionId:Id,text:z.string()})),
 competencies:z.array(z.object({id:Id,text:z.string(),sourceVersionId:Id}).passthrough()),
 indicators:z.array(z.object({id:Id,text:z.string(),sourceVersionId:Id}).passthrough()),
 skills:z.array(z.object({id:Id,version:Version,title:z.string(),status:z.enum(['draft','source_checked','human_reviewed','retired'])})),
 alignments:z.array(z.object({id:Id,skillId:Id,statementId:Id,frameworkKind:z.string(),rationale:z.string().min(1),sourceVersionId:Id})),
 prerequisites:z.array(z.object({id:Id,fromSkillId:Id,toSkillId:Id,rationale:z.string().min(1)})),
 lessons:z.array(z.object({id:Id,title:z.string(),skillIds:Ref,body:z.string(),sourceRefs:Ref})),
 tasks:z.array(z.object({id:Id,version:Version,kind:z.enum(['mc','short','case','writing']),title:z.string(),prompt:z.string(),options:z.array(z.object({id:Id,text:z.string()})).optional(),answerKey:z.object({accepted:Ref,feedback:z.string(),wrongFeedback:z.record(z.string(),z.string())}).nullable().optional(),reviewState:z.enum(['draft','source_checked','human_reviewed','retired']),sourceRefs:Ref,skillIds:Ref,familyId:Id,noveltyKind:z.enum(['familiar','unfamiliar']),mentorTextId:Id.optional(),rubricVersionId:Id.optional(),parts:z.array(z.object({id:Id,title:z.string(),prompt:z.string()})).optional()}).passthrough()),
 cards:z.array(z.object({id:Id,front:z.string(),back:z.string(),source:z.string(),tags:Ref})),
 mentorTexts:z.array(z.object({id:Id,version:Version,title:z.string(),discipline:z.string(),text:z.string(),originKind:z.literal('authored_practice'),sha256:z.string()})),
 rubrics:z.array(z.object({id:Id,version:Version,sourceVersionId:Id,criteria:z.array(z.object({id:Id,title:z.string(),text:z.string()})),scale:z.record(z.string(),z.string())})),
 reviewEvents:z.array(z.record(z.string(),z.unknown()))
}).strict();
export type Catalog=z.infer<typeof CatalogSchema>;
export function validateCatalog(input:unknown):string[]{
 const parsed=CatalogSchema.safeParse(input); if(!parsed.success)return parsed.error.issues.map(x=>`${x.path.join('.')}: ${x.message}`);
 const c=parsed.data,errors:string[]=[];
 for(const [name,rows] of Object.entries(c))if(Array.isArray(rows)){const ids=new Set<string>();for(const row of rows){if(row&&typeof row==='object'&&'id' in row){const id=String(row.id);if(ids.has(id))errors.push(`Duplicate ${name} ID: ${id}`);ids.add(id);}}}
 const skills=new Set(c.skills.map(x=>x.id)),sources=new Set(c.sources.map(x=>x.id)),objectives=new Set(c.objectives.map(x=>x.id)),statements=new Set([...c.statements,...c.competencies,...c.indicators].map(x=>x.id));
 const check=(set:Set<string>,id:string,label:string)=>{if(!set.has(id))errors.push(`Unknown ${label}: ${id}`);};
 for(const x of [...c.objectives,...c.statements,...c.competencies,...c.indicators,...c.rubrics])check(sources,x.sourceVersionId,'source');
 for(const x of c.statements)check(objectives,x.objectiveId,'objective');
 for(const x of c.alignments){check(skills,x.skillId,'skill');check(statements,x.statementId,'statement');check(sources,x.sourceVersionId,'source');}
 for(const x of [...c.lessons,...c.tasks]){x.skillIds.forEach(id=>check(skills,id,'skill'));x.sourceRefs.forEach(id=>check(sources,id,'source'));}
 const edges=new Set<string>(),adj=new Map<string,string[]>();
 for(const x of c.prerequisites){check(skills,x.fromSkillId,'prerequisite');check(skills,x.toSkillId,'prerequisite');if(x.fromSkillId===x.toSkillId)errors.push('Self-edge');const key=`${x.fromSkillId}:${x.toSkillId}`;if(edges.has(key))errors.push('Duplicate edge');edges.add(key);adj.set(x.fromSkillId,[...(adj.get(x.fromSkillId)??[]),x.toSkillId]);}
 const visiting=new Set<string>(),done=new Set<string>();
 const visit=(id:string)=>{if(visiting.has(id)){errors.push(`Cycle at ${id}`);return;}if(done.has(id))return;visiting.add(id);for(const next of adj.get(id)??[])visit(next);visiting.delete(id);done.add(id);};
 skills.forEach(visit);
 for(const task of c.tasks){if(task.mentorTextId)check(new Set(c.mentorTexts.map(x=>x.id)),task.mentorTextId,'mentor text');if(task.rubricVersionId)check(new Set(c.rubrics.map(x=>`${x.id}@${x.version}`)),task.rubricVersionId,'rubric version');if(task.kind==='mc'&&(!task.answerKey||!task.options?.some(x=>task.answerKey!.accepted.includes(x.id))))errors.push(`MC missing key: ${task.id}`);if(task.kind==='writing'&&task.parts?.length!==5)errors.push(`Writing must have five derived parts: ${task.id}`);}
 return errors;
}
export const EVIDENCE_POLICY_VERSION = 2;
export const RETEST_DELAY_MS = 24 * 60 * 60 * 1000;
export type EligibilityAttempt = {id:string;taskId:string;exposureGroupId?:string;startedAt?:string;submittedAt:string;hintCount?:number;assistance?:unknown[];parentAttemptId?:string|null};
export function getAttemptEligibility(attempt:EligibilityAttempt,allAttempts:EligibilityAttempt[]):{eligible:boolean;reason:string|null;policyVersion:2} {
 const exclude=(reason:string)=>({eligible:false,reason,policyVersion:2 as const});
 if((attempt.hintCount??0)>0||(attempt.assistance?.length??0)>0)return exclude('Hints or assistance recorded.');
 const submitted=Date.parse(attempt.submittedAt),started=Date.parse(attempt.startedAt??attempt.submittedAt);
 if(!Number.isFinite(submitted)||!Number.isFinite(started)||started>submitted)return exclude('A valid attempt start and submission time are required.');
 const parent=attempt.parentAttemptId?allAttempts.find(a=>a.id===attempt.parentAttemptId):undefined;
 if(attempt.parentAttemptId&&!parent)return exclude('Revision parent is missing; independence cannot be established.');
 const isDescendant=(candidate:EligibilityAttempt)=>{
  const visited=new Set<string>();let id=candidate.parentAttemptId;
  while(id&&!visited.has(id)){if(id===attempt.id)return true;visited.add(id);id=allAttempts.find(a=>a.id===id)?.parentAttemptId;}
  return false;
 };
 const prior=allAttempts.filter(a=>a.id!==attempt.id&&(a.taskId===attempt.taskId||(!!attempt.exposureGroupId&&a.exposureGroupId===attempt.exposureGroupId))&&Date.parse(a.submittedAt)<=submitted&&!isDescendant(a));
 if(parent&&!prior.includes(parent))prior.push(parent);
 if(prior.length){
  const latest=Math.max(...prior.map(a=>Date.parse(a.submittedAt)));
  if(!attempt.startedAt||!Number.isFinite(latest)||started-latest<RETEST_DELAY_MS)return exclude('Feedback-dependent practice: start a fresh retest at least 24 hours after the latest same-task or item-family response.');
 }
 return {eligible:true,reason:null,policyVersion:2};
}
export type Readiness={status:'unseen'|'exposed'|'practicing'|'independent_evidence'|'transfer_evidence'|'needs_recheck';explanation:string;eligibleCount:number;familyCount:number;dates:string[];observedCount:number;historicalVersionCount:number;exclusions:{attemptId:string;reason:string}[];policyVersion:2};
export function getReadiness(skillId:string,catalog:Pick<Catalog,'tasks'>&Partial<Pick<Catalog,'sources'>>,attempts:any[],judgments:any[],evidenceEvents:any[],historicalTasks:Catalog['tasks']=[]):Readiness {
 const taskMap=new Map([...historicalTasks,...catalog.tasks].map(t=>[`${t.id}@${t.version}`,t]));
 const currentById=new Map(catalog.tasks.map(t=>[t.id,t]));
 const enriched=attempts.map(a=>({...a,exposureGroupId:a.exposureGroupId??taskMap.get(`${a.taskId}@${a.taskVersion}`)?.familyId}));
 const seen=enriched.filter(a=>taskMap.get(`${a.taskId}@${a.taskVersion}`)?.skillIds.includes(skillId)||evidenceEvents.some(e=>e.attemptId===a.id&&e.skillId===skillId));
 const exclusions:{attemptId:string;reason:string}[]=[];
 const ambiguousFailureDates:number[]=[];
 let retirement=false;
 const historicalVersionCount=seen.filter(a=>String(currentById.get(a.taskId)?.version)!==String(a.taskVersion)).length;
 const eligible=seen.flatMap(a=>{
  const task=taskMap.get(`${a.taskId}@${a.taskVersion}`),current=currentById.get(a.taskId);
  if(!task){exclusions.push({attemptId:a.id,reason:'Immutable task snapshot is unavailable; history is retained but cannot establish readiness.'});retirement=true;return [];}
  if(!current||current.reviewState==='retired'||task.sourceRefs?.some(id=>catalog.sources?.some(s=>s.id===id&&s.reviewState==='superseded'))){exclusions.push({attemptId:a.id,reason:'Task or source is retired/superseded in the active catalog; historical evidence is retained and needs recheck.'});retirement=true;return [];}
  const policy=getAttemptEligibility(a,enriched);
  const js=judgments.filter(j=>j.attemptId===a.id&&j.result?.sourceChecked===true&&j.result?.provisional===false);
  const superseded=new Set(js.map(j=>j.supersedesId).filter(Boolean));
  const j=js.filter(j=>!superseded.has(j.id)).sort((x,y)=>Date.parse(x.createdAt??a.submittedAt)-Date.parse(y.createdAt??a.submittedAt)).at(-1);
  const ev=evidenceEvents.find(e=>e.attemptId===a.id&&e.judgmentId===j?.id&&e.skillId===skillId);
  if(!policy.eligible&&ev?.eligible&&j?.result?.status==='incorrect'){
   const instant=Date.parse(a.submittedAt);
   const tied=enriched.some(b=>b.id!==a.id&&Date.parse(b.submittedAt)===instant&&(b.taskId===a.taskId||b.exposureGroupId===a.exposureGroupId));
   const earlier=enriched.filter(b=>b.id===a.id||Date.parse(b.submittedAt)<instant);
   if(tied&&getAttemptEligibility(a,earlier).eligible)ambiguousFailureDates.push(instant);
  }
  if(!policy.eligible||!j||!ev?.eligible||!['source_checked','human_reviewed'].includes(task.reviewState)){
   exclusions.push({attemptId:a.id,reason:policy.reason??ev?.exclusionReason??'A checked task and authoritative eligible judgment are required.'});return [];
  }
  const correct=j.result?.status==='correct'?true:j.result?.status==='incorrect'?false:undefined;
  if(typeof correct!=='boolean')return [];
  return [{date:a.submittedAt,family:a.exposureGroupId??task.familyId,correct,novelty:a.noveltyKind??task.noveltyKind}];
 }).sort((a,b)=>Date.parse(a.date)-Date.parse(b.date));
 const successes=eligible.filter(e=>e.correct),families=new Set(successes.map(e=>e.family));
 const base={eligibleCount:successes.length,familyCount:families.size,dates:successes.map(e=>e.date),observedCount:seen.length,historicalVersionCount,exclusions,policyVersion:2 as const};
 const versionNote=historicalVersionCount?` ${historicalVersionCount} observation(s) use archived task versions, preserved under their original reviewed wording; version changes do not create new item families.`:'';
 const exclusionNote=exclusions.length?` ${exclusions.length} observation(s) excluded under evidence policy v2; see the recorded reasons.`:'';
 const explain=(s:string)=>s+versionNote+exclusionNote;
 if(retirement)return {...base,status:'needs_recheck',explanation:explain('Historical practice remains recorded, but retired/missing task or source versions need a recheck.')};
 if(ambiguousFailureDates.some(date=>!eligible.length||date>=Date.parse(eligible.at(-1)!.date)))return {...base,status:'needs_recheck',explanation:explain('A recorded failure has ambiguous same-time feedback ordering. It remains a recheck signal until a strictly later independent observation; simultaneous corrections cannot restore readiness.')};
 if(eligible.at(-1)?.correct===false)return {...base,status:'needs_recheck',explanation:explain('The latest independent observation was a failure. Feedback-trained corrections cannot clear the recheck.')};
 const pair=successes.some((a,i)=>successes.slice(i+1).some(b=>a.family!==b.family&&Date.parse(b.date)-Date.parse(a.date)>=RETEST_DELAY_MS));
 if(pair){const transfer=successes.some(e=>e.novelty==='unfamiliar'&&successes.some(a=>a.family!==e.family&&Date.parse(e.date)-Date.parse(a.date)>=RETEST_DELAY_MS));return {...base,status:transfer?'transfer_evidence':'independent_evidence',explanation:explain('At least two reviewed, unaided successes from distinct item families, separated by 24 hours; repeated-family retests begin after a 24-hour feedback cooldown.')};}
 return {...base,status:seen.length?(eligible.length?'practicing':'exposed'):'unseen',explanation:explain(seen.length?'Insufficient independent evidence: need checked tasks, no assistance or recent same-family feedback, distinct families and a delay of at least 24 hours.':'No attempts yet. Mapped content is not learning evidence.')};
}

export const ProposalSchema=z.object({schemaVersion:z.literal(1),packetId:Id,attemptId:Id,taskVersion:Version,rubricVersion:Version.nullable(),judgeLabel:z.string().min(1).max(100),provisional:z.literal(true),criteriaFeedback:z.array(z.object({criterionId:Id,comment:z.string().max(10000),answerQuotes:z.array(z.string().min(1).max(10000)).max(50),missingEvidence:z.array(z.string().max(10000)).max(50)}).strict()).max(30),holisticScore:z.union([z.number().int().min(1).max(4),z.enum(['U','B'])]).nullable(),needsHumanReview:z.boolean(),reason:z.string().max(10000),proposedEvidence:z.array(z.object({skillId:Id,evidenceKind:z.string().max(100),reason:z.string().max(1000)}).strict()).max(50)}).strict();
export function validateProposal(proposal:unknown,packet:any,attempt:any):string[]{
 const result=ProposalSchema.safeParse(proposal);if(!result.success)return result.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`);
 const p=result.data,errors:string[]=[];
 if(p.packetId!==packet.id&&p.packetId!==packet.packetId)errors.push('Packet identity mismatch');
 if(p.attemptId!==attempt.id||p.attemptId!==packet.attemptId)errors.push('Attempt identity mismatch');
 if(String(p.taskVersion)!==String(attempt.taskVersion))errors.push('Task version mismatch');
 if(String(p.rubricVersion)!==String(packet.rubricVersion??null))errors.push('Rubric version mismatch');
 const textValues=(value:unknown):string=>typeof value==='string'?value:Array.isArray(value)?value.map(textValues).join('\n'):value&&typeof value==='object'?Object.values(value).map(textValues).join('\n'):'';
 const answer=textValues(attempt.originalAnswer);
 for(const c of p.criteriaFeedback)for(const quote of c.answerQuotes)if(!answer?.includes(quote))errors.push('Answer quote does not occur in original answer');
 return errors;
}
