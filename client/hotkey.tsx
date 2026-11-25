// A hotkey that fired says so on its own button: the line through the icon draws itself on or off (as it does
// for a click), and the button says in a word what the key just did ("Muted"), then lets the word go.
import { useEffect, useRef, useState } from 'react';
import { hotkeyPressed } from './prefs';

/** How long the word stays on the button (the stylesheet's `said` animation runs for as long). */
export const SAID_MS = 1400;

/** What a hotkey said when it last fired: its word, and which press it was (so a second press says it afresh). */
export type Said = { word: string; n: number };

/**
 * Listen for the hotkey `code`, from anywhere but a text field: each press does `press` and says the word it
 * answers. No `press` (the hotkey does nothing just now, e.g. the mic's out of voice) and nothing is listened for.
 */
export function useHotkey(code: string | null, press: (() => string) | null): Said | null {
  const [said, setSaid] = useState<Said | null>(null);
  const act = useRef(press);
  act.current = press;
  const live = !!code && !!press;
  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (!hotkeyPressed(e, code) || !act.current) return;
      const word = act.current();
      setSaid((s) => ({ word, n: (s?.n ?? 0) + 1 }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [code, live]);
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(null), SAID_MS);
    return () => clearTimeout(t);
  }, [said]);
  return live ? said : null;
}

/** The word a hotkey said, inside its button, while it is said. */
export function SaidWord({ said }: { said: Said | null }) {
  return said ? (
    <span key={said.n} className="said" role="status">
      {said.word}
    </span>
  ) : null;
}
