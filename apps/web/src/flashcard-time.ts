/** Flashcard schedules are instants. Keep calendar-only provenance in date-label.ts. */
export function flashcardTime(instant:string):string {
  const date=new Date(instant);
  if(!Number.isFinite(date.getTime()))return 'Invalid schedule';
  return new Intl.DateTimeFormat('en-US',{
    timeZone:'America/New_York',year:'numeric',month:'short',day:'numeric',
    hour:'numeric',minute:'2-digit',timeZoneName:'short',
  }).format(date);
}
