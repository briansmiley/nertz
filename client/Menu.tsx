// The one button in the corner (☰, Settings.tsx `Corner`) and the slip it opens: your settings at the top, under their
// own head, and across the bottom what there is to do, a button each (its name a tooltip), in two lines: the table's
// actions (which are there, open or coming, and what each does, is actions.ts), and under them sound on or off, for an
// admin how much the game is played (Usage.tsx), which opens in the same place, where feedback has no button of its own
// the way to it, likewise, and at the far end leaving the table.
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import type { RoomView } from '../shared/types';
import { answer, press, useAsked, type ActionId, type TableAction } from './actions';
import { Again, Bug, Chair, Chart, Door, Flag, PauseIcon, Play, Redeal, Speaker } from './icons';

/** What the corner has open: the menu (your settings in it), or feedback or how much the game is played, which it leads to. */
export type Panel = 'menu' | 'feedback' | 'usage';

/** The one slip the corner has open, or none: the ☰ opens the menu, and so does the score sheet's gear. */
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
export const ICONS: Record<ActionId, () => React.JSX.Element> = { pause: PauseIcon, resume: Play, vote: Flag, redeal: Redeal, reset: Again, stand: Chair, leave: Door };

/** Back to the menu, at the head of a slip it led to. */
export function Back({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="back" aria-label="Back" data-tip="Back" onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14.5 5.5 8 12l6.5 6.5" />
      </svg>
    </button>
  );
}

/**
 * Your settings (`children`) over the lines of what to do. Muting and the vote leave the slip up (what they did is on
 * it); anything else puts it away (`onDone`) or opens feedback (`onFeedback`), or for an admin how much the game is
 * played (`onUsage`, none for anyone else). One that cannot be undone puts it away and asks (`Sure`).
 */
export function Menu({ room, actions, muted, onMute, onFeedback, onUsage, onDone, children }: { room: RoomView | null | undefined; actions: TableAction[]; muted: boolean; onMute: () => void; onFeedback?: () => void; onUsage?: () => void; onDone: () => void; children: ReactNode }) {
  const act = (a: TableAction) => {
    const Icon = ICONS[a.id];
    return (
      <button
        key={a.id}
        type="button"
        className={a.on ? 'icon on' : 'icon'}
        aria-pressed={a.on}
        aria-disabled={a.coming}
        aria-label={a.tally ? `${a.label} ${a.tally}` : a.label}
        data-tip={a.label}
        onClick={(e) => {
          e.currentTarget.blur(); // keep Space for the cards
          if (a.coming) return; // (not yet: it stays, and so does the menu; its name is still its tip)
          if (room) press(a.id, room);
          if (a.id !== 'vote') onDone(); // (the vote stays up: its tally is the answer)
        }}
      >
        <Icon />
        {a.tally && <small>{a.tally}</small>}
      </button>
    );
  };
  const table = room ? actions.filter((a) => a.id !== 'leave') : [];
  const leave = room && actions.find((a) => a.id === 'leave');
  return (
    <section className="slip menu" id="menu" aria-label="Menu">
      {children}
      <div className="acts">
        {table.length > 0 && <div className="line">{table.map(act)}</div>}
        <div className="line">
          <button type="button" className="icon" aria-pressed={muted} aria-label={muted ? 'Unmute' : 'Mute'} data-tip={muted ? 'Unmute' : 'Mute'} onClick={(e) => (e.currentTarget.blur(), onMute())}>
            <Speaker off={muted} />
          </button>
          {onUsage && (
            <button type="button" className="icon" aria-label="Played" data-tip="Played" onClick={onUsage}>
              <Chart />
            </button>
          )}
          <span className="end">
            {onFeedback && (
              <button type="button" className="icon" aria-label="Feedback" data-tip="Feedback" onClick={onFeedback}>
                <Bug />
              </button>
            )}
            {leave && act(leave)}
          </span>
        </div>
      </div>
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
      <div className="paper-card" role="alertdialog" aria-label={`${a.label}: are you sure?`}>
        <h2>Are you sure?</h2>
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
