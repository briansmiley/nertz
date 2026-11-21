// The way in, where the home pad turns to it: Google, or a code sent to your email and typed back. Signed in, the pad
// is your page (client/Profile.tsx).
import { useState, type FormEvent, type ReactNode } from 'react';
import type { Way } from '../shared/types';
import { enterCode, sendCode, signIn, type Asked, type Entered } from './account';

/** What went wrong, said shortly. */
const SAID: Partial<Record<Asked | Entered, string>> = { bad: 'That isn’t an email address', busy: 'Too many tries: wait a minute', failed: 'Couldn’t reach the server', wrong: 'Not the code', spent: 'That code is used up: send another' };

const CODE_LENGTH = 6;

export function SignIn({ ways, head }: { ways: Way[]; head: ReactNode }) {
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
      {ways.includes('google') && !sentTo && (
        <button type="button" className="go" onClick={() => void signIn()}>
          Sign in with Google
        </button>
      )}
      {ways.includes('email') &&
        (!sentTo ? (
          <form className="mail" onSubmit={submitEmail}>
            <input type="email" aria-label="Email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoCapitalize="off" spellCheck={false} required />
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
