import {useEffect,useRef,useState} from 'react';
import {api,printable} from './api';
import {AnswerHistory,Badge,PageHeading} from './App';
import {useDraftNavigation,useVersionedDraft} from './DraftNavigation';
import type {Catalog,EventRow,StudyState,Task} from './types';

type PracticeDraft={response:string;hintCount:number;assistance:string[];parentAttemptId?:string;startedAt:string};
function readPracticeDraft(value:unknown):PracticeDraft|null {
  if(typeof value==='string')return {response:value,hintCount:0,assistance:[],startedAt:new Date().toISOString()};
  if(!value||typeof value!=='object'||!('response' in value)||typeof value.response!=='string')return null;
  const d=value as Partial<PracticeDraft>;
  return {response:d.response!,hintCount:d.hintCount??0,assistance:d.assistance??[],parentAttemptId:d.parentAttemptId,startedAt:d.startedAt??new Date().toISOString()};
}
export function Practice({catalog,state,refresh,initialTaskId}:{catalog:Catalog;state:StudyState;refresh:()=>Promise<void>;initialTaskId:string}) {
  const navigation=useDraftNavigation(),tasks=catalog.tasks.filter(t=>t.kind!=='writing');
  const [selected,setSelected]=useState(initialTaskId||tasks[0]?.id||''),[lessonId,setLessonId]=useState(catalog.lessons[0]?.id||''),[filter,setFilter]=useState('all');
  const task=tasks.find(t=>t.id===selected),lesson=catalog.lessons.find(l=>l.id===lessonId),filtered=tasks.filter(t=>filter==='all'||t.kind===filter);
  const lessonTasks=lesson?tasks.filter(t=>t.lessonId===lesson.id):[];
  const updatedPolicyLesson=catalog.lessons.find(l=>l.id==='lesson.obj0001.identification-shared.v1');
  const select=(id:string)=>{void navigation.leave(()=>setSelected(id));};
  return <><PageHeading eyebrow="RETRIEVE → REASON → REVISIT" title="Give the idea a little room." text="Try a check before looking for a hint. Unsure answers and revisions belong here too; they help you decide what to study next."/><div className="practice-layout"><aside className="practice-menu"><label htmlFor="lesson-picker">Short lesson</label><select id="lesson-picker" value={lessonId} onChange={e=>setLessonId(e.target.value)}>{catalog.lessons.map(l=><option key={l.id} value={l.id}>{l.title}</option>)}</select>{lesson&&<section className="lesson"><p className="eyebrow">READ & CONNECT</p><h2>{lesson.title}</h2>{lesson.id==='lesson.current-former'&&updatedPolicyLesson&&<div className="notice"><p>Archived starter lesson: its monitoring-duration research gap has been addressed by the January 2026 guidance supplied on 2026-11-08. The original lesson remains preserved for history; use the updated module for this scope.</p><button type="button" onClick={()=>setLessonId(updatedPolicyLesson.id)}>Read the updated identification module</button></div>}<div className="prose">{lesson.body}</div><p className="tiny muted">Source references: {lesson.sourceRefs.join(', ')}</p><button onClick={()=>{const next=lessonTasks[0]??tasks.find(t=>t.skillIds.some(s=>lesson.skillIds.includes(s)));if(next)select(next.id);}}>Try a related check</button>{lessonTasks.length>0&&<nav aria-label="Checks for this lesson"><p className="small muted">Reading and guided checks create no attempts or independent evidence. For an unaided check, put the lesson and its feedback aside. Use the hint control if consulting them during your response. Open cases remain pending judgment.</p>{lessonTasks.map(t=><button type="button" key={t.id} onClick={()=>select(t.id)}>{t.title}</button>)}</nav>}</section>}<label htmlFor="kind-picker">Practice format</label><select id="kind-picker" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All formats</option><option value="mc">Reasoned choices</option><option value="short">Short recall</option><option value="case">Applied cases</option></select><div className="task-list" aria-label="Practice tasks">{filtered.map(t=><button className={t.id===selected?'selected':''} key={t.id} onClick={()=>select(t.id)}><span className="tiny">{t.kind==='mc'?'CHOICE':t.kind.toUpperCase()} · {t.reviewState.replaceAll('_',' ')}</span><span>{t.title}</span></button>)}</div></aside><section>{task?<PracticeCard key={`${task.id}@${task.version}`} task={task} catalog={catalog} state={state} refresh={refresh}/>:<p>No practice task is available.</p>}</section></div></>;
}

function PracticeCard({task,catalog,state,refresh}:{task:Task;catalog:Catalog;state:StudyState;refresh:()=>Promise<void>}) {
  const navigation=useDraftNavigation();
  const draft=useVersionedDraft<PracticeDraft>({taskId:task.id,taskVersion:task.version,initial:{response:'',hintCount:0,assistance:[],startedAt:new Date().toISOString()},decode:readPracticeDraft,recoveredText:'Draft recovered from this device.',emptyText:'No draft yet.',savedText:'Draft saved on this device.'});
  const {response:answer,hintCount:hints,parentAttemptId}=draft.data;
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[feedback,setFeedback]=useState<unknown>(null);
  const submission=useRef<Promise<void>|null>(null);
  useEffect(()=>navigation.register({flush:async()=>{if(submission.current)await submission.current;},dirty:()=>submission.current!==null}),[navigation.register]);
  const save=()=>{void draft.flush().catch(()=>{});};
  const submit=(value=answer)=>{
    if(submission.current)return;
    setBusy(true);setError('');
    const operation=(async()=>{
      try {
        if(value!==draft.latest().response)draft.change(d=>({...d,response:value}));
        await draft.flush();
        const current=draft.latest();
        const result=await api<{attempt:EventRow;judgment?:EventRow}>('/attempts','POST',{taskId:task.id,taskVersion:task.version,answer:current.response,hintCount:current.hintCount,assistance:[...current.assistance,...(current.hintCount?['study_hint']:[])],parentAttemptId:current.parentAttemptId,startedAt:current.startedAt});
        setFeedback(result.judgment?.result??{status:'needs_review',feedback:'Response preserved for review.'});
        draft.change(d=>({...d,parentAttemptId:result.attempt.id}));
        await draft.flush();await refresh();
      } catch(e){setError((e as Error).message);}finally{setBusy(false);}
    })();
    submission.current=operation;void operation.finally(()=>{if(submission.current===operation)submission.current=null;});
  };
  const freshRetest=async()=>{
    setError('');try {await draft.flush();const previous=state.attempts.filter(a=>a.taskId===task.id).at(-1);draft.change({response:'',hintCount:0,assistance:[],parentAttemptId:previous?.id??parentAttemptId,startedAt:new Date().toISOString()});setFeedback(null);await draft.flush();}catch(e){setError((e as Error).message);}
  };
  const prerequisites=catalog.prerequisites.filter(e=>task.skillIds.includes(e.toSkillId));
  return <><article className="panel practice-card"><div className="spread"><span className="eyebrow">{task.kind==='mc'?'CHOOSE & REASON':task.kind==='case'?'APPLY IN A NEW CONTEXT':'RETRIEVE WITHOUT CUES'}</span><Badge value={task.reviewState}/></div><h2>{task.title}</h2><p className="prompt">{task.prompt}</p>
    {draft.olderDrafts.length>0&&<section className="notice older-drafts"><h3>Drafts from earlier versions</h3><p>These answers belong to a different prompt or identity. They have not been placed in this editor. The saved originals are retained.</p>{draft.olderDrafts.map((old,index)=><details key={`${old.taskVersion}-${index}`}><summary>Saved draft · version {String(old.taskVersion)}</summary><pre>{printable(old.answer)}</pre><p>{old.reason??'Review the changed prompt before copying.'}</p><button type="button" disabled={!draft.loaded||busy} onClick={()=>{const previous=readPracticeDraft(old.answer);if(previous){draft.change({...previous,assistance:[...previous.assistance,'copied_prior_version'],startedAt:new Date().toISOString()});setFeedback(null);}}}>Copy this draft into version {String(task.version)}</button></details>)}</section>}
    {prerequisites.length>0&&<details className="recommendation"><summary>Recommended foundations · optional</summary>{prerequisites.map(e=><p key={e.id}>{catalog.skills.find(s=>s.id===e.fromSkillId)?.title}: {e.rationale}</p>)}<p className="small">This check is available now. Taking it is a diagnostic bypass.</p></details>}
    <form onSubmit={e=>{e.preventDefault();submit();}}><fieldset disabled={!draft.loaded||busy}><legend>Your response</legend>{task.options?.length?task.options.map(o=><label className={`choice ${answer===o.id?'chosen':''}`} key={o.id}><input type="radio" name={`answer-${task.id}`} value={o.id} checked={answer===o.id} onChange={()=>{draft.change(d=>({...d,response:o.id}));setFeedback(null);}}/><span><strong>{o.id.toUpperCase()}</strong> {o.text}</span></label>):<><label htmlFor="practice-answer">Your response</label><textarea id="practice-answer" rows={task.kind==='case'?10:5} value={answer} onChange={e=>{draft.change(d=>({...d,response:e.target.value}));setFeedback(null);}} placeholder="Explain what you would decide and why…"/></>}
    <div className="button-row"><button className="primary" type="submit" disabled={!answer.trim()}>{busy?'Preserving response…':parentAttemptId?'Submit a revision':'Submit response'}</button><button type="button" onClick={()=>submit("I don't know")}>I don't know yet</button><button type="button" onClick={()=>{draft.change(d=>({...d,hintCount:d.hintCount+1}));save();}}>Use a hint</button></div></fieldset>
    {hints>0&&<aside className="notice"><strong>Hint used · {hints}</strong><p>Separate what the evidence tells you from what it cannot establish. Name the learning goal, the language demand, and the next useful observation. The lesson can help you check your reasoning.</p><p className="small">This response remains hint-assisted and cannot establish independent evidence.</p></aside>}
    <div className="spread small muted"><span role="status">{draft.status}</span><button type="button" className="text-button" disabled={!draft.loaded||busy} onClick={save}>Save draft now</button></div></form>
    {(error||draft.error)&&<p className="error" role="alert">{error||draft.error}</p>}
    {feedback!==null&&<section className="feedback" aria-live="polite"><h3>What this response shows</h3>{typeof feedback==='object'&&feedback!==null&&'feedback' in feedback?<><p>{String((feedback as {feedback:unknown}).feedback)}</p><Badge value={String((feedback as {status?:string}).status??'recorded')}/></>:<pre>{printable(feedback)}</pre>}<p className="small">Your answer is preserved exactly. A correction after feedback is practice, not a new independent observation.</p></section>}
    {(parentAttemptId||state.attempts.some(a=>a.taskId===task.id))&&<section className="notice"><h3>Return for an independent retest</h3><p>Save this draft, then deliberately start a blank response. It can qualify only when started at least 24 hours after the last response in this item family, with no hints or assistance. The server checks the delay; revisions remain in history.</p><button disabled={!draft.loaded||busy} onClick={()=>void freshRetest()}>Start fresh retest</button></section>}
    <details className="space-top"><summary>Task provenance</summary><p className="tiny">{task.id} · version {String(task.version)}<br/>Item family: {task.familyId}<br/>Novelty: {task.noveltyKind}<br/>Sources: {task.sourceRefs.join(', ')}</p></details>
  </article><h2 className="space-top">Your attempts on this check</h2><AnswerHistory state={state} taskId={task.id}/></>;
}
