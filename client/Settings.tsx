// Settings. Two kinds, kept apart:
// - `Corner`: your own (sound, motion), on every screen, bottom left: a
//   one-click mute button (also the M key) and a gear that opens a small slip.
// - `TableRules`: the table's house rules, on the lobby and score sheets. The
//   host changes them; everyone else reads them.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TableSettings } from '../shared/settings';
import type { RoomView } from '../shared/types';
import { setTableSettings } from './net';
import { calm, setPrefs, usePrefs } from './prefs';

/** Is this key press going into a text field (a name, a table code)? */
const typing = (el: EventTarget | null): boolean => (el instanceof HTMLInputElement ? !['range', 'checkbox'].includes(el.type) : el instanceof HTMLTextAreaElement);

function Speaker({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z" fill="currentColor" stroke="none" />
      {off ? <path d="M15.5 9.2l5 5.6M20.5 9.2l-5 5.6" /> : <path d="M15.2 9.3a4 4 0 0 1 0 5.4M17.6 6.9a7.4 7.4 0 0 1 0 10.2" />}
    </svg>
  );
}

function Gear() {
  const teeth = Array.from({ length: 8 }, (_, i) => <rect key={i} x="10.6" y="2.6" width="2.8" height="4.4" rx="0.9" transform={`rotate(${i * 45} 12 12)`} fill="currentColor" stroke="none" />);
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {teeth}
      <circle cx="12" cy="12" r="5.1" strokeWidth="3" />
    </svg>
  );
}

const percent = (v: number) => `${Math.round(v * 100)}%`;

/** The corner controls. Rendered once, by App, over whatever screen is up. */
export function Corner() {
  const prefs = usePrefs();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // M mutes from anywhere (except while typing a name); Escape puts the slip away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'KeyM' && !typing(e.target)) setPrefs({ muted: !prefs.muted });
      else if (e.code === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prefs.muted]);

  // A press anywhere else closes the slip (and still does whatever it was meant to do).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const sound = prefs.muted ? 'Sound is off' : 'Sound is on';
  return (
    <div className="corner" ref={root}>
      <button
        type="button"
        className={`knob${prefs.muted ? ' off' : ''}`}
        aria-pressed={prefs.muted}
        aria-label={`${sound}. ${prefs.muted ? 'Unmute' : 'Mute'} (M)`}
        title={`${sound} (M)`}
        onClick={(e) => {
          setPrefs({ muted: !prefs.muted });
          e.currentTarget.blur(); // keep Space for flipping
        }}
      >
        <Speaker off={prefs.muted} />
        {prefs.muted && <span>Muted</span>}
      </button>
      <button type="button" className={`knob${open ? ' on' : ''}`} aria-expanded={open} aria-controls="your-settings" aria-label="Your settings" title="Your settings" onClick={() => setOpen(!open)}>
        <Gear />
      </button>
      {open && (
        <section className="slip" id="your-settings" aria-label="Your settings">
          <h3>Your settings</h3>
          <label className="check">
            <input type="checkbox" checked={!prefs.muted} onChange={(e) => setPrefs({ muted: !e.target.checked })} />
            <span>
              Sound <small>M switches it from anywhere</small>
            </span>
          </label>
          <label className="level">
            <span>
              Volume <output>{percent(prefs.volume)}</output>
            </span>
            <input type="range" min="0" max="1" step="0.05" value={prefs.volume} disabled={prefs.muted} onChange={(e) => setPrefs({ volume: Number(e.target.value) })} />
          </label>
          <label className="level">
            <span>
              Other players' cards <output>{percent(prefs.others)}</output>
            </span>
            <input type="range" min="0" max="1" step="0.05" value={prefs.others} disabled={prefs.muted} onChange={(e) => setPrefs({ others: Number(e.target.value) })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={calm()} onChange={(e) => setPrefs({ calm: e.target.checked })} />
            <span>
              Reduce motion <small>{prefs.calm === null ? 'following your system setting' : 'cards jump instead of gliding'}</small>
            </span>
          </label>
        </section>
      )}
    </div>
  );
}

/**
 * The table's house rules, on the lobby and score sheets. One row per option
 * of `TableSettings`; further table-wide controls (`children`) go underneath.
 */
export function TableRules({ room, children }: { room: RoomView; children?: ReactNode }) {
  const host = room.players.find((p) => p.isHost);
  const mine = host?.seat === room.you;
  const set = (patch: Partial<TableSettings>) => setTableSettings(patch);
  return (
    <fieldset className="rules">
      <legend>Table rules</legend>
      <label className="check">
        <input type="checkbox" checked={room.settings.fewerDown} disabled={!mine} onChange={(e) => set({ fewerDown: e.target.checked })} />
        <span>
          Fewer face-down cards for small tables <small>With two or three players the work piles start with 0, 0, 1 and 2 cards face-down, not 0, 1, 2 and 3.</small>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={room.settings.centre === 'spots'} disabled={!mine} onChange={(e) => set({ centre: e.target.checked ? 'spots' : 'free' })} />
        <span>
          Use grid for piles <small>Off: an Ace starts its pile wherever you put it down in the middle, as long as there is room for the card. On: the middle has a marked place for every pile.</small>
        </span>
      </label>
      {children}
      {!mine && <p className="hint">{host?.name ?? 'The host'} sets these.</p>}
    </fieldset>
  );
}
