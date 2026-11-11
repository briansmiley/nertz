// Table settings: house rules the host chooses between rounds. One flat object
// of independent options, stored in the room, sent in every RoomView and read
// when the next round is dealt. To add an option: a field here, its default, a
// line in `parseSettings`, and a row in client/Settings.tsx (`TableRules`).
import { TABLE_MODES, type TableMode } from './table';

export interface TableSettings {
  /**
   * The small-table rule: with fewer than four players in the round each work
   * pile is dealt one fewer face-down card (0/0/1/2 instead of 0/1/2/3).
   */
  fewerDown: boolean;
  /**
   * How a card is dealt off the stock. Either way it is one card per action
   * (the same `flip` intent, enforced by the engine); this only chooses the
   * gesture: 'drag' each card from the stock onto the waste, or 'click' the
   * stock (or press Space) once per card.
   */
  stockDeal: StockDeal;
  /**
   * The middle of the table: 'spots' gives every centre pile a fixed place
   * (an Ace goes on an empty one); 'free' has none, and a pile lies wherever
   * its Ace is put down, as long as it overlaps no other pile.
   */
  centre: TableMode;
}

export type StockDeal = 'drag' | 'click';

export const DEFAULT_SETTINGS: TableSettings = { fewerDown: true, stockDeal: 'drag', centre: 'spots' };

/** Players in the round below which `fewerDown` applies. */
export const SMALL_TABLE = 4;

/**
 * A clean copy of the options a `settings` message wants changed, or null if
 * it is not an object, names nothing we know, or gives any known option a
 * value of the wrong type. Unknown keys are dropped. Never throws.
 */
export function parseSettings(raw: unknown): Partial<TableSettings> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const patch: Partial<TableSettings> = {};
  if ('fewerDown' in v) {
    if (typeof v.fewerDown !== 'boolean') return null;
    patch.fewerDown = v.fewerDown;
  }
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
