import { useEffect, useRef, useState } from 'react';
import { api, printable } from './api';

type FeedbackStatus = {
  available: boolean;
  reason?: string;
  provider: 'DeepSeek';
  model: string;
  dailyBudgetUsd: number;
  spentUsdToday: number;
  reservedUsdToday?: number;
  remainingRequestsToday: number;
  privacyNotice: string;
};
type FeedbackPreview = { available: boolean; model: string; previewSha256: string; sentData: unknown; privacyNotice: string };
type FeedbackProposal = {
  criteriaFeedback: { criterionId: string; comment: string; answerQuotes: string[]; missingEvidence: string[] }[];
  holisticScore: number | 'U' | 'B' | null;
  needsHumanReview: boolean;
  reason: string;
};
type FeedbackResponse = { requestId: string; proposal: FeedbackProposal; warning: string };

/** Remount for each preserved attempt so consent never carries across answers. */
export function AiFeedback({ attemptId, hosted, criteria, refresh }: {
  attemptId: string;
  hosted: boolean;
  criteria: { id: string; title: string }[];
  refresh: () => Promise<void>;
}) {
  const [status, setStatus] = useState<FeedbackStatus>();
  const [preview, setPreview] = useState<FeedbackPreview>();
  const [feedback, setFeedback] = useState<FeedbackResponse>();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [statusFailed, setStatusFailed] = useState(false);
  const active = useRef(true);
  const fallback = hosted ? 'Use manual review.' : "Use manual review or Exchange’s Grok handoff packet in Take it with you.";

  useEffect(() => {
    active.current = true;
    let cancelled = false;
    void api<FeedbackStatus>('/ai-feedback/status').then(value => {
      if (!cancelled) setStatus(value);
    }).catch(() => { if (!cancelled) setStatusFailed(true); });
    return () => { cancelled = true; active.current = false; };
  }, [attemptId]);

  const showPreview = async () => {
    setBusy(true); setError(''); setConsent(false); setPreview(undefined);
    try {
      const value = await api<FeedbackPreview>('/ai-feedback/preview', 'POST', { attemptId });
      if (active.current) setPreview(value);
    } catch (failure) { if (active.current) setError((failure as Error).message); }
    finally { if (active.current) setBusy(false); }
  };
  const requestFeedback = async () => {
    if (!consent || !preview || busy) return;
    setBusy(true); setError(''); setFeedback(undefined); setSaved(false); setConsent(false);
    try {
      const value = await api<FeedbackResponse>('/ai-feedback', 'POST', { attemptId, previewSha256: preview.previewSha256, consent: true });
      if (active.current) setFeedback(value);
    } catch (failure) { if (active.current) setError((failure as Error).message); }
    finally {
      if (active.current) { setConsent(false); setBusy(false); }
      try {
        const value = await api<FeedbackStatus>('/ai-feedback/status');
        if (active.current) setStatus(value);
      } catch { /* Keep the last status; the server enforces the budget on every request. */ }
    }
  };
  const approve = async () => {
    if (!feedback || busy || saved) return;
    setBusy(true); setError('');
    try {
      await api('/ai-feedback/approve', 'POST', { requestId: feedback.requestId, confirm: true });
      if (active.current) setSaved(true);
      await refresh();
    } catch (failure) { if (active.current) setError((failure as Error).message); }
    finally { if (active.current) setBusy(false); }
  };

  if (statusFailed) return <p className="notice">AI feedback is not available right now. {fallback}</p>;
  if (!status) return <p className="small muted">Checking optional AI feedback availability…</p>;
  if (!status.available) return <p className="notice">AI feedback is not available. {status.reason} {fallback}</p>;
  const remainingBudget = Math.max(0, status.dailyBudgetUsd - Number(status.spentUsdToday) - Number(status.reservedUsdToday ?? 0));
  return <section className="panel space-top" aria-labelledby="ai-feedback-heading">
    <h2 id="ai-feedback-heading">AI feedback (optional)</h2>
    <p>Review the latest preserved submission for this task. Draft edits are included only after preserving a new submission.</p>
    <p className="notice">{status.privacyNotice}</p>
    <p className="small">Budget remaining today: ${remainingBudget.toFixed(2)} of ${status.dailyBudgetUsd.toFixed(2)} · {status.remainingRequestsToday} requests remaining · resets at midnight America/New_York. In-flight requests also reserve budget.</p>
    <button disabled={busy} onClick={() => void showPreview()}>Show exactly what will be sent</button>
    {preview && <div className="space-top">
      <h3>Data to send to DeepSeek</h3>
      <p className="small">Model: {preview.model}</p>
      <pre className="json-preview">{printable(preview.sentData)}</pre>
    </div>}
    <label className="checkbox space-top"><input type="checkbox" checked={consent} disabled={busy || !preview?.available} onChange={event => setConsent(event.target.checked)} />I reviewed the preview and consent to send this preserved essay, task, mentor text and rubric to DeepSeek for this request.</label>
    <button className="primary" disabled={busy || !consent || !preview?.available || status.remainingRequestsToday < 1} onClick={() => void requestFeedback()}>{busy ? 'Working…' : 'Request AI feedback'}</button>
    {error && <p className="error" role="alert">{error}</p>}
    {feedback && <article className="space-top" aria-label="Provisional AI feedback">
      <p className="notice">{feedback.warning}</p>
      <h3>Provisional holistic score (unofficial): {feedback.proposal.holisticScore ?? 'Not assigned'}</h3>
      <p>Needs human review: {feedback.proposal.needsHumanReview ? 'Yes' : 'No additional flag; review before saving.'}</p>
      {feedback.proposal.reason && <p>{feedback.proposal.reason}</p>}
      {feedback.proposal.criteriaFeedback.map(criterion => <section key={criterion.criterionId} className="feedback">
        <h4>{criteria.find(item => item.id === criterion.criterionId)?.title ?? criterion.criterionId}</h4>
        <p>{criterion.comment}</p>
        {criterion.answerQuotes.map((quote, index) => <blockquote key={index}>{quote}</blockquote>)}
        {criterion.missingEvidence.length > 0 && <><strong>Missing or ambiguous evidence</strong><ul>{criterion.missingEvidence.map((missing, index) => <li key={index}>{missing}</li>)}</ul></>}
      </section>)}
      <p className="small">This is provisional, unofficial feedback. Saving it does not establish independent evidence or an official MTEL score.</p>
      <button disabled={busy || saved} onClick={() => void approve()}>Save as provisional feedback</button>
      {saved && <p className="notice" role="status">Provisional feedback saved. The original answer is unchanged.</p>}
    </article>}
  </section>;
}
