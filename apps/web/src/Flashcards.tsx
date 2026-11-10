import {useCallback,useEffect,useRef,useState} from 'react';
import type {NativeControlInput,NativeQueue,NativeQueueItem,NativeReceipt} from '../../../packages/shared/src/native-fsrs';
import {exactRecallMatch,FLASHCARD_AI_PRIVACY_NOTICE,formatElapsed,isBlankRecall,ratingFromCloseness,type Closeness} from '../../../packages/shared/src/flashcard-grade';
import {api,download} from './api';
import {PageHeading} from './App';
import {useDraftNavigation} from './DraftNavigation';
import {flashcardTime} from './flashcard-time';
import {archiveFlashcardDraft,draftMatchesCard,FLASHCARD_DRAFT_KEY,FlashcardDraftStorage,freshFlashcardDraft,type FlashcardCheck,type FlashcardDraft,type FlashcardDraftFile,type PendingFlashcardWrite} from './native-flashcard-draft';

const ratingNames=['Again','Hard','Good','Easy'] as const;
const emptyFile:FlashcardDraftFile={schemaVersion:1,active:null,recovery:[]};
const consentKey='sei.flashcard-ai-consent.v1';
type GradeStatus={available:boolean;reason?:string;model:string;privacyNotice:string;remainingFlashcardRequestsToday:number};
type GradePreview={available:boolean;model:string;sentData:{front:string;back:string;response:string};previewSha256:string;privacyNotice:string};
type GradeResult={closeness:Closeness;source:'ai'|'exact';explanation:string};
type PreviewState={key:string;value?:GradePreview;error?:string};
function errorMessage(error:unknown):string{return error instanceof Error?error.message:'The request could not be completed.';}
function conflict(error:unknown):boolean{return error instanceof Error&&'status' in error&&error.status===409;}
function previewKey(draft:FlashcardDraft):string{return JSON.stringify([draft.id,draft.cardFingerprint,draft.response]);}
function elapsed(draft:FlashcardDraft):number{return Date.parse(draft.revealedAt??new Date().toISOString())-Date.parse(draft.startedAt);}
function checkedDraft(draft:FlashcardDraft,closeness:Closeness|'empty',source:'ai'|'exact'|'empty'|'dont_know',explanation:string|null):FlashcardCheck {
  return {closeness,source,explanation,suggestedRating:ratingFromCloseness({closeness,elapsedMs:elapsed(draft),back:draft.card.back,assistance:draft.assistance,hintCount:draft.hintCount}).rating};
}
function verdict(check:Exclude<FlashcardCheck,{fallback:true}>):string {
  if(check.source==='dont_know')return "You chose I don't know";
  if(check.closeness==='empty')return 'No recall entered';
  if(check.source==='exact')return 'Correct (exact match)';
  return `${check.closeness==='correct'?'Correct':check.closeness==='close'?'Close':'Not yet'} — unofficial AI check`;
}
function ratingReason(draft:FlashcardDraft,check:Exclude<FlashcardCheck,{fallback:true}>):string {
  const mapped=ratingFromCloseness({closeness:check.closeness,elapsedMs:elapsed(draft),back:draft.card.back,assistance:draft.assistance,hintCount:draft.hintCount});
  if(mapped.capped)return 'Help or hints used, capped at Hard.';
  if(check.closeness==='empty')return 'No recall to schedule yet; revisit with Again.';
  if(check.closeness==='incorrect')return 'Recall did not match the target; revisit with Again.';
  if(check.closeness==='close')return 'Close to the target; revisit with Hard.';
  return mapped.speed==='fast'?'Correct and fast.':mapped.speed==='slow'?'Correct but slower than expected.':'Correct at a typical pace.';
}
async function timedCheck<T>(request:(waiting:()=>boolean)=>Promise<T>):Promise<T> {
  let waiting=true,timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([request(()=>waiting),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{waiting=false;reject(new Error('The AI check timed out. Choose a rating yourself.'));},55_000);})]);}
  finally{waiting=false;clearTimeout(timer);}
}

export function Flashcards() {
  const navigation=useDraftNavigation();
  const [queue,setQueue]=useState<NativeQueue|null>(null),[file,setFile]=useState<FlashcardDraftFile>(emptyFile);
  const [loaded,setLoaded]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('Loading the local deck…'),[busy,setBusy]=useState(false),[receipt,setReceipt]=useState<NativeReceipt|null>(null);
  const [rawRecovery,setRawRecovery]=useState<string|null>(null);
  const [queueError,setQueueError]=useState('');
  const [aiStatus,setAiStatus]=useState<GradeStatus|null>(null),[aiConsent,setAiConsent]=useState(()=>{try{return sessionStorage.getItem(consentKey)==='true';}catch{return false;}});
  const [checkingId,setCheckingId]=useState<string|null>(null),[changeRating,setChangeRating]=useState(false),[tick,setTick]=useState(Date.now());
  const [previewOpen,setPreviewOpen]=useState(false),[preview,setPreview]=useState<PreviewState|null>(null);
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
    void api<GradeStatus>('/flashcard-grade/status').then(result=>{if(mounted.current)setAiStatus(result);}).catch(()=>{if(mounted.current)setAiStatus({available:false,reason:'AI checking is unavailable.',model:'',privacyNotice:FLASHCARD_AI_PRIVACY_NOTICE,remainingFlashcardRequestsToday:0});});
    return()=>{mounted.current=false;};
  },[refresh]);
  useEffect(()=>navigation.register({
    flush:async()=>{if(unsaved.current){if(!store.current)throw new Error('Draft storage unavailable');store.current.write(latest.current);unsaved.current=false;}},
    dirty:()=>unsaved.current,
  }),[navigation.register]);

  const active=file.active,items=queue?[...queue.queue,...queue.held]:[];
  const checking=!!active&&checkingId===active.id;
  useEffect(()=>{
    if(!active||active.revealedAt)return;
    const timer=setInterval(()=>setTick(Date.now()),200);
    return()=>clearInterval(timer);
  },[active?.id,active?.revealedAt]);
  useEffect(()=>{
    setChangeRating(false);setPreviewOpen(false);setPreview(null);
  },[active?.id]);
  useEffect(()=>{
    if(!previewOpen||!aiStatus?.available||!active||isBlankRecall(active.response))return;
    const key=previewKey(active);let cancelled=false;
    setPreview({key});
    void timedCheck(()=>api<GradePreview>('/flashcard-grade/preview','POST',{cardId:active.card.id,cardFingerprint:active.cardFingerprint,response:active.response})).then(value=>{if(!cancelled)setPreview({key,value});}).catch(cause=>{if(!cancelled)setPreview({key,error:errorMessage(cause)});});
    return()=>{cancelled=true;};
  },[previewOpen,aiStatus?.available,active?.id,active?.cardFingerprint,active?.response]);
  const current=active?items.find(item=>item.card.id===active.card.id):undefined;
  const mismatch=!!active&&!!queue&&!draftMatchesCard(active,current);
  const held=!!active&&(!!active.heldReason||mismatch)&&!active.pending;
  const change=(update:(draft:FlashcardDraft)=>FlashcardDraft)=>{
    const draft=latest.current.active;if(!draft||draft.revealedAt||draft.pending||inFlight.current)return;
    if(save({...latest.current,active:update(draft)})){setError('');setStatus('Draft saved in this browser.');}
  };
  const begin=(item:NativeQueueItem)=>{
    if(latest.current.active||inFlight.current||!loaded)return;
    const next=freshFlashcardDraft(item,crypto.randomUUID(),new Date().toISOString());
    if(save({...latest.current,active:next})){setTick(Date.now());setError('');setStatus('Front shown. Type what you remember, then check.');requestAnimationFrame(()=>frontHeading.current?.focus());}
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
        if(mounted.current){setFile(next);setReceipt(result);setQueue(null);setStatus(pending.kind==='review'?'Review saved. This schedules the card only; it creates no learning evidence.':'Card control saved. Prior reviews remain in history.');}
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
  const checkAnswer=async(dontKnow=false)=>{
    const draft=latest.current.active;if(!draft||draft.revealedAt||draft.pending||held)return;
    const frozen={...draft,revealedAt:new Date().toISOString()};
    const useAi=aiStatus?.available&&aiConsent;
    const initialCheck:FlashcardCheck=dontKnow?checkedDraft(frozen,'empty','dont_know',null):isBlankRecall(frozen.response)?checkedDraft(frozen,'empty','empty',null):exactRecallMatch(frozen.response,frozen.card.back)?checkedDraft(frozen,'correct','exact','Matches the target answer.'):{fallback:true,reason:useAi?'The AI check was interrupted. Choose a rating yourself.':'AI checking is off; choose a rating.'};
    if(!save({...latest.current,active:{...frozen,check:initialCheck}}))return;
    setError('');setChangeRating(false);setStatus('Answer checked. Your recall and time are frozen.');requestAnimationFrame(()=>answerHeading.current?.focus());
    if(!('fallback' in initialCheck)||!useAi)return;
    setCheckingId(frozen.id);
    try{
      const result=await timedCheck(async waiting=>{
        const payload={cardId:frozen.card.id,cardFingerprint:frozen.cardFingerprint,response:frozen.response};
        const shown=await api<GradePreview>('/flashcard-grade/preview','POST',payload);
        if(!waiting()||!mounted.current||latest.current.active?.id!==frozen.id)throw new Error('The AI check was interrupted. Choose a rating yourself.');
        if(!shown.available||typeof shown.previewSha256!=='string'||shown.sentData?.front!==frozen.card.front||shown.sentData.back!==frozen.card.back||shown.sentData.response!==frozen.response)throw new Error('The AI preview could not be validated. Choose a rating yourself.');
        setPreview({key:previewKey(frozen),value:shown});
        const checked=await api<GradeResult>('/flashcard-grade','POST',{...payload,previewSha256:shown.previewSha256,consent:true});
        if(!['correct','close','incorrect'].includes(checked.closeness)||!['ai','exact'].includes(checked.source)||typeof checked.explanation!=='string'||!checked.explanation.trim()||checked.explanation.length>300||/\p{Cc}/u.test(checked.explanation))throw new Error('The AI check could not be validated. Choose a rating yourself.');
        return checked;
      });
      if(mounted.current&&latest.current.active?.id===frozen.id)save({...latest.current,active:{...latest.current.active,check:checkedDraft(frozen,result.closeness,result.source,result.explanation)}});
    }catch(cause){
      if(mounted.current&&latest.current.active?.id===frozen.id)save({...latest.current,active:{...latest.current.active,check:{fallback:true,reason:errorMessage(cause)}}});
    }finally{if(mounted.current){setCheckingId(value=>value===frozen.id?null:value);if(latest.current.active?.id===frozen.id)requestAnimationFrame(()=>answerHeading.current?.focus());}}
  };

  return <>
    <PageHeading eyebrow="NATIVE FLASHCARDS" title="Recall, check, revisit." text="Type what you remember, then check. A timer starts when the front appears. When AI checking is on, DeepSeek gives an unofficial closeness verdict that, with your time, sets the review rating; you can always change it. Ratings schedule reviews only. They do not establish mastery, independent evidence, or an exam pass probability."/>
    <p className="small muted">FSRS-6 schedules reviews. Typed recall is sent to DeepSeek only after you turn on AI checking for this session. Anki TSV remains a one-way export; reviews are not synchronized.</p>
    <section className="notice" aria-label="AI checking">
      {aiStatus?.available?<><label className="checkbox"><input type="checkbox" checked={aiConsent} disabled={checking} onChange={event=>{const consent=event.target.checked;try{sessionStorage.setItem(consentKey,String(consent));setAiConsent(consent);}catch{setAiConsent(false);setError('Session consent could not be saved. Choose a rating yourself.');}}}/>Use AI checking for this session</label><p className="small">{FLASHCARD_AI_PRIVACY_NOTICE}</p></>:<p>{aiStatus?`${aiStatus.reason??'AI checking is unavailable.'} Ratings are chosen manually.`:'Checking AI availability…'}</p>}
    </section>
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
        <label htmlFor="flashcard-response">Your recall</label>
        <textarea id="flashcard-response" maxLength={150000} value={active.response} readOnly={!!active.revealedAt} disabled={!queue||busy} onChange={event=>change(draft=>({...draft,response:event.target.value}))} onPaste={()=>change(draft=>({...draft,assistance:[...new Set([...draft.assistance,'pasted_text'])]}))} rows={5} aria-describedby="flashcard-recall-help"/>
        <p id="flashcard-recall-help" className="small muted">Your text is preserved exactly. Leave it blank if you prefer. Blank, copied, assisted, and revealed responses never count as independent evidence. Checking freezes this response.</p>
        {!active.revealedAt&&<p className="small muted" aria-live="off">Time: {(Math.max(0,tick-Date.parse(active.startedAt))/1000).toFixed(1)} s</p>}
        <label className="checkbox"><input type="checkbox" checked={active.assistance.includes('consulted_materials')} disabled={active.assistance.includes('consulted_materials')||!!active.revealedAt||busy||!queue} onChange={()=>change(draft=>({...draft,assistance:[...new Set([...draft.assistance,'consulted_materials'])]}))}/>I consulted materials or received help</label>
        <div className="button-row"><button type="button" disabled={active.hintCount>=1000||!!active.revealedAt||busy||!queue} onClick={()=>change(draft=>({...draft,hintCount:Math.min(1000,draft.hintCount+1),assistance:[...new Set([...draft.assistance,'study_hint'])]}))}>Use a recall hint</button>{!active.revealedAt&&<><button type="button" className="primary" disabled={busy||!queue} onClick={()=>void checkAnswer()}>Check answer</button><button type="button" disabled={busy||!queue} onClick={()=>void checkAnswer(true)}>I don't know</button></>}</div>
        {active.hintCount>0&&<aside className="notice"><strong>Hints used: {active.hintCount}</strong><p>Name the concept, then explain one limit or distinction. This hint use stays attached to your response.</p></aside>}
        {aiStatus?.available&&<details open={previewOpen} onToggle={event=>{const opened=event.currentTarget.open;if(isBlankRecall(active.response)){event.currentTarget.open=false;setPreviewOpen(false);}else setPreviewOpen(opened);}}><summary aria-disabled={isBlankRecall(active.response)} onClick={event=>{if(isBlankRecall(active.response))event.preventDefault();}}>Show exactly what will be sent</summary>{previewOpen&&!isBlankRecall(active.response)&&<><p className="small">{FLASHCARD_AI_PRIVACY_NOTICE}</p>{preview?.key===previewKey(active)&&preview.value?<><h3>Card prompt</h3><pre aria-label="Preview prompt">{preview.value.sentData.front}</pre><h3>Target answer</h3><pre aria-label="Preview target answer">{preview.value.sentData.back}</pre><h3>Your recall</h3><pre aria-label="Preview recall">{preview.value.sentData.response}</pre></>:preview?.key===previewKey(active)&&preview.error?<p role="alert" className="error">{preview.error}</p>:<p role="status">Loading preview…</p>}</>}</details>}
        {active.revealedAt&&<section className="feedback" aria-label="Revealed answer">
          <h3 tabIndex={-1} ref={answerHeading}>Answer checked</h3>
          <p>You answered in {formatElapsed(elapsed(active))}</p>
          <h4>Your recall</h4><pre aria-label="Frozen recall">{isBlankRecall(active.response)?'(Blank)':active.response}</pre>
          <h4>Target answer</h4><p className="prose">{active.card.back}</p><p className="small">Source: {active.card.source}</p>
          {checking?<p role="status">Checking with DeepSeek…</p>:active.check&&!('fallback' in active.check)?<>
            <p><strong>{verdict(active.check)}</strong></p>{active.check.explanation&&<p>{active.check.explanation}</p>}
            {active.check.source==='ai'&&<p className="small">Unofficial AI closeness check. It is not an MTEL score and does not count as evidence.</p>}
            <p><strong>Rating to save: {ratingNames[active.check.suggestedRating-1]}</strong><br/>{ratingReason(active,active.check)}</p>
            <div className="button-row"><button type="button" className="primary" disabled={busy||!queue} onClick={()=>{if(active.check&&!('fallback' in active.check))grade(active.check.suggestedRating);}}>Continue</button><button type="button" className="text-button" disabled={busy} onClick={()=>setChangeRating(true)}>Change rating</button></div>
          </>:<p role={active.check&&'fallback' in active.check&&active.check.reason!=='AI checking is off; choose a rating.'?'alert':undefined}>{active.check&&'fallback' in active.check?active.check.reason:'Recovered answer; choose a rating yourself.'}</p>}
          {!checking&&(changeRating||!active.check||'fallback' in active.check)&&<fieldset disabled={busy||!queue}><legend>Choose a rating</legend><div className="button-row flashcard-ratings">{ratingNames.map((name,index)=><button type="button" key={name} onClick={()=>grade((index+1) as 1|2|3|4)}>{name}</button>)}</div></fieldset>}
        </section>}
        <button type="button" className="text-button" disabled={busy} onClick={archive}>Keep a recovery copy and close</button>
      </>}
    </article>}
    {queue&&!active&&<section className="panel"><h2 tabIndex={-1} ref={queueHeading}>{queue.queue.length?'Ready to review':'No cards due now'}</h2><p>{queue.queue.length} cards in this due queue. Learning and relearning cards come first.</p>{queue.queue.length>0&&<button type="button" className="primary" disabled={!loaded||busy} onClick={()=>begin(queue.queue[0]!)}>Review next card</button>}{queue.nextDue&&<p className="small">Next scheduled review: {flashcardTime(queue.nextDue)}<br/><time dateTime={queue.nextDue}>{queue.nextDue}</time> UTC</p>}<button type="button" className="text-button" disabled={busy} onClick={()=>void refresh().catch(cause=>setQueueError(errorMessage(cause)))}>Refresh due cards</button></section>}
    {queue&&queue.held.length>0&&<section className="space-top"><h2>Cards needing attention</h2><p className="small">Changed content needs a deliberate choice. Keep retains the schedule; Reset uses the library's new-card reset. Suspend removes the card from the queue until you resume it. Every choice keeps prior history.</p>{queue.held.map(item=><article className="panel" key={item.card.id}><h3>{item.card.front}</h3><p>{item.missing?'This card is missing or retired. Its history is preserved and it cannot receive current reviews.':item.stale?'The card content has changed since its acknowledged version.':item.suspended?'This card is suspended.':''}</p><p className="tiny flashcard-fingerprint">Current content: {item.cardFingerprint}<br/>Acknowledged content: {item.acknowledgedFingerprint}</p>{!item.missing&&<div className="button-row">{item.stale&&<><button type="button" disabled={!!active||busy||!loaded} onClick={()=>control(item,'keep')}>Keep schedule and acknowledge content</button><button type="button" disabled={!!active||busy||!loaded} onClick={()=>control(item,'reset')}>Reset schedule and acknowledge content</button></>}{(!item.suspended||item.stale)&&<button type="button" disabled={!!active||busy||!loaded} onClick={()=>control(item,'suspend')}>Suspend card</button>}{item.suspended&&!item.stale&&<button type="button" disabled={!!active||busy||!loaded} onClick={()=>control(item,'resume')}>Resume card</button>}</div>}</article>)}</section>}
    {file.recovery.length>0&&<section className="space-top"><h2>Browser recovery copies</h2><p className="small">These are unfinished drafts, not accepted reviews. Their original identities and text remain here; they are never applied to another card.</p>{file.recovery.map((entry,index)=><details key={`${entry.draft.id}-${index}`}><summary>{entry.draft.card.id} · {flashcardTime(entry.archivedAt)}</summary><p>{entry.draft.card.front}</p><pre>{entry.draft.response||'(Blank response)'}</pre><p className="small">{entry.reason}</p><button type="button" onClick={()=>download(`flashcard-recovery-${entry.draft.id}.json`,JSON.stringify(entry,null,2))}>Save this recovery copy</button></details>)}</section>}
    <p className="small muted space-top">Unfinished drafts live in this browser. Use one active flashcard tab at a time. Accepted review history and scheduling live in local SQLite. The existing JSON study export does not include native flashcard history; keep a consistent database backup for full preservation.</p>
  </>;
}
