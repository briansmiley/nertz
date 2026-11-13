// Table settings: house rules the host chooses between rounds. One flat object
// of independent options, stored in the room, sent in every RoomView and read
// when the next round is dealt. To add an option: a field here, its default, a
// line in `parseSettings`, and a row in client/Settings.tsx (`TableRules`).
import { TABLE_MODES, type TableMode } from './table';

export interface TableSettings {
  /**
   * How a card is dealt off the stock. Either way it is one card per action
   * (the same `flip` intent, enforced by the engine); this only chooses the
   * gesture: 'drag' each card from the stock onto the waste, or 'click' the
   * stock (or press Space) once per card.
   */
  stockDeal: StockDeal;
  /**
   * The middle of the table: on a 'free' one a pile lies wherever its Ace is
   * put down, as long as it is clear of every other pile; 'spots' gives every
   * centre pile a marked place (an Ace goes on an empty one). The lobby's
   * checkbox for 'spots' reads "Crystallized Nertz".
   */
  centre: TableMode;
}

export type StockDeal = 'drag' | 'click';

export const DEFAULT_SETTINGS: TableSettings = { stockDeal: 'click', centre: 'free' };

/**
 * How many face-down cards lie under the face-up one in each of the four work piles, by how many are dealt into the
 * round: none at all with two, 0/0/1/2 with three, the standard 0/1/2/3 from four up. (A rule of the game, not an
 * option: fewer players put fewer cards in the middle, so less is buried.)
 */
export const faceDown = (players: number): number[] => [0, 1, 2, 3].map((i) => Math.max(0, i - (players <= 2 ? 3 : players === 3 ? 1 : 0)));

/**
 * A clean copy of the options a `settings` message wants changed, or null if
 * it is not an object, names nothing we know, or gives any known option a
 * value of the wrong type. Unknown keys are dropped. Never throws.
 */
export function parseSettings(raw: unknown): Partial<TableSettings> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const patch: Partial<TableSettings> = {};
  if ('stockDeal' in v) {
    if (v.stockDeal !== 'drag' && v.stockDeal !== 'click') return null;
    patch.stockDeal = v.stockDeal;
  }
  if ('centre' in v) {
    const centre = TABLE_MODES.find((m) => m === v.centre);
    if (!centre) return null;
    patch.centre = centre;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
