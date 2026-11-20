// A button says in a word what just happened through it, then lets the word go: a hotkey that fired says what the
// key did ("Muted", and the line through the icon draws itself on or off as it does for a click); the menu's
// button says "Sent" once the feedback slip it opened has gone off and put itself away.
import { useCallback, useEffect, useRef, useState } from 'react';
import { hotkeyPressed } from './prefs';

/** How long the word stays on the button (the stylesheet's `said` animation runs for as long). */
export const SAID_MS = 1400;

/** What a button said last: its word, and which saying it was (so saying it again says it afresh). */
export type Said = { word: string; n: number };

/** A button's word: what it is saying (null once SAID_MS has gone by), and `say` to say another. */
export function useSaid(): [Said | null, (word: string) => void] {
  const [said, setSaid] = useState<Said | null>(null);
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(null), SAID_MS);
    return () => clearTimeout(t);
  }, [said]);
  const say = useCallback((word: string) => setSaid((s) => ({ word, n: (s?.n ?? 0) + 1 })), []);
  return [said, say];
}

/**
 * Listen for the hotkey `code`, from anywhere but a text field: each press does `press` and `say`s the word it
 * answers. No `press` (the hotkey does nothing just now, e.g. the mic's out of voice) and nothing is listened for.
 */
export function useHotkey(code: string | null, press: (() => string) | null, say: (word: string) => void): void {
  const act = useRef(press);
  act.current = press;
  const live = !!code && !!press;
  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (hotkeyPressed(e, code) && act.current) say(act.current());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [code, live, say]);
}

/** The word a button said, inside it, while it is said. */
export function SaidWord({ said }: { said: Said | null }) {
  return said ? (
    <span key={said.n} className="said" role="status">
      {said.word}
    </span>
  ) : null;
}

/** The line through an icon for "off": drawn on as it goes off, drawn back as it comes on. */
export function Slash({ on }: { on: boolean }) {
  return <path className={`slash${on ? ' on' : ''}`} d="M4.5 4.5l15 15" pathLength={1} strokeWidth="2.4" />;
}
