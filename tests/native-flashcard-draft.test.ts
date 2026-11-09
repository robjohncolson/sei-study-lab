import {describe,expect,it} from 'vitest';
import {archiveFlashcardDraft,decodeFlashcardDraftFile,draftMatchesCard,FLASHCARD_DRAFT_KEY,FlashcardDraftStorage,freshFlashcardDraft,type FlashcardDraftFile} from '../apps/web/src/native-flashcard-draft';
import {flashcardTime} from '../apps/web/src/flashcard-time';
import type {NativeQueueItem} from '../packages/shared/src/native-fsrs';

const t0='2026-11-09T00:00:00.000Z';
const item:NativeQueueItem={card:{id:'synthetic.card',front:'Synthetic question',back:'Synthetic answer',source:'Synthetic source',tags:[]},cardFingerprint:'a'.repeat(64),acknowledgedFingerprint:'a'.repeat(64),version:1,suspended:false,stale:false,missing:false,schedule:{due:t0,stability:0,difficulty:0,elapsed_days:0,scheduled_days:0,learning_steps:0,reps:0,lapses:0,state:0}};
function memoryStorage(){const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};}
function pendingFile():FlashcardDraftFile {
  const draft=freshFlashcardDraft(item,'synthetic-draft',t0);
  draft.response='  café 漢字\n\tKeep exact whitespace.  ';
  draft.hintCount=1;draft.assistance=['study_hint','pasted_text'];draft.revealedAt=t0;
  draft.pending={kind:'review',request:{clientEventId:'3d1318b0-ab5d-4928-8e92-3f3a467169a5',cardId:item.card.id,cardFingerprint:item.cardFingerprint,expectedVersion:1,response:draft.response,hintCount:1,assistance:[...draft.assistance],rating:3,revealed:true,revealedAt:t0,startedAt:t0,clientNow:t0}};
  return {schemaVersion:1,active:draft,recovery:[]};
}

describe('native flashcard unfinished work',()=>{
  it('round-trips exact response, assistance, original content and frozen submission through reload',()=>{
    const storage=memoryStorage(),file=pendingFile();
    new FlashcardDraftStorage(storage).write(file);
    const reloaded=new FlashcardDraftStorage(storage).read();
    expect(reloaded).toEqual(file);
    expect(JSON.stringify(reloaded.active?.pending)).toBe(JSON.stringify(file.active?.pending));
    expect(reloaded.active?.response).toBe('  café 漢字\n\tKeep exact whitespace.  ');
  });
  it('cannot silently replace newer work from another tab or a later mounted editor',()=>{
    const storage=memoryStorage(),oldEditor=new FlashcardDraftStorage(storage),newEditor=new FlashcardDraftStorage(storage);
    newEditor.write(pendingFile());
    expect(()=>oldEditor.write({schemaVersion:1,active:null,recovery:[]})).toThrow('another tab');
    expect(new FlashcardDraftStorage(storage).read()).toEqual(pendingFile());
  });
  it('preserves pending payload non-lossily when explicitly closing held work',()=>{
    const file=pendingFile();file.active!.heldReason='Synthetic conflict';
    const archived=archiveFlashcardDraft(file,'Explicit recovery','2026-11-10T00:00:00.000Z');
    expect(archived.active).toBeNull();
    expect(archived.recovery[0]?.draft).toEqual(file.active);
    expect(decodeFlashcardDraftFile(JSON.stringify(archived))).toEqual(archived);
    expect(file.active?.pending).not.toBeNull();
  });
  it('holds a changed fingerprint, stale version, suspension, missing card or different card',()=>{
    const draft=freshFlashcardDraft(item,'synthetic-draft',t0);
    expect(draftMatchesCard(draft,item)).toBe(true);
    for(const changed of [undefined,{...item,card:{...item.card,id:'another.card'}},{...item,card:{...item.card,back:'Changed answer'}},{...item,cardFingerprint:'b'.repeat(64)},{...item,version:2},{...item,stale:true},{...item,suspended:true},{...item,missing:true}])expect(draftMatchesCard(draft,changed)).toBe(false);
  });
  it('refuses corrupt or cross-card pending data without deleting the original bytes',()=>{
    const storage=memoryStorage(),file=pendingFile();
    file.active!.pending!.request.cardId='another.card';
    const raw=JSON.stringify(file);storage.setItem(FLASHCARD_DRAFT_KEY,raw);
    expect(()=>new FlashcardDraftStorage(storage).read()).toThrow('not been overwritten');
    expect(storage.getItem(FLASHCARD_DRAFT_KEY)).toBe(raw);
  });
  it('reports quota failures before a caller can send a pending request',()=>{
    const storage={getItem:()=>null,setItem:()=>{throw new Error('Synthetic quota error');}};
    expect(()=>new FlashcardDraftStorage(storage).write(pendingFile())).toThrow('Synthetic quota error');
  });
});

describe('native flashcard schedule labels',()=>{
  it('uses America/New_York across spring and fall DST changes',()=>{
    expect(flashcardTime('2026-03-08T06:59:00.000Z')).toContain('1:59 AM EST');
    expect(flashcardTime('2026-03-08T07:00:00.000Z')).toContain('3:00 AM EDT');
    expect(flashcardTime('2026-11-01T05:59:00.000Z')).toContain('1:59 AM EDT');
    expect(flashcardTime('2026-11-01T06:00:00.000Z')).toContain('1:00 AM EST');
    expect(flashcardTime('not a date')).toBe('Invalid schedule');
  });
});
