// The Pixel deck: every card built out of little squares, like the playing cards of an old video game. Its own
// drawing, made here, on a grid of 45 by 63 squares: the figures, the suit marks and the court cards (a king, a
// queen and a jack, each a bust drawn twice, the second upside down) are the small pictures below, one character a
// square.
import type { ReactElement } from 'react';
import type { Suit } from '../../shared/types';

const W = 90;
const H = 126;
/** One square of the grid. */
const PX = 2;

/** The figures, 7 squares by 10 (the ten is 8 across), drawn two squares thick. */
const FIGURE: Record<number, string[]> = {
  1: ['..###..', '.#####.', '##...##', '##...##', '##...##', '#######', '#######', '##...##', '##...##', '##...##'],
  2: ['.#####.', '#######', '##...##', '.....##', '....##.', '...##..', '..##...', '.##....', '#######', '#######'],
  3: ['.#####.', '#######', '##...##', '.....##', '..####.', '..####.', '.....##', '##...##', '#######', '.#####.'],
  4: ['....##.', '...###.', '..####.', '.##.##.', '##..##.', '#######', '#######', '....##.', '....##.', '....##.'],
  5: ['#######', '#######', '##.....', '######.', '#######', '.....##', '.....##', '##...##', '#######', '.#####.'],
  6: ['.#####.', '#######', '##.....', '######.', '#######', '##...##', '##...##', '##...##', '#######', '.#####.'],
  7: ['#######', '#######', '.....##', '....##.', '....##.', '...##..', '...##..', '..##...', '..##...', '..##...'],
  8: ['.#####.', '#######', '##...##', '##...##', '.#####.', '.#####.', '##...##', '##...##', '#######', '.#####.'],
  9: ['.#####.', '#######', '##...##', '##...##', '##...##', '#######', '.######', '.....##', '#######', '.#####.'],
  10: ['##..###.', '##.#####', '##.##.##', '##.##.##', '##.##.##', '##.##.##', '##.##.##', '##.##.##', '##.#####', '##..###.'],
  11: ['...####', '...####', '.....##', '.....##', '.....##', '.....##', '##...##', '##...##', '#######', '.#####.'],
  12: ['.#####.', '#######', '##...##', '##...##', '##...##', '##...##', '##.#.##', '##..###', '#######', '.####.#'],
  13: ['##...##', '##..##.', '##.##..', '####...', '###....', '###....', '####...', '##.##..', '##..##.', '##...##'],
};

/** The suit marks, 7 squares by 7. */
const MARK: Record<Suit, string[]> = {
  H: ['.##.##.', '#######', '#######', '#######', '.#####.', '..###..', '...#...'],
  D: ['...#...', '..###..', '.#####.', '#######', '.#####.', '..###..', '...#...'],
  S: ['...#...', '..###..', '.#####.', '#######', '#######', '...#...', '..###..'],
  C: ['..###..', '..###..', '##.#.##', '#######', '##.#.##', '...#...', '..###..'],
};

/**
 * The court cards: a bust 28 squares wide and 28 high, in the way of the old court cards: the King with a sword at
 * his shoulder, the Queen with a flower, the Jack in a feathered cap with a halberd. Each is drawn twice on its card,
 * the second upside down. `g` gold, `o` ink (outlines, hair, beard), `w` white, `s` the suit's colour, `b` blue.
 */
const BUST: Record<number, string[]> = {
  13: [
    '..ww......g...gg...g........',
    '..ww......gg.gggg.gg........',
    '..ww......gggggggggg........',
    '..ww......gsggbbggsg........',
    '..ww......oooooooooo........',
    '..ww.....oowwwwwwwwoo.......',
    '..ww.....oowwwwwwwwoo.......',
    '..ww.....oowowwwwowoo.......',
    '..ww.....oowwwwwwwwoo.......',
    '..ww.....oowwwoowwwoo.......',
    '..ww.....ooowwwwwwooo.......',
    '..ww.....oooossssoooo.......',
    '..ww......oooooooooo........',
    '.ggg.......oooooooo.........',
    '..oo...ssss.oooooo.ssss.....',
    '..oo.ssssssggoooogggsssss...',
    '.www.sssssggggggggggsssss...',
    '.www.ssbbsgwwwwwwwwgsbbss...',
    '..oosssbbsgwwwwwwwwgsbbsss..',
    '..ggssbbssgwwwwwwwwgssbbss..',
    '....ssbbssgwwwwwwwwgssbbss..',
    '...ssbbsssgwwwwwwwwgsssbbss.',
    '...ssbbsssgwwwwwwwwgsssbbss.',
    '..ssbbssssgwwwwwwwwgssssbbss',
    '..ssbbssssgwwwwwwwwgssssbbss',
    '.ssbbsssssgwwwwwwwwgsssssbbs',
    '.ssbbsssssggggggggggsssssbbs',
    'gggggggggggggggggggggggggggg',
  ],
  12: [
    '...........g..gg..g.....s.s.',
    '...........gggggggg....sssss',
    '...........gsgbbgsg.....sgs.',
    '..........oooooooooo...sssss',
    '.........oooooooooooo...sbs.',
    '........ooowwwwwwwwooo..bb..',
    '........oowwwwwwwwwwoo..bb..',
    '........oowwowwwwowwoo..bb..',
    '........oowwwwwwwwwwoo..bb..',
    '........oowwwwoowwwwoo..bb..',
    '........ooowwwwwwwwooo..bb..',
    '........oooowwsswwoooo..www.',
    '........ooooowwwwooooo..www.',
    '........oooo.wwww.oooo..bb..',
    '.......ooooggggggggoooo..b..',
    '......ooosssgwwwwgsssooo.b..',
    '.....ooossssggggggssssooo...',
    '....oosssbssgwwwwwwgssbsssoo',
    '....ossssbssgwwwwwwgssbssss.',
    '...sssbbbbbsgwwwwwwgsbbbbbss',
    '...ssssbbbssgwwwwwwgssbbbsss',
    '..sssssbbbssgwwwwwwgssbbbsss',
    '..ssssbsbsbsgwwwwwwgsbsbsbss',
    '.sssssssssssgwwwwwwgssssssss',
    '.sssbsssssbsgwwwwwwgsbsssssb',
    'sssbbbsssbbbgwwwwwwgbbbsssbb',
    'ssssbsssssbsggggggggsbsssssb',
    'gggggggggggggggggggggggggggg',
  ],
  11: [
    '....gg...........w..........',
    '...gg.....ssssss.ww.........',
    '..gg....ssssssssswww........',
    '..g....ssssssssss.w.........',
    '......gggggggggggg.g........',
    '......oooooooooooo.g........',
    '.......oowwwwwwwwoo.g.......',
    '.......oowwwwwwwwoo.g.......',
    '.......oowowwwwowoo.g.......',
    '.......oowwwwwwwwoo.g.......',
    '.......oowwwoowwwoo.g.......',
    '.......ooowwwwwwooo.g.......',
    '.......oooowsswoooo.g.......',
    '........ooowwwwooo.www......',
    '.........o.wwww.o..www......',
    '......ggggggggggggg.g.......',
    '....ggggggggggggggggg.......',
    '...sssbsgwwwwwwwwgsbsss.....',
    '..ssssbsgwwwwwwwwgsbssss....',
    '..sbssbsgwwwwwwwwgsbssbs....',
    '.ssbssbsgwwwwwwwwgsbssbss...',
    '.ssbssbsgwwwwwwwwgsbssbss...',
    'sssbssbsgwwwwwwwwgsbssbsss..',
    'sssbssbsgwwwwwwwwgsbssbsss..',
    'sssbssbsgwwwwwwwwgsbssbsss..',
    'sssbssbsgwwwwwwwwgsbssbsss..',
    'sssbssbsggggggggggsbssbsss..',
    'gggggggggggggggggggggggggggg',
  ],
};

/** The squares of a small picture that are `mark`, as one path: its top-left corner at (x, y), each square `px` across; `flip`: upside down. */
function squares(rows: readonly string[], x: number, y: number, px: number, flip = false, mark = '#'): string {
  let d = '';
  rows.forEach((row, r) => {
    const at = flip ? rows.length - 1 - r : r;
    // (Each run of squares in a row is one rectangle.)
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== mark) continue;
      let end = c;
      while (row[end + 1] === mark) end++;
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

/** A court card's bust, the right way up: its top-left corner at (17, 7), 56 across and 56 high. */
function Bust({ suit, rank, ink }: { suit: Suit; rank: number; ink: PixelInk }): ReactElement {
  const red = suit === 'H' || suit === 'D';
  // (The robe is the suit's colour, with blue; a black suit's is dark with red trim instead, so that the four suits are not all one picture.)
  // ("White" is a pale grey: a white face or blade would be lost on the card.)
  const paint: Record<string, string> = { g: ink.gold, o: '#2c3040', w: '#dcdfea', s: red ? ink.red : '#454b66', b: red ? '#3f6fd8' : '#e6304e' };
  return (
    <>
      {Object.entries(paint).map(([mark, fill]) => (
        <path key={mark} d={squares(BUST[rank]!, 17, 7, PX, false, mark)} fill={fill} />
      ))}
      {/* On the white front, the suit. */}
      <path d={squares(MARK[suit], 38, 43, PX)} fill={red ? ink.red : '#2c3040'} />
    </>
  );
}

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
  if (mini) return svg(<path d={squares(figure, rank === 10 ? 5 : 8, 10, 4) + squares(MARK[suit], 52, 14, 4) + squares(MARK[suit], 20, 64, 7)} />);
  // The corner: the figure, and the suit under it; the same again in the opposite corner, the other way up.
  const corner = squares(figure, rank === 10 ? 1 : 2, 5, PX) + squares(MARK[suit], 2, 28, PX);
  const corners = (
    <>
      <path d={corner} />
      <path d={corner} transform={`rotate(180 ${W / 2} ${H / 2})`} />
    </>
  );
  if (rank === 1) return svg(<>{corners}<path d={squares(MARK[suit], 24, 42, 6)} /></>);
  if (rank > 10) {
    return svg(
      <>
        {/* A frame round the two busts, and a line where they meet. */}
        <path d="M16 6h58v114h-58zM17 7v112h56v-112z" fillRule="evenodd" />
        <Bust suit={suit} rank={rank} ink={ink} />
        <g transform={`rotate(180 ${W / 2} ${H / 2})`}>
          <Bust suit={suit} rank={rank} ink={ink} />
        </g>
        {corners}
      </>,
    );
  }
  return svg(
    <>
      {corners}
      <path d={SPOTS[rank]!.map(([x, y]) => squares(MARK[suit], x - 7, y - 7, PX, y > YM)).join('')} />
    </>,
  );
}
