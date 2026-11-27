// Your cards, to look at and choose: every back, lying in a loose spread as if dealt out, shown in whichever of the
// colours you like; or (for your own cards) every deck of faces as a fanned hand, the other of the two named small
// beside the one shown. Opened over whatever is on
// screen from a card: the one beside your name in a table's lobby, the one beside a bot's there (whoever deals: that
// bot's), or the card that stands for your backs (`YourBacks`: on the first page and in your settings).
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { createPortal } from 'react-dom';
import { CARD_BACKS, type Back } from '../shared/protocol';
import { BackShelf } from './BackShelf';
import { BACKS, backOf } from './cards/Face';
import { useDismiss } from './dismiss';
import { FaceShelf, Night } from './FaceShelf';
import { calm, setPrefs, usePrefs } from './prefs';

const PANELS = { backs: 'Backs', faces: 'Faces' } as const;
type Panel = keyof typeof PANELS;

/**
 * `colour`: the colour the backs are first shown in (whoever's they are: theirs at the table). `faces`: your own cards
 * are being chosen, so the faces can be shown in place of the backs. `onBare`: whether these backs can go without their white edge.
 */
export function BackPicker({ title, colour, bare, back, random, onPick, onRandom, onBare, onClose, faces }: { faces?: boolean; title: string; colour: string; bare: boolean; back: Back; random: string | null; onPick: (back: Back) => void; onRandom: (scope: string | null) => void; onBare?: (bare: boolean) => void; onClose: () => void }) {
  const [ink, setInk] = useState(() => Math.max(0, (BACKS as readonly string[]).indexOf(colour)));
  const [panel, setPanel] = useState<Panel>('backs');
  /** The one shown first and large; the other after it, small, to be pressed. */
  const order: Panel[] = !faces ? ['backs'] : panel === 'backs' ? ['backs', 'faces'] : ['faces', 'backs'];
  useEffect(() => {
    const key = (e: KeyboardEvent): void => void (e.key === 'Escape' && onClose());
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [onClose]);
  // (Put straight into the page, not into the sheet it was opened from: the lobby's lies at a slight angle, and anything inside it would lie at that angle too and be placed by it, not by the window.)
  return createPortal(
    <div className="picker" role="dialog" aria-modal="true" aria-label={title}>
      <div className="showroom">
        <header>
          <button type="button" className="back-to" aria-label="Back" data-tip="Back" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M14.5 5.5L8 12l6.5 6.5" />
            </svg>
          </button>
          <h1>{title}</h1>
          {/* A back drawn by lot for a table, from all of them: up here, apart from how the backs are shown below. (From one kind only: the first card of that kind's spread.) */}
          <button type="button" className={`edge${random === 'all' ? ' on' : ''}`} aria-pressed={random === 'all'} data-tip="Any back at all, drawn by lot when a table's first round is dealt, and kept for that table" onClick={() => onRandom(random === 'all' ? null : 'all')}>
            <span className="lever" />
            Random back
          </button>
        </header>
        <section>
          <div className="heading">
            <div className="panels" role="tablist">
              {order.map((p) => (
                <motion.button key={p} layout transition={calm() ? { duration: 0 } : { type: 'spring', bounce: 0.15, duration: 0.4 }} type="button" role="tab" aria-selected={p === panel} className={p === panel ? 'on' : ''} onClick={() => setPanel(p)}>
                  {PANELS[p]}
                </motion.button>
              ))}
            </div>
            {panel === 'backs' ? (
              <>
                {onBare && (
                  <button type="button" className={`edge${bare ? ' on' : ''}`} aria-pressed={bare} data-tip="Backs without the white edge: the pattern runs to the edge of the card" onClick={() => onBare(!bare)}>
                    <span className="lever" />
                    Borderless
                  </button>
                )}
                <Inks ink={ink} onInk={setInk} />
              </>
            ) : (
              <Night />
            )}
          </div>
          {panel === 'backs' ? <BackShelf colour={BACKS[ink]!} bare={bare} back={back} random={random} onPick={onPick} onRandom={onRandom} /> : <FaceShelf />}
        </section>
      </div>
    </div>,
    document.body,
  );
}

/** Every colour as a slice of one counter: what the colours are chosen from where there is no room for a row of them. */
const PIE = `conic-gradient(${BACKS.map((c, i) => `${c} ${(i / BACKS.length) * 360}deg ${((i + 1) / BACKS.length) * 360}deg`).join(', ')})`;

/**
 * The colour the backs are shown in: a counter of each. On a phone they are behind one counter of all the colours
 * (the one shown now in its middle), and come out under it when it is pressed; put away again by choosing one, by
 * pressing anywhere else, or by Escape.
 */
function Inks({ ink, onInk }: { ink: number; onInk: (ink: number) => void }) {
  const [open, setOpen] = useState(false);
  const here = useRef<HTMLDivElement>(null);
  useDismiss(here, open, () => setOpen(false));
  return (
    <div ref={here} className={`inks${open ? ' open' : ''}`}>
      <button type="button" className="pie" aria-label="Show the backs in another colour" aria-expanded={open} style={{ background: PIE, color: BACKS[ink] }} onClick={() => setOpen(!open)} />
      <div className="counters" role="radiogroup" aria-label="Show the backs in this colour">
        {BACKS.map((c, i) => (
          <button key={c} type="button" role="radio" aria-checked={i === ink} aria-label={`Colour ${i + 1}`} className={i === ink ? 'on' : ''} style={{ background: c }} onClick={() => (onInk(i), setOpen(false))} />
        ))}
      </div>
    </div>
  );
}
/** The sheet for your own backs (and faces): what is picked is yours, at every table. */
export function YourBackPicker({ colour, onClose }: { colour: string; onClose: () => void }) {
  const prefs = usePrefs();
  return <BackPicker faces title="Deck style" colour={colour} bare={prefs.bare} back={prefs.back} random={prefs.random} onPick={(back) => setPrefs({ back, random: null })} onRandom={(random) => setPrefs({ random })} onBare={(bare) => setPrefs({ bare })} onClose={onClose} />;
}

/** Your usual backs, as a card to press: a picture of what you have (a question mark, for a back by lot) and, unless only the card is wanted (`compact`), its name; pressed, the sheet of backs to choose another. */
export function YourBacks({ colour, compact }: { colour: string; compact?: boolean }) {
  const prefs = usePrefs();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`mybacks${compact ? ' compact' : ''}`} aria-label="Choose your card backs" data-tip="Your card backs: change them" onClick={() => setOpen(true)}>
        <span className="mini">
          <span {...backOf(colour, prefs.random ? null : prefs.back, prefs.bare, true)} />
        </span>
        {!compact && (
          <span className="what">
            <b>{prefs.random ? (prefs.random === 'all' ? 'Random back' : `Random: ${prefs.random}`) : CARD_BACKS[prefs.back]}</b>
            <small>Change</small>
          </span>
        )}
      </button>
      {open && <YourBackPicker colour={colour} onClose={() => setOpen(false)} />}
    </>
  );
}
