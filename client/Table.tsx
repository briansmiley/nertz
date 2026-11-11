// The table: every card on one absolutely-positioned layer (see layout.ts),
// plus drag and drop. All game logic is in shared/engine; this file only asks
// it "what would I pick up?" and "may I drop here?", and sends intents.
import { animate, motion, useMotionValue, type MotionValue } from 'motion/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { bestFoundation, canDrop, grab, isHidden } from '../shared/engine';
import type { PileRef, RoomView, Suit } from '../shared/types';
import { backColour, CARD_W, Face } from './cards/Face';
import { computeLayout, MINI_BELOW, type Placed, type Rect } from './layout';
import { send } from './net';

const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const MOVE = { duration: calm ? 0 : 0.15, ease: 'easeOut' } as const;
const FLIP = { duration: calm ? 0 : 0.16, ease: 'easeInOut' } as const;
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
  /** "No" shake. */
  nudge(): void;
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
  cls: string;
  reg: Registry;
}

const CardView = memo(function CardView(p: CardProps) {
  const x = useMotionValue(p.x);
  const y = useMotionValue(p.y);
  const s = useMotionValue(p.s);
  const z = useMotionValue(p.z);
  const goal = useRef({ x: p.x, y: p.y, s: p.s, z: p.z });
  const flight = useRef(0);
  const flying = useRef(false);

  const fly = useCallback(() => {
    const g = goal.current;
    const n = ++flight.current;
    flying.current = true;
    z.set(g.z + Z_FLYING); // travel above everything that is lying still
    animate(x, g.x, MOVE);
    animate(y, g.y, MOVE);
    animate(s, g.s, MOVE);
    setTimeout(() => {
      if (flight.current !== n) return;
      flying.current = false;
      z.set(goal.current.z);
    }, MOVE.duration * 1000 + 30);
  }, [x, y, s, z]);

  useEffect(() => {
    const was = goal.current;
    goal.current = { x: p.x, y: p.y, s: p.s, z: p.z };
    if (p.reg.held.has(p.id)) return; // in the player's hand; settles on drop
    if (was.x !== p.x || was.y !== p.y || was.s !== p.s) fly();
    else if (!flying.current) z.set(p.z);
  }, [p.x, p.y, p.s, p.z, p.id, p.reg, fly, z]);

  useEffect(() => {
    const nudge = () => void animate(x, [goal.current.x - 5, goal.current.x + 5, goal.current.x], { duration: 0.16 });
    p.reg.handles.set(p.id, { x, y, z, settle: fly, nudge });
    return () => void p.reg.handles.delete(p.id);
  }, [p.id, p.reg, x, y, z, fly]);

  return (
    <motion.div className={p.cls} data-id={p.id} style={{ x, y, scale: s, zIndex: z }}>
      <motion.div className="flip" initial={false} animate={{ rotateY: p.up ? 0 : 180 }} transition={FLIP}>
        <div className="front">{p.suit && p.rank ? <Face suit={p.suit} rank={p.rank} mini={p.mini} /> : null}</div>
        <div className="back" style={{ '--back': backColour(p.owner) } as CSSProperties} />
      </motion.div>
    </motion.div>
  );
});

// ---------------------------------------------------------------- the table

interface Target {
  key: string;
  to: PileRef;
  rect: Rect;
}

interface Drag {
  pointer: number;
  id: string;
  ids: string[];
  sx: number;
  sy: number;
  base: { x: number; y: number }[];
  active: boolean;
  legal: Target[];
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

const box = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: r.w * 0.08 });

/** `frozen`: the round is over; show the table but accept no input. */
export function Table({ room, frozen = false }: { room: RoomView; frozen?: boolean }) {
  const game = room.game!;
  const you = room.you;
  const [W, H] = useViewport();
  const L = useMemo(() => computeLayout(W, H, game, you), [W, H, game, you]);
  const byId = useMemo(() => new Map(L.cards.map((c) => [c.card.id, c])), [L]);
  const reg = useRef<Registry>({ handles: new Map(), held: new Set() }).current;
  const drag = useRef<Drag | null>(null);
  const [legal, setLegal] = useState<Target[] | null>(null);
  const [hot, setHot] = useState<string | null>(null);

  const mine = game.players.find((p) => p.seat === you);
  const over = frozen || game.nertzCalledBy !== null;
  const info = (seat: number) => room.players.find((p) => p.seat === seat);

  // Space flips, like clicking the stock.
  useEffect(() => {
    if (over) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      e.preventDefault();
      send({ k: 'flip' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [over]);

  /** Every pile the held card may legally be dropped on, for highlighting. */
  const legalTargets = (cardId: string): Target[] => {
    const out: Target[] = [];
    if (!L.me) return out;
    L.me.work.forEach((rect, i) => {
      const to: PileRef = { k: 'work', i };
      if (canDrop(game, you, cardId, to)) out.push({ key: `w${i}`, to, rect });
    });
    for (const slot of L.slots) {
      if (!slot.id) {
        if (canDrop(game, you, cardId, { k: 'newFoundation' })) out.push({ key: 'new', to: { k: 'newFoundation' }, rect: slot });
        break;
      }
      const to: PileRef = { k: 'foundation', id: slot.id };
      if (canDrop(game, you, cardId, to)) out.push({ key: `f${slot.id}`, to, rect: slot });
    }
    return out;
  };

  /**
   * What a drop at this point means. Deliberately generous: anywhere above
   * your hand is "the foundations" (the nearest one that takes the card; the
   * engine falls back to any other that does), and anywhere in a work pile's
   * column is that pile.
   */
  const targetAt = (d: Drag, px: number, py: number): { key: string; to: PileRef } | null => {
    if (!L.me) return null;
    if (py < L.horizon) {
      const centre = (r: Rect) => Math.hypot(r.x + r.w / 2 - px, r.y + r.h / 2 - py);
      const near = d.legal.filter((t) => t.to.k !== 'work').sort((a, b) => centre(a.rect) - centre(b.rect))[0];
      return near ?? { key: 'none', to: { k: 'newFoundation' } };
    }
    const w = L.me.nertz.w;
    const half = (L.me.work[1]!.x - L.me.work[0]!.x - w) / 2;
    const i = L.me.work.findIndex((r) => px >= r.x - half && px <= r.x + w + half);
    return i < 0 ? null : { key: `w${i}`, to: { k: 'work', i } };
  };

  const release = (d: Drag) => {
    reg.held.clear();
    for (const id of d.ids) reg.handles.get(id)?.settle();
    setLegal(null);
    setHot(null);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (over || drag.current || e.button !== 0) return;
    const el = (e.target as Element).closest('[data-id],[data-stock]');
    if (!el) return;
    const id = el.getAttribute('data-id');
    const placed = id ? byId.get(id) : undefined;
    if (!id || (placed?.mine && placed.pile === 'stock')) return void send({ k: 'flip' });
    const g = placed?.mine ? grab(game, you, id) : null;
    if (!g) return;
    const ids = g.cards.map((c) => c.id);
    drag.current = {
      pointer: e.pointerId,
      id,
      ids,
      sx: e.clientX,
      sy: e.clientY,
      base: ids.map((i) => ({ x: byId.get(i)!.x, y: byId.get(i)!.y })),
      active: false,
      legal: [],
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.active) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      d.active = true;
      d.legal = legalTargets(d.id);
      for (const id of d.ids) reg.held.add(id);
      setLegal(d.legal);
    }
    d.ids.forEach((id, i) => {
      const h = reg.handles.get(id);
      h?.x.set(d.base[i]!.x + dx);
      h?.y.set(d.base[i]!.y + dy);
      h?.z.set(Z_HELD + i);
    });
    setHot(targetAt(d, e.clientX, e.clientY)?.key ?? null);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    if (d.active) {
      // A drop. If the move is refused (now, or by the server a moment later) the card just animates home.
      const t = targetAt(d, e.clientX, e.clientY);
      if (t) send({ k: 'move', cardId: d.id, to: t.to });
      release(d);
    } else {
      // A click: play it to a foundation if one takes it.
      const to = d.ids.length === 1 ? bestFoundation(game, d.id) : null;
      if (!to || !send({ k: 'move', cardId: d.id, to })) reg.handles.get(d.id)?.nudge();
    }
  };

  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    release(d);
  };

  const cardClass = (c: Placed): string => {
    let cls = 'card';
    if (c.done) cls += ' done';
    if (c.mine && !over) {
      if (c.pile === 'stock') cls += ' tap';
      else if (c.up) cls += ' grab';
    }
    return cls;
  };

  const me = L.me;
  const active = game.players.filter((p) => info(p.seat)?.connected);
  const waitingOn = active.filter((p) => !p.stuck).length;
  const oh = me ? me.nertz.h : 0;

  return (
    <div
      className={`table${legal ? ' dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {L.slots.map((slot, i) => (
        <div key={i} className={`slot foundation${slot.done ? ' done' : ''}`} style={box(slot)} />
      ))}

      {L.opponents.map((o) => {
        const p = info(o.seat);
        const st = game.players.find((g) => g.seat === o.seat);
        return (
          <div key={o.seat}>
            <div className={`tag${p?.connected === false ? ' away' : ''}`} style={{ left: o.box.x, top: o.box.y - 28, width: o.box.w }}>
              <i className="chip" style={{ background: backColour(o.seat) }} />
              <span className="name">{p?.name ?? `Seat ${o.seat + 1}`}</span>
              <span className="pts">{p?.score ?? 0}</span>
              {p?.connected === false ? <em className="flag">away</em> : st?.stuck ? <em className="flag hot">stuck</em> : null}
            </div>
            {[o.nertz, ...o.work.map((w) => ({ ...w, y: o.nertz.y })), o.stock, o.waste].map((r, i) => (
              <div key={i} className="slot" style={box(r)} />
            ))}
            <b className="count" style={{ left: o.nertz.x + o.nertz.w - 9, top: o.nertz.y + o.nertz.h - 6 }}>
              {o.nertzCount}
            </b>
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
            <span className="left" style={{ visibility: me.nertzCount ? 'visible' : 'hidden' }}>
              <b>{me.nertzCount}</b> in your nertz pile
            </span>
            <span className="who">
              <i className="chip" style={{ background: backColour(you) }} />
              {info(you)?.name} <b>{info(you)?.score ?? 0}</b>
            </span>
            <span className="where">
              Round {room.round} at table {room.code}
            </span>
          </div>

          {!over && (
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

          {!over && me.nertzCount === 0 && (
            <button
              type="button"
              className="nertz"
              style={{ left: me.nertz.x + me.nertz.w / 2, top: me.nertz.y + oh / 2, width: me.nertz.w * 1.7, height: me.nertz.w * 1.7 }}
              onClick={() => send({ k: 'nertz' })}
            >
              Nertz!
            </button>
          )}
        </>
      )}

      {legal?.map((t) => (
        <div key={t.key} className={`ring${t.key === hot ? ' hot' : ''}`} style={box(t.rect)} />
      ))}

      {L.cards.map((c) => {
        const known = isHidden(c.card) ? null : c.card;
        return (
          <CardView
            key={c.card.id}
            id={c.card.id}
            owner={c.card.owner}
            suit={known?.suit}
            rank={known?.rank}
            x={c.x}
            y={c.y}
            s={c.s}
            z={c.z}
            up={c.up}
            mini={c.s * CARD_W < MINI_BELOW}
            cls={cardClass(c)}
            reg={reg}
          />
        );
      })}
    </div>
  );
}
