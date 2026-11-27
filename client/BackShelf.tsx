// The backs to choose among, as they are shown wherever one is chosen (the page of your cards, BackPicker, opened
// from a card in a table's lobby): each kind a fan of its first few cards, the rest fading off behind them, and the kind that is picked up dealt out under the
// row, first a card with a question mark on it (any one of that kind, drawn by lot when a table's first round is dealt), then every
// back of the kind with its small rendition tucked against it.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import { backGroups, CARD_BACKS, type Back } from '../shared/protocol';
import { backArt, backOf } from './cards/Face';
import { calm } from './prefs';
import { gatherIn, layOut } from './sound';

/** How each card of a spread lies: a few degrees off square. */
const LIE = [-3, 2, -1.5, 3, -2.5, 1, -1, 2.5];
/** How many cards a kind is shown by: the first three fanned out in full, two more fading away behind them (there are more where those came from). */
const FAN = 5;
/**
 * How many cards of a kind are dealt one at a time: past that, the rest leave the pile together, as one stack going down
 * at one speed, and each stops at its own place (the upper rows first) while the rest go on. (Infinity: every card one at
 * a time.)
 */
const SINGLY = Infinity;
/** How long a spread shown without a pile being picked up (the shelf as it first shows) takes to fade in. */
const SHOW_MS = 280;

/** A card as it lies, from the corner of a pile (as `lying` measures it). */
type Pose = Omit<Fanned, 'back'>;
/** An easing: a cubic Bézier's control points. */
type Curve = readonly [number, number, number, number];
/** Off the pile: lifted gently (a phone can lose the first frames of a deal while it draws the cards, and a card that had gone a long way in them would seem to start below the pile), then down and eased onto its place. */
const LIFT: Curve = [0.45, 0, 0.2, 1];
/** Up a place in the fan. */
const SLIDE: Curve = [0.42, 0, 0.58, 1];
/**
 * How a pile's cards go, in ms: how far apart they leave; how long each takes to its place; how long the fan takes to
 * move them up a place (no longer than `gap`: each is in the top card's place as the one before it has left); and how
 * long the one going furthest of the rest (past SINGLY) takes.
 */
type Pace = { gap: number; fly: number; shift: number; spread: number };
/** The pace everything is set by: each way of going is this, so many times as fast. */
const PACE: Pace = { gap: 80, fly: 700, shift: 70, spread: 820 };
const faster = (by: number): Pace => ({ gap: PACE.gap / by, fly: PACE.fly / by, shift: PACE.shift / by, spread: PACE.spread / by });
/** Dealt out; put back (the same ways, backwards, and quicker). */
const DEAL_SPEED = 1.5;
const STOW_SPEED = 3;
const DEAL = faster(DEAL_SPEED);
const STOW = faster(STOW_SPEED);
/** How long the card by lot takes to come in, from when the first card is down (and to go, as they are put back). */
const LOT_MS = 220;
/** A point on a card's way: when (ms), where (a place in the fan, counted from its top card; or its own place in the spread), and how it went there from the point before. */
type Step = { t: number; at: number | 'down'; by?: Curve };

/**
 * The way the `j`th card to leave a pile goes as the pile is dealt out. It lies at its place in the fan (or past the
 * fan's end, unseen, if it is not in it); moves up a place as each card before it leaves, so that every card leaves from
 * the top card's place; and goes from there to its own place. Past SINGLY, the rest go into the top card's place
 * together as the last of the first few leaves, and leave from it together (`far`: how far this one goes, as a share of
 * the furthest of them, which takes the longest).
 */
function way(j: number, pace: Pace, far: number): Step[] {
  const steps: Step[] = [{ t: 0, at: j }];
  const up = (m: number, to: number) => {
    const shift = Math.min(pace.shift, pace.gap);
    const t = (m + 1) * pace.gap - shift; // (there as the next one leaves)
    steps.push({ t, at: steps.at(-1)!.at }, { t: t + shift, at: to, by: SLIDE });
  };
  for (let m = 0; m < Math.min(j, SINGLY - 1); m++) up(m, j - m - 1);
  if (j >= SINGLY) up(SINGLY - 1, 0);
  const leave = Math.min(j, SINGLY) * pace.gap;
  steps.push({ t: leave, at: 0 }, { t: leave + (j < SINGLY ? pace.fly : Math.max(pace.fly / 2, pace.spread * far)), at: 'down', by: LIFT });
  return steps.filter((step, i) => i === 0 || step.t > steps[i - 1]!.t);
}

/** The same way backwards, finishing at `end` (ms): each part of it gone the other way, under the easing turned round. */
function backwards(steps: Step[], end: number): Step[] {
  const turn = (c?: Curve): Curve | undefined => c && [1 - c[2], 1 - c[3], 1 - c[0], 1 - c[1]];
  const back = [...steps].reverse().map((step, i, all) => ({ t: end - step.t, at: step.at, by: i ? turn(all[i - 1]!.by) : undefined }));
  return back[0]!.t > 0 ? [{ t: 0, at: back[0]!.at }, ...back] : back;
}

/** A card's way as keyframes, for a card whose own place is `down` (`fan`: the places in the fan; `zoom`: how far down the card is zoomed). */
function frames(steps: Step[], fan: Pose[], down: Pose, zoom: number): Keyframe[] {
  const end = steps.at(-1)!.t;
  return steps.map((step, i) => {
    const pose = step.at === 'down' ? null : (fan[step.at] ?? { ...fan.at(-1)!, opacity: 0 });
    const next = steps[i + 1]?.by;
    return {
      offset: step.t / end,
      transform: pose ? `translate(${(pose.x - down.x) / zoom}px, ${(pose.y - down.y) / zoom}px) rotate(${pose.turn}deg) scale(${pose.width / down.width})` : `translate(0px, 0px) rotate(${down.turn}deg) scale(1)`,
      opacity: pose ? pose.opacity : 1,
      easing: next ? `cubic-bezier(${next.join(', ')})` : 'linear',
    };
  });
}

/** A spread's backs in the order they leave the pile: its fan's, top card first, then the rest as they lie in the spread. (Not the card by lot: it is no card of the pile's, and comes in where it lies as the first of them is put down.) */
function queue(lays: HTMLElement[], fanned: readonly Back[]): HTMLElement[] {
  const backs = lays.filter((lay) => lay.dataset.back);
  const first = fanned.map((b) => backs.find((lay) => lay.dataset.back === b)).filter((lay) => !!lay);
  return [...first, ...backs.filter((lay) => !first.includes(lay))];
}

/** The card itself of a card in the spread (not its small rendition). */
const cardOf = (lay: HTMLElement): HTMLElement => lay.querySelector<HTMLElement>(':scope > .mini:not(.small)')!;

/** Where the cards of a pile's fan lie, top card first (`top`: its backs, top card first). */
function fanned(pile: HTMLElement, top: readonly Back[]): Fanned[] {
  const corner = pile.getBoundingClientRect();
  const minis = [...pile.querySelectorAll<HTMLElement>('.stack .mini')];
  return top.flatMap((back) => {
    const mini = minis.find((m) => m.dataset.back === back);
    return mini ? [{ back, ...lying(mini, corner) }] : [];
  });
}

/**
 * Every animation a pile's cards are dealt out by (or put back by, `stow`), all on one clock (`end` long): each card
 * along its way, and with it, what goes with its not being down yet (its name and small rendition hidden, no gold square
 * round it, drawn over the cards that are, and not under the pointer: a card going by under it, or lying in the pile's
 * place as the pile is pressed, would be taken as pointed at, and turn as one does once it is down). Once a card is down it is let go (the rest of the clock is an end delay
 * that does nothing), so that a card at rest is only the page's: under the pointer, picked, as it always is. Put back,
 * each waits (a delay) for its turn. So any of it, at any moment, played backwards, is the same deal going back.
 */
function ways(order: HTMLElement[], fan: Pose[], corner: DOMRect, pace: Pace, stow: boolean) {
  const downs = order.map((lay) => lying(cardOf(lay), corner));
  const reach = downs.map((d) => Math.hypot(fan[0]!.x - d.x, fan[0]!.y - d.y));
  const furthest = Math.max(1, ...reach.slice(SINGLY));
  const steps = order.map((_, j) => way(j, pace, reach[j]! / furthest));
  const end = Math.max(...steps.map((s) => s.at(-1)!.t));
  const parts = order.flatMap((lay, j) => {
    const card = cardOf(lay);
    const down = steps[j]!.at(-1)!.t;
    const path = stow ? backwards(steps[j]!, down) : steps[j]!;
    const timing: EffectTiming = stow ? { duration: down, delay: end - down, fill: 'forwards' } : { duration: down, endDelay: end - down };
    const away = (value: Keyframe): Keyframe[] => [value, value];
    return [
      { el: card, frames: frames(path, fan, downs[j]!, downs[j]!.width / card.offsetWidth), timing },
      { el: lay, frames: away({ zIndex: String(order.length - j), borderColor: 'transparent', pointerEvents: 'none' }), timing },
      ...[...lay.children].filter((part) => part !== card).map((part) => ({ el: part, frames: away({ opacity: 0 }), timing })),
    ];
  });
  /** When the first card is down. */
  const first = Math.min(...steps.map((way) => way.at(-1)!.t));
  return { parts, end, first };
}

/**
 * `go`, two frames on (and a way to call it off). The frame a set of cards' animations is set up in is a heavy one, and
 * a phone that counted their time from then would lose the start of them in it: the cards would seem to jump. Until then
 * they are held as they are.
 */
function twoFramesOn(go: () => void): () => void {
  let frame = requestAnimationFrame(() => (frame = requestAnimationFrame(go)));
  return () => cancelAnimationFrame(frame);
}

/** How long an animation has still to run, at the rate it runs at (backwards: back to its start). */
function left(run: Animation): number {
  const at = Number(run.currentTime ?? 0);
  const end = Number(run.effect?.getComputedTiming().endTime ?? 0);
  return (run.playbackRate < 0 ? at : end - at) / Math.abs(run.playbackRate || 1);
}

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
  /** The few cards a pile is shown by, top card first: its first, as they lie in its spread (so that dealt out, they go down in order; the chosen one is not put on top). */
  const fanOf = (group: (typeof groups)[number]): Back[] => group.backs.slice(0, FAN);
  const dealt = useRef<HTMLDivElement>(null);
  const shelf = useRef<HTMLDivElement>(null);
  /** While the cards dealt out are being gathered back into their pile (a press meanwhile does nothing). */
  const gathering = useRef(false);
  /** The deal of the spread shown, if it was dealt: its pile's fan as it was (top card first), each card's way out, and how to stop what is still to come of it (its start, its sounds). */
  const dealing = useRef<{ fanned: Back[]; runs: Animation[]; stop: () => void } | null>(null);
  /**
   * The cards dealt out go back into their pile (any still on their way first put down): each the way it came, backwards
   * and quickly, so that the few its fan is shown by end up where they lie in it, and the rest past its end, unseen.
   * Then `then`, which puts the pile back (and deals another, if one was pressed): its own fan is there at once, in
   * their place.
   */
  function gather(then: () => void) {
    const spread = dealt.current;
    const pile = shelf.current?.querySelector<HTMLElement>('.pile.open');
    if (gathering.current) return;
    if (!spread || !pile || !shown || calm()) return then();
    gathering.current = true;
    const lays = [...spread.children] as HTMLElement[];
    const minis = [...pile.querySelectorAll<HTMLElement>('.stack .mini')];
    for (const mini of minis) mini.style.transition = 'none';
    // (The card by lot goes where it lies, from however far it had come in.)
    const lots = lays.filter((lay) => !lay.dataset.back).map((lay) => {
      const seen = getComputedStyle(lay).opacity;
      lay.getAnimations().forEach((run) => run.cancel());
      return lay.animate([{ opacity: seen }, { opacity: 0 }], { duration: LOT_MS / 2, fill: 'forwards' });
    });
    const deal = dealing.current;
    let runs: Animation[];
    if (deal && deal.fanned.join() === fanOf(shown).join()) {
      // Dealt out, and its fan as it was: the deal itself, backwards, from wherever it has got to. (Not started yet,
      // the cards are all still where they lie in the fan, and there is nothing to go back.)
      deal.stop();
      const started = deal.runs.some((run) => Number(run.currentTime) > 0);
      runs = started ? [...deal.runs] : [];
      for (const run of runs) {
        run.pause();
        run.effect?.updateTiming({ fill: 'backwards' }); // (held at its place in the fan, back at its start, until the fan is back; let go, down, until its turn)
        run.playbackRate = -STOW_SPEED / DEAL_SPEED;
      }
    } else {
      // Not dealt out (the spread the shelf first shows), or (should a pile's fan ever change while it is open) not from it:
      // each card's way worked out afresh, and gone backwards. (Where the fan's cards lie once the pile is put back:
      // measured with it put back for a moment, unseen, nothing moving.)
      for (const lay of lays) if (lay.dataset.back) lay.getAnimations({ subtree: true }).forEach((run) => run.cancel()); // (the card's, and its name's and the rest)
      pile.classList.remove('open');
      const shut = fanned(pile, fanOf(shown));
      pile.classList.add('open');
      const { parts } = ways(queue(lays, fanOf(shown)), shut, pile.getBoundingClientRect(), STOW, true);
      runs = parts.map(({ el, frames, timing }) => el.animate(frames, timing));
      runs.forEach((run) => run.pause());
    }
    runs.push(...lots);
    twoFramesOn(() => {
      runs.forEach((run) => run.play());
      gatherIn(Math.max(0, ...runs.map(left)) / 1000);
    });
    Promise.all(runs.map((run) => run.finished)).then(
      () => {
        gathering.current = false;
        flushSync(then); // (the pile's fan in the same frame as the cards that came back to it go)
        requestAnimationFrame(() => requestAnimationFrame(() => minis.forEach((mini) => (mini.style.transition = ''))));
      },
      () => {
        gathering.current = false;
        minis.forEach((mini) => (mini.style.transition = ''));
      },
    );
  }
  /** The fan of the pile just picked up, as it lay (measured before it closes up), for its cards to go from there. */
  const fan = useRef<{ pile: HTMLElement; cards: Fanned[] } | null>(null);
  // Dealt out from its pile: every card of the kind goes from the pile to its place in the spread, one after another (a big
  // kind: its first few, then the rest together), in
  // the order they lie (measured, since where the pile and each place are depends on the width and how the row wraps).
  // Every card leaves from the top card's place, the fan moving up a place as each goes (see `way`). Only the cards move: each
  // one's name and small rendition wait, hidden, until it is down (on the same clock as the cards: see `ways`).
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
    // (The deal starts two frames on: until then the cards are held where they lay in the pile, in place of the pile's
    // own, so that nothing blinks.)
    const fanBacks = from.cards.map((c) => c.back);
    const order = queue(lays, fanBacks);
    const { parts, first } = ways(order, from.cards, pile, DEAL, false);
    const runs = parts.map(({ el, frames, timing }) => el.animate(frames, timing));
    // (The card by lot is no card of the pile's: it comes in where it lies, as the first of them is put down.)
    const lots = lays.filter((lay) => !lay.dataset.back).map((lay) => lay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: LOT_MS, delay: first, fill: 'backwards' }));
    [...runs, ...lots].forEach((run) => run.pause());
    let hush = () => {};
    const deal = () => {
      [...runs, ...lots].forEach((run) => run.play());
      const taps = layOut(Math.min(order.length, SINGLY), DEAL.gap / 1000, DEAL.fly / 2000);
      const rest = order.length > SINGLY ? layOut(4, 0.07, (SINGLY * DEAL.gap + DEAL.spread / 2) / 1000) : () => {}; // (the rest, landing about together)
      hush = () => (taps(), rest());
    };
    const unstart = twoFramesOn(deal);
    dealing.current = { fanned: fanBacks, runs, stop: () => (unstart(), hush()) };
    return () => {
      dealing.current = null;
      unstart();
      [...runs, ...lots].forEach((run) => run.cancel());
    };
  }, [shown?.name]);
  // (Every back's pictures decoded ahead, once the shelf itself is drawn.)
  useEffect(() => {
    const t = setTimeout(() => decodeAhead(groups.flatMap((g) => g.backs.flatMap((b) => [backArt(b, bare)?.src, backArt(b, bare, true)?.src])).filter((src): src is string => !!src)), 300);
    return () => clearTimeout(t);
  }, [bare]);
  return (
    <>
      <div ref={shelf} className="shelf" style={{ '--piles': groups.length } as CSSProperties}>
        {groups.map((group) => {
          const holds = random ? random === group.name : group.backs.includes(back);
          const top = fanOf(group);
          return (
            <button key={group.name} type="button" className={`pile${open === group.name ? ' open' : ''}${holds ? ' holds' : ''}`} aria-expanded={open === group.name} onClick={(e) => {
                const pressed = e.currentTarget;
                gather(() => {
                  if (open !== group.name) {
                    if (calm()) layOut(); // (dealt out, the sound goes with the cards)
                    fan.current = { pile: pressed, cards: fanned(pressed, top) };
                  }
                  setOpen(open === group.name ? null : group.name);
                });
              }}>
              <span className="stack">
                {top
                  .map((b, i) => (
                    <span key={b} className="mini" data-back={b} style={{ '--k': i } as CSSProperties}>
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
            <button key={b} type="button" data-back={b} className={`lay${!random && back === b ? ' on' : ''}`} style={{ '--lie': `${LIE[i % LIE.length]}deg` } as CSSProperties} aria-pressed={!random && back === b} onClick={() => onPick(b)}>
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
