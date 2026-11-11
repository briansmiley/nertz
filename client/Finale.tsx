// The end of a round, played on the table: every card that reached the middle
// is washed (spread and swirled, backs up) and then sorted into one pile per
// player. Up to ~300 cards move at once, so they are drawn on one canvas from
// pre-rendered back sprites instead of being 300 animated elements; the
// labels under the piles are ordinary DOM.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameState, RoundScore } from '../shared/types';
import { backColour, CARD_H, CARD_W } from './cards/Face';
import type { Layout } from './layout';

/** How long each step of the end-of-round sequence takes (ms). */
export const TIMING = { flip: 520, out: 620, wash: 1600, sort: 1200, hold: 1150 };
const SPREAD_MS = 560; // a card's trip from its pile out into the wash
const LAND_MS = 420; // a card's trip from the wash onto its owner's pile
const LABEL_H = 70; // room under a sorted pile for its name, count and penalty
const SWIRL = 2.5; // radians the wash turns through

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
/** Repeatable noise in [0, 1): the same card gets the same path on every frame and after a resize. */
function noise(i: number, salt: number): number {
  let t = (Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

interface Mover {
  owner: number;
  /** Start: the pile it lay in. */
  x: number;
  y: number;
  /** Place in the wash: angle and radius (0..1) around the middle, and how far it turns. */
  angle: number;
  radius: number;
  spin: number;
  delay: number;
  /** Destination: which sorted pile, and its place in it. */
  pile: number;
  k: number;
  of: number;
  tilt: number;
}

interface Plan {
  /** The part of the window the cards can reach; the canvas covers only this. */
  area: { x: number; y: number; w: number; h: number };
  movers: Mover[];
  piles: { seat: number; x: number; y: number; total: number }[];
  w: number;
  h: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** Geometry of the whole sequence. Pure, so a resize mid-way just continues with new numbers. */
export function planFinale(L: Layout, game: GameState): Plan {
  const w = L.fs * CARD_W;
  const h = L.fs * CARD_H;
  const m = L.middle;
  const n = game.players.length;
  const step = Math.min(Math.max(w * 2.6, 150), m.w / n); // wide enough for the labels where the window allows
  const y = m.y + Math.max(-h * 0.15, (m.h - h - LABEL_H) / 2); // pile and label together sit in the middle of the free felt
  const piles = game.players.map((p, i) => ({ seat: p.seat, x: m.x + m.w / 2 + (i - (n - 1) / 2) * step - w / 2, y, total: 0 }));
  const pileOf = new Map(piles.map((p, i) => [p.seat, i]));

  const lying = [...game.slots.map((pile, i) => ({ pile, at: L.slots[i] })), ...game.tray.map((pile, i) => ({ pile, at: L.out[i] }))];
  const movers = lying.flatMap(({ pile, at }) =>
    pile.flatMap((card): Mover[] => {
      const to = pileOf.get(card.owner);
      return at && to !== undefined ? [{ owner: card.owner, x: at.x, y: at.y, angle: 0, radius: 0, spin: 0, delay: 0, pile: to, k: 0, of: 0, tilt: 0 }] : [];
    }),
  );
  // Draw order is shuffled so the colours mix in the wash; a card's place in its sorted pile follows the draw order.
  const order = movers.map((_, i) => noise(i, 1));
  const shuffled = movers.map((mv, i) => ({ mv, o: order[i]! })).sort((a, b) => a.o - b.o).map((e) => e.mv);
  shuffled.forEach((mv, i) => {
    mv.angle = noise(i, 2) * Math.PI * 2;
    mv.radius = Math.sqrt(0.04 + 0.96 * noise(i, 3)); // even over the disc
    mv.spin = (noise(i, 4) - 0.5) * 2.4 * Math.PI;
    mv.delay = noise(i, 5);
    mv.tilt = (noise(i, 6) - 0.5) * 0.14;
    mv.k = piles[mv.pile]!.total++;
  });
  for (const mv of shuffled) mv.of = piles[mv.pile]!.total;
  const reach = Math.hypot(w, h) / 2 + 8; // a card turned to any angle, plus its shadow
  const area = { x: 0, y: Math.floor(m.y - reach - h * 0.3), w: m.x * 2 + m.w, h: Math.ceil(m.h + 2 * reach + h * 0.6) };
  return { area, movers: shuffled, piles, w, h, cx: m.x + m.w / 2, cy: m.y + m.h / 2, rx: Math.max(w, Math.min(m.w * 0.42, m.h * 2.2) - w / 2), ry: Math.max(h * 0.3, m.h / 2 - h * 0.1) };
}

/** One card back, drawn once per colour and then stamped for every card of that deck. Matches `.back` in styles.css. */
function backSprite(colour: string, w: number, h: number, dpr: number): HTMLCanvasElement {
  const pad = Math.ceil(w * 0.08);
  const sprite = document.createElement('canvas');
  sprite.width = Math.ceil((w + 2 * pad) * dpr);
  sprite.height = Math.ceil((h + 2 * pad) * dpr);
  const c = sprite.getContext('2d')!;
  const u = w / CARD_W; // one CSS px of the 90x126 drawing
  c.scale(dpr, dpr);
  c.translate(pad, pad);
  c.shadowColor = 'rgba(0, 0, 0, 0.34)';
  c.shadowBlur = 2.5 * u * dpr;
  c.shadowOffsetY = 1.5 * u * dpr;
  c.fillStyle = '#fffdf7';
  c.beginPath();
  c.roundRect(0, 0, w, h, 7 * u);
  c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = 0.6;
  c.strokeStyle = 'rgba(20, 30, 40, 0.5)';
  c.stroke();

  const b = 4.5 * u;
  c.beginPath();
  c.roundRect(b, b, w - 2 * b, h - 2 * b, 2.5 * u);
  c.fillStyle = colour;
  c.fill();
  c.save();
  c.clip();
  c.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  c.lineWidth = 1.3 * u;
  c.beginPath();
  for (let d = -h; d < w + h; d += 7 * Math.SQRT2 * u) {
    c.moveTo(d, 0);
    c.lineTo(d + h, h);
    c.moveTo(d + h, 0);
    c.lineTo(d, h);
  }
  c.stroke();
  const ray = Math.hypot(w / 2 - b, h / 2 - b);
  c.fillStyle = 'rgba(255, 255, 255, 0.85)';
  c.beginPath();
  c.arc(w / 2, h / 2, ray * 0.21, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = colour;
  c.beginPath();
  c.arc(w / 2, h / 2, ray * 0.17, 0, Math.PI * 2);
  c.fill();
  c.restore();
  c.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  c.lineWidth = 1.2 * u;
  c.beginPath();
  c.roundRect(b, b, w - 2 * b, h - 2 * b, 2.5 * u);
  c.stroke();
  return sprite;
}

/** Draws the table `t` ms into the wash and returns how many cards have landed on each sorted pile. */
function paint(c: CanvasRenderingContext2D, plan: Plan, sprites: Map<number, HTMLCanvasElement>, dpr: number, t: number): number[] {
  const { w, h } = plan;
  const pad = Math.ceil(w * 0.08);
  const landed = plan.piles.map(() => 0);
  const u = clamp01(t / TIMING.wash);
  const turn = SWIRL * easeInOut(u);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, c.canvas.width, c.canvas.height);
  const stamp = (mv: Mover, x: number, y: number, rot: number) => {
    const cos = Math.cos(rot) * dpr;
    const sin = Math.sin(rot) * dpr;
    c.setTransform(cos, sin, -sin, cos, (x + w / 2 - plan.area.x) * dpr, (y + h / 2 - plan.area.y) * dpr);
    c.drawImage(sprites.get(mv.owner)!, -w / 2 - pad, -h / 2 - pad, w + 2 * pad, h + 2 * pad);
  };
  const flying: [Mover, number, number, number][] = [];
  for (const mv of plan.movers) {
    const pile = plan.piles[mv.pile]!;
    const q = easeInOut(clamp01((t - TIMING.wash - (mv.k / mv.of) * (TIMING.sort - LAND_MS)) / LAND_MS));
    // A sorted pile leans up and to the left a little with every card, so its thickness shows.
    const rise = Math.min(0.45, (h * 0.16) / mv.of) * mv.k;
    if (q >= 1) {
      landed[mv.pile]!++;
      stamp(mv, pile.x - rise * 0.4, pile.y - rise, mv.tilt);
      continue;
    }
    // In the wash: out from its pile to a spot on the disc, which then turns (the inside faster) and breathes.
    const spread = easeOut(clamp01((t - mv.delay * 280) / SPREAD_MS));
    const a = mv.angle + turn * (1.3 - 0.75 * mv.radius);
    const r = mv.radius * (1 + 0.1 * Math.sin(u * Math.PI * 3 + mv.angle * 3));
    let x = lerp(mv.x, plan.cx + Math.cos(a) * r * plan.rx - w / 2, spread);
    let y = lerp(mv.y, plan.cy + Math.sin(a) * r * plan.ry - h / 2, spread);
    let rot = mv.spin * (0.45 + 0.75 * u) * spread;
    if (q > 0) {
      x = lerp(x, pile.x - rise * 0.4, q);
      y = lerp(y, pile.y - rise, q);
      rot = lerp(rot, mv.tilt, q);
    }
    flying.push([mv, x, y, rot]);
  }
  for (const f of flying) stamp(...f); // cards in the air pass over the piles
  return landed;
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

interface Props {
  L: Layout;
  game: GameState;
  scores: readonly RoundScore[];
  name: (seat: number) => string;
  /** Show the finished picture at once (skipped, reduced motion, or arriving after the fact). */
  instant: boolean;
}

export function Finale({ L, game, scores, name, instant }: Props) {
  const plan = useMemo(() => planFinale(L, game), [L, game]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const began = useRef(0);
  const [landed, setLanded] = useState<number[]>(() => plan.piles.map((p) => (instant ? p.total : 0)));
  const [sorting, setSorting] = useState(instant);
  const [sorted, setSorted] = useState(instant);

  useEffect(() => {
    const el = canvas.current;
    const c = el?.getContext('2d');
    if (!el || !c) return;
    const full = Math.min(2, window.devicePixelRatio || 1);
    let scale = full;
    let sprites = new Map<number, HTMLCanvasElement>();
    const setup = (k: number) => {
      scale = k;
      el.width = Math.round(plan.area.w * k);
      el.height = Math.round(plan.area.h * k);
      sprites = new Map(plan.piles.map((p) => [p.seat, backSprite(backColour(p.seat), plan.w, plan.h, k)]));
    };
    setup(full);
    began.current ||= performance.now();
    const end = TIMING.wash + TIMING.sort;
    let raf = 0;
    let shown = '';
    let last = 0;
    let late = 0;
    const frame = (now: number) => {
      const t = instant ? end : now - began.current;
      // Measured, not guessed: if this machine keeps missing frames at full resolution (a high-density screen
      // without a GPU), draw the moving cards at 1x. Nobody can tell while they move, and the piles they come
      // to rest in are redrawn sharp below.
      if (scale > 1 && last && now - last > 24 && ++late >= 5) setup(1);
      last = now;
      if (t >= end && scale < full) setup(full);
      const counts = paint(c, plan, sprites, scale, t);
      if (counts.join() !== shown) {
        shown = counts.join();
        setLanded(counts);
      }
      if (t >= TIMING.wash) setSorting(true);
      if (t >= end) return setSorted(true);
      raf = requestAnimationFrame(frame);
    };
    frame(performance.now());
    return () => cancelAnimationFrame(raf);
  }, [plan, instant]);

  return (
    <>
      <canvas ref={canvas} className="wash" style={{ left: plan.area.x, top: plan.area.y, width: plan.area.w, height: plan.area.h }} />
      {plan.piles.map((p, i) => {
        const left = scores.find((s) => s.seat === p.seat)?.nertzLeft ?? 0;
        return (
          <div key={p.seat} className={`heap${sorting ? ' on' : ''}${sorted ? ' sorted' : ''}`} style={{ left: p.x + plan.w / 2, top: p.y + plan.h + 8 }}>
            <span className="who">{name(p.seat)}</span>
            <b className="got">{signed(landed[i] ?? 0)}</b>
            <span className={`fine${left ? '' : ' none'}`}>
              {left ? (
                <>
                  <b>{signed(-2 * left)}</b> {left} nertz left
                </>
              ) : (
                'no nertz left'
              )}
            </span>
          </div>
        );
      })}
    </>
  );
}
