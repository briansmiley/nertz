// The way in, where the home pad turns to it: two equal buttons, Google or email. Email opens in its own place into an
// address and Send code, then the code sent to it typed back. Signed in, the pad is your page (client/Profile.tsx).
import { useState, type FormEvent, type ReactNode } from 'react';
import type { Way } from '../shared/types';
import { enterCode, sendCode, signIn, type Asked, type Entered } from './account';

/** What went wrong, said shortly. */
const SAID: Partial<Record<Asked | Entered, string>> = { bad: 'That isn’t an email address', busy: 'Too many tries: wait a minute', enough: 'Enough codes for this address today', unsent: 'Couldn’t send the code: try again', failed: 'Couldn’t reach the server', wrong: 'Not the code', spent: 'That code is used up: send another' };

const CODE_LENGTH = 6;

/** Google's "G", in its four colours, as its sign-in branding asks. */
function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** An envelope, drawn in the button's ink. */
function Envelope() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="m3.8 6.6 8.2 6.4 8.2-6.4" />
    </svg>
  );
}

export function SignIn({ ways, head }: { ways: Way[]; head: ReactNode }) {
  /** Email chosen: its button has given way to the address. */
  const [byEmail, setByEmail] = useState(false);
  const [email, setEmail] = useState('');
  /** The address a code went to, once one has. */
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);

  const ask = async (to: string): Promise<void> => {
    setBusy(true);
    const got = await sendCode(to);
    setBusy(false);
    setTrouble(SAID[got] ?? null);
    if (got === 'sent') (setSentTo(to), setCode(''));
  };
  const enter = async (typed: string): Promise<void> => {
    if (!sentTo || busy) return;
    setBusy(true);
    const got = await enterCode(sentTo, typed);
    setBusy(false); // (signed in, this page is gone)
    if (got !== 'in') (setTrouble(SAID[got] ?? null), setCode(''));
  };

  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    const to = email.trim();
    if (to && !busy) void ask(to);
  };
  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    if (code.length === CODE_LENGTH) void enter(code);
  };

  return (
    <div className="profile signin">
      <div className="you">
        {head}
        <h2>Sign in</h2>
      </div>
      {/* The ways in, as their marks side by side (what each is, in its tip). The email one, pressed, stays pressed and
          opens the address (then the code) on the line under them; pressed again, puts it away. */}
      <div className="bys">
        {ways.includes('google') && (
          <button type="button" className="by" aria-label="Sign in with Google" data-tip="Sign in with Google" onClick={() => void signIn()}>
            <GoogleG />
          </button>
        )}
        {ways.includes('email') && (
          <button type="button" className="by" aria-label="Sign in with email" aria-pressed={byEmail} data-tip="Sign in with email" onClick={() => (setByEmail(!byEmail), setSentTo(null), setTrouble(null))}>
            <Envelope />
          </button>
        )}
      </div>
      {ways.includes('email') &&
        byEmail &&
        (!sentTo ? (
          <form className="mail" onSubmit={submitEmail}>
            <input type="email" aria-label="Email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoCapitalize="off" spellCheck={false} autoFocus required />
            <button type="submit" className="go" disabled={busy || !email.trim()}>
              {busy ? '…' : 'Send code'}
            </button>
          </form>
        ) : (
          <form className="mail" onSubmit={submitCode}>
            <input
              className="code"
              aria-label={`The code sent to ${sentTo}`}
              placeholder="000000"
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={CODE_LENGTH}
              autoFocus
              onChange={(e) => {
                const typed = e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
                setCode(typed);
                setTrouble(null);
                if (typed.length === CODE_LENGTH) void enter(typed);
              }}
            />
            <button type="submit" className="go" disabled={busy || code.length !== CODE_LENGTH}>
              {busy ? '…' : 'Sign in'}
            </button>
            <p className="sent">
              {sentTo}
              <button type="button" disabled={busy} onClick={() => void ask(sentTo)}>
                Send again
              </button>
              <button type="button" onClick={() => (setSentTo(null), setTrouble(null))}>
                Change
              </button>
            </p>
          </form>
        ))}
      {trouble && (
        <p className="error" role="alert">
          {trouble}
        </p>
      )}
    </div>
  );
}
