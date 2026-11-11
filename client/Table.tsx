// The table: every card on one absolutely-positioned layer (see layout.ts),
// plus drag and drop. All game logic is in shared/engine; this file only asks
// it "what would I pick up?" and "may I drop here?", and sends intents.
//
// Placement is exact. A dragged card lands only if it is released on one
// specific pile (the one under the pointer, else the one under the card's
// centre) and fits there; there is no click-to-play and nothing is rerouted.
import { animate, motion, useMotionValue, type MotionValue } from 'motion/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { canDrop, completedBy, DEAL_MS, GRACE_MS, grab, isHidden } from '../shared/engine';
import type { PileRef, RoomView, Suit } from '../shared/types';
import { backColour, CARD_H, CARD_W, Face } from './cards/Face';
import { Finale, TIMING } from './Finale';
import { computeLayout, COUNTDOWN, countdownTop, DEAL, dealWait, dropTarget, MINI_BELOW, type Placed, type Rect, type Stage } from './layout';
import { send } from './net';
import { calm } from './prefs';
import { stage as stageSound } from './sound';

// Durations are asked for at the moment of use: reduced motion (`calm`, see prefs.ts) can be switched while playing.
const MOVE = () => ({ duration: calm() ? 0 : 0.15, ease: 'easeOut' }) as const;
const FLIP = () => ({ duration: calm() ? 0 : 0.16, ease: 'easeInOut' }) as const;
/** Turning the middle face-down at the end of a round is slower: it is a moment, not a move. */
const TURN = () => ({ duration: calm() ? 0 : 0.42, ease: 'easeInOut' }) as const;
const Z_FLYING = 10000;
const Z_HELD = 30000;
const DRAG_SLOP = 6; // px of travel before a press becomes a drag

// ---------------------------------------------------------------- one card

interface Handle {
  x: MotionValue<number>;
  y: MotionValue<number>;
  z: MotionValue<number>;
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
  up: boolean;
  mini: boolean;
  slow: boolean;
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
  const goal = useRef({ x: p.x, y: p.y, s: p.s, z: p.z });
  const flight = useRef(0);
  const flying = useRef(!!dealt); // a card waiting in the deck keeps the deck's stacking until it has landed
  /** When this card leaves the deck (performance clock). 0 once it has, or if it was never in one: it is dealt once. */
  const leaves = useRef(dealt ? performance.now() + dealt.wait : 0);

  const fly = useCallback((move: { duration: number } = p.slow ? TURN() : MOVE()) => {
    const g = goal.current;
    const n = ++flight.current;
    flying.current = true;
    z.set(g.z + Z_FLYING); // travel above everything that is lying still
    animate(x, g.x, move);
    animate(y, g.y, move);
    animate(s, g.s, move);
    setTimeout(() => {
      if (flight.current !== n) return;
      flying.current = false;
      z.set(goal.current.z);
    }, move.duration * 1000 + 30);
  }, [x, y, s, z, p.slow]);

  useEffect(() => {
    const was = goal.current;
    goal.current = { x: p.x, y: p.y, s: p.s, z: p.z };
    if (p.reg.held.has(p.id)) return; // in the player's hand; settles on drop
    if (leaves.current) {
      // Still in the deck. If the window was resized it stays with the deck, and is dealt to its new place in its turn.
      if (p.deal) [x, y, s].forEach((v, i) => v.set([p.deal!.x, p.deal!.y, p.s][i]!));
      return;
    }
    if (was.x !== p.x || was.y !== p.y || was.s !== p.s) fly();
    else if (!flying.current) z.set(p.z);
  }, [p.x, p.y, p.s, p.z, p.id, p.reg, p.deal?.x, p.deal?.y, fly, x, y, s, z]);

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
    p.reg.handles.set(p.id, { x, y, z, settle: () => fly() });
    return () => void p.reg.handles.delete(p.id);
  }, [p.id, p.reg, x, y, z, fly]);

  return (
    <motion.div className={p.cls} data-id={p.id} style={{ x, y, scale: s, zIndex: z }}>
      <motion.div className="flip" initial={false} animate={{ rotateY: p.up ? 0 : 180 }} transition={p.slow ? TURN() : FLIP()}>
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
function useStage(results: boolean, trayPiles: number): [Stage, () => void] {
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
      ['sheet', TIMING.wash + TIMING.sort + TIMING.hold],
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
  to: PileRef | 'tray';
  rect: Rect;
  hit: Rect;
}

/** What is in hand: one of your cards (with any run on top of it), or a finished centre pile on its way to the tray. */
type Held = { k: 'card'; id: string } | { k: 'pile'; slot: number };

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
const box = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: Math.min(r.w, r.h) * 0.08 });

/** `sheet` (the scores) is laid over the table when the end-of-round sequence has played out. */
export function Table({ room, sheet }: { room: RoomView; sheet: ReactNode }) {
  const game = room.game!;
  const you = room.you;
  const results = room.phase === 'results';
  const [W, H] = useViewport();
  const [stage, skip] = useStage(results, game.tray.length);
  const stageWas = useRef(stage);
  useEffect(() => {
    stageSound(stageWas.current, stage); // the riffle of the wash, the flourish of the score sheet
    stageWas.current = stage;
  }, [stage]);
  const L = useMemo(() => computeLayout(W, H, game, you, stage), [W, H, game, you, stage]);
  const byId = useMemo(() => new Map(L.cards.map((c) => [c.card.id, c])), [L]);
  const reg = useRef<Registry>({ handles: new Map(), held: new Set() }).current;
  const drag = useRef<Drag | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const [hot, setHot] = useState<string | null>(null);

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
  const dealing = game.dealing || replaying;
  /** Nothing can be started: the cards are still being dealt, or Nertz has been called. (A card already in hand may still land during grace.) */
  const frozen = dealing || called || results;

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

  // Space flips, like clicking the stock.
  useEffect(() => {
    if (frozen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      e.preventDefault();
      send({ k: 'flip' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [frozen]);

  /** While a finished pile is in hand the tray comes a little way in from the edge to meet it. */
  const trayOpen: Rect = { ...L.tray, x: L.tray.x - L.tray.w * 0.18, w: L.tray.w * 1.18 };
  /** Exactly the piles that would take what is in hand right now. */
  const targetsFor = (h: Held): Target[] => {
    if (h.k === 'pile') return [{ key: 'tray', to: 'tray', rect: trayOpen, hit: L.trayHit }];
    const out: Target[] = [];
    L.me?.work.forEach((rect, i) => {
      if (canDrop(game, you, h.id, { k: 'work', i })) out.push({ key: `w${i}`, to: { k: 'work', i }, rect, hit: L.me!.workHit[i]! });
    });
    L.slots.forEach((rect, i) => {
      if (canDrop(game, you, h.id, { k: 'slot', i })) out.push({ key: `s${i}`, to: { k: 'slot', i }, rect, hit: L.slotHit[i]! });
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
  const targetUnder = (d: Drag): Target | undefined => {
    const h = reg.handles.get(d.lead);
    const c = byId.get(d.lead);
    const centre = h && c ? { x: h.x.get() + (c.s * CARD_W) / 2, y: h.y.get() + (c.s * CARD_H) / 2 } : null;
    return dropTarget(targetsFor(d.held), { x: d.px, y: d.py }, centre);
  };

  /** The hand opens: whatever was in it goes to wherever the layout now wants it (its new pile, or back home). */
  const letGo = (d: Drag) => {
    drag.current = null;
    reg.held.clear();
    for (const id of d.ids) reg.handles.get(id)?.settle();
    setHeld(null);
    setHot(null);
  };

  // The server can take a card out of your hand: Nertz was called and it has
  // nowhere to go, the grace window closed, or the card was buried. Then the
  // drag is over and the card goes home.
  useEffect(() => {
    const d = drag.current;
    if (!d?.active) return;
    if (d.held.k === 'card' ? mine?.holding !== d.held.id : !toClear(d.held.slot)) letGo(d);
  });

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (stage === 'flip' || stage === 'out' || stage === 'wash') return skip();
    if (frozen || drag.current || e.button !== 0) return;
    const el = (e.target as Element).closest('[data-id],[data-stock]');
    if (!el) return;
    const id = el.getAttribute('data-id');
    const placed = id ? byId.get(id) : undefined;
    if (!id || (placed?.mine && placed.pile === 'stock')) return void send({ k: 'flip' });
    let pick: Pick<Drag, 'held' | 'ids' | 'lead'> | null = null;
    if (placed?.pile === 'slot' && toClear(placed.at)) {
      const ids = L.cards.filter((c) => c.pile === 'slot' && c.at === placed.at).map((c) => c.card.id);
      pick = { held: { k: 'pile', slot: placed.at }, ids, lead: ids[ids.length - 1]! };
    } else if (placed?.mine) {
      const g = grab(game, you, id);
      if (g) pick = { held: { k: 'card', id }, ids: g.cards.map((c) => c.id), lead: id };
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
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    [d.px, d.py] = [e.clientX, e.clientY];
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.active) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      // The drag starts here, and the server is told: who holds what decides the grace window.
      if (d.held.k === 'card' && !send({ k: 'hold', cardId: d.held.id })) return void (drag.current = null);
      d.active = true;
      for (const id of d.ids) reg.held.add(id);
      setHeld(d.held);
    }
    d.ids.forEach((id, i) => {
      const h = reg.handles.get(id);
      h?.x.set(d.base[i]!.x + dx);
      h?.y.set(d.base[i]!.y + dy);
      h?.z.set(Z_HELD + i);
    });
    setHot(targetUnder(d)?.key ?? null);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    if (!d.active) return void (drag.current = null);
    // A drop. Only the pile it was released on counts; anywhere else the card is put back. If the move is
    // refused by the server a moment later (someone got there first) the card animates home just the same,
    // and the server takes it out of our hand by itself.
    [d.px, d.py] = [e.clientX, e.clientY];
    const t = targetUnder(d);
    if (d.held.k === 'pile') {
      if (t) send({ k: 'clear', slot: d.held.slot });
    } else if (!t || t.to === 'tray' || !send({ k: 'move', cardId: d.held.id, count: d.ids.length, to: t.to })) {
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
    if (c.pile === 'slot' && game.slots[c.at]?.length === 13) cls += toClear(c.at) ? ' grab' : stage === 'live' ? ' done' : '';
    if (c.mine && !frozen) {
      if (c.pile === 'stock') cls += ' tap';
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

  return (
    <>
    <div
      className={`table${held ? ' dragging' : ''}${frozen ? ' frozen' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {L.slots.map((slot, i) => {
        const full = game.slots[i]?.length === 13 && stage === 'live' && !(held?.k === 'pile' && held.slot === i);
        return (
          <div key={i} className={`slot centre${full ? (toClear(i) ? ' yours' : ' done') : ''}`} style={box(slot)}>
            {full && toClear(i) && <em>Drag to tray</em>}
          </div>
        );
      })}
      <div className={`tray${held?.k === 'pile' ? ' open' : waiting ? ' wanted' : ''}${hot === 'tray' ? ' hot' : ''}${finale ? ' gone' : ''}`} style={box(held?.k === 'pile' ? trayOpen : L.tray)} />

      {L.opponents.map((o) => {
        const p = info(o.seat);
        const st = game.players.find((g) => g.seat === o.seat);
        return (
          <div key={o.seat}>
            <div className={`tag${p?.connected === false ? ' away' : ''}`} style={{ left: o.box.x, top: o.box.y - 28, width: o.box.w }}>
              <i className="chip" style={{ background: backColour(o.seat) }} />
              <span className="name">{name(o.seat)}</span>
              <span className="pts">{points(total(o.seat))}</span>
              {p?.bot && <em className="bot">bot</em>}
              {p?.connected === false ? <em className="flag">away</em> : st?.stuck && !frozen ? <em className="flag hot">stuck</em> : null}
            </div>
            {[o.nertz, ...o.work.map((w) => ({ ...w, y: o.nertz.y })), o.stock, o.waste].map((r, i) => (
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
          <div className={`slot stock${mine.stock.length === 0 && mine.waste.length > 0 ? ' turn' : ''}`} data-stock="" style={box(me.stock)}>
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
                e.currentTarget.blur(); // keep Space for flipping
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
            up={c.up && !replaying}
            mini={c.s * CARD_W < MINI_BELOW}
            slow={results && (c.pile === 'slot' || c.pile === 'tray')}
            cls={cardClass(c)}
            reg={reg}
            deal={deck.get(c.card.id)}
          />
        );
      })}

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
      {results && stage !== 'sheet' && <p className="skip">Click anywhere to skip to the scores</p>}
    </div>
    {stage === 'sheet' && sheet}
    </>
  );
}
