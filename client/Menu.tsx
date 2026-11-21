// The one button in the corner (☰, Settings.tsx `Corner`) and the slip it opens: sound on or off, the table's actions
// (which are open to you, and what each does, is actions.ts), and the way to your settings and to
// feedback, which open in the same place. One line each.
import { useEffect, useSyncExternalStore } from 'react';
import type { RoomView } from '../shared/types';
import { answer, press, useAsked, type ActionId, type TableAction } from './actions';
import { Again, Bug, Door, Eye, Flag, Gear, PauseIcon, Play, Redeal, Speaker } from './icons';

/** What the corner has open: the menu, or one of the slips it leads to. */
export type Panel = 'menu' | 'settings' | 'feedback';

/** The one slip the corner has open, or none: the ☰ opens the menu, and the score sheet's gear your settings directly. */
let panel: Panel | null = null;
const listeners = new Set<() => void>();
export function openCorner(to: Panel | null): void {
  if (to === panel) return;
  panel = to;
  for (const l of listeners) l();
}
export function useCorner(): Panel | null {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => panel,
  );
}

/** Each action's icon, before its name. */
export const ICONS: Record<ActionId, () => React.JSX.Element> = { pause: PauseIcon, resume: Play, vote: Flag, redeal: Redeal, reset: Again, stand: Eye, leave: Door };

/** Back to the menu, at the head of a slip it led to. */
export function Back({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="back" aria-label="Back" title="Back" onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14.5 5.5 8 12l6.5 6.5" />
      </svg>
    </button>
  );
}

/**
 * Muting and the vote leave the slip up (what they did is on it); anything else puts it away (`onDone`) or opens
 * another (`go`). One that cannot be undone puts it away and asks (`Sure`).
 */
export function Menu({ room, actions, muted, onMute, go, onDone }: { room: RoomView | null | undefined; actions: TableAction[]; muted: boolean; onMute: () => void; go: (to: Panel) => void; onDone: () => void }) {
  return (
    <section className="slip acts" id="menu" aria-label="Menu">
      <button type="button" aria-pressed={muted} onClick={(e) => (e.currentTarget.blur(), onMute())}>
        <Speaker off={muted} />
        {muted ? 'Unmute' : 'Mute'}
      </button>
      {room &&
        actions.map((a) => {
          const Icon = ICONS[a.id];
          return (
            <button
              key={a.id}
              type="button"
              className={a.on ? 'on' : undefined}
              aria-pressed={a.on}
              onClick={(e) => {
                e.currentTarget.blur(); // keep Space for the cards
                press(a.id, room);
                if (a.id !== 'vote') onDone(); // (the vote stays up: its tally is the answer)
              }}
            >
              <Icon />
              {a.label}
              {a.tally && <small>{a.tally}</small>}
            </button>
          );
        })}
      <button type="button" onClick={() => go('settings')}>
        <Gear />
        Settings
      </button>
      <button type="button" onClick={() => go('feedback')}>
        <Bug />
        Feedback
      </button>
    </section>
  );
}

/** The question an action that cannot be undone asks (actions.ts `press`), over everything; Esc or a press beside it is no. */
export function Sure({ room }: { room: RoomView }) {
  const a = useAsked(room);
  useEffect(() => {
    if (!a) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') answer(false, room);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [a, room]);
  if (!a?.sure) return null;
  const Icon = ICONS[a.id];
  return (
    <div className="asked" onPointerDown={(e) => e.target === e.currentTarget && answer(false, room)}>
      <div className="paper-card" role="alertdialog" aria-label={a.sure}>
        <h2>{a.sure}</h2>
        <button type="button" className="go" onClick={() => answer(true, room)}>
          <Icon />
          {a.label}
        </button>
        <button type="button" className="quiet" autoFocus onClick={() => answer(false, room)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
