// Card faces, drawn here as SVG (see CREDITS.md). Two renditions of every
// card: the full face with corner indices and proper pip layouts, and a
// "mini" face for cards shown too small for pips to read (opponents' piles),
// which is just a big rank and suit.
import { memo, type CSSProperties, type ReactElement } from 'react';
import type { Back, Deck } from '../../shared/protocol';
import type { Suit } from '../../shared/types';
import { getPrefs, watchPrefs } from '../prefs';
import { drawnBack, isDrawn } from './backArt';
import { CLASSIC_FIGURE, CLASSIC_SUIT } from './classicGlyphs';
import { Pixel, PIXEL, PIXEL_NIGHT } from './pixel';

/** Cards are drawn at this size (CSS px) and scaled by the table. */
export const CARD_W = 90;
export const CARD_H = 126;

/** Back colour per seat. */
export const BACKS = ['#c9303f', '#2b5fd9', '#e2a019', '#1c9468', '#7d4fc7', '#272b35', '#d4428e', '#0f8a9c', '#d2601a', '#7a5c40'] as const;
export const backColour = (seat: number): string => BACKS[((seat % BACKS.length) + BACKS.length) % BACKS.length]!;

/**
 * Which issue of the picture files this is: put after their addresses, so that a browser that has an older picture
 * of the same name fetches the new one. Count it up whenever a file in public/cards/backs is changed.
 */
const ART = 2;
/**
 * How much larger a picture back is shown on a small card (another player's pile), so that only its middle shows:
 * a fine pattern needs more, and one that is a single figure (the two circles of the Rider back) is shown whole (1).
 */
const SMALL: Record<string, number> = { 'carpet-tint': 1.8, waterlily: 1.2, lilypads: 1.2, maple: 1.2, 'dandelion-1': 1.1, daisy: 1.2, tulip: 1.2, poppies: 1.2, sequoia: 1.25, fronds: 1.15, oak: 1.3, thistle: 1.2, lily: 1.2, rose: 1.25, iris: 1.15, sunflower: 1.15, acanthus: 1.7, fern: 1.5, ginkgo: 1, 'ginkgo-ring': 1.4, 'ginkgo-scatter': 2, piatnik: 1.5, atlas: 1.4, bicycle: 1, lion: 1, ornate: 1.8, rosette: 1.8, check: 2.2, stars: 2.4, cobble: 2.8, 'tarot-star-tint': 2, 'tarot-eye-tint': 1.9 };

/**
 * The picture a back is made of (none for the plain one, nor for a back by lot not drawn yet: null), printed in the
 * player's colour: how many times larger than the card it is shown (`zoom`: more than 1 on a small card), and whether
 * it lies inside a white edge.
 */
export function backArt(back: Back | null, bare: boolean, small = false): { src: string; zoom: number; edge: boolean } | null {
  if (back === null || back === 'plain') return null;
  if (isDrawn(back)) return { src: drawnBack(back, small, bare).slice(5, -2), zoom: 1, edge: false };
  const zoom = small ? (SMALL[back] ?? 1.8) : 1;
  return { src: `/cards/backs/${back}.png?v=${ART}`, zoom, edge: !bare };
}

/** What to put on a card's back element: its class and style, for the seat whose card it is and the back they chose (null: by lot, not drawn yet). */
export function backOf(colour: string, back: Back | null, bare: boolean, small = false): { className: string; style: CSSProperties } {
  const vars = { '--back': colour } as CSSProperties;
  if (back === null) return { className: 'back any', style: vars }; // a question mark (the stylesheet's)
  const art = backArt(back, bare, small);
  if (!art) return { className: `back${bare ? ' bare' : ''}`, style: vars };
  return {
    className: `back tint${art.edge ? ' edged' : ''}`,
    style: { ...vars, backgroundImage: `url("${art.src}")`, ...(art.zoom > 1 ? { backgroundSize: `${art.zoom * 100}% ${art.zoom * 100}%`, backgroundPosition: 'center' } : {}) },
  };
}

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

function Index({ suit, rank, font = INDEX_FONT }: { suit: Suit; rank: number; font?: string }) {
  return (
    <>
      <text x="13.5" y="23" textAnchor="middle" fontSize={font === INDEX_FONT ? 25 : 21} fontWeight="700" fontFamily={font} letterSpacing={rank === 10 ? -2 : 0}>
        {LABEL[rank]}
      </text>
      <Pip suit={suit} x={13.5} y={33} size={14} />
    </>
  );
}

function Court({ suit, rank, colour, tint }: { suit: Suit; rank: number; colour: string; tint?: string }) {
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
      <rect x="24.5" y="13.5" width="41" height="99" rx="3.5" fill={tint ?? (colour === RED ? '#fbe6e2' : '#e6e9f0')} stroke={colour} strokeWidth="0.9" />
      <rect x="27" y="16" width="36" height="94" rx="2" fill="none" stroke={GOLD} strokeWidth="0.8" />
      <path d="M27 63H63" stroke={GOLD} strokeWidth="0.8" />
      {half}
      <g transform="rotate(180 45 63)">{half}</g>
    </>
  );
}

// ---------------------------------------------------------------- the decks (shared/protocol.ts `DECKS`)
//
// Every deck has two renditions of a card: the full face, and a large-print one for cards drawn too small for a face
// to be read (`mini`: other players' piles), which goes with it in colour and lettering.
// Drawn here:
// - modern: this file's own drawing.
// - big: the large-print rendition at every size.
// - pixel: every card built out of little squares (pixel.tsx).
// - cute: one big suit mark with a face on it (the court cards' wear their headgear), in pink and plum, rounded letters.
// Sets of picture files (public/cards/<deck>, one a card, named rank then suit; see CREDITS.md):
// - classic. Its large-print rendition is a white card drawn with the Classic deck's own index
//   figures and suit marks (classicGlyphs.ts).

interface Theme {
  /** The card itself, when it is not the usual cream. */
  paper?: string;
  /** A dark card: the class its drawing carries, by which the stylesheet makes the card under it dark too (no light at its edge). */
  dark?: string;
  red: string;
  black: string;
  font: string;
  /** Behind a court card's figure: for a red suit, for a black one. */
  tint?: [string, string];
  cute?: boolean;
}
const CUTE_FONT = "'Fredoka', 'Baloo 2', 'Arial Rounded MT Bold', 'Helvetica Rounded', Arial, sans-serif";
const THEMES: Record<'modern' | 'cute', Theme> = {
  modern: { red: RED, black: BLACK, font: INDEX_FONT },
  cute: { paper: '#fff5f9', red: '#ff5a8c', black: '#4b4573', font: CUTE_FONT, cute: true },
};
/** The same decks dark: light on a dark card. */
const NIGHT: Record<'modern' | 'cute', Theme> = {
  modern: { paper: '#1b2132', dark: 'dark', red: '#ff6f86', black: '#e9edf7', font: INDEX_FONT, tint: ['#3b2433', '#2b334b'] },
  cute: { paper: '#27213f', dark: 'dark dark-cute', red: '#ff7fa8', black: '#cfc8ff', font: CUTE_FONT, cute: true },
};
const FILES = new Set<Deck>(['classic']);

const CODE = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const picture = (deck: Deck, suit: Suit, rank: number): string => `/cards/${deck}/${CODE[rank]}${suit}.svg`;

// A deck of pictures is fetched whole as soon as it is chosen (by you, or by anyone at your table), so that no card is
// blank the first time it is turned up.
const warmed = new Set<Deck>();
export function warm(deck: Deck = getPrefs().deck): void {
  if (warmed.has(deck) || !FILES.has(deck) || typeof Image === 'undefined') return;
  warmed.add(deck);
  for (const suit of ['C', 'D', 'H', 'S'] as const) for (let rank = 1; rank <= 13; rank++) new Image().src = picture(deck, suit, rank);
}
warm();
watchPrefs(() => warm());

const Paper = ({ fill }: { fill?: string }) => (fill ? <rect width={CARD_W} height={CARD_H} rx="7" fill={fill} /> : null);

// Where the face sits on each suit mark (in the mark's own box of -50..50), and how wide apart its eyes are.
const FACE: Record<Suit, { y: number; eyes: number; k: number }> = { H: { y: 2, eyes: 13, k: 1 }, D: { y: -2, eyes: 9, k: 0.85 }, S: { y: 10, eyes: 13, k: 1 }, C: { y: 9, eyes: 15, k: 0.9 } };

/** A suit mark with a face: two eyes, a smile, and a blush on each cheek. */
function Friend({ suit, x, y, size, ink, night = false }: { suit: Suit; x: number; y: number; size: number; ink: string; night?: boolean }) {
  const f = FACE[suit];
  // (Its features are dark on a light mark and light on a dark one: on a dark card the black suits are the light ones.)
  const red = suit === 'H' || suit === 'D' || night;
  const feature = suit === 'H' || suit === 'D' ? '#6e1836' : '#2b2547';
  return (
    <g transform={`translate(${x} ${y}) scale(${size / 100})`}>
      {SHAPE[suit]}
      <g transform={`translate(0 ${f.y}) scale(${f.k})`}>
        <circle cx={-f.eyes} cy="0" r="4.2" fill={red ? feature : '#fff'} />
        <circle cx={f.eyes} cy="0" r="4.2" fill={red ? feature : '#fff'} />
        <circle cx={-f.eyes + 1.4} cy="-1.4" r="1.4" fill={red ? '#fff' : ink} />
        <circle cx={f.eyes + 1.4} cy="-1.4" r="1.4" fill={red ? '#fff' : ink} />
        <path d="M-5 6Q0 11.5 5 6" fill="none" stroke={red ? feature : '#fff'} strokeWidth="2.4" strokeLinecap="round" />
        <circle cx={-f.eyes - 7} cy="7" r="4" fill={red ? '#ffd0de' : '#ff9cba'} opacity={red ? 0.75 : 0.8} />
        <circle cx={f.eyes + 7} cy="7" r="4" fill={red ? '#ffd0de' : '#ff9cba'} opacity={red ? 0.75 : 0.8} />
      </g>
    </g>
  );
}

/** Large print: a big rank, the suit beside it and again below. */
function Large({ suit, rank, colour, theme }: { suit: Suit; rank: number; colour: string; theme: Theme }) {
  return (
    <svg viewBox={`0 0 ${CARD_W} ${CARD_H}`} fill={colour} className={theme.dark}>
      <Paper fill={theme.paper} />
      <text x="25" y="45" textAnchor="middle" fontSize={theme.cute ? 44 : 50} fontWeight="700" fontFamily={theme.font} letterSpacing={rank === 10 ? -5 : 0}>
        {LABEL[rank]}
      </text>
      <Pip suit={suit} x={67} y={27} size={36} />
      {theme.cute ? <Friend suit={suit} x={45} y={89} size={58} ink={colour} night={!!theme.dark} /> : <Pip suit={suit} x={45} y={89} size={54} />}
    </svg>
  );
}

/** A deck of pictures in large print: a white card with the Classic deck's index figure and suit marks. */
function ClassicLarge({ suit, rank, night }: { suit: Suit; rank: number; night: boolean }) {
  const red = suit === 'H' || suit === 'D';
  const colour = night ? (red ? '#ff5d6c' : '#f2f2f2') : red ? 'red' : 'black';
  const mark = (x: number, y: number, size: number) => <path d={CLASSIC_SUIT[suit]} fill={colour} transform={`translate(${x} ${y}) scale(${size / 1000})`} />;
  return (
    <svg viewBox={`0 0 ${CARD_W} ${CARD_H}`}>
      <rect x="0.5" y="0.5" width={CARD_W - 1} height={CARD_H - 1} rx="6" fill={night ? '#16181d' : 'white'} stroke={night ? '#4a4f5c' : 'black'} strokeWidth="0.6" />
      <path d={CLASSIC_FIGURE[rank]} fill="none" stroke={colour} strokeWidth="95" strokeLinecap="square" strokeMiterlimit="1.5" transform="translate(24 29) scale(0.04)" />
      {mark(67, 27, 36)}
      {mark(45, 89, 56)}
    </svg>
  );
}

/** The Cute deck's full face: the corner indices, and one big suit mark with a face (a court card's wears its headgear). */
function Cute({ suit, rank, colour, theme }: { suit: Suit; rank: number; colour: string; theme: Theme }) {
  return (
    <svg viewBox={`0 0 ${CARD_W} ${CARD_H}`} fill={colour} className={theme.dark}>
      <Paper fill={theme.paper} />
      <Index suit={suit} rank={rank} font={theme.font} />
      <g transform="rotate(180 45 63)">
        <Index suit={suit} rank={rank} font={theme.font} />
      </g>
      <Friend suit={suit} x={45} y={rank > 10 ? 70 : 64} size={rank > 10 ? 50 : 54} ink={colour} night={!!theme.dark} />
      {rank > 10 && (
        <g transform="translate(45 37) scale(1.7)" fill={GOLD} stroke={colour} strokeWidth="0.7" strokeLinejoin="round">
          {CROWN[rank]}
        </g>
      )}
    </svg>
  );
}

/**
 * The face of one card. `mini` picks the large-print rendition. A card belongs to its owner's deck, and is drawn as
 * they chose for everyone (`deck` and `night`: whoever draws the card says which, so that a change to your other settings does
 * not draw every card on the table again).
 */
export const Face = memo(function Face({ suit, rank, mini, deck, night }: { suit: Suit; rank: number; mini: boolean; deck: Deck; night: boolean }) {
  // (A deck of pictures has no dark pictures: the light ones are turned inside out, and their colours turned back.)
  if (FILES.has(deck)) return mini ? <ClassicLarge suit={suit} rank={rank} night={night} /> : <img className={`art${night ? ' night' : ''}`} src={picture(deck, suit, rank)} alt="" draggable={false} />;
  if (deck === 'pixel') return <Pixel suit={suit} rank={rank} mini={mini} ink={night ? PIXEL_NIGHT : PIXEL} />;
  const theme = (night ? NIGHT : THEMES)[deck === 'cute' ? 'cute' : 'modern'];
  const red = suit === 'H' || suit === 'D';
  const colour = red ? theme.red : theme.black;
  if (mini || deck === 'big') return <Large suit={suit} rank={rank} colour={colour} theme={theme} />;
  if (theme.cute) return <Cute suit={suit} rank={rank} colour={colour} theme={theme} />;
  return (
    <svg viewBox={`0 0 ${CARD_W} ${CARD_H}`} fill={colour} className={theme.dark}>
      <Paper fill={theme.paper} />
      <Index suit={suit} rank={rank} />
      <g transform="rotate(180 45 63)">
        <Index suit={suit} rank={rank} />
      </g>
      {rank === 1 ? (
        <Pip suit={suit} x={C} y={YM} size={44} />
      ) : rank > 10 ? (
        <Court suit={suit} rank={rank} colour={colour} tint={theme.tint?.[red ? 0 : 1]} />
      ) : (
        SPOTS[rank]!.map(([x, y], i) => <Pip key={i} suit={suit} x={x} y={y} size={18} flip={y > YM} />)
      )}
    </svg>
  );
});
