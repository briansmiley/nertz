// Seating and unseating, for whoever deals: the robot that seats a bot, and the × beside a name. The same two in the
// lobby, on the score sheet, and under the Start button while the table waits for it (Opening.tsx).
import { useState } from 'react';
import { BOT_LEVELS, freeSeats } from '../shared/protocol';
import type { BotLevel, PlayerView, RoomView } from '../shared/types';
import { addBot, kick, removeBot } from './net';
import { Pop, Robot } from './Settings';

/** For whoever deals, between rounds and before their Start: a robot button that opens a slip for seating a bot. */
export function AddBot({ room }: { room: RoomView }) {
  const [level, setLevel] = useState<BotLevel>('medium');
  const full = freeSeats(room.seats) === 0;
  return (
    <Pop icon={<Robot />} label="Add a bot">
      <h3>Add a bot</h3>
      {full ? (
        <p className="hint">The table is full.</p>
      ) : (
        <div className="bots">
          <select value={level} onChange={(e) => setLevel(e.target.value as BotLevel)} aria-label="Bot speed">
            {BOT_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <button type="button" className="plain" onClick={() => addBot(level)}>
            Add
          </button>
        </div>
      )}
    </Pop>
  );
}

/** A small × beside a name, for whoever deals: a bot is sent away; a person is put out of the table, as if they had left. */
export function Unseat({ who }: { who: PlayerView }) {
  return (
    <button type="button" className="unseat" aria-label={`Remove ${who.name}`} data-tip={who.bot ? `Remove ${who.name}` : `Remove ${who.name} from the table`} onClick={() => (who.bot ? who.seat !== null && removeBot(who.seat) : kick(who.id))}>
      ×
    </button>
  );
}
