import {useCallback,useEffect,useRef,useState} from 'react';
import type {NativeControlInput,NativeQueue,NativeQueueItem,NativeReceipt} from '../../../packages/shared/src/native-fsrs';
import {api,download} from './api';
import {PageHeading} from './App';
import {useDraftNavigation} from './DraftNavigation';
import {flashcardTime} from './flashcard-time';
import {archiveFlashcardDraft,draftMatchesCard,FLASHCARD_DRAFT_KEY,FlashcardDraftStorage,freshFlashcardDraft,type FlashcardDraft,type FlashcardDraftFile,type PendingFlashcardWrite} from './native-flashcard-draft';

const ratingNames=['Again','Hard','Good','Easy'] as const;
const emptyFile:FlashcardDraftFile={schemaVersion:1,active:null,recovery:[]};
function errorMessage(error:unknown):string{return error instanceof Error?error.message:'The request could not be completed.';}
function conflict(error:unknown):boolean{return error instanceof Error&&'status' in error&&error.status===409;}

export function Flashcards() {
  const navigation=useDraftNavigation();
  const [queue,setQueue]=useState<NativeQueue|null>(null),[file,setFile]=useState<FlashcardDraftFile>(emptyFile);
  const [loaded,setLoaded]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('Loading the local deck…'),[busy,setBusy]=useState(false),[receipt,setReceipt]=useState<NativeReceipt|null>(null);
  const [rawRecovery,setRawRecovery]=useState<string|null>(null);
  const [queueError,setQueueError]=useState('');
  const store=useRef<FlashcardDraftStorage|null>(null),latest=useRef(file),unsaved=useRef(false),inFlight=useRef(false),mounted=useRef(true);
  const initialization=useRef<Promise<unknown>|null>(null);
  const answerHeading=useRef<HTMLHeadingElement>(null),frontHeading=useRef<HTMLHeadingElement>(null),queueHeading=useRef<HTMLHeadingElement>(null);

  const save=useCallback((next:FlashcardDraftFile):boolean=>{
    latest.current=next;setFile(next);unsaved.current=true;
    try {if(!store.current)throw new Error('Browser draft storage is unavailable.');store.current.write(next);unsaved.current=false;return true;}
    catch(cause){setError(`${errorMessage(cause)} Your work remains in this editor. No new request was sent.`);return false;}
  },[]);
  const refresh=useCallback(async()=>{
    // Entering this workspace deliberately enrolls new cards through the protected
    // command. Share the request across concurrent refreshes; a failed/lost
    // response leaves it retryable, while successful refreshes only read.
    if(!initialization.current)initialization.current=api('/native-flashcards/initialize','POST').catch(cause=>{initialization.current=null;throw cause;});
    await initialization.current;
    const result=await api<NativeQueue>('/native-flashcards');
    if(mounted.current){setQueue(result);setQueueError('');}
  },[]);
  useEffect(()=>{
    mounted.current=true;
    try {store.current=new FlashcardDraftStorage(window.localStorage);const recovered=store.current.read();latest.current=recovered;setFile(recovered);setLoaded(true);setStatus(recovered.active?'Recovered unfinished flashcard work from this browser.':'Choose a due card to begin.');}
    catch(cause){setError(errorMessage(cause));try {setRawRecovery(window.localStorage.getItem(FLASHCARD_DRAFT_KEY));}catch {/* Storage access itself may be unavailable. */}}
    void refresh().catch(cause=>{if(mounted.current)setQueueError(errorMessage(cause));});
    return()=>{mounted.current=false;};
  },[refresh]);
  useEffect(()=>navigation.register({
    flush:async()=>{if(unsaved.current){if(!store.current)throw new Error('Draft storage unavailable');store.current.write(latest.current);unsaved.current=false;}},
    dirty:()=>unsaved.current,
  }),[navigation.register]);

  const active=file.active,items=queue?[...queue.queue,...queue.held]:[];
  const current=active?items.find(item=>item.card.id===active.card.id):undefined;
  const mismatch=!!active&&!!queue&&!draftMatchesCard(active,current);
  const held=!!active&&(!!active.heldReason||mismatch)&&!active.pending;
  const change=(update:(draft:FlashcardDraft)=>FlashcardDraft)=>{
    const draft=latest.current.active;if(!draft||draft.pending||inFlight.current)return;
    if(save({...latest.current,active:update(draft)})){setError('');setStatus('Draft saved in this browser.');}
  };
  const begin=(item:NativeQueueItem)=>{
    if(latest.current.active||inFlight.current||!loaded)return;
    const next=freshFlashcardDraft(item,crypto.randomUUID(),new Date().toISOString());
    if(save({...latest.current,active:next})){setError('');setStatus('Front shown. Recall the answer before revealing it.');requestAnimationFrame(()=>frontHeading.current?.focus());}
  };
  const archive=()=>{
    if(inFlight.current)return;
    if(save(archiveFlashcardDraft(latest.current,'Explicitly kept a recovery copy before closing unfinished work.',new Date().toISOString()))){setError('');setQueue(null);setStatus('An exact recovery copy was kept in this browser. You may start a blank review.');void refresh().catch(cause=>{if(mounted.current)setQueueError(errorMessage(cause));});}
  };
  const send=async(pending:PendingFlashcardWrite)=>{
    if(inFlight.current)return;
    const draft=latest.current.active;
    if(!draft||draft.pending?.request.clientEventId!==pending.request.clientEventId)return;
    // Retry always uses these frozen bytes, including the original client time.
    if(!save(latest.current))return;
    inFlight.current=true;setBusy(true);setError('');setStatus('Saving review context and schedule…');
    let receiptSaved=false;
    try {
      const result=await api<NativeReceipt>(`/native-flashcards/${pending.kind==='review'?'reviews':'controls'}`,'POST',pending.request);
      if(result.clientEventId!==pending.request.clientEventId||result.cardId!==pending.request.cardId||result.cardFingerprint!==pending.request.cardFingerprint||result.version!==pending.request.expectedVersion+1)throw new Error('The receipt did not match this submission. Its frozen request remains available to retry.');
      if(mounted.current&&latest.current.active?.pending?.request.clientEventId===pending.request.clientEventId){
        const next={...latest.current,active:null};
        // A receipt clears only its own pending request. A new mounted editor or
        // another tab changing storage makes write() fail rather than lose work.
        if(!store.current)throw new Error('The accepted receipt could not be saved in this browser. Retry the original request after restoring storage.');
        store.current.write(next);latest.current=next;unsaved.current=false;receiptSaved=true;
        if(mounted.current){setFile(next);setReceipt(result);setQueue(null);setStatus(pending.kind==='review'?'Self-reported recall saved. This review creates no learning evidence.':'Card control saved. Prior reviews remain in history.');}
      }
      await refresh();
      if(mounted.current)requestAnimationFrame(()=>queueHeading.current?.focus());
    }catch(cause){
      if(mounted.current){
        if(receiptSaved){
          setError(`Your submission was accepted and its receipt saved, but due cards could not reload: ${errorMessage(cause)} Use Reload due cards to continue.`);
          return;
        }
        const message=errorMessage(cause);setError(message);
        const existing=latest.current.active;
        if(existing&&conflict(cause))save({...latest.current,active:{...existing,heldReason:message}});
        setStatus(conflict(cause)?'Submission held because the saved card state conflicts. Its exact payload is retained.':'The receipt is unconfirmed. The exact pending request is retained; retry safely.');
      }
    }finally{inFlight.current=false;if(mounted.current)setBusy(false);}
  };
  const grade=(rating:1|2|3|4)=>{
    const draft=latest.current.active;
    if(!draft||!draft.revealedAt||draft.pending||inFlight.current||held||!current||!draftMatchesCard(draft,current))return;
    const pending:PendingFlashcardWrite={kind:'review',request:{clientEventId:crypto.randomUUID(),cardId:draft.card.id,cardFingerprint:draft.cardFingerprint,expectedVersion:draft.expectedVersion,response:draft.response,hintCount:draft.hintCount,assistance:[...draft.assistance],rating,revealed:true,startedAt:draft.startedAt,revealedAt:draft.revealedAt,clientNow:new Date().toISOString()}};
    if(save({...latest.current,active:{...draft,pending}}))void send(pending);
  };
  const control=(item:NativeQueueItem,action:NativeControlInput['action'])=>{
    if(latest.current.active||inFlight.current||item.missing)return;
    const now=new Date().toISOString(),draft=freshFlashcardDraft(item,crypto.randomUUID(),now);
    const pending:PendingFlashcardWrite={kind:'control',request:{clientEventId:crypto.randomUUID(),cardId:item.card.id,cardFingerprint:item.cardFingerprint,expectedVersion:item.version,action,clientNow:now}};
    if(save({...latest.current,active:{...draft,pending}}))void send(pending);
  };
  const reveal=()=>{
    const draft=latest.current.active;if(!draft||draft.revealedAt||draft.pending||held)return;
    change(value=>({...value,revealedAt:new Date().toISOString()}));
    if(!unsaved.current){setStatus('Answer revealed. Your earlier response is frozen. Choose your self-reported recall ease.');requestAnimationFrame(()=>answerHeading.current?.focus());}
  };

  return <>
    <PageHeading eyebrow="NATIVE FLASHCARDS" title="Recall, reveal, revisit." text="Twelve starter cards cover a narrow slice of the curriculum. Again, Hard, Good, and Easy record your own recall ease. They do not establish correctness, comprehension, independent evidence, mastery, or an exam pass probability."/>
    <p className="small muted">FSRS-6 schedules local reviews. No model calls. Anki TSV remains a one-way export; reviews are not synchronized.</p>
    <p role="status" aria-live="polite">{status}</p>
    {error&&<p className="error" role="alert">{error}</p>}
    {queueError&&<p className="error" role="alert">{queueError}</p>}
    {rawRecovery!==null&&<button type="button" onClick={()=>download('flashcard-draft-recovery.json',rawRecovery)}>Save unreadable draft recovery copy</button>}
    {unsaved.current&&<button type="button" onClick={()=>download('flashcard-draft-recovery.json',JSON.stringify(latest.current,null,2))}>Save current work as a recovery copy</button>}
    {receipt&&<section className="notice"><strong>{receipt.suspended?'Saved schedule (card suspended)':'Next due'}: {flashcardTime(receipt.schedule.due)}</strong><p className="small">UTC schedule: <time dateTime={receipt.schedule.due}>{receipt.schedule.due}</time><br/>Receipt: {receipt.eventId}</p></section>}
    {!queue&&<button disabled={busy} type="button" onClick={()=>void refresh().catch(cause=>setQueueError(errorMessage(cause)))}>Reload due cards</button>}
    {active&&<article className="panel flashcard-panel" aria-label="Current flashcard">
      <p className="eyebrow">AUTHORED STARTER CARD · {active.card.id}</p>
      <h2 tabIndex={-1} ref={frontHeading}>{active.card.front}</h2>
      <p className="tiny muted flashcard-fingerprint">Card version: {active.cardFingerprint} · schedule version {active.expectedVersion}</p>
      {active.pending?<section className="notice">
        <h3>{active.heldReason?'Held submission':'Pending receipt'}</h3>
        <p>{active.heldReason??'The exact submission is saved in this browser. A retry uses the original submission ID and cannot create a second accepted review.'}</p>
        {active.pending.kind==='review'&&<><p>Recall rating: {ratingNames[active.pending.request.rating-1]}</p><pre aria-label="Pending response">{active.response||'(Blank response)'}</pre><p>Hints: {active.hintCount} · Assistance: {active.assistance.join(', ')||'None reported'}</p></>}
        {active.pending.kind==='control'&&<p>Card control: {active.pending.request.action}</p>}
        <div className="button-row"><button type="button" className="primary" disabled={busy} onClick={()=>active.pending&&void send(active.pending)}>{busy?'Waiting for receipt…':'Retry original submission'}</button><button type="button" disabled={busy} onClick={archive}>Keep a recovery copy and close</button></div>
      </section>:held?<section className="notice"><h3>Draft held for its original card version</h3><p>{active.heldReason??'The card content, schedule, or availability changed. This response has not been attached to the current card.'}</p><pre aria-label="Held response">{active.response||'(Blank response)'}</pre><p>Hints: {active.hintCount} · Assistance: {active.assistance.join(', ')||'None reported'}</p><button type="button" onClick={archive}>Keep a recovery copy and close</button></section>:<>
        <label htmlFor="flashcard-response">Optional typed recall</label>
        <textarea id="flashcard-response" maxLength={150000} value={active.response} readOnly={!!active.revealedAt} disabled={!queue||busy} onChange={event=>change(draft=>({...draft,response:event.target.value}))} onPaste={()=>change(draft=>({...draft,assistance:[...new Set([...draft.assistance,'pasted_text'])]}))} rows={5} aria-describedby="flashcard-recall-help"/>
        <p id="flashcard-recall-help" className="small muted">Your text is preserved exactly. Leave it blank if you prefer. Blank, copied, assisted, and revealed responses never count as independent evidence. Revealing freezes this response.</p>
        <label className="checkbox"><input type="checkbox" checked={active.assistance.includes('consulted_materials')} disabled={active.assistance.includes('consulted_materials')||!!active.revealedAt||busy||!queue} onChange={()=>change(draft=>({...draft,assistance:[...new Set([...draft.assistance,'consulted_materials'])]}))}/>I consulted materials or received help</label>
        <div className="button-row"><button type="button" disabled={active.hintCount>=1000||!!active.revealedAt||busy||!queue} onClick={()=>change(draft=>({...draft,hintCount:Math.min(1000,draft.hintCount+1),assistance:[...new Set([...draft.assistance,'study_hint'])]}))}>Use a recall hint</button>{!active.revealedAt&&<button type="button" className="primary" disabled={busy||!queue} onClick={reveal}>Reveal answer</button>}</div>
        {active.hintCount>0&&<aside className="notice"><strong>Hints used: {active.hintCount}</strong><p>Name the concept, then explain one limit or distinction. This hint use stays attached to your response.</p></aside>}
        {active.revealedAt&&<section className="feedback" aria-label="Revealed answer"><h3 tabIndex={-1} ref={answerHeading}>Answer revealed</h3><p className="prose">{active.card.back}</p><p className="small">Source: {active.card.source}</p><fieldset disabled={busy||!queue}><legend>Your recall ease before revealing</legend><div className="button-row flashcard-ratings">{ratingNames.map((name,index)=><button type="button" key={name} onClick={()=>grade((index+1) as 1|2|3|4)}>{name}</button>)}</div></fieldset></section>}
        <button type="button" className="text-button" disabled={busy} onClick={archive}>Keep a recovery copy and close</button>
      </>}
    </article>}
    {queue&&!active&&<section className="panel"><h2 tabIndex={-1} ref={queueHeading}>{queue.queue.length?'Ready to review':'No cards due now'}</h2><p>{queue.queue.length} cards in this due queue. Learning and relearning cards come first.</p>{queue.queue.length>0&&<button type="button" className="primary" disabled={!loaded||busy} onClick={()=>begin(queue.queue[0]!)}>Review next card</button>}{queue.nextDue&&<p className="small">Next scheduled review: {flashcardTime(queue.nextDue)}<br/><time dateTime={queue.nextDue}>{queue.nextDue}</time> UTC</p>}<button type="button" className="text-button" disabled={busy} onClick={()=>void refresh().catch(cause=>setQueueError(errorMessage(cause)))}>Refresh due cards</button></section>}
    {queue&&queue.held.length>0&&<section className="space-top"><h2>Cards needing attention</h2><p className="small">Changed content needs a deliberate choice. Keep retains the schedule; Reset uses the library's new-card reset. Suspend removes the card from the queue until you resume it. Every choice keeps prior history.</p>{queue.held.map(item=><article className="panel" key={item.card.id}><h3>{item.card.front}</h3><p>{item.missing?'This card is missing or retired. Its history is preserved and it cannot receive current reviews.':item.stale?'The card content has changed since its acknowledged version.':item.suspended?'This card is suspended.':''}</p><p className="tiny flashcard-fingerprint">Current content: {item.cardFingerprint}<br/>Acknowledged content: {item.acknowledgedFingerprint}</p>{!item.missing&&<div className="button-row">{item.stale&&<><button type="button" disabled={!!active||busy||!loaded} onClick={()=>control(item,'keep')}>Keep schedule and acknowledge content</button><button type="button" disabled={!!active||busy||!loaded} onClick={()=>control(item,'reset')}>Reset schedule and acknowledge content</button></>}{(!item.suspended||item.stale)&&<button type="button" disabled={!!active||busy||!loaded} onClick={()=>control(item,'suspend')}>Suspend card</button>}{item.suspended&&!item.stale&&<button type="button" disabled={!!active||busy||!loaded} onClick={()=>control(item,'resume')}>Resume card</button>}</div>}</article>)}</section>}
    {file.recovery.length>0&&<section className="space-top"><h2>Browser recovery copies</h2><p className="small">These are unfinished drafts, not accepted reviews. Their original identities and text remain here; they are never applied to another card.</p>{file.recovery.map((entry,index)=><details key={`${entry.draft.id}-${index}`}><summary>{entry.draft.card.id} · {flashcardTime(entry.archivedAt)}</summary><p>{entry.draft.card.front}</p><pre>{entry.draft.response||'(Blank response)'}</pre><p className="small">{entry.reason}</p><button type="button" onClick={()=>download(`flashcard-recovery-${entry.draft.id}.json`,JSON.stringify(entry,null,2))}>Save this recovery copy</button></details>)}</section>}
    <p className="small muted space-top">Unfinished drafts live in this browser. Use one active flashcard tab at a time. Accepted review history and scheduling live in local SQLite. The existing JSON study export does not include native flashcard history; keep a consistent database backup for full preservation.</p>
  </>;
}
