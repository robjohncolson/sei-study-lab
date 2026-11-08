import {describe,it,expect} from 'vitest';
import {getReadiness,validateCatalog,validateProposal,ProposalSchema,type Catalog} from '../packages/shared/src/index.js';
const task=(id:string,family:string,noveltyKind='familiar')=>({id,version:1,skillIds:['skill'],familyId:family,reviewState:'source_checked',noveltyKind});
const catalog={tasks:[task('a','family-a'),task('b','family-b'),task('c','family-a'),task('transfer','new','unfamiliar')]} as unknown as Catalog;
const attempt=(id:string,taskId:string,date:string,hintCount=0)=>({id,taskId,taskVersion:1,submittedAt:date,startedAt:date,hintCount,assistance:[]});
const judgment=(id:string,status='correct')=>({id:`j-${id}`,attemptId:id,result:{status,sourceChecked:true,provisional:false}});
const evidence=(id:string,eligible=true)=>({attemptId:id,judgmentId:`j-${id}`,skillId:'skill',eligible});
const now='2026-11-08T12:00:00Z',later='2026-11-09T12:00:00Z';
describe('transparent readiness',()=>{
 it('empty skill never mastered',()=>expect(getReadiness('empty',catalog,[],[],[]).status).toBe('unseen'));
 it('hinted success cannot promote even when imported event claims eligibility',()=>expect(getReadiness('skill',catalog,[attempt('1','a',now,1),attempt('2','b',later,1)],[judgment('1'),judgment('2')],[evidence('1'),evidence('2')]).status).toBe('exposed'));
 it('requires distinct families and a 24-hour delay',()=>{
 expect(getReadiness('skill',catalog,[attempt('1','a',now),attempt('2','b',later)],[judgment('1'),judgment('2')],[evidence('1'),evidence('2')]).status).toBe('independent_evidence');
 expect(getReadiness('skill',catalog,[attempt('1','a',now),attempt('2','b',now)],[judgment('1'),judgment('2')],[evidence('1'),evidence('2')]).status).toBe('practicing');
 expect(getReadiness('skill',catalog,[attempt('1','a',now),attempt('2','c',later)],[judgment('1'),judgment('2')],[evidence('1'),evidence('2')]).status).toBe('practicing');
 });
 it('requires explicit unfamiliar transfer and later failure retains history',()=>{
 const a=[attempt('1','a',now),attempt('2','transfer',later)],j=[judgment('1'),judgment('2')],e=[evidence('1'),evidence('2')];
 expect(getReadiness('skill',catalog,a,j,e).status).toBe('transfer_evidence');
 a.push(attempt('3','b','2026-11-10T12:00:00Z'));j.push(judgment('3','incorrect'));e.push(evidence('3'));
 expect(getReadiness('skill',catalog,a,j,e)).toMatchObject({status:'needs_recheck',eligibleCount:2});
 });
 it('superseding judgment replaces score interpretation without removing original',()=>{
 const j=[judgment('1'),{...judgment('1','incorrect'),id:'replacement',supersedesId:'j-1'}];
 const result=getReadiness('skill',catalog,[attempt('1','a',now)],j,[evidence('1'),{...evidence('1'),judgmentId:'replacement'}]);
 expect(result.eligibleCount).toBe(0);expect(j).toHaveLength(2);
 });
});
const empty:Catalog={schemaVersion:1,sources:[],objectives:[],statements:[],competencies:[],indicators:[],skills:[{id:'a',version:1,title:'a',status:'draft'},{id:'b',version:1,title:'b',status:'draft'}],alignments:[],prerequisites:[],lessons:[],tasks:[],cards:[],mentorTexts:[],rubrics:[],reviewEvents:[]};
describe('catalog graph',()=>{
 it('accepts empty inventory with no invented evidence',()=>expect(validateCatalog(empty)).toEqual([]));
 it('rejects cycles, self edges, duplicates and unknown IDs',()=>{
 const edges=[{id:'1',fromSkillId:'a',toSkillId:'b',rationale:'practice'},{id:'2',fromSkillId:'b',toSkillId:'a',rationale:'practice'},{id:'3',fromSkillId:'a',toSkillId:'b',rationale:'duplicate'},{id:'4',fromSkillId:'a',toSkillId:'a',rationale:'self'},{id:'5',fromSkillId:'missing',toSkillId:'a',rationale:'unknown'}];
 const errors=validateCatalog({...empty,prerequisites:edges}).join(' ');for(const term of ['Cycle','Self-edge','Duplicate edge','Unknown'])expect(errors).toContain(term);
 });
 it('rejects incompatible schema versions',()=>expect(validateCatalog({...empty,schemaVersion:900})).not.toEqual([]));
});
describe('manual judgment schema',()=>{
 const proposal={schemaVersion:1,packetId:'packet',attemptId:'attempt',taskVersion:1,rubricVersion:null,judgeLabel:'Synthetic reviewer',provisional:true,criteriaFeedback:[{criterionId:'purpose',comment:'Synthetic only',answerQuotes:['oral rehearsal'],missingEvidence:[]}],holisticScore:null,needsHumanReview:true,reason:'Practice',proposedEvidence:[]};
 const packet={id:'packet',attemptId:'attempt',rubricVersion:null},a={id:'attempt',taskVersion:1,originalAnswer:'Use oral rehearsal before writing.'};
 it('accepts exact answer quotation',()=>expect(validateProposal(proposal,packet,a)).toEqual([]));
 it('rejects mismatched identities and invented quotations',()=>{
 expect(validateProposal({...proposal,taskVersion:2},packet,a)).toContain('Task version mismatch');
 expect(validateProposal(proposal,packet,{...a,originalAnswer:'Different answer'})).toContain('Answer quote does not occur in original answer');
 });
 it('rejects arbitrary actions and nonprovisional scores',()=>{
 expect(ProposalSchema.safeParse({...proposal,execute:'file write'}).success).toBe(false);
 expect(ProposalSchema.safeParse({...proposal,provisional:false}).success).toBe(false);
 });
});


describe('independent evidence survives diagnostic proposals',()=>{
 it('provisional approval cannot conceal the latest failure',()=>{
 const attempts=[attempt('1','a',now),attempt('2','b',later),attempt('3','a','2026-11-10T12:00:00Z')];
 const judgments=[judgment('1'),judgment('2'),judgment('3','incorrect'),{id:'proposal',attemptId:'3',supersedesId:'j-3',result:{status:'needs_review',provisional:true,sourceChecked:false}}];
 expect(getReadiness('skill',catalog,attempts,judgments,[evidence('1'),evidence('2'),evidence('3')]).status).toBe('needs_recheck');
 });
 it('compares instants rather than lexical date strings',()=>{
 const attempts=[attempt('1','a','2026-11-01T12:00:00Z'),attempt('2','b','2026-11-01T12:00:00.999Z')];
 expect(getReadiness('skill',catalog,attempts,[judgment('1'),judgment('2','incorrect')],[evidence('1'),evidence('2')]).status).toBe('needs_recheck');
 });
});
