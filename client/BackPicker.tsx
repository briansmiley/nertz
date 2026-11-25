// The backs to choose among, in a sheet over whatever is on screen: the same piles as on the page of cards
// (BackShelf), in one colour; over them, the choice of any back at all by lot, and of backs without their white
// edge. Opened from a card: the one beside your name in a table's lobby, the one beside a bot's there (whoever deals:
// that bot's), or the card that stands for your backs (`YourBacks`: on the first page and in your settings).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CARD_BACKS, type Back } from '../shared/protocol';
import { BackShelf } from './BackShelf';
import { backOf } from './cards/Face';
import { FaceShelf } from './FaceShelf';
import { setPrefs, usePrefs } from './prefs';

/** `faces`: your own cards are being chosen, so the sheet has a second panel, for the faces (as the page of cards has). */
export function BackPicker({ title, colour, bare, back, random, onPick, onRandom, onBare, onClose, faces }: { faces?: boolean; title: string; colour: string; bare: boolean; back: Back; random: string | null; onPick: (back: Back) => void; onRandom: (scope: string | null) => void; onBare?: (bare: boolean) => void; onClose: () => void }) {
  const [panel, setPanel] = useState<'backs' | 'faces'>('backs');
  useEffect(() => {
    const key = (e: KeyboardEvent): void => void (e.key === 'Escape' && onClose());
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [onClose]);
  // (Put straight into the page, not into the sheet it was opened from: the lobby's lies at a slight angle, and anything inside it would lie at that angle too and be placed by it, not by the window.)
  return createPortal(
    <div className="picker" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet showroom">
        <div className="heading">
          <h2>{title}</h2>
          {faces && (
            <div className="panels" role="tablist">
              <button type="button" role="tab" aria-selected={panel === 'backs'} className={panel === 'backs' ? 'on' : ''} onClick={() => setPanel('backs')}>
                Backs
              </button>
              <button type="button" role="tab" aria-selected={panel === 'faces'} className={panel === 'faces' ? 'on' : ''} onClick={() => setPanel('faces')}>
                Faces
              </button>
            </div>
          )}
          {panel === 'backs' && onBare && (
            <button type="button" className={`edge${bare ? ' on' : ''}`} aria-pressed={bare} data-tip="Backs without the white edge: the pattern runs to the edge of the card" onClick={() => onBare(!bare)}>
              <span className="lever" />
              Borderless
            </button>
          )}
          {panel === 'backs' && (
            <button type="button" className={`edge${random === 'all' ? ' on' : ''}`} aria-pressed={random === 'all'} data-tip="Any back at all, drawn by lot when the first round is dealt, and kept for the table" onClick={() => onRandom(random === 'all' ? null : 'all')}>
              <span className="lever" />
              Random
            </button>
          )}
          <button type="button" className="shut" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {panel === 'backs' ? <BackShelf colour={colour} bare={bare} back={back} random={random} onPick={onPick} onRandom={onRandom} /> : <FaceShelf />}
      </div>
    </div>,
    document.body,
  );
}

/** The sheet for your own backs (and faces): what is picked is yours, at every table. */
export function YourBackPicker({ colour, onClose }: { colour: string; onClose: () => void }) {
  const prefs = usePrefs();
  return <BackPicker faces title="Deck style" colour={colour} bare={prefs.bare} back={prefs.back} random={prefs.random} onPick={(back) => (setPrefs({ back, random: null }), onClose())} onRandom={(random) => setPrefs({ random })} onBare={(bare) => setPrefs({ bare })} onClose={onClose} />;
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
