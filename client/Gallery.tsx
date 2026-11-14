// The cards there are to choose, laid out on the cloth to look at (/?decks): every back, lying in a loose spread as
// if dealt out, shown in whichever of the six colours you like; then every deck of faces as a fanned hand, light or
// dark, with the whole deck behind "See all 52". Each is shown with its small rendition too: what other players'
// piles are drawn with. What is picked here is your own: everyone at your table sees your cards so.
import { Fragment, useState, type CSSProperties } from 'react';
import { DECKS, type Deck } from '../shared/protocol';
import { BackShelf } from './BackShelf';
import type { Suit } from '../shared/types';
import { BACKS, Face } from './cards/Face';
import { setPrefs, usePrefs } from './prefs';
import { riffle } from './sound';

const SUITS: Suit[] = ['S', 'H', 'C', 'D'];
const RANKS = Array.from({ length: 13 }, (_, i) => i + 1);
/** The hand a deck is shown by: an Ace, pip cards, and the court cards last, the King on top where the whole of him shows. */
const HAND: [Suit, number][] = [['S', 1], ['D', 2], ['H', 7], ['S', 10], ['D', 11], ['C', 12], ['H', 13]];

function Card({ deck, suit, rank, mini }: { deck: string; suit: Suit; rank: number; mini: boolean }) {
  return (
    <span className={`mini${mini ? ' small' : ''}`}>
      <span className="front">
        <Face suit={suit} rank={rank} mini={mini} deck={deck} />
      </span>
    </span>
  );
}

export function Gallery() {
  const prefs = usePrefs();
  const [ink, setInk] = useState(0);
  /** The deck whose 52 cards are laid out, if any: one at a time, across the whole page, the other decks faded. */
  const [all, setAll] = useState<Deck | null>(null);
  const colour = BACKS[ink]!;
  /** A deck as it is shown here: light or dark, as you have yours. */
  const faces = (deck: Deck): string => `${deck}${prefs.night ? ':night' : ''}`;
  return (
    <main className="showroom">
      <header>
        <a className="back-to" href="/" aria-label="Back to the game" title="Back to the game">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14.5 5.5L8 12l6.5 6.5" />
          </svg>
        </a>
        <h1>Deck Style</h1>
        {/* A back drawn by lot for a table, from all of them: up here, apart from how the backs are shown below. (From one kind only: the first card of that kind's spread.) */}
        <button type="button" className={`edge${prefs.random === 'all' ? ' on' : ''}`} aria-pressed={prefs.random === 'all'} title="Any back at all, drawn by lot when a table's first round is dealt, and kept for that table" onClick={() => setPrefs({ random: prefs.random === 'all' ? null : 'all' })}>
          <span className="lever" />
          Random back
        </button>
      </header>

      <section>
        <div className="heading">
          <h2>Backs</h2>
          {/* With or without the white edge: yours, like the back itself. */}
          <button type="button" className={`edge${prefs.bare ? ' on' : ''}`} aria-pressed={prefs.bare} title="Backs without the white edge: the pattern runs to the edge of the card" onClick={() => setPrefs({ bare: !prefs.bare })}>
            <span className="lever" />
            Borderless
          </button>
          <div className="inks" role="radiogroup" aria-label="Show the backs in this colour">
            {BACKS.map((c, i) => (
              <button key={c} type="button" role="radio" aria-checked={i === ink} aria-label={`Colour ${i + 1}`} className={i === ink ? 'on' : ''} style={{ background: c }} onClick={() => setInk(i)} />
            ))}
          </div>
        </div>
        <BackShelf colour={colour} bare={prefs.bare} back={prefs.back} random={prefs.random} onPick={(back) => setPrefs({ back, random: null })} onRandom={(random) => setPrefs({ random })} />
      </section>

      <section>
        <div className="heading">
          <h2>Faces</h2>
          {/* Light or dark cards: two counters, as the backs have for their colour. */}
          <div className="inks" role="radiogroup" aria-label="Light or dark cards">
            {([false, true] as const).map((night) => (
              <button key={String(night)} type="button" role="radio" aria-checked={prefs.night === night} aria-label={night ? 'Dark cards' : 'Light cards'} title={night ? 'Dark cards' : 'Light cards'} className={prefs.night === night ? 'on' : ''} style={{ background: night ? '#1b2132' : '#fffdf7' }} onClick={() => setPrefs({ night })} />
            ))}
          </div>
        </div>
        <div className={`decks${all ? ' one' : ''}`}>
          {(Object.keys(DECKS) as Deck[]).map((deck) => (
            <Fragment key={deck}>
              <article className={`${prefs.deck === deck ? 'on' : ''}${all === deck ? ' open' : ''}`}>
                <button type="button" className="fan" aria-pressed={prefs.deck === deck} aria-label={`Use the ${DECKS[deck]} deck`} onClick={() => setPrefs({ deck })} onPointerEnter={(e) => e.pointerType === 'mouse' && riffle()}>
                  {HAND.map(([suit, rank], i) => (
                    <span key={i} className="leaf" style={{ '--i': i - (HAND.length - 1) / 2 } as CSSProperties}>
                      <Card deck={faces(deck)} suit={suit} rank={rank} mini={false} />
                    </span>
                  ))}
                </button>
                <div className="about">
                  {/* (Yours has a gold square round its name and small cards: the fan is too ragged a shape to frame.) */}
                  <div className="pick">
                    <h3>{DECKS[deck]}</h3>
                    <div className="smalls">
                      {HAND.map(([suit, rank], i) => (
                        <Card key={i} deck={faces(deck)} suit={suit} rank={rank} mini />
                      ))}
                    </div>
                  </div>
                  <button type="button" className="more" aria-expanded={all === deck} onClick={() => setAll(all === deck ? null : deck)}>
                    {all === deck ? 'Put them away' : 'See all 52'}
                  </button>
                </div>
              </article>
              {/* Laid out under the row its deck is in, across the whole page: the decks themselves stay where they are. */}
              {all === deck && <div className="all">{SUITS.flatMap((suit) => RANKS.map((rank) => <Card key={`${suit}${rank}`} deck={faces(deck)} suit={suit} rank={rank} mini={false} />))}</div>}
            </Fragment>
          ))}
        </div>
      </section>
    </main>
  );
}
