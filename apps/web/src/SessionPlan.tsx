import {useEffect, useState} from 'react';
import {planSession} from '../../../packages/shared/src/planner';
import {api} from './api';
import type {Catalog, StudyState, Task} from './types';

const tracks = {
  RETRIEVAL: {label:'Retrieval', launch:'retrieval'},
  APPLICATION_TRANSFER: {label:'Application / transfer', launch:'application'},
  WRITING: {label:'Writing', launch:'writing'},
};

/** Reading suggestions never submits a response, resets a draft, or creates evidence. */
export function SessionPlan({catalog, onOpenTask, onSeeGaps}:{catalog:Catalog;onOpenTask:(task:Task)=>void;onSeeGaps:()=>void}) {
  const [snapshot,setSnapshot]=useState<{state:StudyState;now:string}|null>(null);
  const [loading,setLoading]=useState(true),[error,setError]=useState('');
  const tasks=catalog.tasks.slice().sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const [chosen,setChosen]=useState(tasks[0]?.id??'');
  useEffect(()=>{
    let active=true;
    // The desk mounts after the navigation guard has finished saving drafts.
    void api<StudyState>('/state').then(state=>{if(active)setSnapshot({state,now:new Date().toISOString()});})
      .catch(e=>{if(active)setError((e as Error).message);})
      .finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[]);
  const refresh=async()=>{
    setLoading(true);setError('');
    try {setSnapshot({state:await api<StudyState>('/state'),now:new Date().toISOString()});}
    catch(e){setError((e as Error).message);}
    finally {setLoading(false);}
  };
  const plan=snapshot?planSession({catalog,state:snapshot.state,now:snapshot.now}):null;
  return <section className="space-top session-plan" aria-labelledby="session-plan-title">
    <div className="section-title"><h2 id="session-plan-title">A short next session</h2><button type="button" disabled={loading} onClick={()=>void refresh()}>Refresh recommendations</button></div>
    <p className="small muted">Local suggestions from saved history and current curriculum gaps. Source-checked tasks are model-assisted and source-compared; they are not human validated. Opening a task records no attempt or evidence.</p>
    {loading&&<p role="status">Reading saved history and drafts…</p>}
    {error&&<p className="error" role="alert">Recommendations could not be refreshed: {error}. Choose an existing task below or retry.</p>}
    {plan&&!loading&&!error&&<>
      <p className="tiny muted">Evaluated at <time dateTime={plan.asOf}>{new Date(plan.asOf).toLocaleString()}</time>. Refresh to check a later cooldown boundary.</p>
      <div className="three-columns">{plan.recommendations.map(item=>{
        const track=tracks[item.track],task=catalog.tasks.find(t=>t.id===item.taskId&&String(t.version)===String(item.taskVersion));
        return <article className="panel" data-track={item.track} key={item.track} aria-labelledby={`plan-${item.track}`}>
          <p className="eyebrow" id={`plan-${item.track}`}>{track.label}</p><h3>{item.title}</h3>
          <ul className="small">{item.reasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul>
          <p className="small"><strong>{item.independence.replaceAll('_',' ')}</strong></p>
          {item.availableAt&&<p className="small">Earliest fresh start: <time dateTime={item.availableAt}>{new Date(item.availableAt).toLocaleString()}</time></p>}
          {task&&item.kind==='task'?<button type="button" aria-label={`Open recommended ${track.launch} task`} onClick={()=>onOpenTask(task)}>{item.startMode==='resume'?'Open saved work':'Open task'}</button>:<button type="button" onClick={onSeeGaps}>Review {track.label.toLowerCase()} gaps</button>}
        </article>;
      })}</div>
      <details className="space-top"><summary>Recommendation limits and gaps ({plan.gaps.length} statements)</summary><ul>{plan.limitations.map((limit,index)=><li key={index}>{limit}</li>)}</ul><p>Per-statement scope and unsupported areas are listed in the standards map. A recommendation is not a mastery judgment.</p></details>
    </>}
    <div className="panel space-top"><label htmlFor="session-task-override">Choose any existing task</label>
      <select id="session-task-override" value={chosen} onChange={e=>setChosen(e.target.value)}>{tasks.map(task=><option key={task.id} value={task.id}>{task.title} · {task.kind} · v{String(task.version)} · {task.reviewState.replaceAll('_',' ')}</option>)}</select>
      <div className="button-row"><button type="button" disabled={!chosen} onClick={()=>{const task=tasks.find(t=>t.id===chosen);if(task)onOpenTask(task);}}>Open chosen task</button><button type="button" onClick={onSeeGaps}>See statement gaps</button></div>
      <p className="small muted">You can override the queue. Saved answers keep their original start time and assistance. Use the existing “Start fresh retest” action deliberately after the family cooldown; opening a recommendation does not clear a held draft.</p>
    </div>
  </section>;
}
