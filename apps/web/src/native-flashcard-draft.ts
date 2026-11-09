import type {NativeCardContent,NativeControlInput,NativeQueueItem,NativeReviewInput} from '../../../packages/shared/src/native-fsrs';

export const FLASHCARD_DRAFT_KEY='sei.native-flashcards.draft.v1';
export type PendingFlashcardWrite=
  |{kind:'review';request:NativeReviewInput}
  |{kind:'control';request:NativeControlInput};
export type FlashcardDraft={
  id:string;card:NativeCardContent;cardFingerprint:string;expectedVersion:number;
  response:string;hintCount:number;assistance:string[];startedAt:string;
  revealedAt:string|null;pending:PendingFlashcardWrite|null;heldReason:string|null;
};
export type FlashcardRecovery={draft:FlashcardDraft;archivedAt:string;reason:string};
export type FlashcardDraftFile={schemaVersion:1;active:FlashcardDraft|null;recovery:FlashcardRecovery[]};
type StoragePort=Pick<Storage,'getItem'|'setItem'>;

function record(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function strings(value:unknown):value is string[]{return Array.isArray(value)&&value.every(item=>typeof item==='string');}
function instant(value:unknown):value is string{return typeof value==='string'&&Number.isFinite(new Date(value).getTime());}
function validDraft(value:unknown):value is FlashcardDraft {
  if(!record(value)||typeof value.id!=='string'||!record(value.card)||typeof value.card.id!=='string'||typeof value.card.front!=='string'||typeof value.card.back!=='string'||typeof value.card.source!=='string'||!strings(value.card.tags))return false;
  if(typeof value.cardFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.cardFingerprint)||!Number.isInteger(value.expectedVersion)||Number(value.expectedVersion)<1||typeof value.response!=='string'||!Number.isInteger(value.hintCount)||Number(value.hintCount)<0||!strings(value.assistance)||!instant(value.startedAt)||(value.revealedAt!==null&&!instant(value.revealedAt))||(value.heldReason!==null&&typeof value.heldReason!=='string'))return false;
  if(value.pending!==null){
    if(!record(value.pending)||!['review','control'].includes(String(value.pending.kind))||!record(value.pending.request))return false;
    const pending=value.pending.request;
    if(typeof pending.clientEventId!=='string'||pending.cardId!==value.card.id||pending.cardFingerprint!==value.cardFingerprint||pending.expectedVersion!==value.expectedVersion||!instant(pending.clientNow))return false;
    if(value.pending.kind==='review'&&(pending.response!==value.response||pending.hintCount!==value.hintCount||!strings(pending.assistance)||JSON.stringify(pending.assistance)!==JSON.stringify(value.assistance)||pending.startedAt!==value.startedAt||pending.revealedAt!==value.revealedAt||pending.revealed!==true||typeof pending.rating!=='number'||![1,2,3,4].includes(pending.rating)))return false;
    if(value.pending.kind==='control'&&!['keep','reset','suspend','resume'].includes(String(pending.action)))return false;
  }
  return true;
}

export function decodeFlashcardDraftFile(raw:string|null):FlashcardDraftFile {
  if(raw===null)return {schemaVersion:1,active:null,recovery:[]};
  const value:unknown=JSON.parse(raw);
  if(!record(value)||value.schemaVersion!==1||(value.active!==null&&!validDraft(value.active))||!Array.isArray(value.recovery)||!value.recovery.every(item=>record(item)&&validDraft(item.draft)&&instant(item.archivedAt)&&typeof item.reason==='string'))throw new Error('The saved flashcard draft could not be read. It has not been overwritten. Save a recovery copy before clearing browser data.');
  return value as FlashcardDraftFile;
}

/** Browser storage holds unfinished work only; SQLite receipts remain authoritative.
 * Compare the previous bytes before replacing anything so another tab cannot silently
 * replace this tab's pending request. A rejected write must never reach the server. */
export class FlashcardDraftStorage {
  private previous:string|null;
  private readonly storage:StoragePort;
  constructor(storage:StoragePort){this.storage=storage;this.previous=storage.getItem(FLASHCARD_DRAFT_KEY);}
  read():FlashcardDraftFile{return decodeFlashcardDraftFile(this.previous);}
  write(value:FlashcardDraftFile):void {
    if(this.storage.getItem(FLASHCARD_DRAFT_KEY)!==this.previous)throw new Error('Flashcard work changed in another tab. Reload to recover that work before continuing. Your current text remains in this tab.');
    const serialized=JSON.stringify(value);
    // Validate our own envelope before a durable write as well as on recovery.
    decodeFlashcardDraftFile(serialized);
    this.storage.setItem(FLASHCARD_DRAFT_KEY,serialized);
    this.previous=serialized;
  }
}

export function freshFlashcardDraft(item:NativeQueueItem,id:string,now:string):FlashcardDraft {
  return {id,card:item.card,cardFingerprint:item.cardFingerprint,expectedVersion:item.version,response:'',hintCount:0,assistance:[],startedAt:now,revealedAt:null,pending:null,heldReason:null};
}
export function draftMatchesCard(draft:FlashcardDraft,item:NativeQueueItem|undefined):boolean {
  return !!item&&item.card.id===draft.card.id&&item.card.front===draft.card.front&&item.card.back===draft.card.back&&item.card.source===draft.card.source&&JSON.stringify(item.card.tags)===JSON.stringify(draft.card.tags)&&!item.missing&&!item.stale&&!item.suspended&&item.cardFingerprint===draft.cardFingerprint&&item.version===draft.expectedVersion;
}
export function archiveFlashcardDraft(file:FlashcardDraftFile,reason:string,now:string):FlashcardDraftFile {
  if(!file.active)return file;
  return {...file,active:null,recovery:[...file.recovery,{draft:file.active,reason,archivedAt:now}]};
}
