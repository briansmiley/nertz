// The table's actions during a round, as the slip behind the door (beside the gear, Settings.tsx `Corner`) lists
// them: one line each. Which are open to you, and what each does, is actions.ts.
import { useState } from 'react';
import type { RoomView } from '../shared/types';
import { perform, type ActionId, type TableAction } from './actions';

/** One that cannot be undone asks again in its own line, and forgets when another is pressed. `onDone`: the slip is put away. */
export function TableMenu({ room, actions, onDone }: { room: RoomView; actions: TableAction[]; onDone: () => void }) {
  const [sure, setSure] = useState<ActionId | null>(null);
  return (
    <section className="slip acts" id="table-actions" aria-label="Table">
      {actions.map((a) => (
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
          {sure === a.id ? a.sure : a.label}
          {a.tally && <small>{a.tally}</small>}
        </button>
      ))}
    </section>
  );
}
