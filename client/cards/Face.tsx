// Card faces, drawn here as SVG (see CREDITS.md). Two renditions of every
// card: the full face with corner indices and proper pip layouts, and a
// "mini" face for cards shown too small for pips to read (opponents' piles),
// which is just a big rank and suit.
import { memo, type ReactElement } from 'react';
import type { Suit } from '../../shared/types';

/** Cards are drawn at this size (CSS px) and scaled by the table. */
export const CARD_W = 90;
export const CARD_H = 126;

/** Back colour per seat. */
export const BACKS = ['#c9303f', '#2b5fd9', '#e2a019', '#1c9468', '#7d4fc7', '#272b35'] as const;
export const backColour = (seat: number): string => BACKS[((seat % BACKS.length) + BACKS.length) % BACKS.length]!;

const RED = '#cf2233';
const BLACK = '#1a1c23';
const GOLD = '#d8a521';
const LABEL = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const INDEX_FONT = "'Barlow Condensed', 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";
const COURT_FONT = "'Bowlby One', 'Arial Black', Impact, sans-serif";

// Suit shapes in a box of roughly -50..50 around the origin.
const SHAPE: Record<Suit, ReactElement> = {
  H: <path d="M0-17C-7-39-46-38-46-8C-46 17-15 32 0 48C15 32 46 17 46-8C46-38 7-39 0-17Z" />,
  D: <path d="M0-49C10-29 22-13 37 0C22 13 10 29 0 49C-10 29-22 13-37 0C-22-13-10-29 0-49Z" />,
  S: <path d="M0-49C14-30 46-11 46 12C46 34 17 38 5 22C6 34 10 42 19 48L-19 48C-10 42-6 34-5 22C-17 38-46 34-46 12C-46-11-14-30 0-49Z" />,
  C: (
    <>
      <circle cx="0" cy="-26" r="20" />
      <circle cx="-24" cy="7" r="20" />
      <circle cx="24" cy="7" r="20" />
      <path d="M-9-10H9V10H-9ZM-4 8C-5 28-10 41-19 48L19 48C10 41 5 28 4 8Z" />
    </>
  ),
};

function Pip({ suit, x, y, size, flip }: { suit: Suit; x: number; y: number; size: number; flip?: boolean }) {
  const k = size / 100;
  return <g transform={`translate(${x} ${y}) scale(${flip ? -k : k})`}>{SHAPE[suit]}</g>;
}

// Pip positions for 2..10 as [x, y]; anything below the middle is drawn upside down.
const L = 34;
const C = 45;
const R = 56;
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

// Headgear for the court cards, centred on the origin, about 26 wide.
const CROWN: Record<number, ReactElement> = {
  11: (
    <>
      <path d="M-10 5V1C-6-4 6-4 10 1V5Z" />
      <path d="M3-2C4-10 10-13 15-10C11-9 8-6 7-1Z" />
    </>
  ),
  12: (
    <>
      <path d="M-11 5C-12-1-8-3-6 2C-5-6 5-6 6 2C8-3 12-1 11 5Z" />
      <circle cx="-9.5" cy="-3.5" r="1.7" />
      <circle cx="0" cy="-7.5" r="1.9" />
      <circle cx="9.5" cy="-3.5" r="1.7" />
    </>
  ),
  13: (
    <>
      <path d="M-12 5L-13.5-5L-6.5 0L0-8L6.5 0L13.5-5L12 5Z" />
      <circle cx="-13.5" cy="-6" r="1.5" />
      <circle cx="0" cy="-9" r="1.5" />
      <circle cx="13.5" cy="-6" r="1.5" />
    </>
  ),
};

function Index({ suit, rank }: { suit: Suit; rank: number }) {
  return (
    <>
      <text x="13.5" y="23" textAnchor="middle" fontSize="25" fontWeight="700" fontFamily={INDEX_FONT} letterSpacing={rank === 10 ? -2 : 0}>
        {LABEL[rank]}
      </text>
      <Pip suit={suit} x={13.5} y={33} size={14} />
    </>
  );
}

function Court({ suit, rank, colour }: { suit: Suit; rank: number; colour: string }) {
  const half = (
    <>
      <g transform="translate(45 26)" fill={GOLD} stroke={colour} strokeWidth="0.7" strokeLinejoin="round">
        {CROWN[rank]}
      </g>
      <text x="45" y="59" textAnchor="middle" fontSize="27" fontFamily={COURT_FONT}>
        {LABEL[rank]}
      </text>
      <Pip suit={suit} x={30} y={24} size={8} />
      <Pip suit={suit} x={60} y={24} size={8} />
    </>
  );
  return (
    <>
      <rect x="24.5" y="13.5" width="41" height="99" rx="3.5" fill={colour === RED ? '#fbe6e2' : '#e6e9f0'} stroke={colour} strokeWidth="0.9" />
      <rect x="27" y="16" width="36" height="94" rx="2" fill="none" stroke={GOLD} strokeWidth="0.8" />
      <path d="M27 63H63" stroke={GOLD} strokeWidth="0.8" />
      {half}
      <g transform="rotate(180 45 63)">{half}</g>
    </>
  );
}

/** The face of one card. `mini` picks the large-print rendition. */
export const Face = memo(function Face({ suit, rank, mini }: { suit: Suit; rank: number; mini: boolean }) {
  const colour = suit === 'H' || suit === 'D' ? RED : BLACK;
  if (mini) {
    return (
      <svg viewBox={`0 0 ${CARD_W} ${CARD_H}`} fill={colour}>
        <text x="25" y="45" textAnchor="middle" fontSize="50" fontWeight="700" fontFamily={INDEX_FONT} letterSpacing={rank === 10 ? -5 : 0}>
          {LABEL[rank]}
        </text>
        <Pip suit={suit} x={67} y={27} size={36} />
        <Pip suit={suit} x={45} y={89} size={54} />
      </svg>
    );
  }
  return (
    <svg viewBox={`0 0 ${CARD_W} ${CARD_H}`} fill={colour}>
      <Index suit={suit} rank={rank} />
      <g transform="rotate(180 45 63)">
        <Index suit={suit} rank={rank} />
      </g>
      {rank === 1 ? (
        <Pip suit={suit} x={C} y={YM} size={44} />
      ) : rank > 10 ? (
        <Court suit={suit} rank={rank} colour={colour} />
      ) : (
        SPOTS[rank]!.map(([x, y], i) => <Pip key={i} suit={suit} x={x} y={y} size={18} flip={y > YM} />)
      )}
    </svg>
  );
});
