// A snipe as the felt tells of it (client/Table.tsx), gathered from the server's words of it.
import type { ServerMsg } from '../shared/protocol';

/** The server's word of one snipe: seat `by` beat seat `of` to a pile with `card`. */
export type SnipeWord = Pick<Extract<ServerMsg, { t: 'snipe' }>, 'by' | 'of' | 'card'>;

/**
 * One card's snipe: whose card it was (`by`), and everyone it beat to its pile (`of`, in the order the server told
 * of them). At a full table more than one hand is often going for the same place, so one card can beat several, and
 * the server tells of each in a word of its own, together or seconds apart. `n` counts every word heard, so that the
 * notice comes again with each, naming everyone so far.
 */
export interface Snipe {
  card: string;
  by: number;
  of: readonly number[];
  n: number;
}

/** The notice once `word` is heard: the card it shows beat one more; or another card's snipe, a notice of its own. */
export function heard(was: Snipe | null, { by, of, card }: SnipeWord): Snipe {
  const before = was?.card === card ? was.of.filter((seat) => seat !== of) : [];
  return { card, by, of: [...before, of], n: (was?.n ?? 0) + 1 };
}
