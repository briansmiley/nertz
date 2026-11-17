// The hand fanned out on the home page: six backs, one in each of the first six seat colours, and the ace of spades on
// top. A back pressed is turned over, and lands as another back of its colour, drawn by chance (never the one it was).
import { useAnimate } from 'motion/react';
import { useRef, useState, type CSSProperties } from 'react';
import { anotherBack, type Back } from '../shared/protocol';
import { backArt, backColour, backOf, Face } from './cards/Face';
import { calm, usePrefs } from './prefs';
import { deal } from './sound';

/** (Six, as the fan was drawn: the table seats ten now, the picture does not have to.) */
const CARDS = 6;
/** Each half of the turn: edge-on, then down again. */
const HALF = 0.16;

/** Once the picture of `back` is in (or has failed, or taken too long), so that a card turned over never lands blank. */
function loaded(back: Back): Promise<unknown> {
  const art = backArt(back, true);
  if (!art) return Promise.resolve();
  const img = new Image();
  img.src = art.src;
  return Promise.race([img.decode().catch(() => {}), new Promise((done) => setTimeout(done, 600))]);
}

/** One back of the hand: what it shows, and its turn over when pressed. A press while it turns is let go. */
function Card({ seat }: { seat: number }) {
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
  return (
    <div className="spread" aria-hidden="true">
      {Array.from({ length: CARDS }, (_, seat) => (
        <Card key={seat} seat={seat} />
      ))}
      <span className="mini" style={{ '--i': CARDS } as CSSProperties}>
        <span className="front">
          <Face suit="S" rank={1} mini={false} deck={deck} night={night} />
        </span>
      </span>
    </div>
  );
}
