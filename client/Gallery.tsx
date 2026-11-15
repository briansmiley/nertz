// The cards there are to choose, laid out on the cloth to look at (/?decks): every back, lying in a loose spread as
// if dealt out, shown in whichever of the six colours you like; then every deck of faces as a fanned hand, light or
// dark, with the whole deck behind "See all 52". Each is shown with its small rendition too: what other players'
// piles are drawn with. What is picked here is your own: everyone at your table sees your cards so.
import { useEffect, useRef, useState } from 'react';
import { BackShelf } from './BackShelf';
import { BACKS } from './cards/Face';
import { FaceShelf } from './FaceShelf';
import { setPrefs, usePrefs } from './prefs';

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
          <Inks ink={ink} onInk={setInk} />
        </div>
        <BackShelf colour={colour} bare={prefs.bare} back={prefs.back} random={prefs.random} onPick={(back) => setPrefs({ back, random: null })} onRandom={(random) => setPrefs({ random })} />
      </section>

      <FaceShelf />
    </main>
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
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent): void => void (here.current?.contains(e.target as Node) || setOpen(false));
    const key = (e: KeyboardEvent): void => void (e.key === 'Escape' && setOpen(false));
    addEventListener('pointerdown', away);
    addEventListener('keydown', key);
    return () => (removeEventListener('pointerdown', away), removeEventListener('keydown', key));
  }, [open]);
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
