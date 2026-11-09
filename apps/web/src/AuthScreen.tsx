import {useEffect, useRef, useState, type FormEvent} from 'react';
import {api, type SessionInfo} from './api';

export function AuthScreen({session, onAuthenticated}: {session: SessionInfo; onAuthenticated: () => Promise<void>}) {
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState(''), [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState(''), [setupCode, setSetupCode] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const usernameInput = useRef<HTMLInputElement>(null), errorMessage = useRef<HTMLParagraphElement>(null);
  const signup = creating && session.signupOpen;
  useEffect(() => { usernameInput.current?.focus(); }, [signup]);
  useEffect(() => { if (error) errorMessage.current?.focus(); }, [error]);
  const switchForm = (create: boolean) => {
    setCreating(create); setError(''); setPassword(''); setConfirmation(''); setSetupCode('');
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (signup && password !== confirmation) { setError('The passwords do not match. Enter them again.'); setPassword(''); setConfirmation(''); return; }
    setBusy(true);
    try {
      await api(signup ? '/auth/signup' : '/auth/login', 'POST', {
        username, password, ...(signup && session.setupCodeRequired ? {setupCode} : {}),
      });
      await onAuthenticated();
    } catch (cause) { setError((cause as Error).message); }
    finally { setPassword(''); setConfirmation(''); setSetupCode(''); setBusy(false); }
  }
  return <main className="auth-screen" id="main">
    <header className="page-heading"><p className="eyebrow">SEI STUDY LAB</p><h1>Your study notebook.</h1>
      <p>{session.storageMode === 'postgres' ? 'Sign in to continue your saved study work on any computer.' : 'Sign in to open this local study notebook. Local accounts share the same history.'}</p>
    </header>
    <section className="panel auth-panel" aria-labelledby="auth-title">
      <h2 id="auth-title">{signup ? 'Create account' : 'Sign in'}</h2>
      {signup && <p className="small">The first account on this site keeps the study progress already saved here.</p>}
      {error && <p className="error" role="alert" tabIndex={-1} ref={errorMessage}>{error}</p>}
      <form onSubmit={event => { void submit(event); }} aria-labelledby="auth-title">
        <fieldset disabled={busy}>
          <label htmlFor="auth-username">Username</label>
          <input id="auth-username" name="username" ref={usernameInput} autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,31}" aria-describedby="username-help" value={username} onChange={event => setUsername(event.target.value)}/>
          <p id="username-help" className="small muted">3–32 letters, numbers, dots, underscores or hyphens. Start with a letter or number. Usernames are not case-sensitive.</p>
          <label htmlFor="auth-password">Password</label>
          <input id="auth-password" name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} required minLength={10} maxLength={200} aria-describedby={signup ? 'password-help' : undefined} value={password} onChange={event => setPassword(event.target.value)}/>
          {signup && <>
            <p id="password-help" className="small muted">Use 10–200 characters, including at least one non-space character.</p>
            <label htmlFor="auth-confirmation">Confirm password</label>
            <input id="auth-confirmation" name="confirmation" type="password" autoComplete="new-password" required minLength={10} maxLength={200} value={confirmation} onChange={event => setConfirmation(event.target.value)}/>
            {session.setupCodeRequired && <><label htmlFor="auth-setup-code">Setup code</label><input id="auth-setup-code" name="setupCode" type="password" autoComplete="off" required value={setupCode} onChange={event => setSetupCode(event.target.value)}/></>}
          </>}
          <button className="primary" type="submit">{busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}</button>
        </fieldset>
      </form>
      {session.signupOpen && <div className="auth-switch"><p className="small muted">{signup ? 'Already have an account?' : 'New to this notebook?'}</p><button type="button" disabled={busy} onClick={() => switchForm(!signup)}>{signup ? 'Sign in instead' : 'Create account'}</button></div>}
    </section>
  </main>;
}
