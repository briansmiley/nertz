// The table: every card on one absolutely-positioned layer (see layout.ts),
// plus the hand. All game logic is in shared/engine, and what a press, a move,
// a release or a tap does is decided in hand.ts; this file listens to the
// pointer, sends the intents and moves the card elements.
//
// Other players' cards move here too, while they are still in their hands:
// each dragging client reports where its card is (`drag` messages, about 18 a
// second), and `tick` below glides the very same card element after those
// reports until the snapshot that ends the hold lets it land or go home.
import { animate, motion, useMotionValue, useMotionValueEvent, type MotionValue } from 'motion/react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { beforeStart, calledBy, completedBy, DEAL_MS, GRACE_MS, grab, hasSay, inGrace, isHidden, isLive, reburiedSince, reshuffledSince, wentOut } from '../shared/engine';
import { PLAIN_LOOK, shownBack, type Back, type Deck, type DragAt, type Look } from '../shared/protocol';
import { offFelt, TABLE, type Pt } from '../shared/table';
import type { GameState, PlayerView, RoomView, Suit } from '../shared/types';
import { backColour, backOf, nameColour, CARD_H, CARD_W, Face, warm } from './cards/Face';
import { Finale, finaleSteps, sortings } from './Finale';
import { aloftAt, computeLayout, countBox, inside, COUNTDOWN, countdownTop, DEAL, dealWait, drawnMini, keepOut, MOTION, onCanvas, shapeOf, TAG_H, type Placed, type Rect, type Seat, type Showing, type Stage } from './layout';
import { useFittings } from './fittings';
import { useWindow } from './viewport';
import { nag, send, useClearFirst } from './clearFirst';
import { decide, drawnAt, EMPTY, reporter, sight, type Gesture, type Grasp, type Hand, type Held, type InHand, type Scene } from './hand';
import { inHand, levelOf, mover, moving, whoseOf, IN_PILE, type Doing, type Whose } from './level';
import { Opening } from './Opening';
import { ending, handsAt, stageOf, stepAtMount, unrevealed } from './stage';
import { setUnrevealed } from './social';
import { useFeed } from './feed';
import { Dots } from './Dots';
import { kick, onDrag, onSnipe, pause, playable, post, sit, testing, useNet } from './net';
import { Clock } from './Settings';
import { Chair } from './icons';
import { ballot, canResume, perform, standing } from './actions';
import { useDismiss } from './dismiss';
import { usePicture } from './picture';
import { Name } from './Host';
import { calm, lookOf, seenLook, usePrefs } from './prefs';
import { beaten, hush, sniped as snipeSound, stage as stageSound } from './sound';
import { clamp } from '../shared/numbers';

// Durations are asked for at the moment of use: reduced motion (`calm`, see prefs.ts) can be switched while playing.
const MOVE = () => ({ duration: calm() ? 0 : MOTION.move, ease: 'easeOut' }) as const;
const FLIP = () => ({ duration: calm() ? 0 : MOTION.flip, ease: 'easeInOut' }) as const;
/** Turning the middle face-down at the end of a round is slower: it is a moment, not a move. */
const TURN = () => ({ duration: calm() ? 0 : 0.42, ease: 'easeInOut' }) as const;
/**
 * A card turned up by your own move before its face has come (`unseen`): a soft spring draws it towards EDGE (degrees;
 * 180 is face-down, 90 edge-on), ever slower, its back still showing. When the face comes a stiff spring carries it on
 * from there, at the speed it had; if the move is refused it settles back down.
 */
const EDGE = 100;
const UNSEEN = () => (calm() ? { duration: 0 } : ({ type: 'spring', stiffness: 120, damping: 30 } as const));
const FINISH = () => (calm() ? { duration: 0 } : ({ type: 'spring', stiffness: 500, damping: 45 } as const));
const turnedTo = (face: Showing): number => (face === 'up' ? 0 : face === 'unseen' && !calm() ? EDGE : 180);
/** How a card turns from showing `was` to showing `face`: the one place that is decided. */
const turnOf = (was: Showing, face: Showing, slow: boolean) => (slow ? TURN() : face === 'unseen' ? UNSEEN() : was === 'unseen' && face === 'up' ? FINISH() : FLIP());
/**
 * A card reburied before play (`reburiedSince`) does not cross between the stock and a work pile. It goes from where it
 * lay (`Ghost`) and comes into its new place, each at the level it lies at, so never over the face-up cards: at a work
 * pile sliding `slide` card heights out from behind the pile or in from there, fading as it goes; at the stock, only
 * fading. With reduced motion it only fades.
 */
const REBURY = { slide: 0.2, out: 0.14, in: 0.2 } as const;
const REBURY_OUT = () => ({ duration: REBURY.out, ease: 'easeIn' }) as const;
const REBURY_IN = () => ({ duration: REBURY.in, ease: 'easeOut' }) as const;
/** How long someone else's card takes to cross `far` px of the table. */
const crossing = (far: number) => ({ duration: Math.min(0.45, 0.16 + far / 2400), ease: 'easeInOut' }) as const;
/** How long the mouse has to rest on one of your work piles before it fans out in full: sweeping across them does nothing. */
const PEEK_MS = 380;
/**
 * Which way a reburied card slides at the place `c` (`REBURY`): at a work pile, out from behind it, along the way it
 * fans and away from its face-up cards (from its top card to `c`); at the stock not at all.
 */
function behind(c: Placed, game: GameState, byId: ReadonlyMap<string, Placed>): Pt {
  const top = c.pile === 'work' ? byId.get(game.players.find((p) => p.seat === c.card.owner)?.work[c.at]?.cards.at(-1)?.id ?? '') : undefined;
  if (!top || calm()) return { x: 0, y: 0 };
  const d = REBURY.slide * CARD_H * c.s;
  const len = Math.hypot(c.x - top.x, c.y - top.y);
  return len < 0.5 ? { x: 0, y: -d } : { x: ((c.x - top.x) / len) * d, y: ((c.y - top.y) / len) * d };
}

/** Someone else's card in the air: see-through, so it never hides a pile it passes over. */
const ALOFT = 0.58;
/** Your own card while it is over the felt: the pile underneath shows through. */
const OVER_FELT = 0.74;
/**
 * Someone else's card over the felt is first drawn on its way from their hand, as this window seats them, to the pile
 * it is going to; after this long over the felt (ms; sooner for an Ace, which has no pile to go by) it moves over to
 * where it really is, taking `fade` ms, and stays there while it is over the felt.
 */
const REAL_AFTER = { card: 600, ace: 150, fade: 800 } as const;
/** How quickly another player's card closes on the last place it was reported at (ms to cover about two thirds of the way). */
const GLIDE_MS = 80;
/** A report older than this is not where the card is any more: it stays put until a fresh one comes. */
const STALE_MS = 600;
/** "A", "A and B", "A, B and C". */
const andList = (names: readonly string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// ---------------------------------------------------------------- one card

interface Handle {
  x: MotionValue<number>;
  y: MotionValue<number>;
  s: MotionValue<number>;
  /** Opacity. */
  o: MotionValue<number>;
  /** Tilt, degrees. */
  r: MotionValue<number>;
  /** Into a hand, yours ('held') or someone else's ('carried'), as the `i`th card in it: from here on whoever has it says where it is, not the layout. */
  take(k: 'held' | 'carried', i: number): void;
  /** Out of the hand: animate to wherever the layout currently wants this card. */
  settle(): void;
}

/** A card that is still in the deck when it first appears: where the deck is, how many cards under it are dealt after it, and how long until it is dealt. */
interface Dealt {
  x: number;
  y: number;
  under: number;
  wait: number;
}

/** Lets the drag code move card elements directly, without re-rendering React on every pointer event. */
type Handles = Map<string, Handle>;

interface CardProps {
  id: string;
  owner: number;
  suit: Suit | undefined;
  rank: number | undefined;
  x: number;
  y: number;
  s: number;
  z: number;
  /** Tilt, degrees. */
  rot: number;
  /** Whose the place it lies in is: one of your own piles, someone else's, or the table's. */
  whose: Whose;
  face: Showing;
  /** The faces of the deck this card came from, and whether they are dark: its owner's choice (`Look`). */
  deck: Deck;
  night: boolean;
  /** And its backs: null for a back by lot not drawn yet. */
  back: Back | null;
  bare: boolean;
  slow: boolean;
  /** The pile it lies in. */
  pile: string;
  cls: string;
  handles: Handles;
  /** Whether and when it is dealt is read once, when the card first appears: later snapshots, reconnects and re-renders never deal it again. */
  deal: Dealt | undefined;
  /** Reburied into the place it now lies in (`REBURY`): where it comes in from, off that place, and how far its hand has moved to another place round the table meanwhile (px). */
  rebury: { off: Pt; far: number } | undefined;
}

/** A card's props for how it looks, each a value of its own: a snapshot brings new looks, and a card is drawn again only if its own has changed. */
const drawn = (look: Look): Pick<CardProps, 'deck' | 'night' | 'back' | 'bare'> => ({ deck: look.deck, night: look.night, back: shownBack(look.backs), bare: look.bare });

const CardView = memo(function CardView(p: CardProps) {
  const dealt = useRef(p.deal).current;
  /** What it is doing: in the deck until it is dealt, if it was in one when it first appeared (it is dealt once). */
  const doing = useRef<Doing>(dealt ? { k: 'deck', under: dealt.under, by: p.whose } : IN_PILE);
  const x = useMotionValue(dealt?.x ?? p.x);
  const y = useMotionValue(dealt?.y ?? p.y);
  const s = useMotionValue(p.s);
  const z = useMotionValue(levelOf(p.z, doing.current));
  const r = useMotionValue(p.rot);
  const o = useMotionValue(1);
  const goal = useRef({ x: p.x, y: p.y, s: p.s, z: p.z, rot: p.rot });
  const whose = useRef(p.whose);
  const pile = useRef(p.pile);
  const flight = useRef(0);
  const faceWas = useRef(p.face);
  /**
   * Drawn in large print: by the size it is drawn at right now (`s`), not the size the layout gives it or whose hand it
   * is in (`drawnMini`). React hears of it only when that changes, not on every frame.
   */
  const [mini, setMini] = useState(() => drawnMini(p.s * CARD_W));
  useMotionValueEvent(s, 'change', (v) => setMini((was) => drawnMini(v * CARD_W, was)));
  const el = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  /** When this card leaves the deck (performance clock), if it is in one. */
  const leaves = useRef(dealt ? performance.now() + dealt.wait : 0).current;

  /** The card takes up something else, or the layout has it lie at another level: the one place its level is set. */
  const be = useCallback((d: Doing) => {
    doing.current = d;
    z.set(levelOf(goal.current.z, d));
  }, [z]);

  /** Moves it to where the layout wants it, and has it lie in its pile once it is there. */
  const fly = useCallback((move: { duration: number } = p.slow ? TURN() : MOVE(), veiled = false, passing = false) => {
    const g = goal.current;
    const n = ++flight.current;
    if (veiled) o.set(ALOFT);
    // Somebody else's card crossing the table is not in the pointer's way either (styles/cards.css `.card[data-passing]`).
    if (passing) el.current?.setAttribute('data-passing', '');
    else el.current?.removeAttribute('data-passing');
    animate(x, g.x, move);
    animate(y, g.y, move);
    animate(s, g.s, move);
    // Someone else's card crossing the table comes upright as it leaves their hand, not as it lands: a hand at the
    // side of the table is turned to face it, and a card on its way to the middle is read by whoever is watching.
    animate(r, g.rot, passing ? { ...move, duration: move.duration * 0.3 } : move);
    setTimeout(() => {
      if (flight.current !== n) return;
      be(IN_PILE);
      setMini(drawnMini(s.get() * CARD_W)); // at rest, just what its size says
      o.set(1); // landed: solid again, whatever it was in the air
      el.current?.removeAttribute('data-passing');
    }, move.duration * 1000 + 30);
  }, [x, y, s, r, o, be, p.slow]);

  /**
   * To wherever the layout wants it. Your own cards snap to it. Anyone else's card that has some way to go (a
   * bot's, a click, a lost report, or one let go before it was drawn where it really was) crosses the table at a
   * pace the eye can follow, see-through while it is in the air.
   */
  const go = useCallback((own: boolean) => {
    const g = goal.current;
    const far = Math.hypot(x.get() - g.x, y.get() - g.y);
    if (own || p.slow || calm() || far < 4) fly();
    else fly(crossing(far), far > 2.5 * CARD_W * g.s, true);
  }, [fly, x, y, p.slow]);

  useEffect(() => {
    const was = goal.current;
    const by = mover(whose.current, p.whose);
    const from = pile.current;
    const arrived = first.current;
    first.current = false;
    goal.current = { x: p.x, y: p.y, s: p.s, z: p.z, rot: p.rot };
    whose.current = p.whose;
    pile.current = p.pile;
    if (inHand(doing.current)) return; // settles when it is let go
    if (doing.current.k === 'deck') {
      // If the window was resized it stays with the deck, and is dealt to its new place in its turn.
      if (p.deal) [x, y, s].forEach((v, i) => v.set([p.deal!.x, p.deal!.y, p.s][i]!));
      setMini(drawnMini(s.get() * CARD_W));
      return;
    }
    if (p.rebury && (arrived || from !== p.pile)) {
      // Reburied: into its new place from just behind it, lying in it all the while (it left the old one as a `Ghost`).
      // If its hand is moving to another place round the table, once the hand is there.
      const { off, far } = p.rebury;
      const wait = far < 4 ? 0 : by === 'yours' || calm() ? MOVE().duration : crossing(far).duration;
      flight.current++;
      be(IN_PILE);
      x.set(p.x + off.x);
      y.set(p.y + off.y);
      s.set(p.s);
      r.set(p.rot);
      o.set(0);
      el.current?.removeAttribute('data-passing');
      for (const [v, to] of [[x, p.x], [y, p.y], [o, 1]] as const) animate(v, to, { ...REBURY_IN(), delay: wait });
      return;
    }
    if (was.x === p.x && was.y === p.y && was.s === p.s && was.rot === p.rot) return be(doing.current); // (the level it lies at may be another)
    const on = moving(from, p.pile, by);
    go(by === 'yours');
    // Turning face-up on the way (a group off the stock going over onto the waste): see `levelOf`.
    if (faceWas.current === 'down' && p.face !== 'down' && !calm()) {
      const n = flight.current;
      be({ k: 'turning', by });
      setTimeout(() => flight.current === n && be(on), FLIP().duration * 500);
    } else be(on);
  }, [p.x, p.y, p.s, p.z, p.rot, p.whose, p.pile, p.slow, p.deal?.x, p.deal?.y, go, be, x, y, s]);

  useEffect(() => {
    faceWas.current = p.face; // (after the effect above, which asks what it was)
  }, [p.face]);

  // Its turn to be dealt: out of the deck, to its place in the layout.
  useEffect(() => {
    if (doing.current.k !== 'deck') return;
    const turn = setTimeout(() => {
      be({ k: 'travelling', by: whose.current });
      fly(DEAL);
    }, leaves - performance.now());
    return () => clearTimeout(turn);
  }, [fly, be, leaves]);

  useEffect(() => {
    const take = (k: 'held' | 'carried', i: number) => {
      flight.current++; // whatever flight it was on is over
      be({ k, i });
    };
    const settle = () => {
      // Out of your hand or someone else's: that hand's, on its way to its place.
      const from: Whose = doing.current.k === 'held' ? 'yours' : doing.current.k === 'carried' ? 'theirs' : whose.current;
      be({ k: 'travelling', by: mover(from, whose.current) });
      go(whose.current === 'yours');
    };
    p.handles.set(p.id, { x, y, s, o, r, take, settle });
    return () => void p.handles.delete(p.id);
  }, [p.id, p.handles, x, y, s, o, r, go, be]);

  return (
    <motion.div ref={el} className={p.cls} data-id={p.id} style={{ x, y, scale: s, zIndex: z, '--o': o } as unknown as CSSProperties}>
      <motion.div className="flip" initial={false} style={{ rotate: r }} animate={{ rotateY: turnedTo(p.face) }} transition={turnOf(faceWas.current, p.face, p.slow)}>
        <div className="front">{p.suit && p.rank ? <Face suit={p.suit} rank={p.rank} mini={mini} deck={p.deck} night={p.night} /> : null}</div>
        <div {...backOf(backColour(p.owner), p.back, p.bare, mini)} />
      </motion.div>
    </motion.div>
  );
});

/** Where a reburied card left from (`REBURY`): its back, fading as it slides `off` out from behind its place. Gone when it has. */
const Ghost = memo(function Ghost({ c, off, look, gone }: { c: Placed; off: Pt; look: Look; gone: () => void }) {
  const mini = drawnMini(c.s * CARD_W);
  return (
    <motion.div
      className="card ghost"
      style={{ scale: c.s, zIndex: c.z }}
      initial={{ x: c.x, y: c.y, opacity: 1 }}
      animate={{ x: c.x + off.x, y: c.y + off.y, opacity: 0 }}
      transition={REBURY_OUT()}
      onAnimationComplete={gone}
    >
      <motion.div className="flip" style={{ rotate: c.rot, rotateY: 180 }}>
        <div className="front" />
        <div {...backOf(backColour(c.card.owner), shownBack(look.backs), look.bare, mini)} />
      </motion.div>
    </motion.div>
  );
});

// ---------------------------------------------------------------- end of round

/**
 * Walks the table through the end-of-round sequence once the round is scored (see `stageOf`). `skip` jumps to the sheet.
 */
function useStage(results: boolean, round: number, trayPiles: number, players: number, clear: boolean): [Stage, () => void] {
  const [step, setStep] = useState(() => stepAtMount(results, round));
  const stage = stageOf(results, round, step, calm());
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stop = () => timers.current.splice(0).forEach(clearTimeout);
  useEffect(() => {
    if (!results || step?.round === round) return;
    setStep({ round, stage }); // the first step, as it was drawn: reduced motion switched on now does not cut it short
    if (stage === 'sheet') return;
    timers.current = finaleSteps(trayPiles, players, clear).map(([next, at]) => setTimeout(() => setStep({ round, stage: next }), at));
    return stop;
  }, [results, round]); // the tray cannot change once the round is scored, so `trayPiles` is not a dependency
  return [
    stage,
    () => {
      stop();
      setStep({ round, stage: 'sheet' });
    },
  ];
}

/** Top-right while held cards may still land: a ring that drains over the grace window, and a word or two. */
function Countdown({ ms, text, label, top }: { ms: number; text: string; label: string; top: number }) {
  const [left, setLeft] = useState(ms);
  useEffect(() => {
    const end = performance.now() + ms; // `ms` was what remained when the snapshot was sent
    setLeft(ms);
    const tick = setInterval(() => setLeft(Math.max(0, end - performance.now())), 50);
    return () => clearInterval(tick);
  }, [ms]);
  const round = 2 * Math.PI * 17;
  return (
    <div className="grace" role="timer" aria-label={label} style={{ top, maxWidth: COUNTDOWN.w }}>
      <span>{text}</span>
      <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r="17" />
        <circle cx="22" cy="22" r="17" strokeDasharray={round} strokeDashoffset={round * (1 - left / GRACE_MS)} />
      </svg>
      <b>{Math.ceil(left / 1000)}</b>
    </div>
  );
}

// ---------------------------------------------------------------- the table

/** Another player's card on its way, as this window draws it: the lifted cards, and where the lifted one is now. */
interface Flight {
  id: string;
  ids: string[];
  x: number;
  y: number;
  s: number;
  /** How long it has been over the felt, ms: after a while (`REAL_AFTER`) it is drawn where it really is. */
  over: number;
  ace: boolean;
}

/** What is said across the middle of the felt while a round is played: a snipe you were in, or the table's stocks turned over because everyone was stuck. */
type Said = { k: 'snipe'; by: number; of: number } | { k: 'reshuffle' };

/** A running total, with a real minus sign. */
const points = (n: number) => (n < 0 ? `−${-n}` : `${n}`);
/**
 * How wide the name line of a neighbour whose hand runs down the side may be. It is wider than the turned hand under
 * it, so the line is only as long as what is on it, from the hand's outer edge: nothing on it stands off by itself.
 */
const TAG_SIDE_W = 210;
/** A plain place: just where and how large. */
const box0 = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h });
const box = (r: Rect & { rot?: number }): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: Math.min(r.w, r.h) * 0.08, rotate: r.rot ? `${r.rot}deg` : undefined });

/** Beside a name: the picture they put up, ringed in their colour; or, for none (or one that will not load), their colour's chip. */
function PictureBy({ picture, seat }: { picture: string | undefined; seat: number }) {
  const shown = usePicture(picture);
  if (shown.src) return <img className="face" src={shown.src} alt="" style={{ borderColor: backColour(seat) }} onError={shown.onError} />;
  return <i className="chip" style={{ background: backColour(seat) }} />;
}

/**
 * For whoever deals, someone else's name at the table, in the middle of a round too: pressed, the eye and the × beside
 * it, as on the score sheet. The eye stands them up (their cards lie there for the round, and they watch); the × sends
 * them away.
 */
function Hosting({ who, children }: { who: PlayerView; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  /** The × asks twice: mid-round, sending someone away cannot be taken back. */
  const [sure, setSure] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const shut = () => (setOpen(false), setSure(false));
  useDismiss(root, open, shut);
  return (
    <span className="hosting" ref={root} onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className="who" aria-expanded={open} onClick={() => (open ? shut() : setOpen(true))}>
        {children}
      </button>
      {open && (
        <>
          <button type="button" className="standup" aria-label={`Stand ${who.name} up`} data-tip={`Stand ${who.name} up`} onClick={() => (sit(false, who.id), shut())}>
            <Chair />
          </button>
          <button type="button" className={`unseat${sure ? ' sure' : ''}`} aria-label={`Send ${who.name} away${sure ? '?' : ''}`} data-tip={`Send ${who.name} away${sure ? '?' : ''}`} onClick={() => (sure ? (kick(who.id), shut()) : setSure(true))}>
            ×
          </button>
        </>
      )}
    </span>
  );
}

/**
 * `sheet` (the scores) is laid over the table when the end-of-round sequence has played out. `seats` (the lobby's
 * sheet) is whoever deals', laid over it from the names under Start until they press it: the cards are dealt, nothing
 * is played, and the table can still be seated as in the lobby.
 */
export function Table({ room, sheet, seats }: { room: RoomView; sheet: ReactNode; seats: (close: () => void) => ReactNode }) {
  const game = room.game!;
  const [seating, setSeating] = useState(false);
  const unseat = useCallback(() => setSeating(false), []);
  const unplayed = beforeStart(game);
  const dealer = room.players.find((p) => p.id === room.me)?.isHost === true;
  const seatsOpen = seating && unplayed && dealer;
  useEffect(() => {
    if (!unplayed || !dealer) setSeating(false);
  }, [unplayed, dealer]);
  /** Your seat; or, watching without one, a seat that nobody has. */
  const you = room.seat ?? -1;
  const results = room.phase === 'results';
  const { W, H, pad } = useWindow();
  const prefs = usePrefs();
  // Whatever decks are at the table, as you see them, are fetched before their cards are turned up.
  const decks = room.players.map((p) => seenLook(prefs, p.look).deck);
  useEffect(() => decks.forEach((d) => warm(d)), [decks.join()]);
  /** A phone, upright or on its side: the table is cleared before the end of a round is sorted (`Layout.cleared`). By the height the layout goes by. */
  const clears = shapeOf(W, H - pad.b) !== 'wide';
  const [stage, skip] = useStage(results, room.round, game.tray.length, game.players.length, clears);
  // A click meant for a card must not throw the end of the round away: only Escape skips it, and only on your own screen.
  const playingOut = ending(stage);
  useEffect(() => {
    if (!playingOut) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playingOut]);
  // The chat holds the notice of a round's end back until it is shown here; before the browser paints, so the two come together.
  const yetToShow = unrevealed(stage, room.round);
  useLayoutEffect(() => {
    setUnrevealed(yetToShow);
    return () => setUnrevealed(null);
  }, [yetToShow]);
  const stageWas = useRef(stage);
  useEffect(() => {
    // The riffle of the wash and each player's cards arriving, on the canvas's schedule; the flourish of the score sheet.
    stageSound(stageWas.current, stage, sortings(game, room.lastRound?.scores ?? [], clears));
    stageWas.current = stage;
  }, [stage]);
  useEffect(() => hush, []); // (a table left mid-wash, back to the lobby or sent away, takes its sound with it)
  /** Your work pile that is being looked at (fanned out in full): the mouse rested on it, or it was tapped. */
  const [peek, setPeek] = useState<number | null>(null);
  const peekWait = useRef<{ i: number; t: number } | null>(null);
  useEffect(() => () => void (peekWait.current && clearTimeout(peekWait.current.t)), []);
  // (Everyone at the table has a place round it: whoever is not in the round, an empty one.)
  const seated = room.players.filter((p) => p.seat !== null).map((p) => p.seat).join(); // (those watching have no place at it)
  const sitting = useMemo(() => (seated ? seated.split(',').map(Number) : []), [seated]);
  // The round's hands at the table: once the score sheet is up, only of those still sitting where they played them.
  const kept = handsAt(stage, room).join();
  const hands = useMemo(() => game.players.filter((g) => kept.split(',').includes(`${g.seat}`)), [game, kept]);
  // What stands round the cards (the buttons in the corners, the clock, your name, "I'm stuck" and the vote) is placed
  // by the layout too, and the cards round it: nothing here is measured off the page or put down by hand.
  const fit = useFittings(room);
  const L = useMemo(() => computeLayout(W, H, game, you, stage, peek, pad, sitting, fit, hands), [W, H, game, you, stage, peek, pad, sitting, fit, hands]);
  const byId = useMemo(() => new Map(L.cards.map((c) => [c.card.id, c])), [L]);
  // The table as it was drawn before this game came (the last layout of the game before it), for the cards reburied since (`REBURY`).
  const drawnAs = useRef({ game, byId, before: null as { game: GameState; byId: ReadonlyMap<string, Placed> } | null });
  if (drawnAs.current.game !== game) drawnAs.current = { game, byId, before: { game: drawnAs.current.game, byId: drawnAs.current.byId } };
  else drawnAs.current.byId = byId;
  const before = drawnAs.current.before;
  const reburied = useMemo(() => (before ? reburiedSince(before.game, game) : new Map<string, number>()), [game]);
  /** Where the cards reburied since lay, each going from there as a `Ghost`. (Not in the deal: a card still in the deck went from nowhere anyone sees.) */
  const [ghosts, setGhosts] = useState<{ key: string; c: Placed; off: Pt }[]>([]);
  const ghostN = useRef(0);
  useEffect(() => {
    if (!before || reburied.size === 0 || before.game.status.at === 'dealing') return;
    const gone = [...reburied.keys()].flatMap((id) => {
      const c = before.byId.get(id);
      if (!c) return [];
      // At the level of the bottom of the pile it left, not its own: the face-ups close up over it as it goes, and a
      // card that lay high in the pile (the second of two face-downs) would otherwise go over the one that comes down.
      const pile = before.game.players.flatMap((q) => q.work).find((w) => w.cards.some((x) => x.id === id))?.cards ?? [];
      const z = Math.min(c.z, ...pile.map((x) => before.byId.get(x.id)?.z ?? c.z));
      return [{ key: `${id}:${++ghostN.current}`, c: { ...c, z }, off: behind(c, before.game, before.byId) }];
    });
    if (gone.length) setGhosts((g) => [...g, ...gone]);
  }, [reburied]);
  /** How far the hand at `seat` has moved round the table since `before` (px): by its nertz pile, which nothing reburies. */
  const handMoved = (seat: number): number => {
    const id = game.players.find((p) => p.seat === seat)?.nertz.at(-1)?.id ?? '';
    const [a, b] = [before?.byId.get(id), byId.get(id)];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const ghostGone = useCallback((key: string) => setGhosts((g) => g.filter((x) => x.key !== key)), []);
  const handles = useRef<Handles>(new Map()).current;
  /** What the pointer has hold of: hand.ts decides, `act` below carries it out. */
  const grasp = useRef<Grasp>(EMPTY);
  const [held, setHeld] = useState<Held | null>(null);
  /** The finished pile in hand is over the tray. */
  const [hot, setHot] = useState(false);
  /** What the table says, as it stacks on the felt while it lasts (feed.ts). Across the middle: the snipes you were in, and the reshuffle. Small along its lower edge: the snipes between others. */
  const [said, tell, saidDone] = useFeed<Said>(room.round);
  const [asides, addAside, asideDone] = useFeed<{ by: number; of: number }>(room.round);
  useEffect(
    () =>
      onSnipe(({ by, of }) => {
        if (by === you) snipeSound('me');
        else if (of === you) beaten();
        else snipeSound('other');
        if (by === you || of === you) tell({ k: 'snipe', by, of });
        else addAside({ by, of });
      }),
    [you, tell, addAside],
  );
  // Everyone was stuck and the stocks were turned over, in this round and while this window was looking: the table says so.
  const seen = useRef({ round: room.round, game });
  useEffect(() => {
    const was = seen.current;
    seen.current = { round: room.round, game };
    if (was.round === room.round && reshuffledSince(was.game, game)) tell({ k: 'reshuffle' });
  }, [room.round, game, tell]);
  /** The outline of where the Ace in hand would start its pile. Moved by hand, not by React. */
  const preview = useRef<HTMLDivElement>(null);

  // ---- other players' cards in the air
  /** The cards other players are holding, runs included: see-through, and never in the pointer's way. */
  const aloft = useMemo(() => {
    const ids = new Set<string>();
    for (const p of game.players) if (p.seat !== you && p.holding !== null) for (const c of grab(game, p.seat, p.holding)?.cards ?? []) ids.add(c.id);
    return ids;
  }, [game, you]);
  const now = useRef({ game, L, byId, you, stage });
  now.current = { game, L, byId, you, stage };
  /** The last report from each seat, and when it came. */
  const reports = useRef(new Map<number, DragAt & { at: number }>()).current;
  const flights = useRef(new Map<number, Flight>()).current;
  const loop = useRef({ frame: 0, last: 0 }).current;
  /**
   * One animation frame of everybody else's held cards. A card is drawn on its
   * way from its owner's hand, as this window seats them, to its place on the
   * felt (`aloftAt` in layout.ts): as far along the path out to the felt's
   * edge and on to its pile as its report says (`w`). One with no pile (an Ace
   * on its way to bare felt) stops at the edge, and any card comes over to
   * where it really is while it lingers over the felt. Either way it closes on its
   * place smoothly, so 18 reports a second (or fewer, if some are lost) look
   * like one movement. When the hold ends the card is released from wherever
   * it has got to and the ordinary animation takes it to its pile or home.
   */
  const tick = useRef((time: number) => {
    const { game, L, byId, you, stage } = now.current;
    const dt = Math.min(100, time - loop.last);
    const k = calm() ? 1 : 1 - Math.exp(-dt / GLIDE_MS);
    loop.last = time;
    let waiting = false;
    for (const [seat, f] of flights) {
      if (stage === 'live' && game.players.find((p) => p.seat === seat)?.holding === f.id) continue;
      flights.delete(seat);
      if (reports.get(seat)?.id === f.id) reports.delete(seat);
      for (const id of f.ids) handles.get(id)?.settle();
    }
    for (const p of stage === 'live' ? game.players : []) {
      if (p.seat === you || p.holding === null) continue;
      waiting = true;
      const at = reports.get(p.seat);
      const home = byId.get(p.holding);
      if (!at || at.id !== p.holding || !home) continue;
      let f = flights.get(p.seat);
      if (!f) {
        if (time - at.at > STALE_MS) continue;
        const got = grab(game, p.seat, p.holding)?.cards;
        f = { id: p.holding, ids: got?.map((c) => c.id) ?? [p.holding], x: home.x, y: home.y, s: home.s, over: 0, ace: got?.length === 1 && got[0]!.rank === 1 };
        flights.set(p.seat, f);
      }
      const onFelt = offFelt({ x: at.p[0], y: at.p[1] }, game.players.length) <= 0;
      // Off the felt it runs down rather than starting again: a card held on the felt's edge does not jump back to its line.
      // It counts no further than the fade's end, so taken back off the felt it is on its line again at once (a third of the fade).
      const after = f.ace ? REAL_AFTER.ace : REAL_AFTER.card;
      f.over = onFelt ? Math.min(f.over + dt, after + REAL_AFTER.fade) : Math.max(0, f.over - 3 * dt);
      const t = clamp((f.over - after) / REAL_AFTER.fade, 0, 1);
      const linger = calm() ? 1 : t * t * (3 - 2 * t);
      const a = aloftAt(L, game, { seat: p.seat, ids: f.ids, home, at, linger });
      f.x += (a.x - (a.s * CARD_W) / 2 - f.x) * k;
      f.y += (a.y - (a.s * CARD_H) / 2 - f.y) * k;
      f.s += (a.s - f.s) * k;
      f.ids.forEach((id, i) => {
        const c = byId.get(id);
        const h = handles.get(id);
        if (!c || !h) return;
        h.x.set(f.x + ((c.x - home.x) * f.s) / home.s);
        h.y.set(f.y + ((c.y - home.y) * f.s) / home.s);
        h.s.set(f.s);
        h.take('carried', i);
        h.o.set(ALOFT);
        h.r.set(a.rot);
      });
    }
    loop.frame = waiting || flights.size > 0 ? requestAnimationFrame(tick) : 0;
  }).current;
  const watch = () => {
    if (!loop.frame) loop.frame = requestAnimationFrame(tick);
  };
  useEffect(() => {
    const stop = onDrag((m) => {
      reports.set(m.seat, { ...m, at: performance.now() });
      watch();
    });
    return () => {
      stop();
      cancelAnimationFrame(loop.frame);
      loop.frame = 0;
    };
  }, []);
  useEffect(() => {
    if (aloft.size > 0 || flights.size > 0) watch(); // a snapshot can start a hold, or end one
  });

  const mine = hands.find((p) => p.seat === you);
  /** Nertz has been called: the round is in grace, or over by the call. */
  const called = calledBy(game) !== null;
  /** The round ended by everyone voting to end it. */
  const agreed = game.status.at === 'over' && game.status.end.by === 'vote';
  /** Those who got Nertz: the caller, and anyone else whose nertz pile is empty. */
  const out = wentOut(game);
  // Aid for trying things out (`testing`): Shift+D replays the deal animation in this window only (nothing is sent; the cards are not re-dealt).
  const [replay, setReplay] = useState(0);
  const [replaying, setReplaying] = useState(false);
  const aids = testing(room);
  useEffect(() => {
    if (!aids) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !e.shiftKey || (e.target as Element).closest?.('input,textarea')) return;
      // Shift+N: a bot goes out now (to see and hear it without playing a round through; the server refuses it where `testing` is off).
      if (e.code === 'KeyN') return void post({ t: 'debugBotOut' });
      if (e.code !== 'KeyD') return;
      setReplay((n) => n + 1);
      setReplaying(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [aids]);
  useEffect(() => {
    if (!replaying) return;
    const t = setTimeout(() => setReplaying(false), DEAL_MS);
    return () => clearTimeout(t);
  }, [replay, replaying]);
  const dealing = game.status.at === 'dealing' || replaying;
  /** The round is paused (the card over the table says by whom), and the table is not on its score sheet. */
  const paused = !!room.paused && !results;
  /** The line to the table is up: until it is, the card over a paused table offers nothing (an update: the table is on its way back). */
  const online = useNet().status === 'online';
  /** Nothing can be started: the round is not live (the cards are still being dealt, play has not opened, Nertz has been called, or it is over), or it is paused. (A card already in hand may still land during grace.) */
  const frozen = replaying || !isLive(game) || paused;
  // Nothing stays fanned out once the round stops being played, and no timer outlives the table.
  useEffect(() => {
    if (stage !== 'live' || frozen) setPeek(null);
  }, [stage, frozen]);
  /** Clear-first: with a finished pile of yours waiting, anything but carrying it to the tray is answered with a shake, and the pile then says what it wants (clearFirst.tsx). */
  const must = useClearFirst(room);

  // The deal. Every player's cards start as one deck where their stock lies, and the nertz pile and the work piles
  // are dealt off it one card after another, everyone's at once. `timerMs` says how far along the server is: in a
  // window that arrives late (a reload) the cards already dealt are simply in place and the rest follow on time.
  const dealMs = replaying ? DEAL_MS : room.timerMs;
  const deck = useMemo(() => {
    const plan = new Map<string, Dealt>();
    if (!dealing || dealMs === null || calm()) return plan;
    for (const p of game.players) {
      const hand = p.seat === you ? L.me : L.opponents.find((o) => o.seat === p.seat);
      if (!hand) continue;
      const work = p.work.flatMap((w) => w.cards);
      const out = [...work, ...p.nertz];
      out.forEach((c, i) => {
        const wait = dealWait(i, dealMs, work.length);
        const under = out.length - i; // cards of the deck beneath this one that are also on their way out
        if (wait !== null) plan.set(c.id, { x: hand.stock.x, y: hand.stock.y - under * 0.3 * hand.s, under, wait });
      });
    }
    return plan;
  }, [dealing, dealMs, game.players, L, you]);
  const grace = inGrace(game);
  /** Who paused the round, if it is paused (`Pause`). */
  const pausedBy = room.paused;
  const info = (seat: number) => room.players.find((p) => p.seat === seat);
  /** My own faces and backs: my choice, shown at once; or, if my backs are by lot, the one the table drew for me (it comes with the deal). */
  const chosen = lookOf(prefs);
  const myLook: Look = chosen.backs.k === 'lot' ? { ...chosen, backs: info(you)?.look.backs ?? chosen.backs } : chosen;
  /** This seat's line of the round just scored. The finished table goes by it: whoever played the round may have left since. */
  const line = (seat: number) => (results ? room.lastRound?.scores.find((s) => s.seat === seat) : undefined);
  /**
   * Whose faces and backs the cards from `seat` have: yours, if it is yours; the player's who sits there, as they have them now; but on the
   * finished table, if whoever played the round has left (the seat is empty, or someone else's by now), as they were
   * when the round ended. All as you see them: with your faces or Big print, if you have every card so (`Prefs.faces`).
   */
  const dress = (seat: number): Look => {
    const l = line(seat);
    const p = info(seat);
    return seenLook(prefs, seat === you ? myLook : (p && (!l || p.id === l.id) ? p.look : l?.look) ?? PLAIN_LOOK);
  };
  /** The line the place at `seat` goes by: its hand's, while that is at the table (`hands`); else none, and the place is whoever sits there. */
  const placed = (seat: number) => (hands.some((g) => g.seat === seat) ? line(seat) : undefined);
  const name = (seat: number) => placed(seat)?.name ?? info(seat)?.name ?? `Seat ${seat + 1}`;
  /** The total beside a name. The round's points are not added until the score sheet is up: the wash and the sort reveal them. */
  const total = (seat: number) => {
    const l = placed(seat);
    return l ? l.total - (stage === 'sheet' ? 0 : l.delta) : (info(seat)?.score ?? 0);
  };
  /** The finished pile waiting for you to carry it to the tray. */
  const toClear = (slot: number) => slot === must.slot;
  const finished = (slot: number) => completedBy(game.slots[slot]) !== null;

  /** The table rule for moving a card without dragging it: tap (or click) it, then where it goes. */
  const tapToMove = room.settings.tapToMove;
  const scene: Scene = { game, you, L, byId, live: stage === 'live', playingOut, frozen, tapToMove, waiting: must.slot, plays: playable };

  /** A click on the stock, or Space: one draw (or the waste turned back over). Its group comes in one step and is dealt out here, on the round's clock (net.ts). */
  const dealGroup = useCallback(() => send({ k: 'draw' }), []);
  useEffect(() => {
    if (frozen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      e.preventDefault();
      dealGroup();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [frozen, dealGroup]);

  /** While a finished pile is in hand the tray comes a little way in from the edge to meet it. */
  const trayOpen: Rect = { ...L.tray, x: L.tray.x - L.tray.w * 0.18, w: L.tray.w * 1.18 };
  /** At most DRAG_HZ a second, and never once the hand is open or the table gone. */
  const telling = useMemo(() => reporter((at) => post({ t: 'drag', ...at })), []);
  useEffect(() => telling.stop, [telling]);

  /** After every movement of the hand, and whenever the table changes under it: whether the card lets the middle show through, the report to the others, the tray's outline for a pile, and where an Ace would start one. */
  const aim = (d: InHand) => {
    const see = sight(d, scene);
    for (const id of d.ids) handles.get(id)?.o.set(see.over ? OVER_FELT : 1);
    if (see.report) telling.tell(see.report);
    setHot(see.tray);
    const el = preview.current;
    if (el) {
      el.hidden = !see.felt;
      if (see.felt) Object.assign(el.style, { left: `${see.felt.rect.x}px`, top: `${see.felt.rect.y}px`, width: `${see.felt.rect.w}px`, height: `${see.felt.rect.h}px` });
      el.classList.toggle('no', !see.felt?.ok);
    }
  };

  /** The hand opens: whatever was in it goes to wherever the layout now wants it (its new pile, or back home). */
  const letGo = (d: Hand) => {
    telling.stop();
    for (const id of d.ids) handles.get(id)?.settle();
    if (preview.current) preview.current.hidden = true;
    setHeld(null);
    setHot(false);
  };

  /** Carries out what hand.ts decides about a gesture: what is sent, and the cards taken up, moved with the hand, or let go. */
  const act = (g: Gesture): Hand | null => {
    const was = grasp.current.hand;
    const { effects, ...next } = decide(grasp.current, g, scene);
    grasp.current = next;
    for (const fx of effects) {
      if (fx.k === 'send') send(fx.intent);
      else if (fx.k === 'tried') post({ t: 'tried', card: fx.card, seen: fx.seen });
      else if (fx.k === 'deal') dealGroup();
      else if (fx.k === 'nag') nag();
      else {
        // On a touch screen a tap on one of your work piles fans it out in full, and another tap (anywhere) closes it.
        const i = columnAt(fx.x, fx.y);
        setPeek(i === peek ? null : i);
      }
    }
    const d = next.hand;
    if (d === was) return d;
    if (d && d.phase !== 'pressed') {
      if (!was || was.phase === 'pressed') {
        stopPeek();
        setHeld(d.held);
      }
      d.ids.forEach((id, i) => {
        const h = handles.get(id);
        const at = drawnAt(d, i);
        h?.x.set(at.x);
        h?.y.set(at.y);
        h?.take('held', i);
        if (d.held.k === 'card') h?.s.set(d.s);
      });
      if (d.phase === 'carried') aim(d);
    } else if (was && was.phase !== 'pressed') letGo(was);
    return d;
  };

  // The server can take a card out of your hand (hand.ts, 'table'): then the drag is over and the card goes home.
  useEffect(() => void act({ k: 'table' }));
  useEffect(() => {
    if (!held) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') act({ k: 'escape' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [held]);
  // The table can change under a hand that is holding still: someone starts a pile right where your Ace was about
  // to go. What the outline says is worked out again there and then, not only when the hand next moves.
  useEffect(() => {
    const d = grasp.current.hand;
    if (d && d.phase !== 'pressed') aim(d);
  }, [game, L]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const el = (e.target as Element).closest('[data-id],[data-stock]');
    const id = el?.getAttribute('data-id');
    const d = act({ k: 'down', pointer: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse', main: e.button === 0, on: !el ? null : id ? { card: id } : 'stock' });
    if (d?.phase === 'pressed' && d.pointer === e.pointerId) e.currentTarget.setPointerCapture(e.pointerId);
  };

  /** Which of your work piles is at (x, y): its column, and while it is fanned out in full, all of it. */
  const columnAt = (x: number, y: number): number | null => {
    const hits = L.me?.workHit ?? [];
    for (const [i, r] of hits.entries()) {
      let area = r;
      if (i === peek) {
        const top = Math.min(r.y, ...L.cards.filter((c) => c.mine && c.pile === 'work' && c.x >= r.x && c.x <= r.x + r.w).map((c) => c.y));
        area = { ...r, y: top, h: r.y + r.h - top };
      }
      if (inside(area, x, y)) return i;
    }
    return null;
  };
  const stopPeek = () => {
    if (peekWait.current) clearTimeout(peekWait.current.t);
    peekWait.current = null;
    setPeek(null);
  };
  /** The mouse moved with nothing held: a pile it rests on fans out after a moment; off it, it closes at once. */
  const hover = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || frozen || stage !== 'live') return;
    const i = columnAt(e.clientX, e.clientY);
    if (i === peek) {
      if (peekWait.current) clearTimeout(peekWait.current.t);
      peekWait.current = null;
      return;
    }
    if (peek !== null) setPeek(null);
    if (i === null) return void (peekWait.current && (clearTimeout(peekWait.current.t), (peekWait.current = null)));
    if (peekWait.current?.i === i) return;
    if (peekWait.current) clearTimeout(peekWait.current.t);
    peekWait.current = { i, t: window.setTimeout(() => ((peekWait.current = null), setPeek(i)), PEEK_MS) };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = grasp.current.hand;
    if (!d || d.phase === 'pressed') hover(e);
    act({ k: 'move', pointer: e.pointerId, x: e.clientX, y: e.clientY });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => void act({ k: 'up', pointer: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse' });
  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => void act({ k: 'cancel', pointer: e.pointerId });

  const cardClass = (c: Placed): string => {
    let cls = dealing && calm() ? 'card dealt' : 'card';
    if (c.pile !== 'slot' && c.pile !== 'tray') cls += ' hand';
    if (c.pile === 'slot' && finished(c.at)) cls += toClear(c.at) ? ` grab${must.cls}` : stage === 'live' ? ' done' : '';
    if (aloft.has(c.card.id)) cls += ' aloft';
    if (c.mine && !frozen && !must.blocked) {
      if (c.pile === 'stock') cls += ' tap';
      else if (c.face === 'up') cls += ' grab';
    }
    return cls;
  };

  const me = L.me;
  const say = new Set(room.players.filter(hasSay).map((p) => p.seat));
  const active = game.players.filter((p) => say.has(p.seat));
  const waitingOn = active.filter((p) => !p.stuck).length;
  /** The vote to end the round: stands at the table once the round drags on, or once anyone has voted (the same vote as in the table's menu). */
  const vote = ballot(room);
  /** You have stood up from your cards for now (actions.ts `standing`): as good as away, until you sit back down. */
  const up = !!standing(room);
  /** Your own line, where the layout has room for it: in full under your nertz pile, or as one line. (Cut short, your name gives way, never your total.) */
  const mineLine = L.name && (
    <div className={`mine ${L.name.full ? 'full' : 'line'} ${L.name.align}`} style={{ left: L.name.x, top: L.name.y, width: L.name.w, height: L.name.h }}>
      <span className="who">
        <PictureBy picture={info(you)?.picture} seat={you} />
        <span className="name">{name(you)}</span>
        <b>{points(total(you))}</b>
      </span>
      <span className="where">
        Round {room.round} at table {room.code}
      </span>
    </div>
  );
  const pill = L.pills ? ' pill' : '';
  // The NERTZ! stamp comes down on the place each nertz pile that went out stood (now empty), not across the whole hand:
  // large enough to read at any seat, and kept inside the window.
  const stamps = out.flatMap((seat) => {
    const pile = seat === you ? me?.nertz : L.opponents.find((o) => o.seat === seat)?.nertz;
    if (!pile || !hands.some((g) => g.seat === seat)) return []; // (not on a place whose hand has gone from the table)
    const size = Math.max(22, Math.min(pile.w * 0.78, 60));
    return [{ seat, size, x: clamp(pile.x + pile.w / 2 - size * 2, 4, Math.max(4, W - size * 4 - 4)), y: pile.y, w: size * 4, h: pile.h }];
  });
  const finale = onCanvas(stage, 'slot');
  /** A phone, upright or on its side: the table is cleared for the end of a round (`Layout.cleared`). */
  const phone = L.shape !== 'wide';
  /** An Ace is in hand. */
  const placing = held?.k === 'card' && held.ace;

  /** How many cards a hand's nertz pile has, on the pile (`Seat.count`), kept inside the window. */
  const count = (s: Seat) => {
    const at = countBox(s.count, W, H, pad); // (as the layout kept clear of it)
    return (
      <b className="count" style={{ left: at.x + at.w / 2, top: at.y + at.h / 2, '--d': `${s.count.d}px` } as CSSProperties}>
        {s.nertzCount}
      </b>
    );
  };

  return (
    <>
    <div
      className={`table${L.shape === 'tall' ? ' tall' : L.shape === 'low' ? ' short' : ''}${L.cleared ? ' cleared' : ''}${held ? ' dragging' : ''}${frozen ? ' frozen' : ''}${paused ? ' paused' : ''}`}
      aria-hidden={paused || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={(e) => e.pointerType === 'mouse' && !grasp.current.hand && stopPeek()}
    >
      <div className={`felt${placing ? ' placing' : ''}`} style={{ left: L.middle.x, top: L.middle.y, width: L.middle.w, height: L.middle.h, borderRadius: TABLE.corner * L.felt.u }} />
      {L.slots.map((slot, i) => {
        if (!slot) return null;
        const full = finished(i) && stage === 'live' && !(held?.k === 'pile' && held.slot === i);
        return (
          <div key={i} className={`slot centre${full ? (toClear(i) ? ' yours' : ' done') : ''}`} style={box(slot)}>
            {full && toClear(i) && must.told && <em>Drag to tray</em>}
          </div>
        );
      })}
      <div className={`tray${held?.k === 'pile' ? ' open' : must.blocked ? ' wanted' : ''}${hot ? ' hot' : ''}${finale ? ' gone' : ''}${must.cls}`} style={box(held?.k === 'pile' ? trayOpen : L.tray)} />

      {L.opponents.map((o) => {
        const p = info(o.seat);
        const st = hands.find((g) => g.seat === o.seat);
        return (
          <div key={o.seat} className={st ? undefined : 'vacant'}>
            <div
              className={`tag${p?.connected === false || p?.left || p?.standing ? ' away' : ''}`}
              style={o.turn ? { left: o.turn === 90 ? o.box.x : undefined, right: o.turn === -90 ? L.window.w - o.box.x - o.box.w : undefined, top: o.box.y - TAG_H, maxWidth: TAG_SIDE_W } : { left: o.box.x, top: o.box.y - TAG_H, width: o.box.w }}
            >
              <PictureBy picture={p?.picture} seat={o.seat} />
              {dealer && p && !p.bot && !p.left && !results ? (
                <Hosting who={p}>
                  <Name host={p.isHost} className="name">
                    {name(o.seat)}
                  </Name>
                </Hosting>
              ) : (
                <Name host={p?.isHost} className="name">
                  {name(o.seat)}
                </Name>
              )}
              <span className="pts">{points(total(o.seat))}</span>
              {p?.bot && !((L.shape === 'tall' || L.cols) && o.box.w < 150) && <em className="bot">bot</em>}
              {p?.left ? <em className="flag">{p.connected ? 'watching' : 'left'}</em> : p?.connected === false || p?.standing ? <em className="flag">away</em> : !st ? <em className="flag">next round</em> : st.stuck && !frozen ? <em className="flag hot">stuck</em> : null}
            </div>
            {[o.nertz, ...o.workAt, o.stockPad, o.waste].map((r, i) => (
              <div key={i} className="slot" style={box(r)} />
            ))}
            {!dealing && st && count(o)}
          </div>
        );
      })}

      {/* Sitting this round out (you came in the middle of it, or were away at the deal): your own place, with nothing in it yet. */}
      {me && !mine && (
        <div className="vacant">
          {[me.nertz, ...me.workAt, me.stockPad, me.waste].map((r, i) => (
            <div key={i} className="slot" style={box(r)} />
          ))}
          {mineLine}
        </div>
      )}

      {me && mine && (
        <>
          <div className="slot" style={box(me.nertz)} />
          {me.workAt.map((w, i) => (
            <div key={i} className="slot" style={box(w)} />
          ))}
          <div className={`slot stock${mine.stock.length === 0 && mine.waste.length > 0 ? ' turn' : ''}`} data-stock="" style={box(me.stockPad)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12a7 7 0 0 1 12-5l2-2v6h-6l2.3-2.3A4.6 4.6 0 0 0 7.4 12ZM19 12a7 7 0 0 1-12 5l-2 2v-6h6l-2.3 2.3A4.6 4.6 0 0 0 16.6 12Z" />
            </svg>
          </div>
          <div className="slot" style={box(me.waste)} />
          {/* Your pile wears its count as everyone else's does. (None left: the call stands there instead.) */}
          {!dealing && me.nertzCount > 0 && count(me)}

          {mineLine}

          {/* Saying you are stuck, and beside it, once the round drags on, voting to end it: each in the place the
              layout keeps for it by your stock, clear of your cards and of everything else. */}
          {/* Standing up for now (from the menu): in the place of "I'm stuck", the one thing to say is that you are coming back. */}
          {!frozen && L.stuck && up && (
            <button
              type="button"
              className={`stuck${pill} on`}
              style={box0(L.stuck)}
              onClick={(e) => {
                perform('stand', room);
                e.currentTarget.blur();
              }}
            >
              Sit back down
            </button>
          )}
          {!frozen && L.stuck && !up && (
            <button
              type="button"
              className={`stuck${pill}${mine.stuck ? ' on' : ''}`}
              style={box0(L.stuck)}
              aria-pressed={mine.stuck}
              onClick={(e) => {
                send({ k: 'stuck', on: !mine.stuck });
                e.currentTarget.blur(); // keep Space for dealing
              }}
            >
              {mine.stuck ? (
                <>
                  Stuck <small>{waitingOn > 0 ? `${active.length - waitingOn}/${active.length}` : 'reshuffling'}</small>
                </>
              ) : (
                <>
                  I'm stuck {active.length > waitingOn && <small>{active.length - waitingOn}/{active.length}</small>}
                </>
              )}
            </button>
          )}
          {!frozen && L.vote && vote?.pressing && (
            <button
              type="button"
              className={`stuck${pill}${vote.mine ? ' on' : ''}`}
              style={box0(L.vote)}
              aria-pressed={vote.mine}
              onClick={(e) => {
                perform('vote', room);
                e.currentTarget.blur();
              }}
            >
              End round {vote.voted > 0 && <small>{vote.voted}/{vote.voters}</small>}
            </button>
          )}

          {/* Going out is a call, made from the very place the nertz pile stood. */}
          {!frozen && me.nertzCount === 0 && (
            <button type="button" className="nertz" style={{ ...box(me.nertz), fontSize: me.nertz.w * 0.215 }} onClick={() => send({ k: 'nertz' })}>
              Nertz!
            </button>
          )}
        </>
      )}

      {/* Where a card in hand may go is for the player to see for themselves: no pile is outlined for it, nor when it is
          over one. (Only the tray, for a finished pile: that says nothing.) */}
      {held?.k === 'pile' && <div className={`ring${hot ? ' hot' : ''}`} style={box(trayOpen)} />}
      {/* An Ace is in hand that may go anywhere there is room: what is not room. Around every pile, the gap the rules
          keep (shared/table.ts `clash`); the edge of the felt is the other limit, and is drawn up while this lasts. */}
      {placing && L.slots.map((slot, i) => slot && <div key={i} className="keepout" style={box(keepOut(L, slot, game.players.length))} />)}
      <div ref={preview} className="landing" hidden />

      {ghosts.map((g) => (
        <Ghost key={g.key} c={g.c} off={g.off} look={dress(g.c.card.owner)} gone={() => ghostGone(g.key)} />
      ))}
      {L.cards.map((c) => {
        const known = isHidden(c.card) ? null : c.card;
        return (
          <CardView
            key={replay ? `${c.card.id}:${replay}` : c.card.id}
            id={c.card.id}
            owner={c.card.owner}
            suit={known?.suit}
            rank={known?.rank}
            x={c.x}
            y={c.y}
            s={c.s}
            z={c.z}
            rot={c.rot}
            whose={whoseOf(c)}
            face={replaying ? 'down' : c.face}
            {...drawn(dress(c.card.owner))}
            slow={results && (c.pile === 'slot' || c.pile === 'tray')}
            pile={`${c.pile} ${c.at}`}
            cls={cardClass(c)}
            handles={handles}
            deal={deck.get(c.card.id)}
            rebury={reburied.has(c.card.id) ? { off: behind(c, game, byId), far: handMoved(c.card.owner) } : undefined}
          />
        );
      })}

      {/* (Not while the pile is in hand, on its way: that is what the notice asks for.) */}
      <Opening room={room} at={{ x: L.felt.cx, y: L.felt.cy }} onSeats={seatsOpen ? undefined : () => setSeating(true)} />

      {/* And for everyone, across the middle of the table: who it was, or that the round was ended by agreement. It comes, stands a moment, and is gone before the piles are washed. */}
      {(called || agreed) && stage !== 'sheet' && (
        <div key={`got${room.round}`} className="gotnertz" style={{ left: L.middle.x, top: L.middle.y, width: L.middle.w, height: L.middle.h, fontSize: clamp(L.middle.w * 0.075, 22, 76) }}>
          <span>{agreed ? 'Round ended by agreement' : `${andList(out.map((seat) => (seat === you ? 'You' : name(seat))))} got Nertz!`}</span>
        </div>
      )}
      {/* Snipes you were in (who by, or whom) and the reshuffle of a table that was stuck: across the middle, each there and gone in a second or so; more at once stack as a feed does, the newest in the middle and those before it moving up. */}
      {said.length > 0 && !called && !agreed && (
        <div className="gotnertz sniped" style={{ left: L.middle.x, top: L.middle.y, width: L.middle.w, height: `calc(${L.middle.h / 2}px + 0.55em)`, fontSize: clamp(L.middle.w * 0.06, 20, 60) }}>
          {said.map((s) =>
            s.k === 'reshuffle' ? (
              <motion.span layout="position" key={s.id} className="reshuffle" onAnimationEnd={(e) => e.target === e.currentTarget && saidDone(s.id)}>
                Reshuffle!
              </motion.span>
            ) : (
              <motion.span layout="position" key={s.id} style={{ color: backColour(s.by === you ? s.of : s.by) }} onAnimationEnd={(e) => e.target === e.currentTarget && saidDone(s.id)}>
                {s.by === you ? `You sniped ${name(s.of)}!` : `Sniped by ${name(s.by)}!`}
              </motion.span>
            ),
          )}
        </div>
      )}
      {/* Somebody beat somebody else to a pile: the same, small, along the lower edge of the felt, where no pile lies; more at once stack upward. */}
      {asides.length > 0 && !called && !agreed && (
        <div className="gotnertz sniped aside" style={{ left: L.middle.x, top: L.middle.y + L.middle.h - clamp(L.middle.w * 0.026, 13, 24) * 0.9, width: L.middle.w, height: clamp(L.middle.w * 0.026, 13, 24) * 1.8, fontSize: clamp(L.middle.w * 0.026, 13, 24) }}>
          {asides.map((a) => (
            <motion.span layout="position" key={a.id} onAnimationEnd={(e) => e.target === e.currentTarget && asideDone(a.id)}>
              <b style={{ color: nameColour(a.by) }}>{name(a.by)}</b> sniped <b style={{ color: nameColour(a.of) }}>{name(a.of)}</b>
            </motion.span>
          ))}
        </div>
      )}
      {stamps.map((s) => (
        <div key={`shout${s.seat}`} className="shout" style={{ left: s.x, top: s.y, width: s.w, height: s.h, fontSize: s.size }}>
          <span>Nertz!</span>
        </div>
      ))}

      {grace.length > 0 && room.timerMs !== null && (
        <Countdown
          ms={room.timerMs}
          top={countdownTop(L, W)}
          text={grace.includes(you) ? 'Put it down!' : name(grace[0]!) + (grace.length > 1 ? ` +${grace.length - 1}` : '')}
          label={grace.includes(you) ? 'Put your card down' : `Waiting for ${grace.map(name).join(' and ')} to put a card down`}
        />
      )}

      {finale && room.lastRound && <Finale L={L} game={game} scores={room.lastRound.scores} name={(seat) => line(seat)?.name ?? name(seat)} stage={stage} looks={dress} />}
      {/* A button of its own (a tap meant for a card must not throw the end of the round away), in the bar on a phone. */}
      {playingOut && (
        // Level with the menu's button, on every screen (so clear of what the screen keeps at its bottom, as that is). On
        // a phone the middle of the bottom edge is for your own pile: beside the chat button upright, beside the menu's on its side.
        <button
          type="button"
          className={`skip${phone ? ' aside' : ''}`}
          style={{ top: L.at.knobs.y + L.at.knobs.h / 2, left: L.shape === 'tall' ? L.at.chat.x + L.at.chat.w + 8 : phone ? L.at.knobs.x + L.at.knobs.w + 8 : undefined }}
          onClick={skip}
        >
          {phone ? 'Skip' : 'Skip to the scores'} <small>Esc</small>
        </button>
      )}
    </div>
    {paused && pausedBy && (
      <div className="paper-card" role="dialog" aria-label="Paused">
        <h2>Paused</h2>
        {pausedBy.by === 'update' ? (
          // (Paused by the server going down for an update: while it is away, that it will be back; once it is, that play can go on.)
          <>
            <p>Game paused while the server updates.</p>
            {pausedBy.done ? <p className="done">Update complete. Ready to resume.</p> : <p>It’ll be back in a moment<Dots /></p>}
          </>
        ) : (
          <p>{pausedBy.id === room.me ? 'You paused the round.' : `${room.players.find((p) => p.id === pausedBy.id)?.name ?? 'Someone'} paused the round.`}</p>
        )}
        {canResume(room) && online && (
          <button type="button" className="go" autoFocus onClick={() => pause(false)}>
            Resume game
          </button>
        )}
      </div>
    )}
    {stage === 'sheet' && sheet}
    {seatsOpen && seats(unseat)}
    {/* The round's clock, where the layout has a free place for it. (Over the score sheet too: it has stopped.) */}
    {L.clock && room.clock && <Clock clock={room.clock} at={L.clock} />}
    </>
  );
}
