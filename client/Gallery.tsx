// The cards there are to choose, laid out on the cloth to look at (/?decks): every back, lying in a loose spread as
// if dealt out, shown in whichever of the six colours you like; then every deck of faces as a fanned hand, with the
// whole deck behind "all 52". Each is shown with its small rendition too: what other players' piles are drawn with.
// What is picked here is your own deck: everyone at your table sees your cards so.
import { useState } from 'react';
import { CARD_BACKS, DECKS, type Back, type Deck } from '../shared/protocol';
import type { Suit } from '../shared/types';
import { BACKS, backOf, Face } from './cards/Face';
import { setPrefs, usePrefs } from './prefs';

const SUITS: Suit[] = ['S', 'H', 'C', 'D'];
const RANKS = Array.from({ length: 13 }, (_, i) => i + 1);
/** The hand a deck is shown by: an Ace, the three court cards, and pip cards of every suit. */
const HAND: [Suit, number][] = [['S', 1], ['H', 13], ['C', 12], ['D', 11], ['S', 10], ['H', 7], ['D', 2]];
/** How each card of a spread lies: a few degrees off square, up or down a little. */
const LIE = [-3, 2, -1.5, 3, -2.5, 1, -1, 2.5];

function Card({ deck, suit, rank, mini }: { deck: Deck; suit: Suit; rank: number; mini: boolean }) {
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
  const colour = BACKS[ink]!;
  return (
    <main className="showroom">
      <header>
        <a className="back-to" href="/" aria-label="Back to the game" title="Back to the game">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14.5 5.5L8 12l6.5 6.5" />
          </svg>
        </a>
        <h1>Your cards</h1>
      </header>

      <section>
        <div className="heading">
          <h2>Backs</h2>
          <div className="inks" role="radiogroup" aria-label="Show the backs in this colour">
            {BACKS.map((c, i) => (
              <button key={c} type="button" role="radio" aria-checked={i === ink} aria-label={`Colour ${i + 1}`} className={i === ink ? 'on' : ''} style={{ background: c }} onClick={() => setInk(i)} />
            ))}
          </div>
        </div>
        <div className="dealt">
          {(Object.keys(CARD_BACKS) as Back[]).map((back, i) => (
            <button key={back} type="button" className={`lay${prefs.back === back ? ' on' : ''}`} style={{ '--lie': `${LIE[i % LIE.length]}deg` } as React.CSSProperties} aria-pressed={prefs.back === back} onClick={() => setPrefs({ back })}>
              <span className="mini">
                <span {...backOf(colour, back)} />
              </span>
              <span className="mini small">
                <span {...backOf(colour, back, true)} />
              </span>
              <em>{CARD_BACKS[back]}</em>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="heading">
          <h2>Faces</h2>
        </div>
        {(Object.keys(DECKS) as Deck[]).map((deck) => (
          <article key={deck} className={prefs.deck === deck ? 'on' : ''}>
            <button type="button" className="fan" aria-pressed={prefs.deck === deck} aria-label={`Use the ${DECKS[deck]} deck`} onClick={() => setPrefs({ deck })}>
              {HAND.map(([suit, rank], i) => (
                <span key={i} className="leaf" style={{ '--i': i - (HAND.length - 1) / 2 } as React.CSSProperties}>
                  <Card deck={deck} suit={suit} rank={rank} mini={false} />
                </span>
              ))}
            </button>
            <div className="about">
              <h3>{DECKS[deck]}</h3>
              <div className="smalls">
                {HAND.map(([suit, rank], i) => (
                  <Card key={i} deck={deck} suit={suit} rank={rank} mini />
                ))}
              </div>
              <details>
                <summary>All 52</summary>
                {SUITS.map((suit) => (
                  <div key={suit} className="row">
                    {RANKS.map((rank) => (
                      <Card key={rank} deck={deck} suit={suit} rank={rank} mini={false} />
                    ))}
                  </div>
                ))}
              </details>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
