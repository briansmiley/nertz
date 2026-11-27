// The decks of faces to choose among, on the page of your cards (BackPicker): every deck as a fanned hand, light or
// dark, with the whole deck behind "See all 52". Each is shown with its small rendition too: what other players' piles are drawn with.
import { Fragment, useState, type CSSProperties } from 'react';
import { DECKS, type Deck } from '../shared/protocol';
import type { Suit } from '../shared/types';
import { Face } from './cards/Face';
import { setPrefs, usePrefs } from './prefs';
import { riffle } from './sound';

const SUITS: Suit[] = ['S', 'H', 'C', 'D'];
const RANKS = Array.from({ length: 13 }, (_, i) => i + 1);
/** The hand a deck is shown by: an Ace, pip cards, and the court cards last, the King on top where the whole of him shows. */
const HAND: [Suit, number][] = [['S', 1], ['D', 2], ['H', 7], ['S', 10], ['D', 11], ['C', 12], ['H', 13]];

function Card({ deck, night, suit, rank, mini }: { deck: Deck; night: boolean; suit: Suit; rank: number; mini: boolean }) {
  return (
    <span className={`mini${mini ? ' small' : ''}`}>
      <span className="front">
        <Face suit={suit} rank={rank} mini={mini} deck={deck} night={night} />
      </span>
    </span>
  );
}

/** Light or dark cards: two counters, as the backs have for their colour. (Beside the faces' heading.) */
export function Night() {
  const prefs = usePrefs();
  return (
    <div className="inks" role="radiogroup" aria-label="Light or dark cards">
      {([false, true] as const).map((night) => (
        <button key={String(night)} type="button" role="radio" aria-checked={prefs.night === night} aria-label={night ? 'Dark cards' : 'Light cards'} data-tip={night ? 'Dark cards' : 'Light cards'} className={prefs.night === night ? 'on' : ''} style={{ background: night ? '#1b2132' : '#fffdf7' }} onClick={() => setPrefs({ night })} />
      ))}
    </div>
  );
}

export function FaceShelf() {
  const prefs = usePrefs();
  /** The deck whose 52 cards are laid out, if any: one at a time, across the whole page, the other decks faded. */
  const [all, setAll] = useState<Deck | null>(null);
  return (
    <>
      <div className={`decks${all ? ' one' : ''}`}>
        {(Object.keys(DECKS) as Deck[]).map((deck) => (
          <Fragment key={deck}>
            <article className={`${prefs.deck === deck ? 'on' : ''}${all === deck ? ' open' : ''}`}>
              <button type="button" className="fan" aria-pressed={prefs.deck === deck} aria-label={`Use the ${DECKS[deck]} deck`} onClick={() => setPrefs({ deck })} onPointerEnter={(e) => e.pointerType === 'mouse' && riffle()}>
                {HAND.map(([suit, rank], i) => (
                  <span key={i} className="leaf" style={{ '--i': i - (HAND.length - 1) / 2 } as CSSProperties}>
                    <Card deck={deck} night={prefs.night} suit={suit} rank={rank} mini={false} />
                  </span>
                ))}
              </button>
              <div className="about">
                {/* (Yours has a gold square round its name and small cards: the fan is too ragged a shape to frame.) */}
                <div className="pick">
                  <h3>{DECKS[deck]}</h3>
                  <div className="smalls">
                    {HAND.map(([suit, rank], i) => (
                      <Card key={i} deck={deck} night={prefs.night} suit={suit} rank={rank} mini />
                    ))}
                  </div>
                </div>
                <button type="button" className="more" aria-expanded={all === deck} onClick={() => setAll(all === deck ? null : deck)}>
                  {all === deck ? 'Put them away' : 'See all 52'}
                </button>
              </div>
            </article>
            {/* Laid out under the row its deck is in, across the whole page: the decks themselves stay where they are. */}
            {all === deck && <div className="all">{SUITS.flatMap((suit) => RANKS.map((rank) => <Card key={`${suit}${rank}`} deck={deck} night={prefs.night} suit={suit} rank={rank} mini={false} />))}</div>}
          </Fragment>
        ))}
      </div>
    </>
  );
}
