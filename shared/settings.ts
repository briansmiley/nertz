// Table settings: house rules the host chooses between rounds. One flat object
// of independent options, stored in the room and sent in every RoomView. To add
// an option: a field here, its default, a line in `parseSettings`, and a row in
// client/Settings.tsx (`TableRules`) if the host is to be offered it.
// None today: Tap to play, the last, is each player's own (client/prefs.ts
// `Prefs.tapToMove`), and an older client asking the table for it changes nothing.

export interface TableSettings {}

export const DEFAULT_SETTINGS: TableSettings = {};

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
  const patch: Partial<TableSettings> = {}; // (a line here for each option)
  return Object.keys(patch).length > 0 ? patch : null;
}
