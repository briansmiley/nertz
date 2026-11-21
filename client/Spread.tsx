// The hand fanned out on the home page: six backs, one in each of the first six seat colours, and the ace of spades on
// top. A back pressed is turned over, and lands as another back of its colour, drawn by chance (never the one it was).
// The ace pressed twice turns them all, one after another from the red, like a spread of cards flipped down the table.
import { useAnimate } from 'motion/react';
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { anotherBack, type Back } from '../shared/protocol';
import { backArt, backColour, backOf, Face } from './cards/Face';
import { calm, usePrefs } from './prefs';
import { deal } from './sound';

/** (Six, as the fan was drawn: the table seats ten now, the picture does not have to.) */
const CARDS = 6;
/** Each half of the turn: edge-on, then down again. */
const HALF = 0.22;
/** How long after one card of the wave starts turning the next one does (ms). */
const STAGGER = 90;
/** Two presses of the ace this close together are a double press (ms): timed by hand, as a phone's double tap is not a dblclick. */
const DOUBLE = 350;

/** Once the picture of `back` is in (or has failed, or taken too long), so that a card turned over never lands blank. */
function loaded(back: Back): Promise<unknown> {
  const art = backArt(back, true);
  if (!art) return Promise.resolve();
  const img = new Image();
  img.src = art.src;
  return Promise.race([img.decode().catch(() => {}), new Promise((done) => setTimeout(done, 600))]);
}

/** One back of the hand: what it shows, and its turn over when pressed or when a wave reaches it. A press while it turns is
 *  let go. */
function Card({ seat, wave }: { seat: number; wave: number }) {
  const [back, setBack] = useState<Back>('plain');
  const [scope, animate] = useAnimate<HTMLSpanElement>();
  const turning = useRef(false);

  const turn = async () => {
    if (turning.current) return;
    const next = anotherBack(back);
    deal();
    turning.current = true;
    const still = calm(); // reduced motion: the new back, without the turn
    try {
      await Promise.all([loaded(next), still || animate(scope.current, { rotateY: 90 }, { duration: HALF, ease: 'easeIn' })]);
      setBack(next);
      if (!still && scope.current) await animate(scope.current, { rotateY: [-90, 0] }, { duration: HALF, ease: 'easeOut' });
    } catch {
      setBack(next); // (a turn cut short, e.g. the page left mid-turn: the card still lands as its new back)
    } finally {
      turning.current = false;
    }
  };

  const latest = useRef(turn);
  latest.current = turn;
  useEffect(() => {
    if (!wave) return;
    const t = setTimeout(() => latest.current(), calm() ? 0 : seat * STAGGER); // reduced motion: all at once, no wave
    return () => clearTimeout(t);
  }, [wave, seat]);

  return (
    <span className="mini" style={{ '--i': seat } as CSSProperties} onClick={turn}>
      <span ref={scope} className="turn">
        <span {...backOf(backColour(seat), back, true)} />
      </span>
    </span>
  );
}

export function Spread() {
  const { deck, night } = usePrefs(); // a card shown for its own sake is one of yours
  const [wave, setWave] = useState(0);
  const pressed = useRef(0);
  const press = (e: PointerEvent) => {
    if (e.timeStamp - pressed.current < DOUBLE) {
      pressed.current = 0;
      setWave((n) => n + 1);
    } else pressed.current = e.timeStamp;
  };
  return (
    <div className="spread" aria-hidden="true">
      {Array.from({ length: CARDS }, (_, seat) => (
        <Card key={seat} seat={seat} wave={wave} />
      ))}
      <span className="mini" style={{ '--i': CARDS } as CSSProperties} onPointerUp={press}>
        <span className="front">
          <Face suit="S" rank={1} mini={false} deck={deck} night={night} />
        </span>
      </span>
    </div>
  );
}
