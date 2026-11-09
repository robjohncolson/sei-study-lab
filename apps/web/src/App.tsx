import { useCallback, useEffect, useRef, useState } from 'react';
import { api, initializeSession, onSignInRequired, printable, type SessionInfo } from './api';
import { AuthScreen } from './AuthScreen';
import type { Catalog, Readiness, StudyState, Task } from './types';
import { Practice } from './Practice';
import { Writing } from './Writing';
import { Standards } from './Standards';
import { SessionPlan } from './SessionPlan';
import { StudyProgress } from './StudyProgress';
import type { StudySlice } from '../../../packages/shared/src/study-estimate';
import { Exchange } from './Exchange';
import { Flashcards } from './Flashcards';
import { getReadiness } from '../../../packages/shared/src/index';
import { useDraftNavigation } from './DraftNavigation';
import { dateLabel } from './date-label';
export { dateLabel } from './date-label';

type View = 'desk'|'practice'|'writing'|'flashcards'|'evidence'|'coverage'|'sources'|'exchange';
const navigation: {id:View; label:string; mark:string}[] = [{id:'desk',label:'Study desk',mark:'01'},{id:'practice',label:'Learn & practice',mark:'02'},{id:'writing',label:'Writing studio',mark:'03'},{id:'evidence',label:'Learning evidence',mark:'04'},{id:'coverage',label:'Standards map',mark:'05'},{id:'sources',label:'Source library',mark:'06'},{id:'exchange',label:'Take it with you',mark:'07'},{id:'flashcards',label:'Flashcards',mark:'08'}];
export function statusName(value: string) { return value.replaceAll('_',' '); }
export function Badge({value}:{value:string}) { return <span className={`badge ${value === 'draft'||value === 'unverified'||value === 'needs_recheck'?'amber':value.includes('evidence')||value==='source_checked'?'green':''}`}>{statusName(value)}</span>; }
export function AnswerHistory({state, taskId}:{state:StudyState;taskId?:string}) {
  const attempts=state.attempts.filter(a=>!taskId||a.taskId===taskId).slice().reverse();
  return <div className="history">{attempts.length===0?<p className="muted">No attempts yet. Your first response will start this history.</p>:attempts.map(a=><details key={a.id}><summary><span>{dateLabel(a.submittedAt)}</span><Badge value={a.hintCount?'hint_assisted':'submitted'}/></summary><p className="small muted">{a.taskId} · version {String(a.taskVersion)} · {a.hintCount??0} hints</p><pre>{printable(a.originalAnswer??a.answer)}</pre>{state.judgments.filter(j=>j.attemptId===a.id).map(j=><div key={j.id} className="feedback"><strong>Recorded judgment</strong><pre>{printable(j.result??j.resultJson??j)}</pre></div>)}</details>)}</div>;
}
export function App() {
  const draftNavigation=useDraftNavigation();
  const authGeneration=useRef(0);
  const [session,setSession]=useState<SessionInfo|null>(null);
  const hosted=session?.storageMode==='postgres';
  const publicHosted=hosted&&session?.authMode==='public';
  const passwordAuth=session?.authMode==='password';
  const [signingOut,setSigningOut]=useState(false);
  const [view,setView]=useState<View>('desk'); const [catalog,setCatalog]=useState<Catalog|null>(null); const [state,setState]=useState<StudyState>({attempts:[],judgments:[],evidenceEvents:[]}); const [error,setError]=useState(''); const [taskId,setTaskId]=useState(''); const [writingTaskId,setWritingTaskId]=useState('');
  const [lessonId,setLessonId]=useState(''),[writingPartId,setWritingPartId]=useState('');
  const refresh=useCallback(async()=>{const generation=authGeneration.current;const value=await api<StudyState>('/state');if(generation===authGeneration.current)setState(value);},[]);
  useEffect(()=>{let active=true;const generation=authGeneration.current;void initializeSession().then(value=>{if(active&&generation===authGeneration.current)setSession(value);}).catch(e=>{if(active&&generation===authGeneration.current)setError(String(e.message));});return()=>{active=false;};},[]);
  useEffect(()=>{if(session?.authMode!=='password')return;return onSignInRequired(()=>{
    const generation=++authGeneration.current;
    setSession(value=>value?.authMode==='password'?{...value,signedIn:false,username:null}:value);
    setCatalog(null);setState({attempts:[],judgments:[],evidenceEvents:[]});setError('');setView('desk');
    void initializeSession().then(value=>{if(generation===authGeneration.current)setSession(value);}).catch(()=>{});
  });},[session?.authMode]);
  useEffect(()=>{
    if(!session||(session.authMode==='password'&&!session.signedIn))return;
    let active=true;
    const generation=authGeneration.current;
    void Promise.all([api<Catalog>('/catalog'),api<StudyState>('/state')]).then(([c,s])=>{
      if(active&&generation===authGeneration.current){setCatalog(c);setState(s);if(session.authMode==='password')requestAnimationFrame(()=>document.getElementById('main')?.focus());}
    }).catch(e=>{if(active&&generation===authGeneration.current)setError(String(e.message));});
    return()=>{active=false;};
  },[session]);
  const authenticated=async()=>{const generation=++authGeneration.current;const value=await initializeSession();if(generation!==authGeneration.current)return;setCatalog(null);setState({attempts:[],judgments:[],evidenceEvents:[]});setError('');setView('desk');setSession(value);};
  const signOut=async()=>{
    ++authGeneration.current;
    setSigningOut(true);
    try{await api('/auth/logout','POST');setSession(value=>value?{...value,signedIn:false,username:null}:value);setCatalog(null);setState({attempts:[],judgments:[],evidenceEvents:[]});setView('desk');setError('');await authenticated();}
    catch(cause){setError((cause as Error).message);}
    finally{setSigningOut(false);}
  };
  const navigate=(next:View)=>{void draftNavigation.leave(()=>{setView(next);setLessonId('');setWritingPartId('');setError('');window.scrollTo(0,0);});};
  const practice=(task?:Task)=>{void draftNavigation.leave(()=>{setTaskId(task?.id??'');setLessonId('');setView('practice');setError('');window.scrollTo(0,0);});};
  const openTask=(task:Task)=>{void draftNavigation.leave(()=>{setLessonId('');setWritingPartId('');if(task.kind==='writing'){setWritingTaskId(task.id);setView('writing');}else{setTaskId(task.id);setView('practice');}setError('');window.scrollTo(0,0);requestAnimationFrame(()=>document.getElementById('main')?.focus());});};
  const openStudySlice=(slice:StudySlice)=>{void draftNavigation.leave(()=>{
    if(slice.track==='flashcards')setView('flashcards');
    else if(slice.track==='essay'){setWritingTaskId(slice.taskId??'');setWritingPartId(slice.partId??'');setView('writing');}
    else{setTaskId(slice.taskId??'');setLessonId(slice.lessonId??'');setView('practice');}
    setError('');window.scrollTo(0,0);requestAnimationFrame(()=>document.getElementById('main')?.focus());
  });};
  const ready=(skillId:string):Readiness=>catalog?getReadiness(skillId,catalog,state.attempts,state.judgments,state.evidenceEvents,state.taskVersions):{status:'unseen',explanation:'No attempts yet.'};
  const content = !catalog ? <section className="panel"><h2>{error?'Could not open the study desk':'Opening your study desk…'}</h2><p>{error||(hosted?'Reading the curriculum and your saved work.':'Reading the local curriculum and your saved work.')}</p>{error&&<button onClick={()=>window.location.reload()}>Retry</button>}</section> : <>
    {view==='desk'&&<><StudyProgress catalog={catalog} onOpenSlice={openStudySlice}/><section className="hero"><div><p className="eyebrow">A little retrieval. A little application. Every day.</p><h1>Build understanding.<br/><em>Keep the evidence.</em></h1><p className="hero-copy">A quiet workspace for Sheltered English Immersion, grounded in sources and the decisions you make as a teacher.</p><button className="primary" onClick={()=>practice(catalog.tasks.find(t=>t.kind==='mc'))}>Begin a practice check <span aria-hidden="true">↗</span></button></div><div className="hero-note"><span className="note-rule"/><p className="eyebrow">Your planning target</p><strong>16 January<br/>2027</strong><p>MTEL Field 56<br/>Planning target · exam not booked</p><span className="tiny">Progress here is evidence of practice, never a prediction of passing.</span></div></section><section className="stats" aria-label="Study overview"><div><strong>{catalog.objectives.length}</strong><span>objectives in the inventory</span></div><div><strong>{catalog.lessons.length}</strong><span>short lessons to explore</span></div><div><strong>{state.attempts.length}</strong><span>responses you've preserved</span></div><div><strong>{catalog.tasks.filter(t=>t.reviewState==='source_checked'||t.reviewState==='human_reviewed').length}<small> / {catalog.tasks.length}</small></strong><span>source-checked practice tasks</span></div></section><SessionPlan catalog={catalog} onOpenTask={openTask} onSeeGaps={()=>navigate('coverage')}/><div className="section-title"><h2>Make a useful next move</h2><span className="muted small">Start where you are</span></div><section className="three-columns"><button className="action-card" onClick={()=>practice()}><span className="card-number">01 / RETRIEVE</span><h3>Put an idea into words</h3><p>Short lessons, contrasting cases, and checks that ask you to choose a reason.</p><span className="text-link">Open practice →</span></button><button className="action-card" onClick={()=>navigate('writing')}><span className="card-number">02 / APPLY</span><h3>Plan from a real text</h3><p>Develop a five-part lesson plan with one authored mentor text held throughout.</p><span className="text-link">Enter writing studio →</span></button><button className="action-card" onClick={()=>navigate('evidence')}><span className="card-number">03 / REFLECT</span><h3>See what the work shows</h3><p>Keep hints, uncertainty, and revisions visible alongside successful responses.</p><span className="text-link">Review your evidence →</span></button></section><section className="notice"><strong>A fresh start, honestly.</strong><p>Prior conversation is context, not mastery. Objective 0001 policy and identification remain substantially untested. Current legal specifics stay marked as research gaps until verified.</p></section></>}
    {view==='practice'&&<Practice catalog={catalog} state={state} refresh={refresh} initialTaskId={taskId} initialLessonId={lessonId}/>}
    {view==='writing'&&<Writing catalog={catalog} state={state} refresh={refresh} initialTaskId={writingTaskId} initialPartId={writingPartId} hosted={hosted}/>}
    {view==='flashcards'&&<Flashcards/>}
    {view==='evidence'&&<><PageHeading eyebrow="WHAT YOUR WORK SUPPORTS" title="Evidence, with the uncertainty intact." text="These are educational heuristics, not pass predictions. Distinct item families, no hints, reviewed tasks and judgments, and at least 24 hours between qualifying observations are required for promotion."/><div className="two-columns">{catalog.skills.map(s=>{const r=ready(s.id);return <section className="panel" key={s.id}><Badge value={r.status}/><h2>{s.title}</h2><p>{r.explanation??r.reason??'Insufficient evidence.'}</p><p className="small muted">{r.eligibleCount??0} qualifying successes / {state.evidenceEvents.filter(e=>e.skillId===s.id).length} recorded events</p>{r.exclusions&&r.exclusions.length>0&&<details><summary>Why observations do not qualify ({r.exclusions.length})</summary>{r.exclusions.map(e=><p className="small" key={e.attemptId}>{e.reason} <span className="tiny muted">Attempt {e.attemptId}</span></p>)}</details>}{r.dates&&<p className="small">Observations: {r.dates.map(dateLabel).join(' · ')}</p>}<button onClick={()=>practice(catalog.tasks.find(t=>t.skillIds.includes(s.id)&&t.kind!=='writing'))}>Practice this skill</button></section>;})}</div><h2 className="space-top">Response archive</h2><p className="muted">Original answers are preserved. Revisions and corrected judgments create new records.</p><AnswerHistory state={state}/></>}
    {view==='coverage'&&<Standards catalog={catalog} state={state} onPractice={()=>practice()}/>}
    {view==='sources'&&<><PageHeading eyebrow="AUTHORITY & PROVENANCE" title="Know what supports the content." text="Official source excerpts and authored practice are kept separate. Source-compared means a recorded comparison; only a real human review can earn human-reviewed status."/><div className="two-columns">{catalog.sources.map(s=><article className="panel source" key={s.id}><Badge value={s.reviewState}/><h2>{s.title}</h2><p className="small">Retrieved: {dateLabel(s.retrievedAt)}<br/>Effective date: {s.effectiveDate??'Not established; do not infer current legal requirements.'}</p>{s.excerpt&&<blockquote>{s.excerpt}</blockquote>}{typeof s.error==='string'&&s.error&&<p className="notice">Verification gap: {s.error}</p>}<details><summary>Source identity</summary><p className="small">{s.id} · version {String(s.version)}</p><code className="hash">{s.sha256||'Hash unavailable'}</code></details><a href={s.url} target="_blank" rel="noreferrer">Open official source <span aria-hidden="true">↗</span></a><p className="tiny muted">Opens an external website only when selected.</p></article>)}</div><section className="notice"><strong>Independent application. No official affiliation.</strong><p>Historical law references in an exam framework do not establish current Massachusetts policy. Unverified requirements, cutoffs, durations, and accommodations remain research gaps.</p></section></>}
    {view==='exchange'&&<Exchange catalog={catalog} state={state} refresh={refresh} hosted={hosted}/>}
  </>;
  if(passwordAuth&&!session.signedIn)return <AuthScreen session={session} onAuthenticated={authenticated}/>;
  return <div className="app-shell"><a className="skip-link" href="#main">Skip to main content</a><aside className="sidebar"><button className="brand" onClick={()=>navigate('desk')} aria-label="SEI Study Lab home"><span className="brand-symbol" aria-hidden="true">s<span>e</span>i</span><span>STUDY LAB<small>A teacher's working notebook</small></span></button><nav aria-label="Workspace">{navigation.map(n=><button key={n.id} onClick={()=>navigate(n.id)} aria-current={view===n.id?'page':undefined}><span className="nav-mark">{n.mark}</span>{n.label}</button>)}</nav>{passwordAuth&&session.signedIn&&<div className="sidebar-account"><p>Signed in as <strong>{session.username}</strong></p><button type="button" disabled={signingOut||draftNavigation.pending} onClick={()=>{void draftNavigation.leave(()=>{void signOut();});}}>{signingOut?'Signing out…':'Sign out'}</button></div>}<div className="sidebar-bottom"><span className="local-dot"/> {hosted?(publicHosted?'HOSTED & PUBLIC':passwordAuth?'HOSTED · SIGNED IN':'HOSTED STUDY'):'LOCAL & PRIVATE'}<p>{hosted?(passwordAuth?'Saved to your account. Sign in on any computer to continue.':'Saved in the hosted study history.'):'Saved on this device.'}<br/>{publicHosted?'Anyone with this URL can read and write this study history.':hosted?'Owner sign-in required. No automatic model calls.':passwordAuth?'Local accounts share this device’s study history.':'No automatic model calls. No account needed.'}</p><span className="tiny">MTEL 56 · Independent practice</span></div></aside><div className="main-shell"><header className="topbar"><span>YOUR STUDY DESK <span className="top-divider">/</span> {navigation.find(n=>n.id===view)?.label}</span><span className="local-label"><span className="local-dot"/> {hosted?(publicHosted?'Public hosted copy':passwordAuth?'Saved to your account':'Hosted copy'):'Offline core'}</span></header><main id="main" tabIndex={-1}>{publicHosted&&<p className="notice" role="status">Public hosted copy: anyone with this URL can read and write this study history.</p>}{error&&catalog&&<p role="alert" className="error">{error}</p>}{content}</main><footer>SEI Study Lab <span>{hosted?(publicHosted?'Public hosted copy. Shared study history.':'Hosted copy. Owner study history.'):'Thoughtful practice. Honest evidence.'}</span></footer></div></div>;
}
export function PageHeading({eyebrow,title,text}:{eyebrow:string;title:string;text:string}) { return <header className="page-heading"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{text}</p></header>; }
