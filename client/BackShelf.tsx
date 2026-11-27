// The backs to choose among, as they are shown wherever one is chosen (the page of your cards, BackPicker, opened
// from a card in a table's lobby): each kind a fan of its first few cards, the rest fading off behind them, and the kind that is picked up dealt out under the
// row, first a card with a question mark on it (any one of that kind, drawn by lot when a table's first round is dealt), then every
// back of the kind with its small rendition tucked against it.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { backGroups, CARD_BACKS, type Back } from '../shared/protocol';
import { backArt, backOf } from './cards/Face';
import { calm } from './prefs';
import { layOut } from './sound';

/** How each card of a spread lies: a few degrees off square. */
const LIE = [-3, 2, -1.5, 3, -2.5, 1, -1, 2.5];
/** How many cards a kind is shown by: the first three fanned out in full, two more fading away behind them (there are more where those came from). */
const FAN = 5;
/** How long each card takes to go from the pile to its place in the spread; how long after one card the next leaves, and the most the whole deal takes (a big kind is dealt quicker). */
const FLY_MS = 520;
const GAP_MS = 60;
const DEAL_MS = 1300;
/** How long a spread shown without a pile being picked up (the shelf as it first shows) takes to fade in. */
const SHOW_MS = 280;

/** Every back's pictures, decoded ahead and kept (so they stay decoded): a kind dealt out has them ready, rather than two dozen being decoded in the frames its cards fly in. */
const decoded = new Map<string, HTMLImageElement>();
function decodeAhead(srcs: string[]) {
  for (const src of srcs) {
    if (decoded.has(src)) continue;
    const img = new Image();
    img.src = src;
    decoded.set(src, img);
    img.decode().catch(() => {});
  }
}

/** Where a card of a pile's fan lay as the pile was picked up: its middle (from the pile's corner), its width and turn, and how far it had faded. */
type Fanned = { back: Back; x: number; y: number; width: number; turn: number; opacity: number };

/**
 * `back` is the one chosen (shown as chosen unless `random` is set); `random` the lot chosen in its place: 'all', or
 * the name of a kind. `colour` and `bare` are how the backs are drawn here.
 */
export function BackShelf({ colour, bare, back, random, onPick, onRandom }: { colour: string; bare: boolean; back: Back; random: string | null; onPick: (back: Back) => void; onRandom: (scope: string | null) => void }) {
  const groups = backGroups();
  /** The kind of back that is dealt out (one at a time; none, if its pile was put back): to begin with, the one the choice is in. */
  const [open, setOpen] = useState<string | null>(() => (groups.find((g) => (random && random !== 'all' ? g.name === random : g.backs.includes(back))) ?? groups[0]!).name);
  const shown = groups.find((g) => g.name === open);
  const dealt = useRef<HTMLDivElement>(null);
  /** The fan of the pile just picked up, as it lay (measured before it closes up), for its cards to go from there. */
  const fan = useRef<{ pile: HTMLElement; cards: Fanned[] } | null>(null);
  // Dealt out from its pile: every card of the kind goes from the pile to its place in the spread, one after another, in
  // the order they lie (measured, since where the pile and each place are depends on the width and how the row wraps).
  // The cards of the pile's fan go from where they lay in it; the rest come off its top card. Only the cards move: each
  // one's name and small rendition wait, hidden, until it is down (a class taken off, not one more animation).
  useLayoutEffect(() => {
    const from = fan.current;
    fan.current = null;
    const spread = dealt.current;
    if (!shown || !spread || calm()) return;
    const pile = from?.pile.getBoundingClientRect();
    const top = from?.cards[0];
    if (!pile || !top) {
      const run = spread.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SHOW_MS, easing: 'ease-out' });
      return () => run.cancel();
    }
    const lays = [...spread.children] as HTMLElement[];
    const gap = Math.min(GAP_MS, (DEAL_MS - FLY_MS) / Math.max(1, lays.length - 1));
    const runs: Animation[] = [];
    // (The deal starts two frames on. The frame the spread is first drawn in is a heavy one, and a phone that counts an
    // animation from when it was made would lose the start of every card's flight in it: the cards would seem to jump.
    // Until then the cards are not shown.)
    spread.classList.add('waiting');
    for (const lay of lays) lay.classList.add('coming');
    const deal = () => {
      spread.classList.remove('waiting');
      lays.forEach((lay, i) => {
        const mini = lay.firstElementChild as HTMLElement | null;
        if (!mini) return;
        const card = from.cards.find((c) => lays[shown.backs.indexOf(c.back) + 1] === lay);
        const start = card ?? { ...top, opacity: 0 };
        const at = lying(mini, pile);
        const zoom = at.width / mini.offsetWidth; // (a card that is zoomed down is moved in its own smaller pixels)
        const run = mini.animate(
          [
            { transform: `translate(${(start.x - at.x) / zoom}px, ${(start.y - at.y) / zoom}px) rotate(${start.turn}deg) scale(${start.width / at.width})`, opacity: start.opacity },
            { opacity: 1, offset: 0.15 },
            { transform: `translate(0px, 0px) rotate(${at.turn}deg) scale(1)`, opacity: 1 },
          ],
          { duration: FLY_MS, delay: i * gap, easing: 'cubic-bezier(0.25, 0.8, 0.3, 1)', fill: 'backwards' },
        );
        run.onfinish = () => lay.classList.remove('coming');
        runs.push(run);
      });
      layOut(lays.length, gap / 1000, FLY_MS / 2000);
    };
    let frame = requestAnimationFrame(() => (frame = requestAnimationFrame(deal)));
    return () => {
      cancelAnimationFrame(frame);
      runs.forEach((run) => run.cancel());
      spread.classList.remove('waiting');
      for (const lay of lays) lay.classList.remove('coming');
    };
  }, [shown?.name]);
  // (Every back's pictures decoded ahead, once the shelf itself is drawn.)
  useEffect(() => {
    const t = setTimeout(() => decodeAhead(groups.flatMap((g) => g.backs.flatMap((b) => [backArt(b, bare)?.src, backArt(b, bare, true)?.src])).filter((src): src is string => !!src)), 300);
    return () => clearTimeout(t);
  }, [bare]);
  return (
    <>
      <div className="shelf" style={{ '--piles': groups.length } as CSSProperties}>
        {groups.map((group) => {
          const holds = random ? random === group.name : group.backs.includes(back);
          /** The few cards the pile is shown by, top card first: the chosen one, if it is in this pile. */
          const top = [...(holds && !random ? [back] : []), ...group.backs.filter((b) => random || b !== back)].slice(0, FAN);
          return (
            <button key={group.name} type="button" className={`pile${open === group.name ? ' open' : ''}${holds ? ' holds' : ''}`} aria-expanded={open === group.name} onClick={(e) => {
                if (open !== group.name) {
                  if (calm()) layOut(); // (dealt out, the sound goes with the cards)
                  const pile = e.currentTarget.getBoundingClientRect();
                  const minis = [...e.currentTarget.querySelectorAll<HTMLElement>('.stack .mini')].reverse(); // (drawn bottom card first)
                  fan.current = { pile: e.currentTarget, cards: minis.map((mini, i) => ({ back: top[i]!, ...lying(mini, pile) })) };
                }
                setOpen(open === group.name ? null : group.name);
              }}>
              <span className="stack">
                {top
                  .map((b, i) => (
                    <span key={b} className="mini" style={{ '--k': i } as CSSProperties}>
                      <span {...backOf(colour, b, bare)} />
                    </span>
                  ))
                  .reverse()}
              </span>
              <b>{group.name}</b>
              <i>{group.backs.length}</i>
            </button>
          );
        })}
      </div>
      {shown && (
        <div key={shown.name} ref={dealt} className="dealt" style={{ '--at': groups.indexOf(shown), '--piles': groups.length } as CSSProperties}>
          {/* First in every spread: any one of this kind, drawn by lot for a table, when its first round is dealt. */}
          <button type="button" className={`lay lot${random === shown.name ? ' on' : ''}`} style={{ '--lie': '-2deg' } as CSSProperties} aria-pressed={random === shown.name} data-tip={`One of ${shown.name}, drawn by lot when a table's first round is dealt, and kept for that table`} onClick={() => onRandom(random === shown.name ? null : shown.name)}>
            <span className="mini">
              <span {...backOf(colour, null, bare)} />
            </span>
            <em>Random</em>
          </button>
          {shown.backs.map((b, i) => (
            <button key={b} type="button" className={`lay${!random && back === b ? ' on' : ''}`} style={{ '--lie': `${LIE[i % LIE.length]}deg` } as CSSProperties} aria-pressed={!random && back === b} onClick={() => onPick(b)}>
              <span className="mini">
                <span {...backOf(colour, b, bare)} />
              </span>
              <span className="mini small">
                <span {...backOf(colour, b, bare, true)} />
              </span>
              <em>{CARD_BACKS[b]}</em>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** How many degrees an element is turned by its transform. */
function turnOf(el: Element) {
  const m = new DOMMatrix(getComputedStyle(el).transform);
  return (Math.atan2(m.b, m.a) * 180) / Math.PI;
}

/** Where a card lies, from the corner of a pile: what is seen of it is turned, so its width is had from the box round it and its turn. */
function lying(mini: HTMLElement, pile: DOMRect): Omit<Fanned, 'back'> {
  const box = mini.getBoundingClientRect();
  const turn = turnOf(mini);
  const [cos, sin] = [Math.abs(Math.cos((turn * Math.PI) / 180)), Math.abs(Math.sin((turn * Math.PI) / 180))];
  return { x: box.x + box.width / 2 - pile.x, y: box.y + box.height / 2 - pile.y, width: box.width / (cos + (sin * mini.offsetHeight) / mini.offsetWidth), turn, opacity: parseFloat(getComputedStyle(mini).opacity) };
}
