// Every deck there is to choose (shared/protocol.ts `DECKS`), laid out to look at: each card's full face, and the
// large-print rendition that small cards (other players' piles) are drawn with. Opened at /?decks.
import { CARD_BACKS, DECKS, type Back, type Deck } from '../shared/protocol';
import type { CSSProperties } from 'react';
import type { Suit } from '../shared/types';
import { BACKS, Face } from './cards/Face';
import { setPrefs, usePrefs } from './prefs';

const SUITS: Suit[] = ['S', 'H', 'C', 'D'];
const RANKS = Array.from({ length: 13 }, (_, i) => i + 1);

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
  return (
    <main className="gallery">
      <h1>
        <a className="back-to" href="/" aria-label="Back to the game" title="Back to the game">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14.5 5.5L8 12l6.5 6.5" />
          </svg>
        </a>
        Decks
      </h1>
      {(Object.keys(CARD_BACKS) as Back[]).map((back) => (
        <section key={back}>
          <h2>
            {CARD_BACKS[back]} backs{' '}
            <button type="button" disabled={prefs.back === back} onClick={() => setPrefs({ back })}>
              {prefs.back === back ? 'Your backs' : 'Use these backs'}
            </button>
          </h2>
          <div className="row">
            {BACKS.map((colour) => (
              <span key={colour} className="mini">
                <span className={`back${back === 'plain' ? '' : ` ${back}`}`} style={{ '--back': colour } as CSSProperties} />
              </span>
            ))}
            {BACKS.map((colour) => (
              <span key={colour} className="mini small">
                <span className={`back${back === 'plain' ? '' : ` ${back}`}`} style={{ '--back': colour } as CSSProperties} />
              </span>
            ))}
          </div>
        </section>
      ))}
      {(Object.keys(DECKS) as Deck[]).map((deck) => (
        <section key={deck}>
          <h2>
            {DECKS[deck]}{' '}
            <button type="button" disabled={prefs.deck === deck} onClick={() => setPrefs({ deck })}>
              {prefs.deck === deck ? 'Your deck' : 'Use this deck'}
            </button>
          </h2>
          {SUITS.map((suit) => (
            <div key={suit} className="row">
              {RANKS.map((rank) => (
                <Card key={rank} deck={deck} suit={suit} rank={rank} mini={false} />
              ))}
            </div>
          ))}
          <h3>Small cards</h3>
          {SUITS.map((suit) => (
            <div key={suit} className="row">
              {RANKS.map((rank) => (
                <Card key={rank} deck={deck} suit={suit} rank={rank} mini />
              ))}
            </div>
          ))}
        </section>
      ))}
    </main>
  );
}
