// Table settings: house rules the host chooses between rounds. One flat object
// of independent options, stored in the room and sent in every RoomView. To add
// an option: a field here, its default, a line in `parseSettings`, and a row in
// client/Settings.tsx (`TableRules`) if the host is to be offered it.

export interface TableSettings {
  /**
   * Whether a card can be moved without dragging it: a tap or a click takes it
   * up, and the next one says where it goes. The same on every screen; off, a
   * card has to be dragged by mouse and finger alike. Dragging always works. A
   * card moved so is never seen travelling, but the server cannot tell it from
   * a drag (the same `hold` and `move`), so this only chooses gestures.
   */
  tapToMove: boolean;
}

export const DEFAULT_SETTINGS: TableSettings = { tapToMove: false };

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
  if ('tapToMove' in v) {
    if (typeof v.tapToMove !== 'boolean') return null;
    patch.tapToMove = v.tapToMove;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
