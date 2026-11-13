// The Pixel deck: every card built out of little squares, like the playing cards of an old video game. Its own
// drawing, made here: the figures, the suit marks and the court cards' headgear are the small pictures below, one
// character a square.
import type { ReactElement } from 'react';
import type { Suit } from '../../shared/types';

const W = 90;
const H = 126;

const FIGURE: Record<number, string[]> = {
  1: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['#...#', '#...#', '#...#', '#####', '....#', '....#', '....#'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '..#..', '..#..', '..#..'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  10: ['#..##.', '#.#..#', '#.#..#', '#.#..#', '#.#..#', '#.#..#', '#..##.'],
  11: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  12: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  13: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
};

const MARK: Record<Suit, string[]> = {
  H: ['.#.#.', '#####', '#####', '.###.', '..#..'],
  D: ['..#..', '.###.', '#####', '.###.', '..#..'],
  S: ['..#..', '.###.', '#####', '#.#.#', '..#..'],
  C: ['.###.', '#.#.#', '#####', '..#..', '.###.'], // (flat-topped, its notches high: not to be taken for a spade)
};

const BIG: Record<Suit, string[]> = {
  H: ['.##.##.', '#######', '#######', '#######', '.#####.', '..###..', '...#...'],
  D: ['...#...', '..###..', '.#####.', '#######', '.#####.', '..###..', '...#...'],
  S: ['...#...', '..###..', '.#####.', '#######', '#######', '.#.#.#.', '..###..'],
  C: ['..###..', '..###..', '##.#.##', '#######', '##.#.##', '...#...', '..###..'],
};

/** What a court card wears: a cap with a feather, a coronet, a crown. */
const HEADGEAR: Record<number, string[]> = {
  11: ['......##.', '.....##..', '.######..', '########.'],
  12: ['..#.#.#..', '.#######.', '#########', '#########'],
  13: ['#...#...#', '##.###.##', '#########', '#########'],
};

/** The squares of a small picture as one path: its top-left corner at (x, y), each square `px` across; `flip`: upside down. */
function squares(rows: readonly string[], x: number, y: number, px: number, flip = false): string {
  let d = '';
  rows.forEach((row, r) => {
    const at = flip ? rows.length - 1 - r : r;
    // (Each run of squares in a row is one rectangle.)
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== '#') continue;
      let end = c;
      while (row[end + 1] === '#') end++;
      d += `M${x + c * px} ${y + at * px}h${(end - c + 1) * px}v${px}h${-(end - c + 1) * px}z`;
      c = end;
    }
  });
  return d;
}

// Where the suit marks of 2 to 10 stand: their middles, as on any card; those below the middle are upside down.
const [L, C, R] = [31, 45, 59];
const [Y1, Y2, Y3, Y4, YM] = [27, 51, 75, 99, 63];
const SPOTS: Record<number, [number, number][]> = {
  2: [[C, Y1], [C, Y4]],
  3: [[C, Y1], [C, YM], [C, Y4]],
  4: [[L, Y1], [R, Y1], [L, Y4], [R, Y4]],
  5: [[L, Y1], [R, Y1], [C, YM], [L, Y4], [R, Y4]],
  6: [[L, Y1], [R, Y1], [L, YM], [R, YM], [L, Y4], [R, Y4]],
  7: [[L, Y1], [R, Y1], [C, 45], [L, YM], [R, YM], [L, Y4], [R, Y4]],
  8: [[L, Y1], [R, Y1], [C, 45], [L, YM], [R, YM], [C, 81], [L, Y4], [R, Y4]],
  9: [[L, Y1], [R, Y1], [L, Y2], [R, Y2], [C, YM], [L, Y3], [R, Y3], [L, Y4], [R, Y4]],
  10: [[L, Y1], [R, Y1], [C, 39], [L, Y2], [R, Y2], [L, Y3], [R, Y3], [C, 87], [L, Y4], [R, Y4]],
};

export interface PixelInk {
  paper: string;
  red: string;
  black: string;
  gold: string;
  /** The class the drawing carries when the card is dark (see `.front:has(> svg.dark)` in the stylesheet). */
  dark?: string;
}
export const PIXEL: PixelInk = { paper: '#fbfaf4', red: '#e6304e', black: '#2c3040', gold: '#eaa91c' };
export const PIXEL_NIGHT: PixelInk = { paper: '#1b2132', red: '#ff6481', black: '#e6eaf5', gold: '#f2b320', dark: 'dark' };

/** One card of the Pixel deck; `mini`: the large-print rendition for a small card. */
export function Pixel({ suit, rank, mini, ink }: { suit: Suit; rank: number; mini: boolean; ink: PixelInk }): ReactElement {
  const colour = suit === 'H' || suit === 'D' ? ink.red : ink.black;
  const figure = FIGURE[rank]!;
  const svg = (body: ReactElement) => (
    <svg viewBox={`0 0 ${W} ${H}`} fill={colour} shapeRendering="crispEdges" className={ink.dark}>
      <rect width={W} height={H} rx="7" fill={ink.paper} />
      {body}
    </svg>
  );
  if (mini) return svg(<path d={squares(figure, rank === 10 ? 6 : 8, 8, 6) + squares(MARK[suit], 52, 10, 6) + squares(BIG[suit], 17, 60, 8)} />);
  // The corner: the figure, and the suit under it; the same again in the opposite corner, the other way up.
  const corner = squares(figure, rank === 10 ? 4 : 6, 6, 3) + squares(MARK[suit], 6, 30, 3);
  const corners = (
    <>
      <path d={corner} />
      <path d={corner} transform={`rotate(180 ${W / 2} ${H / 2})`} />
    </>
  );
  if (rank === 1) return svg(<>{corners}<path d={squares(BIG[suit], 24, 42, 6)} /></>);
  if (rank > 10) {
    const gear = HEADGEAR[rank]!;
    return svg(
      <>
        {corners}
        <path d="M27 15h36v96h-36zM30 18v90h30v-90z" fillRule="evenodd" />
        <path d={squares(gear, 31.5, 24, 3) + squares(gear, 31.5, 90, 3, true)} fill={ink.gold} />
        <path d={squares(figure, 33, 42, 6)} />
      </>,
    );
  }
  return svg(
    <>
      {corners}
      <path d={SPOTS[rank]!.map(([x, y]) => squares(MARK[suit], x - 7.5, y - 7.5, 3, y > YM)).join('')} />
    </>,
  );
}
