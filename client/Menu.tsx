// The one button in the corner (☰, Settings.tsx `Corner`) and the slip it opens: sound on or off, the table's actions
// during a round (which are open to you, and what each does, is actions.ts), and the way to your settings and to
// feedback, which open in the same place. One line each.
import { useState, useSyncExternalStore } from 'react';
import type { RoomView } from '../shared/types';
import { perform, type ActionId, type TableAction } from './actions';
import { Bug, Door, Eye, Flag, Gear, PauseIcon, Play, Redeal, Speaker } from './icons';

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
/** Put `p` away if it is still the one open (a slip done with, which may have been put away or swapped meanwhile). */
export function putAway(p: Panel): void {
  if (panel === p) openCorner(null);
}
export function useCorner(): Panel | null {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => panel,
  );
}

/** Each action's icon, before its name. */
const ICONS: Record<ActionId, () => React.JSX.Element> = { pause: PauseIcon, resume: Play, vote: Flag, redeal: Redeal, stand: Eye, leave: Door };

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
 * An action that cannot be undone asks again in its own line, and forgets when another line is pressed. Muting and the
 * vote leave the slip up (what they did is on it); anything else puts it away (`onDone`) or opens another (`go`).
 */
export function Menu({ room, actions, muted, onMute, go, onDone }: { room: RoomView | null | undefined; actions: TableAction[]; muted: boolean; onMute: () => void; go: (to: Panel) => void; onDone: () => void }) {
  const [sure, setSure] = useState<ActionId | null>(null);
  return (
    <section className="slip acts" id="menu" aria-label="Menu">
      <button type="button" aria-pressed={muted} onClick={(e) => (e.currentTarget.blur(), setSure(null), onMute())}>
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
              className={`${a.on ? 'on' : ''}${sure === a.id ? ' sure' : ''}`}
              aria-pressed={a.on}
              onClick={(e) => {
                e.currentTarget.blur(); // keep Space for the cards
                setSure(a.sure && sure !== a.id ? a.id : null);
                if (a.sure && sure !== a.id) return;
                perform(a.id, room);
                if (a.id !== 'vote') onDone(); // (the vote stays up: its tally is the answer)
              }}
            >
              <Icon />
              {sure === a.id ? a.sure : a.label}
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
