import {useEffect, useState} from 'react';
import {estimateStudyPlan, type StudySlice} from '../../../packages/shared/src/study-estimate';
import type {FlashcardSummary, NativeQueueResponse} from '../../../packages/shared/src/native-fsrs';
import {api} from './api';
import type {Catalog, StudyState} from './types';

const launchLabels = {flashcards: 'Open card reviews', knowledge: 'Open knowledge practice', essay: 'Open essay practice'};

/** The desk only reads projections. Opening a workspace uses App's draft navigation guard. */
export function StudyProgress({catalog, onOpenSlice}: {catalog: Catalog; onOpenSlice: (slice: StudySlice) => void}) {
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{state: StudyState; flashcards: FlashcardSummary | null; now: string} | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void Promise.all([
      api<StudyState>('/state'),
      api<NativeQueueResponse>('/native-flashcards').then(queue => queue.summary ?? null).catch(() => null),
    ]).then(([state, flashcards]) => {
      if (active) setSnapshot({state, flashcards, now: new Date().toISOString()});
    }).catch(cause => { if (active) setError((cause as Error).message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  const estimate = snapshot ? estimateStudyPlan({catalog, state: snapshot.state, flashcards: snapshot.flashcards, now: snapshot.now}) : null;
  return <section className="panel study-progress" aria-labelledby="study-progress-title">
    <div className="section-title"><h2 id="study-progress-title">Your 40-minute plan</h2><button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh</button></div>
    {loading && <p role="status">Reading saved work…</p>}
    {error && <p role="alert" className="error">The study estimate could not be refreshed: {error}. Try Refresh.</p>}
    {estimate && !loading && !error && <>
      <p className="study-session-count"><strong>{estimate.remainingSessions === 0 ? 'Core plan complete: keep up flashcard maintenance' : `About ${estimate.remainingSessions} more 40-minute ${estimate.remainingSessions === 1 ? 'session' : 'sessions'}`}</strong></p>
      {estimate.sessionNumber !== undefined && <p>Session {estimate.sessionNumber} of about {estimate.aboutTotal}<br/><span className="tiny muted">counted by study days with saved responses</span></p>}
      <p>{estimate.daysUntilExam} days until 16 January 2027{estimate.examDatePassed && <span className="small muted"> · The planning date has elapsed; the final time split continues.</span>}</p>
      <div className="two-columns">
        <section>
          <div className="spread"><h3 id="knowledge-progress-label">Knowledge progress</h3><strong>{estimate.knowledgePercent}%</strong></div>
          <div className="study-progress-bar" role="progressbar" aria-labelledby="knowledge-progress-label" aria-valuemin={0} aria-valuemax={100} aria-valuenow={estimate.knowledgePercent}><span style={{width: `${estimate.knowledgePercent}%`}}/></div>
          <p className="small">{estimate.objectivesStable} of {estimate.objectivesTotal} objectives stable · {estimate.stableCards === null || estimate.totalCards === null ? 'Flashcard review counts unavailable' : `${estimate.stableCards} of ${estimate.totalCards} flashcards in long-term review`}</p>
          {snapshot?.flashcards === null && <p className="tiny muted">Flashcard workload is unknown. The flashcard slice stays reserved for maintenance; no catch-up time has been added.</p>}
          {estimate.deckNotStarted && <p className="tiny muted">The deck has not been started. Its catalog cards are included in this estimate.</p>}
        </section>
        <section>
          <div className="spread"><h3 id="essay-progress-label">Written-response progress</h3><strong>{estimate.essayPercent}%</strong></div>
          <div className="study-progress-bar" role="progressbar" aria-labelledby="essay-progress-label" aria-valuemin={0} aria-valuemax={100} aria-valuenow={estimate.essayPercent}><span style={{width: `${estimate.essayPercent}%`}}/></div>
          <ul className="study-part-progress">{estimate.essay.parts.map(part => <li key={part.id}><strong>Part {part.number}: {part.title}</strong><span>{part.drafted ? '✓' : '—'} drafted · {part.revised ? '✓' : '—'} revised after feedback · {part.evidence ? '✓' : '—'} mentor-text evidence</span></li>)}</ul>
        </section>
      </div>
      <h3 id="study-today-label">Today:</h3>
      <ol className="study-slices" aria-labelledby="study-today-label">{estimate.slices.map(slice => <li key={slice.track} data-track={slice.track} data-minutes={slice.minutes}>
        <div><strong>{slice.minutes} min · {slice.label}</strong><p className="small muted">{slice.detail}</p></div>
        <button type="button" onClick={() => onOpenSlice(slice)}>{launchLabels[slice.track]}</button>
      </li>)}</ol>
      <details><summary>How this estimate works</summary>
        <p className="small">Knowledge work (k): {estimate.math.k} minutes, including {estimate.flashcardCatchUpMinutes} minutes of flashcard catch-up. Written-response work (e): {estimate.math.e} minutes. Today reserves {estimate.slices.find(slice => slice.track === 'flashcards')?.minutes ?? 0} minutes for flashcards, {estimate.math.K} for knowledge (K), and {estimate.math.E} for writing (E).</p>
        <p className="small">Both tracks progress together. Take the smaller of k divided by K and e divided by E, rounded down, as the number of shared sessions. Subtract those sessions from the longer track, then divide its remaining minutes by K plus E and round up. Add the two session counts. If no remainder is left, use the larger of the two original rounded-up track counts. If one track is empty, give all K plus E minutes to the other. If both are empty, no core sessions remain.</p>
        <p className="small">Empty tracks release their time. When no flashcards are due, their time goes to the track with more remaining work per minute of its slice; ties go to writing. Flashcard catch-up assumes about 30 seconds per review beyond the normal flashcard slice. Knowledge progress uses objective work remaining, excluding card catch-up. Each writing part counts drafting, revision after feedback, and a matching mentor-text quote equally.</p>
      </details>
      <p className="small muted study-planning-note">{estimate.planningNote}</p>
    </>}
  </section>;
}
