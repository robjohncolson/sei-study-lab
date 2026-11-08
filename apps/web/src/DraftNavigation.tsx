import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {api} from './api';

type Guard={flush:()=>Promise<void>;dirty:()=>boolean};
type Navigation={register:(guard:Guard)=>()=>void;leave:(action:()=>void)=>Promise<void>;pending:boolean};
const Context=createContext<Navigation|null>(null);

export function DraftNavigation({children}:{children:ReactNode}) {
  const guards=useRef(new Set<Guard>()),leaving=useRef(false);
  const [pending,setPending]=useState(false),[error,setError]=useState('');
  const register=useCallback((guard:Guard)=>{guards.current.add(guard);return()=>{guards.current.delete(guard);};},[]);
  const leave=useCallback(async(action:()=>void)=>{
    if(leaving.current)return;
    leaving.current=true;setPending(true);setError('');
    try {do {for(const guard of guards.current)await guard.flush();} while([...guards.current].some(guard=>guard.dirty()));action();}
    catch {setError('Your latest draft could not be saved. You are still in this editor. Retry saving before leaving.');}
    finally {leaving.current=false;setPending(false);}
  },[]);
  useEffect(()=>{
    const warn=(event:BeforeUnloadEvent)=>{if([...guards.current].some(g=>g.dirty())){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
  },[]);
  const value=useMemo(()=>({register,leave,pending}),[register,leave,pending]);
  return <Context.Provider value={value}>{pending&&<p className="draft-navigation-status" role="status">Saving your latest draft before leaving…</p>}{error&&<p className="draft-navigation-status error" role="alert">{error}</p>}{children}</Context.Provider>;
}

export function useDraftNavigation(){const value=useContext(Context);if(!value)throw new Error('Draft navigation provider is missing');return value;}

export type StoredDraft={answer:unknown;taskVersion:string|number;updatedAt?:string;reason?:string};
type DraftResponse={answer:unknown;taskVersion:string|number;currentTaskVersion:string|number;olderDrafts?:StoredDraft[]};

/** The latest ref is changed synchronously by each edit. All writes are serialized,
 * and navigation waits for every edit through the final successful SQLite save. */
export function useVersionedDraft<T>({taskId,taskVersion,initial,decode,recoveredText,emptyText,savedText}:{taskId:string;taskVersion:string|number;initial:T;decode:(answer:unknown)=>T|null;recoveredText:string;emptyText:string;savedText:string}) {
  const navigation=useDraftNavigation();
  const [data,setData]=useState(initial),[loaded,setLoaded]=useState(false),[status,setStatus]=useState('Loading saved draft…'),[error,setError]=useState(''),[olderDrafts,setOlderDrafts]=useState<StoredDraft[]>([]);
  const current=useRef(initial),revision=useRef(0),savedRevision=useRef(0),loadedRef=useRef(false),inFlight=useRef<Promise<void>|null>(null),decoder=useRef(decode);
  decoder.current=decode;
  const change=useCallback((next:T|((value:T)=>T))=>{
    if(!loadedRef.current)return;
    current.current=typeof next==='function'?(next as (value:T)=>T)(current.current):next;
    revision.current++;setData(current.current);setStatus('Unsaved changes');setError('');
  },[]);
  const flush=useCallback(async()=>{
    if(!loadedRef.current)throw new Error('Wait for the saved draft to finish loading.');
    while(inFlight.current)await inFlight.current;
    if(savedRevision.current===revision.current)return;
    const operation=(async()=>{
      try {
        while(savedRevision.current!==revision.current){
          const targetRevision=revision.current,snapshot=current.current;
          setStatus('Saving draft…');
          await api(`/drafts/${encodeURIComponent(taskId)}`,'PUT',{answer:snapshot,taskVersion});
          savedRevision.current=targetRevision;
        }
        setStatus(savedText);setError('');
      } catch(e){setStatus('Unsaved changes — save failed');setError((e as Error).message);throw e;}
    })();
    inFlight.current=operation;
    try {await operation;} finally {if(inFlight.current===operation)inFlight.current=null;}
  },[taskId,taskVersion,savedText]);
  useEffect(()=>navigation.register({flush,dirty:()=>revision.current!==savedRevision.current}),[navigation.register,flush]);
  useEffect(()=>{
    let active=true;
    void api<DraftResponse>(`/drafts/${encodeURIComponent(taskId)}`).then(response=>{
      if(!active)return;
      const old=[...(response.olderDrafts??[])];
      const sameVersion=String(response.taskVersion)===String(taskVersion);
      const restored=response.answer!=null&&sameVersion?decoder.current(response.answer):null;
      if(response.answer!=null&&!restored)old.unshift({answer:response.answer,taskVersion:response.taskVersion,reason:sameVersion?'Text or rubric identity differs from the current task.':'The prompt version has changed.'});
      if(restored){current.current=restored;setData(restored);}
      setOlderDrafts(old);setStatus(restored?recoveredText:emptyText);loadedRef.current=true;setLoaded(true);
    }).catch(e=>{if(active){setError(`Could not recover the saved draft: ${(e as Error).message}. Reload to retry; editing is disabled to protect existing work.`);setStatus('Draft recovery failed');}});
    return()=>{active=false;};
  },[taskId,taskVersion,recoveredText,emptyText]);
  useEffect(()=>{if(!loaded||revision.current===savedRevision.current)return;const timer=setTimeout(()=>{void flush().catch(()=>{});},900);return()=>clearTimeout(timer);},[data,loaded,flush]);
  return {data,change,flush,loaded,status,error,olderDrafts,latest:()=>current.current};
}
