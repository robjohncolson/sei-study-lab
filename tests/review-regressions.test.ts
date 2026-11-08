import {describe,it,expect} from 'vitest';
import {getAttemptEligibility,getReadiness,type Catalog,type EligibilityAttempt} from '../packages/shared/src/index.js';
const tasks=[{id:'a',version:1,title:'a',kind:'short',prompt:'a',skillIds:['skill'],familyId:'family-a',reviewState:'source_checked',noveltyKind:'familiar',sourceRefs:[]},{id:'b',version:1,title:'b',kind:'short',prompt:'b',skillIds:['skill'],familyId:'family-b',reviewState:'source_checked',noveltyKind:'familiar',sourceRefs:[]}] as Catalog['tasks'];
const observation=(id:string,taskId:string,date:string,parentAttemptId:string|null=null):EligibilityAttempt&{taskVersion:number}=>({id,taskId,taskVersion:1,exposureGroupId:`family-${taskId}`,startedAt:date,submittedAt:date,hintCount:0,assistance:[],parentAttemptId});
const judged=(attempts:EligibilityAttempt[],incorrect:string[]=[])=>({judgments:attempts.map(a=>({id:`j-${a.id}`,attemptId:a.id,createdAt:a.submittedAt,result:{status:incorrect.includes(a.id)?'incorrect':'correct',sourceChecked:true,provisional:false}})),events:attempts.map(a=>({attemptId:a.id,judgmentId:`j-${a.id}`,skillId:'skill',eligible:true}))});
describe('evidence policy v2: feedback exposure',()=>{
 it('excludes wrong-right and right-edited immediate revisions, even legacy eligible events',()=>{
  const a=[observation('first','a','2026-01-01T12:00:00Z'),observation('revision','a','2026-01-01T12:01:00Z','first'),observation('other','b','2026-01-02T12:01:00Z')];
  expect(getAttemptEligibility(a[1],a)).toMatchObject({eligible:false,policyVersion:2});
  const {judgments,events}=judged(a,['first']);
  const ready=getReadiness('skill',{tasks},a,judgments,events);
  expect(ready.status).not.toBe('independent_evidence');expect(ready.eligibleCount).toBe(1);expect(ready.exclusions[0].reason).toContain('Feedback-dependent');
  const good=judged(a);expect(getReadiness('skill',{tasks},a,good.judgments,good.events).eligibleCount).toBe(2);
 });
 it('dropping parent or changing task ID/version within same family cannot bypass cooldown',()=>{
  const first=observation('first','a','2026-01-01T12:00:00Z');
  const next={...observation('next','a','2026-01-01T12:00:01Z'),taskId:'paraphrase',taskVersion:2};
  expect(getAttemptEligibility(next,[first,next]).eligible).toBe(false);
 });
 it('an immediate correction cannot hide failure behind an older delayed success pair',()=>{
  const a=[observation('one','a','2026-01-01T12:00:00Z'),observation('two','b','2026-01-02T12:00:00Z'),observation('failure','a','2026-01-03T12:00:00Z'),observation('correction','a','2026-01-03T12:01:00Z','failure')];
  const {judgments,events}=judged(a,['failure']);expect(getReadiness('skill',{tasks},a,judgments,events).status).toBe('needs_recheck');
 });
 it('fresh delayed retest qualifies despite retaining parent lineage; a lingering draft does not',()=>{
  const first=observation('first','a','2026-01-01T12:00:00Z');
  const later=observation('later','a','2026-01-02T12:00:00Z','first');
  expect(getAttemptEligibility(later,[first,later]).eligible).toBe(true);
  expect(getAttemptEligibility({...later,startedAt:'2026-01-01T12:01:00Z'},[first,later]).eligible).toBe(false);
 });
 it('latest exposure resets the window and hint/assistance exclusions remain',()=>{
  const a=[observation('first','a','2026-01-01T12:00:00Z'),observation('practice','a','2026-01-02T11:00:00Z'),observation('later','a','2026-01-02T12:00:00Z')];
  expect(getAttemptEligibility(a[2],a).eligible).toBe(false);
  expect(getAttemptEligibility({...a[0],assistance:['feedback copied']},[]).eligible).toBe(false);
 });
});
describe('immutable task versions in readiness',()=>{
 const active={tasks:[{...tasks[0],version:2,prompt:'Changed wording'},tasks[1]]};
 it('preserves v1 success and failure after v2 activation',()=>{
  const a=[observation('old','a','2026-01-01T12:00:00Z')];
  const success=judged(a),failure=judged(a,['old']);
  const ready=getReadiness('skill',active,a,success.judgments,success.events,tasks);
  expect(ready).toMatchObject({status:'practicing',observedCount:1,eligibleCount:1,historicalVersionCount:1});expect(ready.explanation).toContain('archived task versions');
  expect(getReadiness('skill',active,a,failure.judgments,failure.events,tasks).status).toBe('needs_recheck');
 });
 it('retirement and missing snapshots retain explicit history instead of unseen',()=>{
  const a=[observation('old','a','2026-01-01T12:00:00Z')],{judgments,events}=judged(a);
  const retired={tasks:[{...tasks[0],version:2,reviewState:'retired' as const},tasks[1]]};
  expect(getReadiness('skill',retired,a,judgments,events,tasks)).toMatchObject({status:'needs_recheck',observedCount:1,eligibleCount:0});
  expect(getReadiness('skill',active,a,judgments,events)).toMatchObject({status:'needs_recheck',observedCount:1});
 });
 it('versions remain one family and unchanged catalogs keep their interpretation',()=>{
  const a=[observation('old','a','2026-01-01T12:00:00Z'),{...observation('new','a','2026-01-02T12:00:00Z'),taskVersion:2}],{judgments,events}=judged(a);
  expect(getReadiness('skill',active,a,judgments,events,tasks)).toMatchObject({status:'practicing',familyCount:1,eligibleCount:2});
  const unchanged=[observation('one','a','2026-01-01T12:00:00Z'),observation('two','b','2026-01-02T12:00:00Z')],j=judged(unchanged);
  expect(getReadiness('skill',{tasks},unchanged,j.judgments,j.events,tasks).status).toBe('independent_evidence');
 });
});

describe('ambiguous simultaneous feedback cannot erase a failure',()=>{
 it('keeps recheck when same-time unparented correction would otherwise restore an older success pair',()=>{
  const a=[observation('one','a','2026-01-01T12:00:00Z'),observation('two','b','2026-01-02T12:00:00Z'),observation('failure','a','2026-01-03T12:00:00Z'),observation('correction','a','2026-01-03T12:00:00Z')];
  const {judgments,events}=judged(a,['failure']);
  const ready=getReadiness('skill',{tasks},a,judgments,events);
  expect(ready.status).toBe('needs_recheck');expect(ready.explanation).toContain('ambiguous same-time');
  const later=observation('retest','a','2026-01-04T12:00:00Z','correction');a.push(later);
  const revised=judged(a,['failure']);expect(getReadiness('skill',{tasks},a,revised.judgments,revised.events).status).toBe('independent_evidence');
 });
 it('parented same-time correction retains the original failure observation',()=>{
  const a=[observation('failure','a','2026-01-03T12:00:00Z'),observation('correction','a','2026-01-03T12:00:00Z','failure')];
  const {judgments,events}=judged(a,['failure']);expect(getReadiness('skill',{tasks},a,judgments,events).status).toBe('needs_recheck');
  expect(getAttemptEligibility(a[0],a).eligible).toBe(true);expect(getAttemptEligibility(a[1],a).eligible).toBe(false);
 });
});
