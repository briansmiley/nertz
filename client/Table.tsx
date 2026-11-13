// The table: every card on one absolutely-positioned layer (see layout.ts),
// plus drag and drop. All game logic is in shared/engine; this file only asks
// it "what would I pick up?" and "may I drop here?", and sends intents.
//
// Placement is exact. A dragged card lands only if it is released on one
// specific pile (the one under the pointer, else the one under the card's
// centre) and fits there; there is no click-to-play and nothing is rerouted.
//
// Other players' cards move here too, while they are still in their hands:
// each dragging client reports where its card is (`drag` messages, about 18 a
// second), and `tick` below glides the very same card element after those
// reports until the snapshot that ends the hold lets it land or go home.
import { animate, motion, useMotionValue, type MotionValue } from 'motion/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { canDrop, completedBy, DEAL_MS, GRACE_MS, grab, isHidden } from '../shared/engine';
import { DRAG_HZ, STOCK_CARD_MS, STOCK_TURN_MS, type DragAt } from '../shared/protocol';
import { cardSize, offFelt, TABLE } from '../shared/table';
import type { PileRef, RoomView, Suit } from '../shared/types';
import { backColour, CARD_H, CARD_W, Face } from './cards/Face';
import { Finale, sortMs, TIMING } from './Finale';
import { aloftAt, computeLayout, inside, COUNTDOWN, countdownTop, DEAL, dealWait, dropTarget, keepOut, landingAt, MINI_BELOW, TAG_H, toScreen, toTable, type Placed, type Rect, type Stage } from './layout';
import { ClearNotice, nag, send, useClearFirst } from './clearFirst';
import { Opening } from './Opening';
import { onDrag, pause, post } from './net';
import { canResume } from './Settings';
import { calm } from './prefs';
import { beaten, stage as stageSound } from './sound';
import { beatenTo } from './soundEvents';

// Durations are asked for at the moment of use: reduced motion (`calm`, see prefs.ts) can be switched while playing.
const MOVE = () => ({ duration: calm() ? 0 : 0.15, ease: 'easeOut' }) as const;
const FLIP = () => ({ duration: calm() ? 0 : 0.16, ease: 'easeInOut' }) as const;
/** Turning the middle face-down at the end of a round is slower: it is a moment, not a move. */
const TURN = () => ({ duration: calm() ? 0 : 0.42, ease: 'easeInOut' }) as const;
const Z_FLYING = 10000;
const Z_HELD = 30000;
const DRAG_SLOP = 6; // px of travel before a press becomes a drag
/** How long the mouse has to rest on one of your work piles before it fans out in full: sweeping across them does nothing. */
const PEEK_MS = 380;
/** Someone else's card in the air: see-through, so it never hides a pile it passes over. */
const ALOFT = 0.58;
/** Your own card while it is over the felt: the pile underneath shows through. */
const OVER_FELT = 0.74;
/** An Ace on its way to start a pile shrinks to the size of a pile in the middle over the last few px before the felt. */
const SHRINK_PX = 14;
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
const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- one card

interface Handle {
  x: MotionValue<number>;
  y: MotionValue<number>;
  z: MotionValue<number>;
  s: MotionValue<number>;
  /** Opacity. */
  o: MotionValue<number>;
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
  slow: boolean;
  /** Travels at its own level, not above everything: a card coming up under the ones already held. */
  low: boolean;
  cls: string;
  reg: Registry;
  /** Whether and when it is dealt is read once, when the card first appears: later snapshots, reconnects and re-renders never deal it again. */
  deal: Dealt | undefined;
}

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
    animate(r, g.rot, move);
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
    if (was.x !== p.x || was.y !== p.y || was.s !== p.s || was.rot !== p.rot) go(wasMine || p.mine);
    else if (!flying.current) z.set(p.z);
  }, [p.x, p.y, p.s, p.z, p.rot, p.mine, p.slow, p.id, p.reg, p.deal?.x, p.deal?.y, go, x, y, s, z]);

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
    p.reg.handles.set(p.id, { x, y, z, s, o, settle: () => go(mine.current) });
    return () => void p.reg.handles.delete(p.id);
  }, [p.id, p.reg, x, y, z, s, o, go]);

  return (
    <motion.div ref={el} className={p.cls} data-id={p.id} style={{ x, y, scale: s, zIndex: z, '--o': o } as unknown as CSSProperties}>
      <motion.div className="flip" initial={false} style={{ rotate: r }} animate={{ rotateY: p.up ? 0 : 180 }} transition={p.slow ? TURN() : FLIP()}>
        <div className="front">{p.suit && p.rank ? <Face suit={p.suit} rank={p.rank} mini={p.mini} /> : null}</div>
        <div className="back" style={{ '--back': backColour(p.owner) } as CSSProperties} />
      </motion.div>
    </motion.div>
  );
});

// ---------------------------------------------------------------- end of round

/**
 * Walks the table through the end-of-round sequence once the round is scored.
 * A window that was not watching the round (a reload, a latecomer) and anyone
 * who prefers reduced motion go straight to the sheet. `skip` jumps there.
 */
function useStage(results: boolean, trayPiles: number, players: number): [Stage, () => void] {
  const watched = useRef(!results);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [stage, setStage] = useState<Stage>(results ? 'sheet' : 'live');
  const stop = () => timers.current.splice(0).forEach(clearTimeout);
  useEffect(() => {
    if (!results) {
      watched.current = true;
      return setStage('live');
    }
    if (!watched.current || calm()) return setStage('sheet');
    setStage('flip');
    let at = 0;
    const steps: [Stage, number][] = [
      ['out', TIMING.flip],
      ['wash', trayPiles ? TIMING.out : 0],
      ['sheet', TIMING.wash + sortMs(players) + TIMING.hold],
    ];
    timers.current = steps.map(([next, ms]) => setTimeout(() => setStage(next), (at += ms)));
    return stop;
  }, [results]); // the tray cannot change once the round is scored, so `trayPiles` is not a dependency
  return [
    stage,
    () => {
      stop();
      setStage('sheet');
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

/** Somewhere the thing in hand may be put down. `hit` is where it has to be released. */
interface Target {
  key: string;
  to: PileRef | 'tray' | 'waste';
  rect: Rect & { rot?: number };
  hit: Rect;
}

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

/**
 * What is in hand: one of your cards (with any run on top of it), a finished centre pile on its way to the tray, or
 * the top card of your stock on its way to the waste. `ace`: it is an Ace on a table without marked places, which
 * may start a pile wherever there is room. The stock card is face-down and nobody's business: the server
 * is not told it is held (no `hold`), so it can never count for the grace window; only its landing is sent.
 */
type Held = { k: 'card'; id: string; ace: boolean } | { k: 'pile'; slot: number } | { k: 'stock' };

interface Drag {
  pointer: number;
  held: Held;
  /** The elements that move, and the one that was grabbed. */
  ids: string[];
  lead: string;
  /** Where the pointer went down, and where it is now. */
  sx: number;
  sy: number;
  px: number;
  py: number;
  base: { x: number; y: number }[];
  active: boolean;
  /** The last report of where it is, when one was last sent, and the timer for one that is waiting its turn. */
  report: ({ t: 'drag' } & DragAt) | null;
  sent: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function useViewport(): [number, number] {
  const [size, setSize] = useState<[number, number]>([window.innerWidth, window.innerHeight]);
  useEffect(() => {
    const on = () => setSize([window.innerWidth, window.innerHeight]);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

/** A running total, with a real minus sign. */
const points = (n: number) => (n < 0 ? `−${-n}` : `${n}`);
/** How wide the name line of a neighbour whose hand runs down the side may be. */
const TAG_SIDE_W = 210;
const box = (r: Rect & { rot?: number }): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: Math.min(r.w, r.h) * 0.08, rotate: r.rot ? `${r.rot}deg` : undefined });

/** `sheet` (the scores) is laid over the table when the end-of-round sequence has played out. */
export function Table({ room, sheet }: { room: RoomView; sheet: ReactNode }) {
  const game = room.game!;
  const you = room.you;
  const results = room.phase === 'results';
  const [W, H] = useViewport();
  const [stage, skip] = useStage(results, game.tray.length, game.players.length);
  // A click meant for a card must not throw the end of the round away: only Escape skips it, and only on your own screen.
  const ending = results && stage !== 'sheet';
  useEffect(() => {
    if (!ending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ending]);
  const stageWas = useRef(stage);
  useEffect(() => {
    stageSound(stageWas.current, stage); // the riffle of the wash, the flourish of the score sheet
    stageWas.current = stage;
  }, [stage]);
  /** Your work pile that is being looked at (fanned out in full): the mouse rested on it, or it was tapped. */
  const [peek, setPeek] = useState<number | null>(null);
  const peekWait = useRef<{ i: number; t: number } | null>(null);
  useEffect(() => () => void (peekWait.current && clearTimeout(peekWait.current.t)), []);
  const packet = room.settings.stockDeal !== 'drag';
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
        if (packet && stage === 'live' && !calm() && q && grown > 0 && p.dealt === 0 && q.stock.length - p.stock.length === grown) {
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
  }, [game, packet, stage, turned, turning]);
  useEffect(() => {
    if (!groupHeld.size) return;
    const until = Math.max(...[...turning.holds.values()].map((h) => h.until));
    const t = setTimeout(() => setTurned((n) => n + 1), Math.max(0, until - performance.now()) + 1);
    return () => clearTimeout(t);
  }, [groupHeld, turning]);
  const L = useMemo(() => computeLayout(W, H, game, you, stage, peek, packet, groupHeld), [W, H, game, you, stage, peek, packet, groupHeld]);
  const byId = useMemo(() => new Map(L.cards.map((c) => [c.card.id, c])), [L]);
  const reg = useRef<Registry>({ handles: new Map(), held: new Set() }).current;
  const drag = useRef<Drag | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  /** On a table without marked places: the outline of where the Ace in hand would start its pile. Moved by hand, not by React. */
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
          if (!r || game.slots[i]!.length === 0 || !canDrop(game, p.seat, f!.id, { k: 'slot', i })) return;
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
        h.z.set(Z_FLYING + 5000 + i);
        h.o.set(ALOFT);
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
  const called = game.nertzCalledBy !== null;
  // Development aid: Shift+D replays the deal animation in this window only (nothing is sent; the cards are not re-dealt).
  const [replay, setReplay] = useState(0);
  const [replaying, setReplaying] = useState(false);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyD' || !e.shiftKey || e.repeat || (e.target as Element).closest?.('input,textarea')) return;
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
  const dealing = game.stage === 'dealing' || replaying;
  /** Nothing can be started: the cards are still being dealt, play has not opened, or Nertz has been called. (A card already in hand may still land during grace.) */
  const paused = !!room.paused && !results;
  const frozen = dealing || game.stage !== 'play' || called || results || paused;
  // Nothing stays fanned out once the round stops being played, and no timer outlives the table.
  useEffect(() => {
    if (stage !== 'live' || frozen) setPeek(null);
  }, [stage, frozen]);
  /** Clear-first: with a finished pile of yours waiting, anything but carrying it to the tray is answered with a nudge (clearFirst.tsx). */
  const must = useClearFirst(game, you);

  // The deal. Every player's cards start as one deck where their stock lies, and the nertz pile and the work piles
  // are dealt off it one card after another, everyone's at once. `dealMs` says how far along the server is: in a
  // window that arrives late (a reload) the cards already dealt are simply in place and the rest follow on time.
  const dealMs = replaying ? DEAL_MS : room.dealMs;
  const deck = useMemo(() => {
    const plan = new Map<string, Dealt>();
    if (!dealing || dealMs === null || calm()) return plan;
    for (const p of game.players) {
      const hand = p.seat === you ? L.me : L.opponents.find((o) => o.seat === p.seat);
      if (!hand) continue;
      const work = p.work.flat();
      const out = [...work, ...p.nertz];
      out.forEach((c, i) => {
        const wait = dealWait(i, dealMs, work.length);
        const under = out.length - i; // cards of the deck beneath this one that are also on their way out
        if (wait !== null) plan.set(c.id, { x: hand.stock.x, y: hand.stock.y - under * 0.3 * hand.s, z: Z_FLYING + under, wait });
      });
    }
    return plan;
  }, [dealing, dealMs, game.players, L, you]);
  const inGrace = called && !results && game.grace.length > 0;
  const info = (seat: number) => room.players.find((p) => p.seat === seat);
  /** This seat's line of the round just scored. The finished table goes by it: whoever played the round may have left since. */
  const line = (seat: number) => (results ? room.lastRound?.scores.find((s) => s.seat === seat) : undefined);
  const name = (seat: number) => line(seat)?.name ?? info(seat)?.name ?? `Seat ${seat + 1}`;
  /** The total beside a name. The round's points are not added until the score sheet is up: the wash and the sort reveal them. */
  const total = (seat: number) => {
    const l = line(seat);
    return l ? l.total - (stage === 'sheet' ? 0 : l.delta) : (info(seat)?.score ?? 0);
  };
  /** Finished piles waiting for you to carry them to the tray. */
  const toClear = (slot: number) => !frozen && completedBy(game.slots[slot] ?? []) === you;

  /** The table rule for dealing off the stock: drag each card to the waste, or click the stock once per card. */
  const dragDeal = room.settings.stockDeal === 'drag';

  // Dealing off the stock takes time. One click (or Space) starts a group of three; the cards then come off one at a
  // time, STOCK_CARD_MS apart, and the next group cannot start sooner than that after the last card. The server
  // holds everyone to the same pace, so there is nothing to gain by clicking faster.
  const flipped = useRef(0);
  const dealNow = useCallback(() => {
    flipped.current = performance.now();
    return send({ k: 'flip' });
  }, []);
  /** A click on the stock, or Space: starts a group (or turns the waste back over), unless one is still coming off. */
  const dealGroup = useCallback(() => {
    if (performance.now() - flipped.current >= STOCK_CARD_MS) dealNow();
  }, [dealNow]);
  const midGroup = !frozen && !dragDeal && (mine?.dealt ?? 0) > 0 && (mine?.stock.length ?? 0) > 0;
  useEffect(() => {
    if (!midGroup) return;
    const t = setTimeout(dealNow, Math.max(0, flipped.current + STOCK_CARD_MS - performance.now()));
    return () => clearTimeout(t);
  }, [midGroup, mine?.dealt, mine?.stock.length, dealNow]);
  useEffect(() => {
    if (frozen || dragDeal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      e.preventDefault();
      dealGroup();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [frozen, dragDeal, dealGroup]);

  /** While a finished pile is in hand the tray comes a little way in from the edge to meet it. */
  const trayOpen: Rect = { ...L.tray, x: L.tray.x - L.tray.w * 0.18, w: L.tray.w * 1.18 };
  /** Exactly the piles that would take what is in hand right now. */
  const targetsFor = (h: Held): Target[] => {
    if (h.k === 'pile') return [{ key: 'tray', to: 'tray', rect: trayOpen, hit: L.trayHit }];
    if (h.k === 'stock') {
      // No precision needed: on the waste or anywhere near it, as long as the card has clearly left the stock.
      const w = L.me?.waste;
      return w ? [{ key: 'waste', to: 'waste', rect: w, hit: { x: w.x - w.w * 0.1, y: w.y - w.h * 0.75, w: w.w * 2.2, h: w.h * 2.5 } }] : [];
    }
    const out: Target[] = [];
    L.me?.work.forEach((rect, i) => {
      if (canDrop(game, you, h.id, { k: 'work', i })) out.push({ key: `w${i}`, to: { k: 'work', i }, rect, hit: L.me!.workHit[i]! });
    });
    L.slots.forEach((rect, i) => {
      if (rect && canDrop(game, you, h.id, { k: 'slot', i })) out.push({ key: `s${i}`, to: { k: 'slot', i }, rect, hit: L.slotHit[i]! });
    });
    return out;
  };
  const targets = useMemo(() => (held ? targetsFor(held) : []), [held, L, game, you]); // for the outlines; drops ask again

  /**
   * The one target the hand is over: the drop area under the pointer, and
   * only if the pointer is over none, the one under the centre of the grabbed
   * card. (A card held by its corner is aimed with the pointer, not with a
   * centre that is half a card away.) Drop areas never overlap, so between
   * two piles is neither.
   */
  const centreOf = (d: Drag): { x: number; y: number } | null => {
    const h = reg.handles.get(d.lead);
    const c = byId.get(d.lead);
    return h && c ? { x: h.x.get() + (h.s.get() * CARD_W) / 2, y: h.y.get() + (h.s.get() * CARD_H) / 2 } : null;
  };
  /**
   * On a table without marked places an Ace that is over no pile of yours
   * aims at the felt under its own centre: that very point, nothing snaps.
   * Returned as soon as any of the card is over the felt, whether or not a
   * pile may start there (`ok`), for the outline.
   */
  const feltUnder = (d: Drag, centre: { x: number; y: number } | null): (Target & { ok: boolean }) | undefined => {
    if (d.held.k !== 'card' || !d.held.ace || !centre) return undefined;
    const at = toTable(L.felt, centre.x, centre.y);
    if (offFelt(at, game.players.length) > cardSize(game.players.length).h / 2) return undefined;
    const to: PileRef = { k: 'felt', x: round3(at.x), y: round3(at.y) };
    const rect = landingAt(L, centre);
    return { key: 'felt', to, rect, hit: rect, ok: canDrop(game, you, d.held.id, to) };
  };
  const targetUnder = (d: Drag): Target | undefined => {
    const centre = centreOf(d);
    const pile = dropTarget(targetsFor(d.held), { x: d.px, y: d.py }, centre);
    if (pile) return pile;
    const felt = feltUnder(d, centre);
    return felt?.ok ? felt : undefined;
  };

  /**
   * Tells the others where the card in hand is: its centre as a distance from
   * its pile (along your row, and towards the middle) in cards of your hand,
   * and as a point of the table, with how far it has come of the way to a pile
   * in the middle that would take it (`piles`; nothing if there is none). At
   * most DRAG_HZ a second; the last position always goes out, late if need be.
   */
  const report = (d: Drag, centre: { x: number; y: number }, piles: readonly Target[]) => {
    const c = byId.get(d.lead);
    if (d.held.k !== 'card' || !c) return;
    const hw = c.s * CARD_W;
    const home = { x: d.base[0]!.x + hw / 2, y: d.base[0]!.y + (c.s * CARD_H) / 2 };
    const at = toTable(L.felt, centre.x, centre.y);
    // Within a third of a card of the pile's middle it has arrived.
    const there = L.fs * CARD_W * 0.35;
    let come = 0;
    for (const t of piles) {
      const to = { x: t.rect.x + t.rect.w / 2, y: t.rect.y + t.rect.h / 2 };
      come = Math.max(come, 1 - (Math.hypot(to.x - centre.x, to.y - centre.y) - there) / Math.max(1, Math.hypot(to.x - home.x, to.y - home.y) - there));
    }
    d.report = {
      t: 'drag',
      id: d.held.id,
      w: round3(clamp(come, 0, 1)),
      h: [round3(clamp((centre.x - home.x) / hw, -60, 60)), round3(clamp((home.y - centre.y) / hw, -60, 60))],
      p: [round3(clamp(at.x, -8, 8)), round3(clamp(at.y, -8, 8))],
    };
    const wait = d.sent + 1000 / DRAG_HZ - performance.now();
    const go = () => {
      d.timer = undefined;
      d.sent = performance.now();
      if (drag.current === d && d.report) post(d.report);
    };
    if (wait <= 0) go();
    else d.timer ??= setTimeout(go, wait);
  };

  /** After every movement of the hand: which pile it is over, whether the card should let the middle show through, and the report. */
  const aim = (d: Drag) => {
    const centre = centreOf(d);
    const over = !!centre && offFelt(toTable(L.felt, centre.x, centre.y), game.players.length) < 0;
    for (const id of d.ids) reg.handles.get(id)?.o.set(over ? OVER_FELT : 1);
    const targets = targetsFor(d.held);
    // (An empty marked place is not somewhere the card is known to be going: an Ace fits them all.)
    if (centre) report(d, centre, targets.filter((t) => typeof t.to === 'object' && t.to.k === 'slot' && game.slots[t.to.i]!.length > 0));
    const pile = dropTarget(targets, { x: d.px, y: d.py }, centre);
    const felt = pile ? undefined : feltUnder(d, centre);
    setHot(pile?.key ?? (felt?.ok ? felt.key : null));
    const el = preview.current;
    if (el) {
      el.hidden = !felt;
      if (felt) Object.assign(el.style, { left: `${felt.rect.x}px`, top: `${felt.rect.y}px`, width: `${felt.rect.w}px`, height: `${felt.rect.h}px` });
      el.classList.toggle('no', !felt?.ok);
    }
  };

  /** The hand opens: whatever was in it goes to wherever the layout now wants it (its new pile, or back home). */
  const letGo = (d: Drag) => {
    drag.current = null;
    clearTimeout(d.timer);
    for (const id of d.ids) {
      reg.held.delete(id);
      reg.handles.get(id)?.settle();
    }
    if (preview.current) preview.current.hidden = true;
    setHeld(null);
    setHot(null);
  };

  // The server can take a card out of your hand: Nertz was called and it has
  // nowhere to go, the grace window closed, or the card was buried. Then the
  // drag is over and the card goes home.
  useEffect(() => {
    const d = drag.current;
    if (!d?.active) return;
    const gone = d.held.k === 'card' ? mine?.holding !== d.held.id : d.held.k === 'pile' ? !toClear(d.held.slot) : frozen || mine?.stock.at(-1)?.id !== d.lead;
    if (gone) letGo(d);
  });
  // The table can change under a hand that is holding still: someone starts a pile right where your Ace was about
  // to go. What the outline says is worked out again there and then, not only when the hand next moves.
  useEffect(() => {
    const d = drag.current;
    if (d?.active) aim(d);
  }, [game, L]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (stage === 'flip' || stage === 'out' || stage === 'wash') return; // the end of a round plays out; only Escape skips it
    if (frozen || drag.current || e.button !== 0) return;
    const el = (e.target as Element).closest('[data-id],[data-stock]');
    if (!el) return;
    const id = el.getAttribute('data-id');
    const placed = id ? byId.get(id) : undefined;
    if (must.blocked && (!id || placed?.mine)) return nag();
    let pick: Pick<Drag, 'held' | 'ids' | 'lead'> | null = null;
    if (!id || (placed?.mine && placed.pile === 'stock')) {
      // The stock. Empty: a click turns the waste back over. Otherwise one card per action: a click deals it, or
      // (the table rule) it has to be carried to the waste.
      const card = mine?.stock.at(-1)?.id;
      if (!card || !dragDeal) return void dealGroup();
      pick = { held: { k: 'stock' }, ids: [card], lead: card };
    } else if (placed?.pile === 'slot' && toClear(placed.at)) {
      const ids = L.cards.filter((c) => c.pile === 'slot' && c.at === placed.at).map((c) => c.card.id);
      pick = { held: { k: 'pile', slot: placed.at }, ids, lead: ids[ids.length - 1]! };
    } else if (placed?.mine) {
      const g = grab(game, you, id);
      if (g) pick = { held: { k: 'card', id, ace: game.table === 'free' && g.cards.length === 1 && g.cards[0]!.rank === 1 }, ids: g.cards.map((c) => c.id), lead: id };
    }
    if (!pick) return;
    drag.current = {
      ...pick,
      pointer: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      px: e.clientX,
      py: e.clientY,
      base: pick.ids.map((i) => ({ x: byId.get(i)!.x, y: byId.get(i)!.y })),
      active: false,
      report: null,
      sent: 0,
      timer: undefined,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
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
    const d = drag.current;
    if (!d || !d.active) hover(e);
    if (!d || e.pointerId !== d.pointer) return;
    [d.px, d.py] = [e.clientX, e.clientY];
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.active) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      // The drag starts here, and the server is told: who holds what decides the grace window.
      if (d.held.k === 'card' && !send({ k: 'hold', cardId: d.held.id })) return void (drag.current = null);
      d.active = true;
      stopPeek();
      for (const id of d.ids) reg.held.add(id);
      setHeld(d.held);
    }
    // An Ace that may start a pile comes down to the size of a pile in the middle as it reaches the felt, about the
    // point it is held by: what you carry over the felt is exactly what would lie there.
    const home = byId.get(d.lead)?.s ?? 1;
    const near = d.held.k === 'card' && d.held.ace ? clamp(1 - (offFelt(toTable(L.felt, d.px, d.py), game.players.length) * L.felt.u) / SHRINK_PX, 0, 1) : 0;
    const k = 1 + (L.fs / home - 1) * near;
    d.ids.forEach((id, i) => {
      const h = reg.handles.get(id);
      h?.x.set(d.px - (d.sx - d.base[i]!.x) * k);
      h?.y.set(d.py - (d.sy - d.base[i]!.y) * k);
      h?.z.set(Z_HELD + i);
      if (d.held.k === 'card' && d.held.ace) h?.s.set(home * k);
    });
    aim(d);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    // On a touch screen a tap on one of your work piles fans it out in full, and another tap (anywhere) closes it.
    if (e.pointerType !== 'mouse' && (!d || !d.active) && stage === 'live') {
      const i = columnAt(e.clientX, e.clientY);
      setPeek(i === peek ? null : i);
    }
    if (!d || e.pointerId !== d.pointer) return;
    if (!d.active) return void (drag.current = null);
    // A drop. Only the pile it was released on counts; anywhere else the card is put back. If the move is
    // refused by the server a moment later (someone got there first) the card animates home just the same,
    // and the server takes it out of our hand by itself.
    [d.px, d.py] = [e.clientX, e.clientY];
    const t = targetUnder(d);
    if (d.held.k === 'pile') {
      if (t) send({ k: 'clear', slot: d.held.slot });
    } else if (d.held.k === 'stock') {
      if (t) send({ k: 'flip' });
    } else if (!t || t.to === 'tray' || t.to === 'waste' || !send({ k: 'move', cardId: d.held.id, count: d.ids.length, to: t.to })) {
      // Let go over a pile in the middle that will not take it because someone else's same card is already there: beaten to it.
      const id = d.held.id;
      const c = centreOf(d);
      const over = d.ids.length === 1 && !t ? L.slotHit.findIndex((r) => r && (inside(r, d.px, d.py) || (c && inside(r, c.x, c.y)))) : -1;
      if (over >= 0 && beatenTo(game, you, id, over)) beaten();
      send({ k: 'release' });
    }
    letGo(d);
  };

  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    if (d.active && d.held.k === 'card') send({ k: 'release' });
    letGo(d);
  };

  const cardClass = (c: Placed): string => {
    let cls = dealing && calm() ? 'card dealt' : 'card';
    if (c.pile === 'tray' && stage !== 'out') cls += ' shelved';
    if (c.pile === 'slot' && game.slots[c.at]?.length === 13) cls += toClear(c.at) ? ` grab${must.cls}` : stage === 'live' ? ' done' : '';
    if (aloft.has(c.card.id)) cls += ' aloft';
    if (c.mine && !frozen && !must.blocked) {
      if (c.pile === 'stock') cls += dragDeal ? ' grab' : ' tap';
      else if (c.up) cls += ' grab';
    }
    return cls;
  };

  const me = L.me;
  const active = game.players.filter((p) => info(p.seat)?.connected);
  const waitingOn = active.filter((p) => !p.stuck).length;
  const oh = me ? me.nertz.h : 0;
  const waiting = game.slots.some((_, i) => toClear(i));
  const callerBox = called ? (game.nertzCalledBy === you ? me?.box : L.opponents.find((o) => o.seat === game.nertzCalledBy)?.box) : undefined;
  const finale = stage === 'wash' || stage === 'sheet';
  /** An Ace is in hand on a table without marked places. */
  const placing = held?.k === 'card' && held.ace;

  return (
    <>
    <div
      className={`table${held ? ' dragging' : ''}${frozen ? ' frozen' : ''}${paused ? ' paused' : ''}`}
      aria-hidden={paused || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={(e) => e.pointerType === 'mouse' && !drag.current && stopPeek()}
    >
      <div className={`felt${placing ? ' placing' : ''}`} style={{ left: L.middle.x, top: L.middle.y, width: L.middle.w, height: L.middle.h, borderRadius: TABLE.corner * L.felt.u }} />
      {L.slots.map((slot, i) => {
        if (!slot) return null;
        const full = game.slots[i]?.length === 13 && stage === 'live' && !(held?.k === 'pile' && held.slot === i);
        return (
          <div key={i} className={`slot centre${game.table === 'free' ? ' bare' : ''}${full ? (toClear(i) ? ' yours' : ' done') : ''}`} style={box(slot)}>
            {full && toClear(i) && <em>Drag to tray</em>}
          </div>
        );
      })}
      <div className={`tray${held?.k === 'pile' ? ' open' : waiting ? ' wanted' : ''}${hot === 'tray' ? ' hot' : ''}${finale ? ' gone' : ''}${must.cls}`} style={box(held?.k === 'pile' ? trayOpen : L.tray)} />

      {L.opponents.map((o) => {
        const p = info(o.seat);
        const st = game.players.find((g) => g.seat === o.seat);
        return (
          <div key={o.seat}>
            <div
              className={`tag${p?.connected === false ? ' away' : ''}${o.turn === -90 ? ' end' : ''}`}
              style={o.turn ? { left: o.turn === 90 ? o.box.x : undefined, right: o.turn === -90 ? L.window.w - o.box.x - o.box.w : undefined, top: o.box.y - TAG_H, width: TAG_SIDE_W } : { left: o.box.x, top: o.box.y - TAG_H, width: o.box.w }}
            >
              <i className="chip" style={{ background: backColour(o.seat) }} />
              <span className="name">{name(o.seat)}</span>
              <span className="pts">{points(total(o.seat))}</span>
              {p?.bot && <em className="bot">bot</em>}
              {p?.connected === false ? <em className="flag">away</em> : st?.stuck && !frozen ? <em className="flag hot">stuck</em> : null}
            </div>
            {[o.nertz, ...o.workAt, o.stockPad, o.waste].map((r, i) => (
              <div key={i} className="slot" style={box(r)} />
            ))}
            {!dealing && (
              <b className="count" style={{ left: o.nertz.x + o.nertz.w - 9, top: o.nertz.y + o.nertz.h - 6 }}>
                {o.nertzCount}
              </b>
            )}
          </div>
        );
      })}

      {me && mine && (
        <>
          <div className="slot" style={box(me.nertz)} />
          {me.work.map((w, i) => (
            <div key={i} className="slot" style={box({ ...w, y: me.nertz.y })} />
          ))}
          <div className={`slot stock${mine.stock.length === 0 && mine.waste.length > 0 ? ' turn' : ''}`} data-stock="" style={box(me.stockPad)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12a7 7 0 0 1 12-5l2-2v6h-6l2.3-2.3A4.6 4.6 0 0 0 7.4 12ZM19 12a7 7 0 0 1-12 5l-2 2v-6h6l-2.3 2.3A4.6 4.6 0 0 0 16.6 12Z" />
            </svg>
          </div>
          <div className="slot" style={box({ ...me.waste, x: me.stock.x + me.stock.w * 1.2 })} />

          <div className="mine" style={{ right: W - (me.nertz.x + me.nertz.w), top: me.nertz.y + oh + 14 }}>
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
              style={{ left: me.stock.x, top: me.stock.y + oh + 16, width: me.box.x + me.box.w - me.stock.x }}
              onClick={(e) => {
                send({ k: 'stuck', on: !mine.stuck });
                e.currentTarget.blur(); // keep Space for dealing
              }}
            >
              {mine.stuck ? (
                <>
                  Stuck <small>{waitingOn > 0 ? `waiting on ${waitingOn} more` : 'reshuffling'}</small>
                </>
              ) : (
                <>
                  I'm stuck {active.length > waitingOn && <small>{active.length - waitingOn} stuck already</small>}
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

      {targets.map((t) => (
        <div key={t.key} className={`ring${t.key === hot ? ' hot' : ''}`} style={box(t.rect)} />
      ))}
      {/* An Ace is in hand that may go anywhere there is room: what is not room. Around every pile, the gap the rules
          keep (shared/table.ts `clash`); the edge of the felt is the other limit, and is drawn up while this lasts. */}
      {placing && L.slots.map((slot, i) => slot && game.slots[i]!.length > 0 && <div key={i} className="keepout" style={box(keepOut(L, slot, game.players.length))} />)}
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
            mini={c.s * CARD_W < MINI_BELOW}
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

      {callerBox && (
        <div className="shout" style={{ left: callerBox.x, top: callerBox.y, width: callerBox.w, height: callerBox.h, fontSize: Math.min(callerBox.w * 0.2, callerBox.h * 0.95) }}>
          <span>Nertz!</span>
        </div>
      )}

      {inGrace && room.graceMs !== null && (
        <Countdown
          ms={room.graceMs}
          top={countdownTop(L, W)}
          text={game.grace.includes(you) ? 'Put it down!' : name(game.grace[0]!) + (game.grace.length > 1 ? ` +${game.grace.length - 1}` : '')}
          label={game.grace.includes(you) ? 'Put your card down' : `Waiting for ${game.grace.map(name).join(' and ')} to put a card down`}
        />
      )}

      {finale && room.lastRound && <Finale L={L} game={game} scores={room.lastRound.scores} name={name} instant={stage === 'sheet'} />}
      {results && stage !== 'sheet' && <p className="skip">Esc skips to the scores</p>}
    </div>
    {paused && (
      <div className="paused-card" role="dialog" aria-label="Paused">
        <h2>Paused</h2>
        <p>{room.paused!.by === you ? 'You paused the round.' : `${name(room.paused!.by)} paused the round.`}</p>
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
