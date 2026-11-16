// The table: every card on one absolutely-positioned layer (see layout.ts),
// plus the hand. All game logic is in shared/engine, and what a press, a move,
// a release or a tap does is decided in hand.ts; this file listens to the
// pointer, sends the intents and moves the card elements.
//
// Other players' cards move here too, while they are still in their hands:
// each dragging client reports where its card is (`drag` messages, about 18 a
// second), and `tick` below glides the very same card element after those
// reports until the snapshot that ends the hold lets it land or go home.
import { insets, useViewport } from './viewport';
import { animate, motion, useMotionValue, type MotionValue } from 'motion/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { calledBy, canDrop, completedBy, DEAL_MS, GRACE_MS, grab, inGrace, isHidden, isLive } from '../shared/engine';
import { PLAIN_LOOK, shownBack, STOCK_CARD_MS, STOCK_TURN_MS, type Back, type Deck, type DragAt, type Look } from '../shared/protocol';
import { offFelt, TABLE } from '../shared/table';
import type { Intent, RoomView, Suit } from '../shared/types';
import { backColour, backOf, CARD_H, CARD_W, Face, warm } from './cards/Face';
import { Finale, sortAt, sortMs, TIMING, washedAt } from './Finale';
import { aloftAt, computeLayout, inside, isLow, isTall, COUNTDOWN, countdownTop, DEAL, dealWait, keepOut, MINI_BELOW, onCanvas, TAG_H, toScreen, type Placed, type Rect, type Stage } from './layout';
import { ClearNotice, nag, send, useClearFirst } from './clearFirst';
import { cardDue, decide, drawnAt, EMPTY, reporter, sight, type Gesture, type Grasp, type Hand, type Held, type InHand, type Scene } from './hand';
import { Opening } from './Opening';
import { ending, stageOf, stepAtMount } from './stage';
import { onDrag, onSnipe, pause, playable, post, send as play } from './net';
import { canResume } from './Settings';
import { calm, lookOf, usePrefs } from './prefs';
import { beaten, sniped as snipeSound, stage as stageSound } from './sound';

// Durations are asked for at the moment of use: reduced motion (`calm`, see prefs.ts) can be switched while playing.
const MOVE = () => ({ duration: calm() ? 0 : 0.15, ease: 'easeOut' }) as const;
const FLIP = () => ({ duration: calm() ? 0 : 0.16, ease: 'easeInOut' }) as const;
/** Turning the middle face-down at the end of a round is slower: it is a moment, not a move. */
const TURN = () => ({ duration: calm() ? 0 : 0.42, ease: 'easeInOut' }) as const;
const Z_FLYING = 10000;
/** Someone else's card in the air: over every card of the layout, lying still or flying (in play none lies higher than 7500), and under the one in your own hand. */
const Z_ALOFT = Z_FLYING + 7500;
const Z_HELD = 30000;
/** How long the mouse has to rest on one of your work piles before it fans out in full: sweeping across them does nothing. */
const PEEK_MS = 380;
/** Someone else's card in the air: see-through, so it never hides a pile it passes over. */
const ALOFT = 0.58;
/** Your own card while it is over the felt: the pile underneath shows through. */
const OVER_FELT = 0.74;
/**
 * Someone else's card that has no pile to go to (an Ace above all) is drawn where it really is once it has been
 * over the felt, going slowly, for about this long (ms); "slowly" is under SLOW table units a millisecond.
 */
const DWELL_MS = 240;
const SLOW = 0.002;
/** How quickly another player's card closes on the last place it was reported at (ms to cover about two thirds of the way). */
const GLIDE_MS = 70;
/** A report older than this is not where the card is any more: it stays put until a fresh one comes. */
const STALE_MS = 600;
const clamp =(v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------- one card

interface Handle {
  x: MotionValue<number>;
  y: MotionValue<number>;
  z: MotionValue<number>;
  s: MotionValue<number>;
  /** Opacity. */
  o: MotionValue<number>;
  /** Tilt, degrees. */
  r: MotionValue<number>;
  /** Animate to wherever the layout currently wants this card. */
  settle(): void;
}

/** A card that is still in the deck when it first appears: where the deck is, and how long until it is dealt. */
interface Dealt {
  x: number;
  y: number;
  z: number;
  wait: number;
}

/** Lets the drag code move card elements directly, without re-rendering React on every pointer event. */
interface Registry {
  handles: Map<string, Handle>;
  held: Set<string>;
}

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
  /** In one of your own piles. */
  mine: boolean;
  up: boolean;
  mini: boolean;
  /** The faces of the deck this card came from, and whether they are dark: its owner's choice (`Look`). */
  deck: Deck;
  night: boolean;
  /** And its backs: null for a back by lot not drawn yet. */
  back: Back | null;
  bare: boolean;
  slow: boolean;
  /** Travels at its own level, not above everything: a card coming up under the ones already held. */
  low: boolean;
  cls: string;
  reg: Registry;
  /** Whether and when it is dealt is read once, when the card first appears: later snapshots, reconnects and re-renders never deal it again. */
  deal: Dealt | undefined;
}

/** A card's props for how it looks, each a value of its own: a snapshot brings new looks, and a card is drawn again only if its own has changed. */
const drawn = (look: Look): Pick<CardProps, 'deck' | 'night' | 'back' | 'bare'> => ({ deck: look.deck, night: look.night, back: shownBack(look.backs), bare: look.bare });

const CardView = memo(function CardView(p: CardProps) {
  const dealt = useRef(p.deal).current;
  const x = useMotionValue(dealt?.x ?? p.x);
  const y = useMotionValue(dealt?.y ?? p.y);
  const s = useMotionValue(p.s);
  const z = useMotionValue(dealt?.z ?? p.z);
  const r = useMotionValue(p.rot);
  const o = useMotionValue(1);
  const goal = useRef({ x: p.x, y: p.y, s: p.s, z: p.z, rot: p.rot });
  const mine = useRef(p.mine);
  const flight = useRef(0);
  const upWas = useRef(p.up);
  const low = useRef(p.low);
  low.current = p.low;
  const el = useRef<HTMLDivElement>(null);
  const flying = useRef(!!dealt); // a card waiting in the deck keeps the deck's stacking until it has landed
  /** When this card leaves the deck (performance clock). 0 once it has, or if it was never in one: it is dealt once. */
  const leaves = useRef(dealt ? performance.now() + dealt.wait : 0);

  const fly = useCallback((move: { duration: number } = p.slow ? TURN() : MOVE(), veiled = false, passing = false) => {
    const g = goal.current;
    const n = ++flight.current;
    flying.current = true;
    z.set(g.z + (low.current ? 0 : Z_FLYING)); // travel above everything that is lying still (unless it is slipping in under)
    if (veiled) o.set(ALOFT);
    // Somebody else's card crossing the table is not in the pointer's way either (styles.css `.card[data-passing]`).
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
      flying.current = false;
      z.set(goal.current.z);
      o.set(1); // landed: solid again, whatever it was in the air
      el.current?.removeAttribute('data-passing');
    }, move.duration * 1000 + 30);
  }, [x, y, s, z, r, o, p.slow]);

  /**
   * To wherever the layout wants it. Your own cards snap to it. Anyone else's card that has some way to go (a
   * bot's, a click, a lost report, or one let go before it was drawn where it really was) crosses the table at a
   * pace the eye can follow, see-through while it is in the air.
   */
  const go = useCallback((own: boolean) => {
    const g = goal.current;
    const far = Math.hypot(x.get() - g.x, y.get() - g.y);
    if (own || p.slow || calm() || far < 4) fly();
    else fly({ duration: Math.min(0.45, 0.16 + far / 2400), ease: 'easeInOut' } as { duration: number }, far > 2.5 * CARD_W * g.s, true);
  }, [fly, x, y, p.slow]);

  useEffect(() => {
    const was = goal.current;
    const wasMine = mine.current;
    goal.current = { x: p.x, y: p.y, s: p.s, z: p.z, rot: p.rot };
    mine.current = p.mine;
    if (p.reg.held.has(p.id)) return; // in a player's hand (yours, or someone else's as reported); settles when it is let go
    if (leaves.current) {
      // Still in the deck. If the window was resized it stays with the deck, and is dealt to its new place in its turn.
      if (p.deal) [x, y, s].forEach((v, i) => v.set([p.deal!.x, p.deal!.y, p.s][i]!));
      return;
    }
    if (was.x !== p.x || was.y !== p.y || was.s !== p.s || was.rot !== p.rot) {
      go(wasMine || p.mine);
      // Turning face-up on the way (a group off the stock going over onto the waste): a stack turned over shows the
      // back of the card that was on top of it until the faces come round, and only then the card that ends on top.
      // So for the first half of the turn the cards keep the order they were held in, which is the other way round.
      if (!upWas.current && p.up && !calm()) {
        const n = flight.current;
        z.set(p.z - 2 * (p.z % 100) + 99 + Z_FLYING);
        setTimeout(() => flight.current === n && z.set(goal.current.z + Z_FLYING), FLIP().duration * 500);
      }
    } else if (!flying.current) z.set(p.z);
  }, [p.x, p.y, p.s, p.z, p.rot, p.mine, p.slow, p.id, p.reg, p.deal?.x, p.deal?.y, go, x, y, s, z]);

  useEffect(() => {
    upWas.current = p.up; // (after the effect above, which asks what it was)
  }, [p.up]);

  // Its turn to be dealt: out of the deck, to its place in the layout.
  useEffect(() => {
    if (!leaves.current) return;
    const turn = setTimeout(() => {
      leaves.current = 0;
      fly(DEAL);
    }, leaves.current - performance.now());
    return () => clearTimeout(turn);
  }, [fly]);

  useEffect(() => {
    p.reg.handles.set(p.id, { x, y, z, s, o, r, settle: () => go(mine.current) });
    return () => void p.reg.handles.delete(p.id);
  }, [p.id, p.reg, x, y, z, s, o, r, go]);

  return (
    <motion.div ref={el} className={p.cls} data-id={p.id} style={{ x, y, scale: s, zIndex: z, '--o': o } as unknown as CSSProperties}>
      <motion.div className="flip" initial={false} style={{ rotate: r }} animate={{ rotateY: p.up ? 0 : 180 }} transition={p.slow ? TURN() : FLIP()}>
        <div className="front">{p.suit && p.rank ? <Face suit={p.suit} rank={p.rank} mini={p.mini} deck={p.deck} night={p.night} /> : null}</div>
        <div {...backOf(backColour(p.owner), p.back, p.bare, p.mini)} />
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
    let at = 0;
    const steps: [Stage, number][] = [
      ['spread', TIMING.flip],
      ['out', TIMING.spread],
      ['wash', trayPiles ? TIMING.out : 0],
      ['sort', washedAt(trayPiles) - TIMING.spread - (trayPiles ? TIMING.out : 0)],
      // (On a phone the table is cleared before the sorting starts: `clear`.)
      ['sheet', sortAt(trayPiles, clear) - washedAt(trayPiles) + sortMs(players) + TIMING.hold],
    ];
    timers.current = steps.map(([next, ms]) => setTimeout(() => setStep({ round, stage: next }), (at += ms)));
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
  /** How long it has been over the felt going slowly, as a share of DWELL_MS: at 1 it is drawn where it really is. */
  dwell: number;
}

/** A running total, with a real minus sign. */
const points = (n: number) => (n < 0 ? `−${-n}` : `${n}`);
/** How wide the name line of a neighbour whose hand runs down the side may be. */
const TAG_SIDE_W = 210;
const box = (r: Rect & { rot?: number }): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: Math.min(r.w, r.h) * 0.08, rotate: r.rot ? `${r.rot}deg` : undefined });

/** `sheet` (the scores) is laid over the table when the end-of-round sequence has played out. */
export function Table({ room, sheet }: { room: RoomView; sheet: ReactNode }) {
  const game = room.game!;
  /** Your seat; or, watching without one, a seat that nobody has. */
  const you = room.seat ?? -1;
  const results = room.phase === 'results';
  const [W, H] = useViewport();
  const prefs = usePrefs();
  // Whatever decks are at the table are fetched before their cards are turned up.
  const decks = room.players.map((p) => p.look.deck).join();
  useEffect(() => room.players.forEach((p) => warm(p.look.deck)), [decks]);
  /** A phone, upright or on its side: the table is cleared before the end of a round is sorted (`Layout.cleared`). */
  const clears = isTall(W, H) || isLow(W, H);
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
  const stageWas = useRef(stage);
  useEffect(() => {
    stageSound(stageWas.current, stage, sortAt(game.tray.length, clears)); // the riffle of the wash, the flourish of the score sheet
    stageWas.current = stage;
  }, [stage]);
  /** Your work pile that is being looked at (fanned out in full): the mouse rested on it, or it was tapped. */
  const [peek, setPeek] = useState<number | null>(null);
  const peekWait = useRef<{ i: number; t: number } | null>(null);
  useEffect(() => () => void (peekWait.current && clearTimeout(peekWait.current.t)), []);
  // A group that has just been completed is drawn held over the stock for a beat before it turns over onto the waste
  // (one, two, three... and over). Worked out while rendering, from one game state to the next, so the cards never
  // start for the waste first.
  const turning = useRef<{ game: typeof game | null; holds: Map<number, { n: number; waste: number; until: number }> }>({ game: null, holds: new Map() }).current;
  const [turned, setTurned] = useState(0);
  const groupHeld = useMemo(() => {
    const was = turning.game;
    const now = performance.now();
    if (was !== game) {
      turning.game = game;
      for (const p of game.players) {
        const q = was?.players.find((o) => o.seat === p.seat);
        const grown = q ? p.waste.length - q.waste.length : 0;
        // Cards came off the stock and none is left face-down: the group is whole.
        if (stage === 'live' && !calm() && q && grown > 0 && p.dealt === 0 && q.stock.length - p.stock.length === grown) {
          turning.holds.set(p.seat, { n: q.dealt + grown, waste: p.waste.length, until: now + STOCK_TURN_MS });
        } else if (turning.holds.get(p.seat)?.waste !== p.waste.length || p.dealt > 0) turning.holds.delete(p.seat);
      }
    }
    const out = new Map<number, number>();
    for (const [seat, h] of turning.holds) {
      if (h.until > now) out.set(seat, h.n);
      else turning.holds.delete(seat);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, stage, turned, turning]);
  useEffect(() => {
    if (!groupHeld.size) return;
    const until = Math.max(...[...turning.holds.values()].map((h) => h.until));
    const t = setTimeout(() => setTurned((n) => n + 1), Math.max(0, until - performance.now()) + 1);
    return () => clearTimeout(t);
  }, [groupHeld, turning]);
  // (The screen's own edges are read again whenever the window changes: turning a phone moves its notch.)
  const pad = useMemo(() => insets(), [W, H]);
  // (Everyone at the table has a place round it: whoever is not in the round, an empty one.)
  const seated = room.players.filter((p) => p.seat !== null).map((p) => p.seat).join(); // (those watching have no place at it)
  const sitting = useMemo(() => (seated ? seated.split(',').map(Number) : []), [seated]);
  const L = useMemo(() => computeLayout(W, H, game, you, stage, peek, groupHeld, pad, sitting), [W, H, game, you, stage, peek, groupHeld, pad, sitting]);
  const byId = useMemo(() => new Map(L.cards.map((c) => [c.card.id, c])), [L]);
  // Upright, "I'm stuck" stands in the bar at the top, right after the chat's button: after all of it, which is wider
  // when you are in voice (the microphone and its mute button stand there too), so that it is never under them.
  const [besideChat, setBesideChat] = useState(74);
  useEffect(() => {
    const chat = document.querySelector('.chat');
    if (!chat || typeof ResizeObserver === 'undefined') return;
    const measure = () => setBesideChat(Math.max(74, Math.round(chat.getBoundingClientRect().right) + 8));
    const seen = new ResizeObserver(measure);
    seen.observe(chat);
    measure();
    return () => seen.disconnect();
  }, []);
  const reg = useRef<Registry>({ handles: new Map(), held: new Set() }).current;
  /** What the pointer has hold of: hand.ts decides, `act` below carries it out. */
  const grasp = useRef<Grasp>(EMPTY);
  const [held, setHeld] = useState<Held | null>(null);
  /** The finished pile in hand is over the tray. */
  const [hot, setHot] = useState(false);
  /** The last snipe the server told of that you were in, and the last between two others: who beat whom to a pile (and a count, so that the same names flash again). Kept apart so that one does not put out the other. */
  const [snipe, setSnipe] = useState<{ by: number; of: number; n: number } | null>(null);
  const [aside, setAside] = useState<{ by: number; of: number; n: number } | null>(null);
  useEffect(() => {
    setSnipe(null);
    setAside(null);
  }, [room.round]);
  useEffect(
    () =>
      onSnipe(({ by, of }) => {
        if (by === you) snipeSound('me');
        else if (of === you) beaten();
        else snipeSound('other');
        (by === you || of === you ? setSnipe : setAside)((s) => ({ by, of, n: (s?.n ?? 0) + 1 }));
      }),
    [you],
  );
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
  /** The last report from each seat, when it came, and how fast the card was then going (table units a millisecond). */
  const reports = useRef(new Map<number, DragAt & { at: number; v: number }>()).current;
  const flights = useRef(new Map<number, Flight>()).current;
  const loop = useRef({ frame: 0, last: 0 }).current;
  /**
   * One animation frame of everybody else's held cards. A card is drawn on its
   * way from its owner's hand, as this window seats them, to its place on the
   * felt (`aloftAt` in layout.ts). A card with a pile to go to says how far it
   * has come (`w` of its report), and is drawn that far along the line to the
   * pile. One with none (an Ace on its way to bare felt) comes over to where
   * it really is while it lingers over the felt. Either way it closes on its
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
      for (const id of f.ids) {
        reg.held.delete(id);
        reg.handles.get(id)?.settle();
      }
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
        f = { id: p.holding, ids: grab(game, p.seat, p.holding)?.cards.map((c) => c.id) ?? [p.holding], x: home.x, y: home.y, s: home.s, dwell: 0 };
        flights.set(p.seat, f);
        for (const id of f.ids) reg.held.add(id);
      }
      const hw = home.s * CARD_W;
      const table = { x: at.p[0], y: at.p[1] };
      // Lingering: a report that has had no successor for a while means the card is being held still.
      const speed = time - at.at > 150 ? 0 : at.v;
      f.dwell = clamp(f.dwell + (offFelt(table, game.players.length) <= 0 ? clamp(1 - speed / SLOW, 0, 1) : -2) * (dt / DWELL_MS), 0, 1);
      const linger = calm() ? 1 : f.dwell * f.dwell * (3 - 2 * f.dwell);
      const s = home.s + (L.fs - home.s) * Math.max(at.w, linger);
      const seat = L.opponents.find((o) => o.seat === p.seat);
      // The pile it is going to: of those in the middle that would take it, the nearest to where it is.
      let pile: { x: number; y: number } | undefined;
      if (at.w > 0 && f.ids.length === 1) {
        const there = toScreen(L.felt, table);
        const off = (q: { x: number; y: number }) => Math.hypot(q.x - there.x, q.y - there.y);
        L.slots.forEach((r, i) => {
          if (!r || !canDrop(game, p.seat, f!.id, { k: 'slot', i })) return;
          const q = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
          if (!pile || off(q) < off(pile)) pile = q;
        });
      }
      const c = aloftAt(L.felt, { x: home.x + hw / 2, y: home.y + (home.s * CARD_H) / 2 }, hw, seat, at, pile, pile ? linger : Math.max(at.w, linger));
      f.x += (c.x - (s * CARD_W) / 2 - f.x) * k;
      f.y += (c.y - (s * CARD_H) / 2 - f.y) * k;
      f.s += (s - f.s) * k;
      f.ids.forEach((id, i) => {
        const c = byId.get(id);
        const h = reg.handles.get(id);
        if (!c || !h) return;
        h.x.set(f.x + ((c.x - home.x) * f.s) / home.s);
        h.y.set(f.y + ((c.y - home.y) * f.s) / home.s);
        h.s.set(f.s);
        h.z.set(Z_ALOFT + i);
        h.o.set(ALOFT);
        // Upright for whoever is watching once it is out of the hand (a neighbour's hand is turned to face the felt).
        h.r.set(c.rot * (1 - clamp(Math.max(at.h[1] / 0.6, at.w * 4, linger), 0, 1)));
      });
    }
    loop.frame = waiting || flights.size > 0 ? requestAnimationFrame(tick) : 0;
  }).current;
  const watch = () => {
    if (!loop.frame) loop.frame = requestAnimationFrame(tick);
  };
  useEffect(() => {
    const stop = onDrag((m) => {
      const now = performance.now();
      const was = reports.get(m.seat);
      const v = was?.id === m.id ? Math.hypot(m.p[0] - was.p[0], m.p[1] - was.p[1]) / Math.max(1, now - was.at) : Infinity;
      reports.set(m.seat, { ...m, at: now, v });
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

  const mine = game.players.find((p) => p.seat === you);
  const caller = calledBy(game);
  const called = caller !== null;
  // Development aid: Shift+D replays the deal animation in this window only (nothing is sent; the cards are not re-dealt).
  const [replay, setReplay] = useState(0);
  const [replaying, setReplaying] = useState(false);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !e.shiftKey || (e.target as Element).closest?.('input,textarea')) return;
      // Shift+N: a bot goes out now (to see and hear it without playing a round through; the server refuses it in production).
      if (e.code === 'KeyN') return void post({ t: 'debugBotOut' });
      if (e.code !== 'KeyD') return;
      setReplay((n) => n + 1);
      setReplaying(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!replaying) return;
    const t = setTimeout(() => setReplaying(false), DEAL_MS);
    return () => clearTimeout(t);
  }, [replay, replaying]);
  const dealing = game.status.at === 'dealing' || replaying;
  /** Nothing can be started: the round is not live (the cards are still being dealt, play has not opened, Nertz has been called, or it is over). (A card already in hand may still land during grace.) */
  const paused = !!room.paused && !results;
  const frozen = replaying || !isLive(game) || paused;
  // Nothing stays fanned out once the round stops being played, and no timer outlives the table.
  useEffect(() => {
    if (stage !== 'live' || frozen) setPeek(null);
  }, [stage, frozen]);
  /** Clear-first: with a finished pile of yours waiting, anything but carrying it to the tray is answered with a nudge (clearFirst.tsx). */
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
        if (wait !== null) plan.set(c.id, { x: hand.stock.x, y: hand.stock.y - under * 0.3 * hand.s, z: Z_FLYING + under, wait });
      });
    }
    return plan;
  }, [dealing, dealMs, game.players, L, you]);
  const grace = inGrace(game);
  const info = (seat: number) => room.players.find((p) => p.seat === seat);
  /** My own faces and backs: my choice, shown at once; or, if my backs are by lot, the one the table drew for me (it comes with the deal). */
  const chosen = lookOf(prefs);
  const myLook: Look = chosen.backs.k === 'lot' ? { ...chosen, backs: info(you)?.look.backs ?? chosen.backs } : chosen;
  /** This seat's line of the round just scored. The finished table goes by it: whoever played the round may have left since. */
  const line = (seat: number) => (results ? room.lastRound?.scores.find((s) => s.seat === seat) : undefined);
  /**
   * Whose faces and backs the cards from `seat` have: yours, if it is yours; the player's who sits there, as they have them now; but on the
   * finished table, if whoever played the round has left (the seat is empty, or someone else's by now), as they were
   * when the round ended.
   */
  const dress = (seat: number): Look | undefined => {
    if (seat === you) return myLook;
    const l = line(seat);
    const p = info(seat);
    return p && (!l || p.id === l.id) ? p.look : l?.look;
  };
  const name = (seat: number) => line(seat)?.name ?? info(seat)?.name ?? `Seat ${seat + 1}`;
  /** The total beside a name. The round's points are not added until the score sheet is up: the wash and the sort reveal them. */
  const total = (seat: number) => {
    const l = line(seat);
    return l ? l.total - (stage === 'sheet' ? 0 : l.delta) : (info(seat)?.score ?? 0);
  };
  /** The finished pile waiting for you to carry it to the tray. */
  const toClear = (slot: number) => slot === must.slot;
  const finished = (slot: number) => completedBy(game.slots[slot]) !== null;

  /** The table rule for moving a card without dragging it: tap (or click) it, then where it goes. */
  const tapToMove = room.settings.tapToMove;
  const scene: Scene = { game, you, L, byId, live: stage === 'live', playingOut, frozen, tapToMove, waiting: must.slot, plays: playable };

  // Dealing off the stock takes time. One click (or Space) starts a group of three; the cards then come off one at a
  // time, STOCK_CARD_MS apart, and the next group cannot start sooner than that after the last card. The server
  // holds everyone to the same pace, so there is nothing to gain by clicking faster.
  /** When the last card that went came off the stock. */
  const flipped = useRef(0);
  const dealNow = useCallback((by: (intent: Intent) => boolean) => {
    if (by({ k: 'flip' })) flipped.current = performance.now();
  }, []);
  /** A click on the stock, or Space: starts a group (or turns the waste back over), unless one is still coming off. */
  const dealGroup = useCallback(() => {
    if (performance.now() - flipped.current >= STOCK_CARD_MS) dealNow(send);
  }, [dealNow]);
  const due = cardDue(scene);
  // (A flip the server refuses is undone by its snapshot: the stock is as it was again, and this runs again.)
  useEffect(() => {
    if (!due) return;
    const t = setTimeout(() => dealNow(play), Math.max(0, flipped.current + STOCK_CARD_MS - performance.now()));
    return () => clearTimeout(t);
  }, [due, mine?.dealt, mine?.stock.length, dealNow]);
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
    for (const id of d.ids) reg.handles.get(id)?.o.set(see.over ? OVER_FELT : 1);
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
    for (const id of d.ids) {
      reg.held.delete(id);
      reg.handles.get(id)?.settle();
    }
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
      else if (fx.k === 'tried') post({ t: 'tried', card: fx.card, slot: fx.slot, seen: fx.seen });
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
        for (const id of d.ids) reg.held.add(id);
        setHeld(d.held);
      }
      d.ids.forEach((id, i) => {
        const h = reg.handles.get(id);
        const at = drawnAt(d, i);
        h?.x.set(at.x);
        h?.y.set(at.y);
        h?.z.set(Z_HELD + i);
        if (d.held.k === 'card' && d.held.ace) h?.s.set(d.s);
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
      else if (c.up) cls += ' grab';
    }
    return cls;
  };

  const me = L.me;
  const active = game.players.filter((p) => info(p.seat)?.connected);
  const waitingOn = active.filter((p) => !p.stuck).length;
  const oh = me ? me.nertz.h : 0;
  /** Upright: the room between your nertz pile and your stock, for your name. (The stuck button is a small pill in the top bar, after Chat.) */
  const between = me ? { x: me.nertz.x + me.nertz.w + 10, w: me.stock.x - 10 - (me.nertz.x + me.nertz.w + 10) } : { x: 0, w: 0 };
  // The NERTZ! stamp comes down on the place the caller's nertz pile stood (now empty), not across their whole hand:
  // large enough to read at any seat, and kept inside the window.
  const callerPile = called ? (caller === you ? me?.nertz : L.opponents.find((o) => o.seat === caller)?.nertz) : undefined;
  const stampSize = callerPile ? Math.max(22, Math.min(callerPile.w * 0.78, 60)) : 0;
  const callerBox = callerPile && {
    x: clamp(callerPile.x + callerPile.w / 2 - stampSize * 2, 4, Math.max(4, W - stampSize * 4 - 4)),
    y: callerPile.y,
    w: stampSize * 4,
    h: callerPile.h,
  };
  const finale = onCanvas(stage, 'slot');
  /** A phone, upright or on its side: the table is cleared for the end of a round (`Layout.cleared`). */
  const phone = L.phone;
  /** An Ace is in hand. */
  const placing = held?.k === 'card' && held.ace;

  return (
    <>
    <div
      className={`table${L.tall ? ' tall' : L.low ? ' short' : ''}${L.cleared ? ' cleared' : ''}${held ? ' dragging' : ''}${frozen ? ' frozen' : ''}${paused ? ' paused' : ''}`}
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
            {full && toClear(i) && <em>Drag to tray</em>}
          </div>
        );
      })}
      <div className={`tray${held?.k === 'pile' ? ' open' : must.blocked ? ' wanted' : ''}${hot ? ' hot' : ''}${finale ? ' gone' : ''}${must.cls}`} style={box(held?.k === 'pile' ? trayOpen : L.tray)} />

      {L.opponents.map((o) => {
        const p = info(o.seat);
        const st = game.players.find((g) => g.seat === o.seat);
        return (
          <div key={o.seat} className={st ? undefined : 'vacant'}>
            <div
              className={`tag${p?.connected === false ? ' away' : ''}${o.turn === -90 ? ' end' : ''}`}
              style={o.turn ? { left: o.turn === 90 ? o.box.x : undefined, right: o.turn === -90 ? L.window.w - o.box.x - o.box.w : undefined, top: o.box.y - TAG_H, width: TAG_SIDE_W } : { left: o.box.x, top: o.box.y - TAG_H, width: o.box.w }}
            >
              <i className="chip" style={{ background: backColour(o.seat) }} />
              <span className="name">{name(o.seat)}</span>
              <span className="pts">{points(total(o.seat))}</span>
              {p?.bot && !((L.tall || L.low) && o.box.w < 150) && <em className="bot">bot</em>}
              {p?.connected === false ? <em className="flag">away</em> : !st ? <em className="flag">next round</em> : st.stuck && !frozen ? <em className="flag hot">stuck</em> : null}
            </div>
            {[o.nertz, ...o.workAt, o.stockPad, o.waste].map((r, i) => (
              <div key={i} className="slot" style={box(r)} />
            ))}
            {!dealing && st && (
              <b className="count" style={{ left: Math.min(o.nertz.x + o.nertz.w - 9, W - 24), top: o.nertz.y + o.nertz.h - 6 }}>
                {o.nertzCount}
              </b>
            )}
          </div>
        );
      })}

      {/* Sitting this round out (you came in the middle of it, or were away at the deal): your own place, with nothing in it yet. */}
      {me && !mine && (
        <div className="vacant">
          {[me.nertz, ...me.workAt, me.stockPad, me.waste].map((r, i) => (
            <div key={i} className="slot" style={box(r)} />
          ))}
          <div className="mine" style={L.tall ? { left: between.x, width: between.w, top: me.nertz.y + 2 } : { right: W - (me.nertz.x + me.nertz.w), top: me.nertz.y + oh + 14 }}>
            <span className="who">
              <i className="chip" style={{ background: backColour(you) }} />
              {name(you)} <b>{points(total(you))}</b>
            </span>
            <span className="where">
              Round {room.round} at table {room.code}
            </span>
          </div>
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
          {/* Upright, your line stands between the nertz pile and the stock, and the pile wears its count as everyone else's does. */}
          {(L.tall || L.low) && !dealing && me.nertzCount > 0 && (
            <b className="count" style={{ left: me.nertz.x + me.nertz.w - 14, top: me.nertz.y + me.nertz.h - 14 }}>
              {me.nertzCount}
            </b>
          )}

          <div className="mine" style={L.tall ? { left: between.x, width: between.w, top: me.nertz.y + 2 } : { right: W - (me.nertz.x + me.nertz.w), top: me.nertz.y + oh + 14 }}>
            <span className="left" style={{ visibility: me.nertzCount && !dealing ? 'visible' : 'hidden' }}>
              <b>{me.nertzCount}</b> in your nertz pile
            </span>
            <span className="who">
              <i className="chip" style={{ background: backColour(you) }} />
              {name(you)} <b>{points(total(you))}</b>
            </span>
            <span className="where">
              Round {room.round} at table {room.code}
            </span>
          </div>

          {!frozen && (
            <button
              type="button"
              className={`stuck${mine.stuck ? ' on' : ''}`}
              style={L.tall ? { left: besideChat, top: 9, height: 32 } : L.low ? { left: me.box.x + me.box.w + 10, top: me.stock.y + oh - 32, height: 32 } : { left: me.stock.x, top: me.stock.y + oh + 16, width: me.box.x + me.box.w - me.stock.x }}
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
            mine={c.mine}
            up={c.up && !replaying}
            // (A card somebody is carrying is shown at the size of the cards in the middle, wherever it came from: so in its full drawing, not the small one of the hand it left.)
            mini={c.s * CARD_W < MINI_BELOW && !aloft.has(c.card.id)}
            {...drawn(dress(c.card.owner) ?? PLAIN_LOOK)}
            slow={results && (c.pile === 'slot' || c.pile === 'tray')}
            low={!!c.low}
            cls={cardClass(c)}
            reg={reg}
            deal={deck.get(c.card.id)}
          />
        );
      })}

      {/* (Not while the pile is in hand, on its way: that is what the notice asks for.) */}
      <ClearNotice must={must} rect={held?.k === 'pile' ? undefined : (L.slots[must.slot] ?? undefined)} />
      <Opening room={room} at={{ x: L.felt.cx, y: L.felt.cy }} />

      {/* And for everyone, across the middle of the table: who it was. It comes, stands a moment, and is gone before the piles are washed. */}
      {called && stage !== 'sheet' && (
        <div key={`got${room.round}`} className="gotnertz" style={{ left: L.middle.x, top: L.middle.y, width: L.middle.w, height: L.middle.h, fontSize: clamp(L.middle.w * 0.075, 22, 76) }}>
          <span>{caller === you ? 'You' : name(caller)} got Nertz!</span>
        </div>
      )}
      {/* A snipe you were in: who by, or whom, across the middle, there and gone in under a second. */}
      {snipe && !called && (
        <div key={`sniped${snipe.n}`} className="gotnertz sniped" style={{ left: L.middle.x, top: L.middle.y, width: L.middle.w, height: L.middle.h, fontSize: clamp(L.middle.w * 0.06, 20, 60) }}>
          <span style={{ color: backColour(snipe.by === you ? snipe.of : snipe.by) }}>{snipe.by === you ? `You sniped ${name(snipe.of)}!` : `Sniped by ${name(snipe.by)}!`}</span>
        </div>
      )}
      {/* Somebody beat somebody else to a pile: the same, small, along the lower edge of the felt, where no pile lies. */}
      {aside && !called && (
        <div key={`aside${aside.n}`} className="gotnertz sniped aside" style={{ left: L.middle.x, top: L.middle.y + L.middle.h - clamp(L.middle.w * 0.026, 13, 24) * 0.9, width: L.middle.w, height: clamp(L.middle.w * 0.026, 13, 24) * 1.8, fontSize: clamp(L.middle.w * 0.026, 13, 24) }}>
          <span>
            <b style={{ color: backColour(aside.by) }}>{name(aside.by)}</b> sniped <b style={{ color: backColour(aside.of) }}>{name(aside.of)}</b>
          </span>
        </div>
      )}
      {callerBox && (
        <div className="shout" style={{ left: callerBox.x, top: callerBox.y, width: callerBox.w, height: callerBox.h, fontSize: stampSize }}>
          <span>Nertz!</span>
        </div>
      )}

      {grace.length > 0 && room.timerMs !== null && (
        <Countdown
          ms={room.timerMs}
          top={countdownTop(L, W)}
          text={grace.includes(you) ? 'Put it down!' : name(grace[0]!) + (grace.length > 1 ? ` +${grace.length - 1}` : '')}
          label={grace.includes(you) ? 'Put your card down' : `Waiting for ${grace.map(name).join(' and ')} to put a card down`}
        />
      )}

      {finale && room.lastRound && <Finale L={L} game={game} scores={room.lastRound.scores} name={name} stage={stage} looks={dress} />}
      {/* A button of its own (a tap meant for a card must not throw the end of the round away), in the bar on a phone. */}
      {playingOut && (
        // (On a phone the middle of the bottom edge is for your own pile: beside the chat button upright, beside the sound and settings buttons on its side.)
        <button type="button" className={`skip${phone ? ' aside' : ''}`} style={L.tall ? { left: besideChat } : phone ? { left: Math.max(12, pad.l) + 136 } : undefined} onClick={skip}>
          {phone ? 'Skip' : 'Skip to the scores'} <small>Esc</small>
        </button>
      )}
    </div>
    {paused && (
      <div className="paused-card" role="dialog" aria-label="Paused">
        <h2>Paused</h2>
        <p>{room.paused!.by === room.me ? 'You paused the round.' : `${room.players.find((p) => p.id === room.paused!.by)?.name ?? 'Someone'} paused the round.`}</p>
        {canResume(room) ? (
          <button type="button" className="go" autoFocus onClick={() => pause(false)}>
            Carry on <small>P</small>
          </button>
        ) : (
          <p className="wait">Waiting for them to carry on.</p>
        )}
      </div>
    )}
    {stage === 'sheet' && sheet}
    </>
  );
}
