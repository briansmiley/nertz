// Card backs drawn here, not fetched: each is a small SVG picture, white on nothing, that is laid over the player's
// colour like the one-colour picture backs (`backOf` in Face.tsx). A card is 90 x 126; every back has the same white
// edge and a thin line inside it, and its own pattern in the field within.
import type { Back } from '../../shared/protocol';

const W = 90;
const H = 126;
const n = (v: number): string => (Math.round(v * 100) / 100).toString();
const pts = (p: readonly (readonly [number, number])[]): string => p.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join('');

/** The field the pattern fills: inside the edge and the thin line. */
const F = { x: 9, y: 9, w: W - 18, h: H - 18 };

/**
 * Set while a back is drawn without its edge (`drawnBack`): the picture is then only the field, drawn larger. The
 * field is a little taller for its width than the card, so either its width is fitted to the card's and a sliver of
 * its top and bottom is lost ('fill': a pattern that covers the field), or its height is, and it stops just short of
 * the sides ('fit': a single figure on bare ground, where that does not show and nothing of the figure is lost).
 */
let bare: 'fill' | 'fit' | null = null;

// (Each picture says how large it is, 90 by 126: without that it has no size of its own, and the end-of-round canvas,
// which draws a back by its picture's own size, drew only a part of it, out of shape.)
const frame = (body: string, stroke = 1.3, small = false): string =>
  bare
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${bare === 'fill' ? `${F.x} ${n(F.y + (F.h - (F.w * H) / W) / 2)} ${F.w} ${n((F.w * H) / W)}` : `${n(W / 2 - (F.h * W) / H / 2)} ${F.y} ${n((F.h * W) / H)} ${F.h}`}" preserveAspectRatio="none">` +
      `<g fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`
    : framed(body, stroke, small);

const framed = (body: string, stroke: number, small: boolean): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
  `<path fill="#fff" fill-rule="evenodd" d="M0 0H${W}V${H}H0ZM4.5 7.5a3 3 0 0 1 3-3H${W - 7.5}a3 3 0 0 1 3 3V${H - 7.5}a3 3 0 0 1-3 3H7.5a3 3 0 0 1-3-3Z"/>` +
  `<g fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">` +
  `${small ? '' : `<rect x="6.6" y="6.6" width="${W - 13.2}" height="${H - 13.2}" rx="1.6" stroke-width="0.7"/>`}${body}</g></svg>`;

/** A fixed stream of numbers in 0..1: the same picture every time. */
function dice(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Hilbert curve: one line that visits every cell of a 16 x 16 grid, stretched over the field. */
function hilbert(small: boolean): string {
  const order = small ? 8 : 16; // a small card has one nesting less
  const d2xy = (d: number): [number, number] => {
    let [x, y, t] = [0, 0, d];
    for (let s = 1; s < order; s *= 2) {
      const rx = 1 & (t / 2);
      const ry = 1 & (t ^ rx);
      if (ry === 0) {
        if (rx === 1) [x, y] = [s - 1 - x, s - 1 - y];
        [x, y] = [y, x];
      }
      x += s * rx;
      y += s * ry;
      t = Math.floor(t / 4);
    }
    return [x, y];
  };
  const cw = (F.w - 4) / (order - 1);
  const ch = (F.h - 4) / (order - 1);
  const line = Array.from({ length: order * order }, (_, d) => d2xy(d)).map(([x, y]) => [F.x + 2 + x * cw, F.y + 2 + y * ch] as const);
  return frame(`<path d="${pts(line)}"/>`, small ? 2.5 : 1.2, small);
}

/**
 * A Greek key: bands of meander, each one unbroken line. In every turn of it the line winds into the middle of a
 * square, doubles back there, and winds out again between its own coils, to run on along the foot of the band into
 * the next turn. Every line is the same distance from the next, within a turn, from turn to turn and from band to
 * band. Every other band runs the other way.
 */
function key(small: boolean): string {
  const across = small ? 2 : 3; // turns of the key in a band
  // One turn is 12 across and 10 high, in steps of half the gap between one line and the next.
  const TURN: [number, number][] = [[0, 10], [0, 0], [10, 0], [10, 8], [4, 8], [4, 4], [6, 4], [6, 6], [8, 6], [8, 2], [2, 2], [2, 10], [12, 10]];
  const u = (F.w * 0.97) / (across * 12);
  const bands = Math.floor((F.h + 2 * u) / (12 * u)); // a band and the gap under it are 12 high
  const top0 = H / 2 - ((bands * 12 - 2) * u) / 2;
  let d = '';
  for (let b = 0; b < bands; b++) {
    const line: [number, number][] = [];
    for (let k = 0; k < across; k++) for (const [x, y] of k ? TURN.slice(1) : TURN) line.push([k * 12 + x, y]);
    // (Both its ends run off along the foot of the band into the card's border.)
    const out = (W / 2 - (small ? 4.5 : 6.6)) / u - across * 6;
    line.unshift([-out, 10]);
    line.push([across * 12 + out, 10]);
    d += pts(line.map(([x, y]) => [b % 2 ? W / 2 + (across * 6 - x) * u : W / 2 + (x - across * 6) * u, top0 + (b * 12 + y) * u] as const));
  }
  return frame(`<path d="${d}" stroke-linecap="butt" stroke-linejoin="miter"/>`, small ? 1.9 : 1.15, small);
}

/** Braids: columns of two strands twisted round each other, each passing under the other in turn. */
function braid(small: boolean): string {
  const cols = small ? 3 : 5;
  const turns = small ? 5 : 9; // half-turns down the card
  const cw = F.w / cols;
  const amp = cw * 0.3;
  const half = F.h / turns;
  let d = '';
  for (let c = 0; c < cols; c++) {
    const cx = F.x + (c + 0.5) * cw;
    for (const side of [1, -1]) {
      // The strands cross at every half-turn; this one goes under at every other crossing, where it is left out.
      let run: [number, number][] = [];
      const steps = turns * 14;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const y = F.y + t * F.h;
        const phase = (t * turns) % 1; // 0 at a crossing
        const crossing = Math.round(t * turns);
        const under = (crossing + (side > 0 ? 0 : 1) + c) % 2 === 0 && Math.min(phase, 1 - phase) * half < (small ? 3 : 1.5) && crossing > 0 && crossing < turns;
        if (under) {
          if (run.length > 1) d += pts(run);
          run = [];
        } else run.push([cx + side * amp * Math.sin(Math.PI * t * turns), y]);
      }
      if (run.length > 1) d += pts(run);
    }
  }
  return frame(`<path d="${d}"/>`, small ? 3.2 : 1.7, small);
}

/** Loops: quarter-circles in every square of a grid, turned this way or that by a fixed roll of the dice, which join up into wandering loops. */
function loops(small: boolean): string {
  const cols = small ? 4 : 8;
  const rows = small ? 6 : 12;
  const cw = F.w / cols;
  const ch = F.h / rows;
  const roll = dice(7);
  let d = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [x, y] = [F.x + c * cw, F.y + r * ch];
      const arc = (x0: number, y0: number, x1: number, y1: number, sweep: number) => `M${n(x0)} ${n(y0)}A${n(cw / 2)} ${n(ch / 2)} 0 0 ${sweep} ${n(x1)} ${n(y1)}`;
      d += roll() < 0.5 ? arc(x + cw / 2, y, x, y + ch / 2, 1) + arc(x + cw, y + ch / 2, x + cw / 2, y + ch, 1) : arc(x + cw / 2, y, x + cw, y + ch / 2, 0) + arc(x, y + ch / 2, x + cw / 2, y + ch, 0);
    }
  }
  return frame(`<path d="${d}"/>`, small ? 2.6 : 1.3, small);
}

/** Rings: rows of circles, each overlapping its neighbours, like mail. */
function rings(small: boolean): string {
  const across = small ? 3 : 6;
  const step = F.w / across;
  const rad = step * 0.72;
  let body = `<clipPath id="f"><rect x="${F.x}" y="${F.y}" width="${F.w}" height="${F.h}"/></clipPath><g clip-path="url(#f)">`;
  for (let r = -1; r * step * 0.5 <= F.h + step; r++) {
    for (let c = -1; c <= across + 1; c++) body += `<circle cx="${n(F.x + (c + (r % 2 ? 0.5 : 0)) * step)}" cy="${n(F.y + r * step * 0.5)}" r="${n(rad)}"/>`;
  }
  return frame(`${body}</g>`, small ? 1.8 : 0.8, small);
}

/** A rosette such as is engraved on banknotes: one line wound round and round, inside another, with small ones in the corners. */
function rosette(small: boolean): string {
  const wind = (cx: number, cy: number, rx: number, ry: number, lobes: number, depth: number, turns: number): string => {
    const line: [number, number][] = [];
    const steps = 360 * turns;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2 * turns;
      const k = 1 - depth + depth * Math.cos((lobes / turns) * t);
      line.push([cx + rx * k * Math.cos(t), cy + ry * k * Math.sin(t)]);
    }
    return `<path d="${pts(line)}Z"/>`;
  };
  const [cx, cy] = [W / 2, H / 2];
  if (small) return frame(wind(cx, cy, F.w * 0.47, F.h * 0.42, 9, 0.45, 2), 1.5, true); // one winding, fewer lobes
  let body = wind(cx, cy, F.w * 0.47, F.h * 0.4, 17, 0.42, 4) + wind(cx, cy, F.w * 0.25, F.h * 0.21, 11, 0.5, 3);
  for (const [x, y] of [[F.x + 8, F.y + 8], [F.x + F.w - 8, F.y + 8], [F.x + 8, F.y + F.h - 8], [F.x + F.w - 8, F.y + F.h - 8]] as const) body += wind(x, y, 7, 7, 7, 0.45, 2);
  return frame(body, 0.55);
}

/**
 * A Voronoi pattern: points scattered over the field (one to each square of a grid, anywhere in it, by a fixed roll
 * of the dice), and round each the patch of the field that is nearer to it than to any other: drawn a little short
 * of its edges, like paving.
 */
function voronoi(small: boolean): string {
  const cols = small ? 3 : 6;
  const rows = small ? 4 : 8;
  const roll = dice(11);
  const sites: [number, number][] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) sites.push([F.x + ((c + 0.12 + 0.76 * roll()) * F.w) / cols, F.y + ((r + 0.12 + 0.76 * roll()) * F.h) / rows]);
  let d = '';
  for (const [sx, sy] of sites) {
    // The field, cut down by the line half-way to every other point.
    let cell: [number, number][] = [[F.x, F.y], [F.x + F.w, F.y], [F.x + F.w, F.y + F.h], [F.x, F.y + F.h]];
    for (const [ox, oy] of sites) {
      if (ox === sx && oy === sy) continue;
      const [mx, my, nx, ny] = [(sx + ox) / 2, (sy + oy) / 2, ox - sx, oy - sy];
      const side = ([x, y]: [number, number]) => (x - mx) * nx + (y - my) * ny; // <= 0: on this point's side
      const next: [number, number][] = [];
      cell.forEach((a, i) => {
        const b = cell[(i + 1) % cell.length]!;
        const [fa, fb] = [side(a), side(b)];
        if (fa <= 0) next.push(a);
        if (fa <= 0 !== fb <= 0) next.push([a[0] + ((b[0] - a[0]) * fa) / (fa - fb), a[1] + ((b[1] - a[1]) * fa) / (fa - fb)]);
      });
      cell = next;
      if (cell.length < 3) break;
    }
    if (cell.length < 3) continue;
    const cx = cell.reduce((t, q) => t + q[0], 0) / cell.length;
    const cy = cell.reduce((t, q) => t + q[1], 0) / cell.length;
    d += `${pts(cell.map(([x, y]) => [cx + (x - cx) * (small ? 0.8 : 0.86), cy + (y - cy) * (small ? 0.8 : 0.86)] as const))}Z`;
  }
  return frame(`<path d="${d}"/>`, small ? 2.2 : 1.1, small);
}

/** Fits a line drawing into the field (keeping its shape), in the middle of it. */
function fit(line: readonly (readonly [number, number])[], room = 0.94): [number, number][] {
  const xs = line.map((p) => p[0]);
  const ys = line.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const k = Math.min((F.w * room) / (x1 - x0 || 1), (F.h * room) / (y1 - y0 || 1));
  return line.map(([x, y]) => [W / 2 + (x - (x0 + x1) / 2) * k, H / 2 + (y - (y0 + y1) / 2) * k]);
}

/** A binary tree: a trunk that forks in two, each branch forking again, shorter and shorter; two of them, rooted together at the middle of the card, one growing up and one down, so the card reads the same either way up. */
function tree(small: boolean): string {
  const depth = small ? 5 : 7;
  const segs: [number, number, number, number][] = [];
  const grow = (x: number, y: number, angle: number, len: number, d: number): void => {
    const [nx, ny] = [x + Math.cos(angle) * len, y + Math.sin(angle) * len];
    segs.push([x, y, nx, ny]);
    if (d > 1) {
      grow(nx, ny, angle - 0.52, len * 0.72, d - 1);
      grow(nx, ny, angle + 0.52, len * 0.72, d - 1);
    }
  };
  grow(0, 0, -Math.PI / 2, 1, depth);
  // Fitted into the upper half of the field, its root at the very middle; then again turned upside down below.
  const ends = segs.flatMap(([a, b, c, d]) => [[a, b], [c, d]] as [number, number][]);
  const xs = ends.map((p) => p[0]);
  const ys = ends.map((p) => p[1]);
  const [x0, x1, y0] = [Math.min(...xs), Math.max(...xs), Math.min(...ys)];
  const k = Math.min((F.w * 0.94) / (x1 - x0), (F.h * 0.47) / -y0);
  let d = '';
  for (const flip of [1, -1]) for (const [a, b, c, e] of segs) d += `M${n(W / 2 + a * k * flip)} ${n(H / 2 + flip * b * k)}L${n(W / 2 + c * k * flip)} ${n(H / 2 + flip * e * k)}`;
  return frame(`<path d="${d}"/>`, small ? 1.8 : 0.9, small);
}

/**
 * The dragon curve: a strip of paper folded in half again and again, always the same way, and opened out to right
 * angles. Drawn through the middle of each straight piece, not round its corners: the corners are cut off, so the
 * line never touches itself and its winding can be followed (drawn corner to corner it closes up into solid squares).
 */
function dragon(small: boolean): string {
  const folds = small ? 7 : 9;
  let turns: number[] = [];
  for (let i = 0; i < folds; i++) turns = [...turns, 1, ...turns.map((t) => -t).reverse()];
  const line: [number, number][] = [[0, 0], [1, 0]];
  let [dx, dy] = [1, 0];
  for (const t of turns) {
    [dx, dy] = t > 0 ? [-dy, dx] : [dy, -dx];
    const last = line.at(-1)!;
    line.push([last[0] + dx, last[1] + dy]);
  }
  // (It is longer one way than the other: stood on end if that fills the card better.)
  const tall = line.map(([x, y]) => [y, -x] as [number, number]);
  const span = (l: [number, number][]) => Math.max(...l.map((p) => p[0])) - Math.min(...l.map((p) => p[0]));
  const height = (l: [number, number][]) => Math.max(...l.map((p) => p[1])) - Math.min(...l.map((p) => p[1]));
  const use = height(line) / span(line) > height(tall) / span(tall) ? line : tall;
  const mids = use.slice(1).map((p, i): [number, number] => [(p[0] + use[i]![0]) / 2, (p[1] + use[i]![1]) / 2]);
  return frame(`<path d="${pts(fit(mids))}"/>`, small ? 2 : 1.15, small);
}

/** Koch snowflakes: a triangle whose every side has a smaller triangle built on its middle third, and so on; a large one, and a smaller one above and below. */
function koch(small: boolean): string {
  const flake = (cx: number, cy: number, r: number, depth: number): string => {
    let line: [number, number][] = [0, 1, 2, 0].map((i) => [cx + r * Math.sin((i * 2 * Math.PI) / 3), cy - r * Math.cos((i * 2 * Math.PI) / 3)]);
    for (let d = 0; d < depth; d++) {
      const next: [number, number][] = [line[0]!];
      for (let i = 1; i < line.length; i++) {
        const [a, b] = [line[i - 1]!, line[i]!];
        const [ux, uy] = [(b[0] - a[0]) / 3, (b[1] - a[1]) / 3];
        const p1: [number, number] = [a[0] + ux, a[1] + uy];
        const p2: [number, number] = [a[0] + 2 * ux, a[1] + 2 * uy];
        // The point of the new triangle, out from the side (the corners go round clockwise).
        next.push(p1, [p1[0] + ux / 2 + (uy * Math.sqrt(3)) / 2, p1[1] + uy / 2 - (ux * Math.sqrt(3)) / 2], p2, b);
      }
      line = next;
    }
    return `<path d="${pts(line)}Z"/>`;
  };
  const r = F.w * 0.43;
  if (small) return frame(flake(W / 2, H / 2, F.w * 0.48, 2), 1.7, true);
  return frame(flake(W / 2, H / 2, r, 3) + flake(W / 2, F.y + 12, 9, 2) + flake(W / 2, F.y + F.h - 12, 9, 2) + flake(W / 2, H / 2, r * 0.38, 2), 0.8);
}

/**
 * The Mandelbrot set: the numbers c for which z -> z*z + c, begun at nothing, never runs away. One, stood on end
 * (its needle pointing up), which is how it fills a card best. Worked out on a grid of square cells and drawn as rows
 * of filled strips; the needle, which is thinner than any cell, is drawn in as a line.
 */
function mandelbrot(small: boolean): string {
  const inside = (re: number, im: number): boolean => {
    let [x, y] = [0, 0];
    for (let i = 0; i < 120; i++) {
      [x, y] = [x * x - y * y + re, 2 * x * y + im];
      if (x * x + y * y > 4) return false;
    }
    return true;
  };
  // The set lies between -2.05 and 0.55 (here: from the top down) and between -1.15 and 1.15 (across): `u` px to one of those units.
  // (A little wider than the field: only the tips of its two side buds reach that far, and they may cross the thin line.)
  const u = Math.min((F.w * 1.08) / 2.3, (F.h * 0.96) / 2.6);
  const cell = small ? 1.3 : 0.6;
  const rows = Math.ceil((2.6 * u) / cell);
  const cols = Math.ceil((2.3 * u) / cell);
  const at = (re: number, im: number): [number, number] => [W / 2 + im * u, H / 2 + (re + 0.75) * u];
  let d = '';
  for (let r = 0; r < rows; r++) {
    const re = -2.05 + ((r + 0.5) / rows) * 2.6;
    let from = -1;
    for (let c = 0; c <= cols; c++) {
      const on = c < cols && inside(re, -1.15 + ((c + 0.5) / cols) * 2.3);
      if (on && from < 0) from = c;
      if (!on && from >= 0) {
        const [x0, y0] = at(-2.05 + (r / rows) * 2.6, -1.15 + (from / cols) * 2.3);
        const [x1, y1] = at(-2.05 + ((r + 1) / rows) * 2.6, -1.15 + (c / cols) * 2.3);
        d += `M${n(x0)} ${n(y0)}H${n(x1)}V${n(y1 + 0.12)}H${n(x0)}Z`; // (a hair too deep: no cloth between the rows)
        from = -1;
      }
    }
  }
  return frame(`<path d="${d}" fill="#fff" stroke="none"/><path d="${pts([at(-2, 0), at(-1.4, 0)])}" stroke-width="${small ? 1.2 : 0.6}"/>`, 1, small);
}

/**
 * A random walk: from a dot at the bottom, a line that wanders one square at a time (up more often than not, left or
 * right, now and then back down, by a fixed roll of the dice), doubling back over itself, until it reaches a cross
 * at the top.
 */
function walk(small: boolean): string {
  const step = small ? 5 : 2;
  const cols = Math.floor(F.w / step);
  const rows = Math.floor((F.h - (small ? 16 : 12)) / step);
  const half = Math.floor(cols / 2) - 1;
  const roll = dice(small ? 5 : 31);
  let [x, y] = [0, 0];
  const line: [number, number][] = [[x, y]];
  // It keeps going one way for a few squares at a time: that is what gives the walk its long straights and tight knots.
  while (y < rows && line.length < 4000) {
    const r = roll();
    // (Sideways it leans back towards the middle of the card, the further out it is: it wanders, but does not hug an edge.)
    const lean = (x / half) * 0.12;
    const [dx, dy] = r < 0.32 ? [0, 1] : r < 0.59 - lean ? [1, 0] : r < 0.86 ? [-1, 0] : [0, -1];
    const far = 1 + Math.floor(roll() * roll() * 3);
    for (let i = 0; i < far && y < rows; i++) {
      if (Math.abs(x + dx) > half || y + dy < 0) break;
      [x, y] = [x + dx, y + dy];
      line.push([x, y]);
    }
  }
  const at = ([i, j]: [number, number]): [number, number] => [W / 2 + i * step, F.y + F.h - (small ? 8 : 6) - j * step];
  const [ex, ey] = at(line.at(-1)!);
  const [sx, sy] = at(line[0]!);
  const k = small ? 3 : 1.8;
  const cross = `M${n(ex - k)} ${n(ey - k)}L${n(ex + k)} ${n(ey + k)}M${n(ex + k)} ${n(ey - k)}L${n(ex - k)} ${n(ey + k)}`;
  return frame(`<path d="${pts(line.map(at))}${cross}" stroke-linecap="square" stroke-linejoin="miter"/><circle cx="${n(sx)}" cy="${n(sy)}" r="${small ? 3 : 1.8}" fill="#fff" stroke="none"/>`, small ? 1.5 : 0.7, small);
}

/** Everything in `body` is cut off at the edge of the field. */
const clipped = (body: string): string => `<clipPath id="f"><rect x="${F.x}" y="${F.y}" width="${F.w}" height="${F.h}"/></clipPath><g clip-path="url(#f)">${body}</g>`;
const poly = (p: readonly (readonly [number, number])[]): string => `${pts(p)}Z`;

/** In the manner of Mondrian: the field cut again and again into rectangles by heavy lines, a few of them filled, some solid and some half. */
function mondrian(small: boolean): string {
  const roll = dice(small ? 3 : 14);
  const leaves: [number, number, number, number][] = [];
  const cut = (x: number, y: number, w: number, h: number, depth: number): void => {
    const least = small ? 15 : 13;
    // (The first cuts are always made: no block is as much as half the card.)
    if (depth === 0 || (w < least * 2 && h < least * 2) || (depth < (small ? 2 : 3) && roll() < 0.18)) {
      leaves.push([x, y, w, h]);
      return;
    }
    const at = [0.34, 0.5, 0.62, 0.7][Math.floor(roll() * 4)]!;
    // (Across the longer side, unless that would leave a sliver.)
    if (w * 1.15 > h && w >= least * 2) {
      cut(x, y, w * at, h, depth - 1);
      cut(x + w * at, y, w * (1 - at), h, depth - 1);
    } else {
      cut(x, y, w, h * at, depth - 1);
      cut(x, y + h * at, w, h * (1 - at), depth - 1);
    }
  };
  cut(F.x, F.y, F.w, F.h, small ? 4 : 5);
  let body = '';
  for (const [x, y, w, h] of leaves) {
    const r = roll();
    const fill = r < 0.2 ? '#fff' : r < 0.36 ? 'rgba(255,255,255,0.45)' : 'none';
    body += `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}"/>`;
  }
  return frame(body, small ? 3 : 2.1, small);
}

/** Diamond tiles: in every square a diamond of the card's colour, the four corners round it white with their tips cut off, so a small diamond stands where four tiles meet; thin lines of colour between the tiles. */
function diamonds(small: boolean): string {
  const cols = small ? 2 : 3;
  const rows = small ? 3 : 4;
  const [w, h] = [F.w / cols, F.h / rows];
  const g = small ? 1.1 : 0.7; // half the line between two tiles
  const c = Math.min(w, h) * 0.16; // how much of a corner is cut off
  let d = '';
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const [x, y] = [F.x + k * w, F.y + r * h];
      // One corner piece, and the same turned into the other three corners.
      for (const [fx, fy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
        const at = (px: number, py: number): [number, number] => [x + w / 2 + fx * (px - w / 2), y + h / 2 + fy * (py - h / 2)];
        d += poly([at(g + c, g), at(w / 2, g), at(g, h / 2), at(g, g + c)]);
      }
    }
  }
  return frame(`<path d="${d}" fill="#fff" stroke="none"/>`, 1, small);
}

/** Herringbone: bricks twice as long as they are wide, laid in a zigzag, as a floor is. */
function herringbone(small: boolean): string {
  const a = small ? 9 : 5.2;
  let body = '';
  const span = Math.ceil((F.w + F.h) / a) + 6;
  for (let k = -span; k < span; k++) {
    for (let i = -span; i < span; i++) {
      const [x, y] = [F.x + (i + 4 * k) * a, F.y + i * a];
      if (x > F.x + F.w + 2 * a || x < F.x - 4 * a || y > F.y + F.h + a || y < F.y - 2 * a) continue;
      body += `<rect x="${n(x)}" y="${n(y)}" width="${n(2 * a)}" height="${n(a)}"/><rect x="${n(x + 2 * a)}" y="${n(y - a)}" width="${n(a)}" height="${n(2 * a)}"/>`;
    }
  }
  return frame(clipped(body), small ? 1.5 : 0.8, small);
}

/** Honeycomb: six-sided tiles, each row half a tile along from the last. */
function honeycomb(small: boolean): string {
  const across = small ? 3 : 6;
  const wide = F.w / across; // across the flats
  const r = wide / Math.sqrt(3);
  let d = '';
  for (let row = -1; row * 1.5 * r < F.h + r; row++) {
    for (let c = -1; c <= across; c++) {
      const [cx, cy] = [F.x + (c + (row % 2 ? 0.5 : 0) + 0.5) * wide, F.y + row * 1.5 * r + r];
      d += poly(Array.from({ length: 6 }, (_, i) => [cx + r * Math.sin((i * Math.PI) / 3), cy - r * Math.cos((i * Math.PI) / 3)] as const));
    }
  }
  return frame(clipped(`<path d="${d}"/>`), small ? 1.8 : 0.9, small);
}

/** Star and cross: eight-pointed stars (a square, and the same square turned an eighth), white, tip to tip; the cloth left between four of them is a cross. */
function starCross(small: boolean): string {
  const across = small ? 2 : 4;
  const pitch = F.w / across;
  const out = (pitch / 2) * 0.985; // a tip (the stars all but touch)
  const inn = (out * Math.SQRT1_2) / Math.cos(Math.PI / 8); // where the two squares cross
  let d = '';
  const down = Math.round(F.h / pitch);
  const y0 = F.y + (F.h - down * pitch) / 2;
  for (let r = 0; r < down; r++) {
    for (let c = 0; c < across; c++) {
      const [cx, cy] = [F.x + (c + 0.5) * pitch, y0 + (r + 0.5) * pitch];
      d += poly(Array.from({ length: 16 }, (_, i) => [cx + (i % 2 ? inn : out) * Math.sin((i * Math.PI) / 8), cy - (i % 2 ? inn : out) * Math.cos((i * Math.PI) / 8)] as const));
    }
  }
  return frame(`<path d="${d}" fill="#fff" stroke="none"/>`, 1, small);
}

/**
 * Houndstooth, as it is woven: threads four of one colour and four of the other, both ways, in a twill where each
 * thread goes over two and under two, stepping one along each row. Where both threads are white there is a white
 * square, and where both are coloured a bare one; where one is white and the other not, the twill shows as slanting
 * stripes two threads wide, and those are the teeth. Drawn as it is printed, with the stripes' edges straight (thread
 * by thread they are little stairs).
 */
function houndstooth(small: boolean): string {
  const across = small ? 3 : 5; // repeats (eight threads) across the card
  const t = F.w / (across * 8); // one thread
  const down = Math.ceil(F.h / (4 * t));
  let squares = '';
  const mixed = ['', '']; // the blocks where the upright threads are white, and where the level ones are
  for (let bj = 0; bj < down; bj++) {
    for (let bi = 0; bi < across * 2; bi++) {
      const e = 0.07; // (a hair over its edges, so that no seam shows between a square and its teeth)
      const block = `M${n(F.x + bi * 4 * t - e)} ${n(F.y + bj * 4 * t - e)}h${n(4 * t + 2 * e)}v${n(4 * t + 2 * e)}h${n(-4 * t - 2 * e)}z`;
      if (bi % 2 === 0 && bj % 2 === 0) squares += block;
      else if (bi % 2 !== bj % 2) mixed[bi % 2 === 0 ? 0 : 1] += block;
    }
  }
  // Slanting stripes two threads wide, four apart, over the whole field: one set where the upright thread is on top, the other between them.
  const stripes = (shift: number): string => {
    let d = '';
    const reach = F.w + F.h;
    for (let k = -Math.ceil(reach / (4 * t)); k * 4 * t < F.w; k++) {
      const x = F.x + (k * 4 + shift) * t;
      d += `M${n(x)} ${n(F.y)}h${n(2 * t)}l${n(reach)} ${n(reach)}h${n(-2 * t)}z`;
    }
    return d;
  };
  return frame(
    clipped(
      `<path d="${squares}" fill="#fff" stroke="none"/>` +
        `<clipPath id="a"><path d="${mixed[0]}"/></clipPath><clipPath id="b"><path d="${mixed[1]}"/></clipPath>` +
        `<path d="${stripes(0)}" clip-path="url(#a)" fill="#fff" stroke="none"/><path d="${stripes(2)}" clip-path="url(#b)" fill="#fff" stroke="none"/>`,
    ),
    1,
    small,
  );
}

const HALF = 'rgba(255,255,255,0.45)';

/** Shards: rows of long spikes, like the points of a backgammon board, each with a light side and a shaded one; every other row hangs down from above, half a spike along. */
function shards(small: boolean): string {
  const across = small ? 3 : 4;
  const rows = small ? 2 : 3;
  const [w, h] = [F.w / across, F.h / rows];
  let white = '';
  let half = '';
  for (let r = 0; r < rows; r++) {
    const down = r % 2 === 1;
    for (let k = -1; k <= across; k++) {
      const x = F.x + (k + (down ? 0.5 : 0)) * w;
      const [foot, tip] = down ? [F.y + r * h, F.y + (r + 1) * h - 1.5] : [F.y + (r + 1) * h, F.y + r * h + 1.5];
      // The spike's two faces: the left one catches the light.
      white += poly([[x, foot], [x + w / 2, foot], [x + w / 2, tip]]);
      half += poly([[x + w / 2, foot], [x + w, foot], [x + w / 2, tip]]);
    }
  }
  return frame(clipped(`<path d="${white}" fill="#fff" stroke="none"/><path d="${half}" fill="${HALF}" stroke="none"/>`), 1, small);
}

/** Pinwheels: in every tile four blades from its middle almost out to its edges, each a wedge with its tip cut off, two white and two shaded, all turning the same way. */
function pinwheel(small: boolean): string {
  const cols = small ? 2 : 3;
  const size = F.w / cols;
  const rows = Math.round(F.h / size);
  const y0 = F.y + (F.h - rows * size) / 2;
  let white = '';
  let half = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let q = 0; q < 4; q++) {
        // One blade, in a tile that is 2 by 2 with its middle at (0, 0), turned a quarter for each of the four.
        const turn = ([x, y]: [number, number]): [number, number] => [[x, y], [-y, x], [-x, -y], [y, -x]][q] as [number, number];
        const blade = poly(([[0, 0], [0, -1], [0.5, -1], [0.5, -0.5]] as [number, number][]).map(([x, y]): [number, number] => turn([x, y])).map(([x, y]) => [F.x + (c + 0.5 + (x / 2) * 0.86) * size, y0 + (r + 0.5 + (y / 2) * 0.86) * size] as const));
        if (q % 2) half += blade;
        else white += blade;
      }
    }
  }
  return frame(clipped(`<path d="${white}" fill="#fff" stroke="none"/><path d="${half}" fill="${HALF}" stroke="none"/>`), 1, small);
}

/**
 * A mosaic, laid as the Romans laid a medallion: ring upon ring of little stones round the middle of the card, none
 * quite true, in three tones that make a flower of petals at the centre, a band round it, and arms that wind
 * outwards from the band to the corners.
 */
function mosaic(small: boolean): string {
  const t = small ? 6.4 : 3.5; // from one ring to the next
  const gap = small ? 1.2 : 0.62;
  const petals = small ? 6 : 8;
  const heart = small ? 24 : 27; // how far out the flower reaches
  const roll = dice(41);
  const [cx, cy] = [W / 2, H / 2];
  const tones: Record<string, string> = { white: '', half: '', faint: '' };
  const first = t * 0.85;
  tones.half += `M${n(cx + first)} ${n(cy)}A${n(first)} ${n(first)} 0 1 0 ${n(cx - first)} ${n(cy)}A${n(first)} ${n(first)} 0 1 0 ${n(cx + first)} ${n(cy)}Z`;
  for (let ring = 0; first + gap + ring * t < Math.hypot(F.w, F.h) / 2; ring++) {
    const [r0, r1] = [first + gap + ring * t, first + ring * t + t];
    const mid = (r0 + r1) / 2;
    const count = Math.max(6, Math.round((2 * Math.PI * mid) / (t * 1.05)));
    const start = roll() * 2 * Math.PI;
    for (let k = 0; k < count; k++) {
      const a = start + (k / count) * 2 * Math.PI;
      const [px, py] = [cx + mid * Math.cos(a), cy + mid * Math.sin(a)];
      if (px < F.x - t || px > F.x + F.w + t || py < F.y - t || py > F.y + F.h + t) {
        roll(), roll(), roll();
        continue;
      }
      // Which tone this stone is: by where its middle lies in the picture.
      const reach = heart * (0.38 + 0.62 * Math.abs(Math.cos((petals * a) / 2)) ** 1.4);
      const band = Math.round((heart + t * 1.2 - first) / t); // the ring just outside the flower
      const arm = (((a * petals) / (2 * Math.PI) + (mid - heart) / (t * 5.5)) % 1 + 1) % 1;
      const tone = mid < reach ? (mid < heart * 0.3 ? 'half' : 'white') : ring === band ? 'white' : ring === band - 1 || ring === band + 1 || mid < heart + t ? 'faint' : arm < 0.42 ? 'half' : 'faint';
      // The stone: a piece of its ring, a little short of its neighbours, and knocked a little out of true.
      const half = Math.PI / count - gap / 2 / mid;
      const turn = (roll() - 0.5) * 0.07;
      const [in0, out0] = [r0 + roll() * gap * 0.5, r1 - roll() * gap * 0.5];
      const at = (r: number, da: number): readonly [number, number] => [cx + r * Math.cos(a + da), cy + r * Math.sin(a + da)];
      tones[tone] += poly([at(in0, -half + turn * 0.3), at(out0, -half - turn * 0.3), at(out0, half - turn * 0.3), at(in0, half + turn * 0.3)]);
    }
  }
  return frame(clipped(`<path d="${tones.white}" fill="#fff" stroke="none"/><path d="${tones.half}" fill="${HALF}" stroke="none"/><path d="${tones.faint}" fill="rgba(255,255,255,0.2)" stroke="none"/>`), 1, small);
}

/** Flower tiles: an eight-petalled flower in every tile, and a small four-pointed star where four tiles meet. */
function flowers(small: boolean): string {
  const across = small ? 2 : 3;
  const pitch = F.w / across;
  const down = Math.round(F.h / pitch);
  const y0 = F.y + (F.h - down * pitch) / 2;
  const petal = (cx: number, cy: number, angle: number, long: number, wide: number): string => {
    const at = (a: number, r: number): [number, number] => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    return poly([at(angle, long * 0.12), at(angle - wide, long * 0.55), at(angle, long), at(angle + wide, long * 0.55)]);
  };
  let big = '';
  let little = '';
  for (let r = 0; r <= down; r++) {
    for (let c = 0; c <= across; c++) {
      if (r < down && c < across) for (let i = 0; i < 8; i++) big += petal(F.x + (c + 0.5) * pitch, y0 + (r + 0.5) * pitch, (i * Math.PI) / 4, pitch * 0.47, 0.3);
      for (let i = 0; i < 4; i++) little += petal(F.x + c * pitch, y0 + r * pitch, (i * Math.PI) / 2 + Math.PI / 4, pitch * 0.24, 0.5);
    }
  }
  return frame(clipped(`<path d="${big}" fill="#fff" stroke="none"/><path d="${little}" fill="${HALF}" stroke="none"/>`), 1, small);
}

/**
 * A compass rose: four long points and four short ones between them, each point half white and half bare with a
 * white edge, over two rings. (The short points are cut where the long ones lie over them, and the rings where any
 * point does, so that the bare halves really are bare.)
 */
function compass(small: boolean): string {
  const [cx, cy] = [W / 2, H / 2];
  const at = (deg: number, r: number): [number, number] => [cx + r * Math.sin((deg * Math.PI) / 180), cy - r * Math.cos((deg * Math.PI) / 180)];
  const waist = 6.5; // where two long points meet, on the diagonals
  const reach = (deg: number): number => (deg % 180 === 0 ? F.h * 0.47 : F.w * 0.49); // north and south are longer: the card is
  const short = F.w * 0.36;
  const cross = (a: [number, number], b: [number, number], c: [number, number], e: [number, number]): [number, number] => {
    const t = ((c[0] - a[0]) * (e[1] - c[1]) - (c[1] - a[1]) * (e[0] - c[0])) / ((b[0] - a[0]) * (e[1] - c[1]) - (b[1] - a[1]) * (e[0] - c[0]));
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  let white = '';
  let bare = '';
  let all = '';
  for (let k = 0; k < 4; k++) {
    const deg = k * 90;
    const tip = at(deg, reach(deg));
    // A long point: its left half white, its right half bare.
    white += poly([[cx, cy], at(deg - 45, waist), tip]);
    bare += poly([[cx, cy], tip, at(deg + 45, waist)]);
    all += poly([[cx, cy], at(deg - 45, waist), tip, at(deg + 45, waist)]);
    // The short point between this one and the next: what shows of it beside the two long points.
    const [p, corner] = [at(deg + 45, short), at(deg + 45, waist)];
    const next = at(deg + 90, reach(deg + 90));
    const left = cross(p, at(deg, 11), tip, corner); // where its edge meets this long point's edge
    const right = cross(p, at(deg + 90, 11), next, corner);
    white += poly([p, left, corner]);
    bare += poly([p, corner, right]);
    all += poly([p, left, corner, right]);
  }
  const rings = small ? `<circle cx="${cx}" cy="${cy}" r="${n(F.w * 0.4)}" stroke-width="2"/>` : `<circle cx="${cx}" cy="${cy}" r="${n(F.w * 0.43)}" stroke-width="0.9"/><circle cx="${cx}" cy="${cy}" r="${n(F.w * 0.34)}" stroke-width="2.2"/>`;
  return frame(
    `<mask id="m"><rect width="${W}" height="${H}" fill="#fff"/><path d="${all}" fill="#000" stroke="#000" stroke-width="1.6"/></mask><g mask="url(#m)">${rings}</g>` +
      `<path d="${white}" fill="#fff" stroke="none"/><path d="${bare}" stroke-linejoin="miter"/>`,
    small ? 1.3 : 0.7,
    small,
  );
}

/**
 * The Lightcone mark (the owner's own choice of emblem; it is Lightcone's logo, not this project's drawing): its
 * outlines as they are in the logo's file, 158.1 by 201.2, fitted into the middle of the card.
 */
function lightcone(small: boolean): string {
  const shapes = [
    'M79.1,100.6L131,8.5c-2.2,1-3.7,1.9-6.1,2.8L82.3,84.2l-3.3-29.7l-3.3,29.7L37.7,17.1c20.4,6,45.3,7,68,3.2L85.6,56.7l2.7,5.9l27.5-48.9c-24.6,6.1-56.8,5.2-79.4-2c21.7-9,57.2-8.2,81.3-2.1l2-4.4C91.5-2.9,54-1.3,27.1,8.5',
    'M158.1,100.6 86.2,97.8 103.9,82.8 82.4,94.8 79.1,100.6Z',
    'M0,100.6 72,97.8 54.3,82.8 75.8,94.8 79.1,100.6Z',
    'M79.1,100.6l-51.9,92.1c2.2-1,3.7-1.9,6.1-2.8L75.8,117l3.3,29.7l3.3-29.7l38.1,67.1c-20.4-6-45.3-7-68-3.2l20.1-36.5l-2.7-5.9l-27.5,48.9c24.6-6.1,56.8-5.2,79.4,2c-21.7,9-57.2,8.2-81.3,2.1l-2,4.4c28.3,8.1,65.8,6.5,92.6-3.4',
    'M158.1,100.6 86.2,103.4 103.9,118.4 82.4,106.4 79.1,100.6Z',
    'M0,100.6 72,103.4 54.3,118.4 75.8,106.4 79.1,100.6Z',
  ];
  const k = Math.min((F.w * (small ? 0.98 : 0.94)) / 158.1, (F.h * 0.94) / 201.2);
  return frame(`<g transform="translate(${n(W / 2 - (158.1 * k) / 2)} ${n(H / 2 - (201.2 * k) / 2)}) scale(${Math.round(k * 10000) / 10000})" fill="#fff" fill-rule="evenodd" stroke="none">${shapes.map((d) => `<path d="${d}"/>`).join('')}</g>`, 1, small);
}

/**
 * The Arbor mark (the owner's own organisation's logo): a binary tree of seven round nodes, as it is in the logo's
 * file (253 by 228), fitted into the middle of the card.
 */
function arbor(small: boolean): string {
  const at: [number, number][] = [[126.63, 29], [61.56, 114], [191.71, 114], [29.02, 199], [94.1, 199], [159.17, 199], [224.24, 199]];
  const k = (F.w * (small ? 0.96 : 0.9)) / 253;
  const twigs = [1, 2, 3, 4, 5, 6].map((i) => `M${at[(i - 1) >> 1]![0]} ${at[(i - 1) >> 1]![1]}L${at[i]![0]} ${at[i]![1]}`).join('');
  const nodes = at.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="19.5"/>`).join('');
  return frame(`<g transform="translate(${n(W / 2 - (253 * k) / 2)} ${n(H / 2 - (228 * k) / 2)}) scale(${Math.round(k * 10000) / 10000})"><path d="${twigs}" stroke-width="8"/><g fill="#fff" stroke="none">${nodes}</g></g>`, 1, small);
}

/**
 * Earth's point of origin, as it is cut into the gate in Stargate: a broad chevron with no floor, its legs the same
 * width all the way down until their feet kick in toward each other, and a ring over its peak. In heights of the
 * chevron, from its peak.
 */
function earth(small: boolean): string {
  const lean = 0.58; // how far a leg's outer edge goes out for each step down
  const thick = 0.14; // a leg's width, across
  const [heel, foot] = [0.82, 0.31]; // where the feet start to kick in, and how wide a foot is at the bottom
  const leg: [number, number][] = [[0, 0], [lean, 1], [lean - foot, 1], [lean * heel - thick, heel], [0, thick / lean]];
  const shape = [...leg, ...leg.slice(1, -1).reverse().map(([x, y]): [number, number] => [-x, y])];
  const [ringY, ringOut, ringIn] = [-0.125, 0.11, 0.052];
  const k = (F.w * (small ? 0.94 : 0.86)) / (2 * lean);
  const top = H / 2 - (k * (1 - (ringY - ringOut))) / 2 - k * (ringY - ringOut); // the whole of it centred
  const at = ([x, y]: [number, number]): [number, number] => [W / 2 + x * k, top + y * k];
  const ring = (r: number): string => `M${n(W / 2 - r * k)} ${n(top + ringY * k)}a${n(r * k)} ${n(r * k)} 0 1 0 ${n(2 * r * k)} 0a${n(r * k)} ${n(r * k)} 0 1 0 ${n(-2 * r * k)} 0Z`;
  return frame(`<path d="${poly(shape.map(at))}${ring(ringOut)}${ring(ringIn)}" fill="#fff" fill-rule="evenodd" stroke="none"/>`, 1, small);
}

/**
 * Waves, as on Japanese cloth (seigaiha): rows of overlapping scales, each row half a scale along from the last, and
 * each scale three arcs one inside another. Only as much of a scale is drawn as the rows below it leave showing.
 */
function waves(small: boolean): string {
  const across = small ? 3 : 5;
  const r = F.w / (across * 2); // a scale's radius; scales are 2r apart, rows r / 2
  const rings = small ? [1, 0.55] : [1, 0.68, 0.36];
  let d = '';
  const centre = (row: number, k: number): [number, number] => [F.x + (k * 2 + (row % 2 ? 1 : 0)) * r, F.y + row * (r / 2) + r * 0.4];
  for (let row = -1; row * (r / 2) < F.h + r; row++) {
    for (let k = -1; k <= across + 1; k++) {
      const [cx, cy] = centre(row, k);
      // What lies over this scale: its neighbours in the next two rows down.
      const over: [number, number][] = [centre(row + 1, row % 2 ? k : k - 1), centre(row + 1, row % 2 ? k + 1 : k), centre(row + 2, k)];
      for (const ring of rings) {
        let run: [number, number][] = [];
        for (let a = -180; a <= 0; a += 4) {
          const p: [number, number] = [cx + ring * r * Math.cos((a * Math.PI) / 180), cy + ring * r * Math.sin((a * Math.PI) / 180)];
          if (over.some(([ox, oy]) => Math.hypot(p[0] - ox, p[1] - oy) < r * 0.995)) {
            if (run.length > 1) d += pts(run);
            run = [];
          } else run.push(p);
        }
        if (run.length > 1) d += pts(run);
      }
    }
  }
  return frame(clipped(`<path d="${d}"/>`), small ? 1.6 : 0.85, small);
}

/** Flow: lines across the card that rise and fall together, each a little out of step with the one above, and swelling towards the middle of the card, like water over a stone. */
function flow(small: boolean): string {
  const lines = small ? 9 : 19;
  let d = '';
  for (let i = 0; i < lines; i++) {
    const y0 = F.y + ((i + 0.5) / lines) * F.h;
    const swell = Math.exp(-(((i + 0.5) / lines - 0.5) ** 2) / 0.07); // most in the middle of the card
    const line: [number, number][] = [];
    for (let x = 0; x <= F.w; x += 1.5) {
      const u = x / F.w;
      line.push([F.x + x, y0 + (2.2 + 6.5 * swell) * Math.sin(2 * Math.PI * (u * 1.5 + i * 0.045)) * Math.sin(Math.PI * u) + 1.6 * Math.sin(2 * Math.PI * (u * 3.2 - i * 0.07))]);
    }
    d += pts(line);
  }
  return frame(clipped(`<path d="${d}"/>`), small ? 1.7 : 0.9, small);
}

/**
 * The Game of Life: a squared board with some of its well-known inhabitants on it (gliders, a spaceship, and still
 * and blinking things), and a few stray cells scattered between them.
 */
function life(small: boolean): string {
  const cell = small ? 8 : 4;
  const cols = Math.floor(F.w / cell);
  const rows = Math.floor(F.h / cell);
  const [x0, y0] = [W / 2 - (cols * cell) / 2, H / 2 - (rows * cell) / 2];
  const SHAPES: Record<string, string[]> = {
    glider: ['.#.', '..#', '###'],
    glider2: ['###', '#..', '.#.'],
    ship: ['.#..#', '#....', '#...#', '####.'],
    beehive: ['.##.', '#..#', '.##.'],
    loaf: ['.##.', '#..#', '.#.#', '..#.'],
    block: ['##', '##'],
    blinker: ['###'],
    toad: ['.###', '###.'],
  };
  const put: [string, number, number][] = small
    ? [['glider', 1, 1], ['block', 6, 5], ['blinker', 2, 7], ['glider2', 5, 9]]
    : [['glider', 2, 2], ['block', 13, 2], ['glider2', 11, 6], ['ship', 3, 10], ['beehive', 12, 13], ['blinker', 3, 17], ['toad', 10, 18], ['loaf', 2, 21], ['glider', 12, 22]];
  const live = new Set<string>();
  for (const [name, cx, cy] of put) SHAPES[name]!.forEach((row, j) => [...row].forEach((ch, i) => ch === '#' && live.add(`${cx + i},${cy + j}`)));
  // A few cells by themselves, clear of everything else.
  const roll = dice(9);
  const near = (i: number, j: number): boolean => [-2, -1, 0, 1, 2].some((a) => [-2, -1, 0, 1, 2].some((b) => live.has(`${i + a},${j + b}`)));
  for (let tries = 0, strays = 0; tries < 200 && strays < (small ? 3 : 9); tries++) {
    const [i, j] = [Math.floor(roll() * cols), Math.floor(roll() * rows)];
    if (near(i, j)) continue;
    live.add(`${i},${j}`);
    strays++;
  }
  let cells = '';
  const gap = small ? 0.8 : 0.45;
  for (const at of live) {
    const [i, j] = at.split(',').map(Number) as [number, number];
    if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
    cells += `M${n(x0 + i * cell + gap)} ${n(y0 + j * cell + gap)}h${n(cell - 2 * gap)}v${n(cell - 2 * gap)}h${n(-(cell - 2 * gap))}z`;
  }
  let grid = '';
  for (let i = 0; i <= cols; i++) grid += `M${n(x0 + i * cell)} ${n(y0)}v${n(rows * cell)}`;
  for (let j = 0; j <= rows; j++) grid += `M${n(x0)} ${n(y0 + j * cell)}h${n(cols * cell)}`;
  return frame(`<path d="${grid}" stroke-width="${small ? 0.5 : 0.3}" opacity="0.4"/><path d="${cells}" fill="#fff" stroke="none"/>`, 1, small);
}

/**
 * A Penrose tiling: fat and thin diamonds that fill the plane without ever repeating, with fivefold symmetry about
 * the middle of the card. Made the usual way: ten triangles round a point, each cut again and again into smaller ones
 * in the golden ratio; two triangles back to back are a diamond. The thin diamonds are white.
 */
function penrose(small: boolean): string {
  const phi = (1 + Math.sqrt(5)) / 2;
  type P = [number, number];
  type Tri = [0 | 1, P, P, P]; // kind (0: half a thin diamond, 1: half a fat one), apex, and the two base corners
  const mix = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  let tris: Tri[] = [];
  const reach = 72; // far enough to cover the corners of the field
  for (let i = 0; i < 10; i++) {
    const at = (k: number): P => [reach * Math.cos(((2 * k - 1) * Math.PI) / 10), reach * Math.sin(((2 * k - 1) * Math.PI) / 10)];
    const [b, c] = i % 2 ? [at(i), at(i + 1)] : [at(i + 1), at(i)];
    tris.push([0, [0, 0], b, c]);
  }
  for (let step = 0; step < (small ? 4 : 5); step++) {
    const next: Tri[] = [];
    for (const [kind, a, b, c] of tris) {
      if (kind === 0) {
        const p = mix(a, b, 1 / phi);
        next.push([0, c, p, b], [1, p, c, a]);
      } else {
        const q = mix(b, a, 1 / phi);
        const r = mix(b, c, 1 / phi);
        next.push([1, r, c, a], [1, q, r, b], [0, r, q, a]);
      }
    }
    tris = next;
  }
  let thin = '';
  let edges = '';
  const at = ([x, y]: P): P => [W / 2 + x, H / 2 + y];
  for (const [kind, a, b, c] of tris) {
    // (Only what could show in the field.)
    if (Math.abs(a[0]) > F.w / 2 + 12 || Math.abs(a[1]) > F.h / 2 + 12) continue;
    if (kind === 0) thin += poly([at(a), at(b), at(c)]);
    // A diamond's sides: the two from the apex. (The base is the middle of the diamond, where its halves meet.)
    edges += pts([at(b), at(a), at(c)]);
  }
  return frame(clipped(`<path d="${thin}" fill="#fff" stroke="none"/><path d="${edges}" stroke-linecap="butt"/>`), small ? 1 : 0.55, small);
}

// ---------------------------------------------------------------- the hat
//
// The "einstein": one shape, the hat (thirteen sides, made of eight kites), that tiles the plane but never in a
// repeating pattern (Smith, Myers, Kaplan and Goodman-Strauss, 2023). A patch of it is built as in their paper: four
// clusters of hats (H, T, P, F) are put together by rule into larger clusters of the same four kinds, again and
// again. This follows Craig S. Kaplan's hatviz (https://github.com/isohedral/hatviz, BSD 3-Clause; see CREDITS.md).
type Pt2 = { x: number; y: number };
type Mat = [number, number, number, number, number, number];
interface Meta {
  shape: Pt2[];
  children: { T: Mat; geom: Meta | string }[]; // a string: a hat, of that kind
}
const HR3 = Math.sqrt(3) / 2;
const hexPt = (x: number, y: number): Pt2 => ({ x: x + 0.5 * y, y: HR3 * y });
const mInv = (T: Mat): Mat => {
  const det = T[0] * T[4] - T[1] * T[3];
  return [T[4] / det, -T[1] / det, (T[1] * T[5] - T[2] * T[4]) / det, -T[3] / det, T[0] / det, (T[2] * T[3] - T[0] * T[5]) / det];
};
const mMul = (A: Mat, B: Mat): Mat => [A[0] * B[0] + A[1] * B[3], A[0] * B[1] + A[1] * B[4], A[0] * B[2] + A[1] * B[5] + A[2], A[3] * B[0] + A[4] * B[3], A[3] * B[1] + A[4] * B[4], A[3] * B[2] + A[4] * B[5] + A[5]];
const mRot = (a: number): Mat => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0];
const mMove = (x: number, y: number): Mat => [1, 0, x, 0, 1, y];
const mAt = (M: Mat, P: Pt2): Pt2 => ({ x: M[0] * P.x + M[1] * P.y + M[2], y: M[3] * P.x + M[4] * P.y + M[5] });
const add2 = (p: Pt2, q: Pt2): Pt2 => ({ x: p.x + q.x, y: p.y + q.y });
const sub2 = (p: Pt2, q: Pt2): Pt2 => ({ x: p.x - q.x, y: p.y - q.y });
const rotAbout = (p: Pt2, a: number): Mat => mMul(mMove(p.x, p.y), mMul(mRot(a), mMove(-p.x, -p.y)));
const matchSeg = (p: Pt2, q: Pt2): Mat => [q.x - p.x, p.y - q.y, p.x, q.y - p.y, q.x - p.x, p.y];
const matchTwo = (p1: Pt2, q1: Pt2, p2: Pt2, q2: Pt2): Mat => mMul(matchSeg(p2, q2), mInv(matchSeg(p1, q1)));
const meet = (p1: Pt2, q1: Pt2, p2: Pt2, q2: Pt2): Pt2 => {
  const d = (q2.y - p2.y) * (q1.x - p1.x) - (q2.x - p2.x) * (q1.y - p1.y);
  const uA = ((q2.x - p2.x) * (p1.y - p2.y) - (q2.y - p2.y) * (p1.x - p2.x)) / d;
  return { x: p1.x + uA * (q1.x - p1.x), y: p1.y + uA * (q1.y - p1.y) };
};
const HAT: Pt2[] = [hexPt(0, 0), hexPt(-1, -1), hexPt(0, -2), hexPt(2, -2), hexPt(2, -1), hexPt(4, -2), hexPt(5, -1), hexPt(4, 0), hexPt(3, 0), hexPt(2, 2), hexPt(0, 3), hexPt(0, 2), hexPt(-1, 2)];

/** The four clusters to begin with: H (four hats, one of them turned over), T (one), P and F (two each). */
function firstClusters(): [Meta, Meta, Meta, Meta] {
  const pt = (x: number, y: number): Pt2 => ({ x, y });
  const Ho = [pt(0, 0), pt(4, 0), pt(4.5, HR3), pt(2.5, 5 * HR3), pt(1.5, 5 * HR3), pt(-0.5, HR3)];
  const H: Meta = {
    shape: Ho,
    children: [
      { T: matchTwo(HAT[5]!, HAT[7]!, Ho[5]!, Ho[0]!), geom: 'H' },
      { T: matchTwo(HAT[9]!, HAT[11]!, Ho[1]!, Ho[2]!), geom: 'H' },
      { T: matchTwo(HAT[5]!, HAT[7]!, Ho[3]!, Ho[4]!), geom: 'H' },
      { T: mMul(mMove(2.5, HR3), mMul([-0.5, -HR3, 0, HR3, -0.5, 0], [0.5, 0, 0, 0, -0.5, 0])), geom: 'H1' },
    ],
  };
  const T: Meta = { shape: [pt(0, 0), pt(3, 0), pt(1.5, 3 * HR3)], children: [{ T: [0.5, 0, 0.5, 0, 0.5, HR3], geom: 'T' }] };
  const two = (kind: string): Meta['children'] => [
    { T: [0.5, 0, 1.5, 0, 0.5, HR3], geom: kind },
    { T: mMul(mMove(0, 2 * HR3), mMul([0.5, HR3, 0, -HR3, 0.5, 0], [0.5, 0, 0, 0, 0.5, 0])), geom: kind },
  ];
  const P: Meta = { shape: [pt(0, 0), pt(4, 0), pt(3, 2 * HR3), pt(-1, 2 * HR3)], children: two('P') };
  const F: Meta = { shape: [pt(0, 0), pt(3, 0), pt(3.5, HR3), pt(3, 2 * HR3), pt(-1, 2 * HR3)], children: two('F') };
  return [H, T, P, F];
}

/** One round of putting clusters together: a patch of 29 of them, laid edge to edge by rule, and out of it the four larger clusters. */
function largerClusters([H, T, P, F]: [Meta, Meta, Meta, Meta]): [Meta, Meta, Meta, Meta] {
  const kinds: Record<string, Meta> = { H, T, P, F };
  // Each rule: which cluster already placed, and which side of it, the next one is laid against (and by which of its own sides).
  const rules: (string | number)[][] = [['H'], [0, 0, 'P', 2], [1, 0, 'H', 2], [2, 0, 'P', 2], [3, 0, 'H', 2], [4, 4, 'P', 2], [0, 4, 'F', 3], [2, 4, 'F', 3], [4, 1, 3, 2, 'F', 0], [8, 3, 'H', 0], [9, 2, 'P', 0], [10, 2, 'H', 0], [11, 4, 'P', 2], [12, 0, 'H', 2], [13, 0, 'F', 3], [14, 2, 'F', 1], [15, 3, 'H', 4], [8, 2, 'F', 1], [17, 3, 'H', 0], [18, 2, 'P', 0], [19, 2, 'H', 2], [20, 4, 'F', 3], [20, 0, 'P', 2], [22, 0, 'H', 2], [23, 4, 'F', 3], [23, 0, 'F', 3], [16, 0, 'P', 2], [9, 4, 0, 2, 'T', 2], [4, 0, 'F', 3]];
  const patch: { T: Mat; geom: Meta }[] = [];
  for (const r of rules) {
    if (r.length === 1) patch.push({ T: [1, 0, 0, 0, 1, 0], geom: kinds[r[0] as string]! });
    else if (r.length === 4) {
      const on = patch[r[0] as number]!;
      const side = on.geom.shape;
      const [p, q] = [mAt(on.T, side[((r[1] as number) + 1) % side.length]!), mAt(on.T, side[r[1] as number]!)];
      const next = kinds[r[2] as string]!;
      patch.push({ T: matchTwo(next.shape[r[3] as number]!, next.shape[((r[3] as number) + 1) % next.shape.length]!, p, q), geom: next });
    } else {
      const [chP, chQ] = [patch[r[0] as number]!, patch[r[2] as number]!];
      const [p, q] = [mAt(chQ.T, chQ.geom.shape[r[3] as number]!), mAt(chP.T, chP.geom.shape[r[1] as number]!)];
      const next = kinds[r[4] as string]!;
      patch.push({ T: matchTwo(next.shape[r[5] as number]!, next.shape[((r[5] as number) + 1) % next.shape.length]!, p, q), geom: next });
    }
  }
  const corner = (n: number, i: number): Pt2 => mAt(patch[n]!.T, patch[n]!.geom.shape[i]!);
  const made = (shape: Pt2[], from: number[]): Meta => {
    // (Each new cluster is moved so that its middle is at the origin.)
    const cx = shape.reduce((t, p) => t + p.x, 0) / shape.length;
    const cy = shape.reduce((t, p) => t + p.y, 0) / shape.length;
    return { shape: shape.map((p) => ({ x: p.x - cx, y: p.y - cy })), children: from.map((n) => ({ T: mMul(mMove(-cx, -cy), patch[n]!.T), geom: patch[n]!.geom })) };
  };
  const bps1 = corner(8, 2);
  const bps2 = corner(21, 2);
  const rbps = mAt(rotAbout(bps1, (-2 * Math.PI) / 3), bps2);
  const p72 = corner(7, 2);
  const p252 = corner(25, 2);
  const llc = meet(bps1, rbps, corner(6, 2), p72);
  let w = sub2(corner(6, 2), llc);
  const Ho = [llc, bps1];
  w = mAt(mRot(-Math.PI / 3), w);
  Ho.push(add2(Ho[1]!, w));
  Ho.push(corner(14, 2));
  w = mAt(mRot(-Math.PI / 3), w);
  Ho.push(sub2(Ho[3]!, w));
  Ho.push(corner(6, 2));
  const newH = made(Ho, [0, 9, 16, 27, 26, 6, 1, 8, 10, 15]);
  const newP = made([p72, add2(p72, sub2(bps1, llc)), bps1, llc], [7, 2, 3, 4, 28]);
  const newF = made([bps2, corner(24, 2), corner(25, 0), p252, add2(p252, sub2(llc, bps1))], [21, 20, 22, 23, 24, 25]);
  const AAA = Ho[2]!;
  const BBB = add2(Ho[1]!, sub2(Ho[4]!, Ho[5]!));
  const CCC = mAt(rotAbout(BBB, -Math.PI / 3), AAA);
  const newT = made([BBB, CCC, AAA], [11]);
  return [newH, newT, newP, newF];
}

/** The hat tiling: a patch of it over the card, each hat outlined; the hats that are turned over (about one in seven) are white, and the three round each of them shaded. */
function hat(small: boolean, tones: 1 | 2 | 3 = 3): string {
  let clusters = firstClusters();
  for (let i = 0; i < 3; i++) clusters = largerClusters(clusters);
  const hats: { kind: string; at: Pt2[] }[] = [];
  const gather = (m: Meta, T: Mat): void => {
    for (const ch of m.children) {
      const M = mMul(T, ch.T);
      if (typeof ch.geom === 'string') hats.push({ kind: ch.geom, at: HAT.map((p) => mAt(M, p)) });
      else gather(ch.geom, M);
    }
  };
  gather(clusters[0], [1, 0, 0, 0, 1, 0]);
  // One step of the hat's own grid is `u` px; the patch's middle is put at the middle of the card.
  const u = small ? 9 : 5.2;
  const cx = hats.reduce((t, h) => t + h.at[0]!.x, 0) / hats.length;
  const cy = hats.reduce((t, h) => t + h.at[0]!.y, 0) / hats.length;
  const fill: Record<string, string> = { H1: '', H: '' };
  let lines = '';
  for (const h of hats) {
    const at = h.at.map((p): [number, number] => [W / 2 + (p.x - cx) * u, H / 2 + (p.y - cy) * u]);
    if (at.every(([x, y]) => x < F.x - 2 || x > F.x + F.w + 2 || y < F.y - 2 || y > F.y + F.h + 2)) continue;
    const d = poly(at);
    lines += d;
    if (h.kind in fill) fill[h.kind] += d;
  }
  // `tones`: 3 as described; 2 without the shading (turned-over hats white, the rest bare); 1 outlines only.
  const solid = tones >= 2 ? `<path d="${fill.H1}" fill="#fff" stroke="none"/>` : '';
  const shade = tones >= 3 ? `<path d="${fill.H}" fill="rgba(255,255,255,0.3)" stroke="none"/>` : '';
  return frame(clipped(`${solid}${shade}<path d="${lines}" stroke-linejoin="round"/>`), small ? 1.2 : 0.6, small);
}

/** Chains: rows of oval links, each through the next: where two cross, one passes over and the other is broken off short of it. Every other row is half a link along. */
function chain(small: boolean): string {
  const across = small ? 3 : 5;
  const step = F.w / across; // from one link to the next
  const [rx, ry] = [step * 0.72, step * 0.36];
  const rows = Math.floor(F.h / (ry * 2 + step * 0.34));
  const pitch = F.h / rows;
  const gap = small ? 2 : 1.25;
  let d = '';
  for (let r = 0; r < rows; r++) {
    const cy = F.y + (r + 0.5) * pitch;
    for (let k = -1; k <= across + 1; k++) {
      const cx = F.x + (k + (r % 2 ? 0.5 : 0)) * step;
      // How far a point is from the outline of the link `n` along from this one.
      const off = (x: number, y: number, n: number): number => Math.abs(Math.hypot((x - cx - n * step) / rx, (y - cy) / ry) - 1) * ry;
      let run: [number, number][] = [];
      for (let a = 0; a <= 360; a += 5) {
        const [x, y] = [cx + rx * Math.cos((a * Math.PI) / 180), cy + ry * Math.sin((a * Math.PI) / 180)];
        // It goes under the next link along the top, and under the last one along the bottom.
        if ((y < cy && off(x, y, 1) < gap) || (y > cy && off(x, y, -1) < gap)) {
          if (run.length > 1) d += pts(run);
          run = [];
        } else run.push([x, y]);
      }
      if (run.length > 1) d += pts(run);
    }
  }
  return frame(clipped(`<path d="${d}"/>`), small ? 2.2 : 1.35, small);
}

/**
 * Pulsar: lines of signal one above another, flat at the sides and leaping in the middle, each in front of the ones
 * above it and hiding them where it rises (a made-up signal, by a fixed roll of the dice).
 */
function pulsar(small: boolean): string {
  const lines = small ? 13 : 30;
  const roll = dice(77);
  const samples = Math.round(F.w / 0.75);
  const top = F.y + F.h * 0.17;
  const pitch = (F.h * 0.76) / (lines - 1);
  // Each line: a few peaks of different heights and widths, somewhere in the middle half.
  const traces: number[][] = [];
  for (let i = 0; i < lines; i++) {
    const peaks = Array.from({ length: 4 + Math.floor(roll() * 4) }, () => ({ at: 0.3 + roll() * 0.4, wide: 0.012 + roll() * 0.035, high: (0.3 + roll()) * pitch * (small ? 1.6 : 2.6) }));
    traces.push(
      Array.from({ length: samples + 1 }, (_, k) => {
        const u = k / samples;
        const lift = peaks.reduce((t, p) => t + p.high * Math.exp(-((u - p.at) ** 2) / (2 * p.wide ** 2)), 0);
        return top + i * pitch - lift - 0.5 * Math.sin(u * 40 + i) * Math.exp(-((u - 0.5) ** 2) / 0.05);
      }),
    );
  }
  // From the front (the lowest line) back: a line shows only where it is above everything in front of it.
  const horizon = new Array<number>(samples + 1).fill(Infinity);
  let d = '';
  for (let i = lines - 1; i >= 0; i--) {
    let run: [number, number][] = [];
    traces[i]!.forEach((y, k) => {
      if (y < horizon[k]! - 0.3) run.push([F.x + (k / samples) * F.w, y]);
      else {
        if (run.length > 1) d += pts(run);
        run = [];
      }
      horizon[k] = Math.min(horizon[k]!, y);
    });
    if (run.length > 1) d += pts(run);
  }
  return frame(clipped(`<path d="${d}"/>`), small ? 1.3 : 0.7, small);
}

/**
 * Packed circles: circles of every size, each as large as the room where it fell allows (by a fixed roll of the
 * dice) and so all but touching a neighbour: big ones first, then smaller and smaller ones into the gaps left.
 */
function bubbles(small: boolean): string {
  const roll = dice(small ? 19 : 8);
  const gap = small ? 1.6 : 0.75;
  const out = small ? 8 : 6; // (how far outside the field a circle's middle may be: the field cuts those off)
  const all: { x: number; y: number; r: number }[] = [];
  // Rounds of smaller and smaller circles: in each, one is kept only if it has room to be nearly as big as the round allows.
  for (const [most, tries] of small ? [[19, 60], [11, 300], [6.5, 1500], [4, 3000]] as const : [[13, 80], [8.5, 400], [5.5, 1500], [3.4, 4000], [2.2, 10000]] as const) {
    for (let t = 0; t < tries; t++) {
      const [x, y] = [F.x - out + roll() * (F.w + 2 * out), F.y - out + roll() * (F.h + 2 * out)];
      let r: number = most;
      for (const c of all) r = Math.min(r, Math.hypot(x - c.x, y - c.y) - c.r - gap);
      if (r >= most * 0.62) all.push({ x, y, r });
    }
  }
  return frame(clipped(all.map((c) => `<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(c.r)}"/>`).join('')), small ? 1.5 : 0.75, small);
}

// The outline of a fleur-de-lis, 584 by 593 ("Fleur de lis flat.svg", Wikimedia Commons, CC0), and of the lily of
// Florence with its stamens, 347.465 by 475.946 ("Fleur de lis of Florence.svg", Wikimedia Commons, public domain).
const LIS = 'M 291.5,-0.5 C 292.167,-0.5 292.833,-0.5 293.5,-0.5C 296.695,2.85212 300.362,5.68545 304.5,8C 322.991,17.4119 341.325,27.0785 359.5,37C 374.753,45.2489 387.92,56.0822 399,69.5C 416.942,100.784 416.942,132.118 399,163.5C 384.728,183.706 369.728,203.373 354,222.5C 335.913,253.107 326.079,286.273 324.5,322C 324.667,325.167 324.833,328.333 325,331.5C 325.494,338.841 329.327,341.341 336.5,339C 337.333,338.167 338.167,337.333 339,336.5C 347.152,283.694 369.985,238.528 407.5,201C 430.639,179.601 457.973,167.101 489.5,163.5C 535.074,168.922 565.241,193.256 580,236.5C 581.607,243.912 582.773,251.245 583.5,258.5C 583.5,259.5 583.5,260.5 583.5,261.5C 581.563,296.546 566.23,324.046 537.5,344C 516.373,354.325 494.039,358.825 470.5,357.5C 472.038,351.421 473.871,345.421 476,339.5C 479.045,329.13 479.045,318.797 476,308.5C 462.086,292.063 444.919,287.23 424.5,294C 403.371,302.456 392.871,317.956 393,340.5C 393.69,343.196 395.19,345.363 397.5,347C 407.809,349.99 417.476,354.323 426.5,360C 439.712,370.373 439.712,380.706 426.5,391C 416.963,397.52 406.63,402.52 395.5,406C 393.406,407.255 392.406,409.088 392.5,411.5C 396.803,428.943 405.803,443.443 419.5,455C 434.523,465.482 448.857,464.482 462.5,452C 469.764,444.64 474.264,435.807 476,425.5C 476.347,423.82 477.347,422.82 479,422.5C 497.213,431.083 508.38,445.25 512.5,465C 506.525,498.975 486.525,518.975 452.5,525C 418.583,529.123 391.75,517.29 372,489.5C 360.642,472.116 351.976,453.449 346,433.5C 344.713,425.219 344.213,416.886 344.5,408.5C 336.5,408.5 328.5,408.5 320.5,408.5C 321.743,424.032 324.243,439.365 328,454.5C 332.939,467.428 340.273,478.761 350,488.5C 356.305,498.444 360.972,509.111 364,520.5C 367.252,535.742 362.752,548.242 350.5,558C 345.442,562.057 340.108,565.724 334.5,569C 319.784,576.354 305.451,584.187 291.5,592.5C 291.167,592.5 290.833,592.5 290.5,592.5C 286.438,588.291 281.772,584.791 276.5,582C 262.356,575.43 248.689,568.097 235.5,560C 216.748,544.168 213.248,525.335 225,503.5C 227.599,497.911 230.599,492.577 234,487.5C 247.88,474.074 256.214,457.741 259,438.5C 260.496,428.531 261.663,418.531 262.5,408.5C 254.5,408.5 246.5,408.5 238.5,408.5C 239.914,426.511 236.414,443.511 228,459.5C 219.709,478.949 207.876,495.782 192.5,510C 163.588,529.908 133.588,531.574 102.5,515C 82.4515,501.947 72.2848,483.447 72,459.5C 77.36,442.31 88.1933,429.976 104.5,422.5C 105.647,422.818 106.481,423.484 107,424.5C 110.476,443.971 121.643,456.471 140.5,462C 153.379,462.479 163.879,457.646 172,447.5C 180.069,438.033 186.069,427.366 190,415.5C 191.71,409.531 189.543,405.697 183.5,404C 173.33,400.915 163.997,396.248 155.5,390C 143.955,377.919 145.288,367.252 159.5,358C 168.934,353.635 178.434,349.468 188,345.5C 192.115,337.621 192.115,329.621 188,321.5C 175.251,297.041 155.417,287.541 128.5,293C 118.136,296.375 110.636,302.875 106,312.5C 103.991,328.12 106.491,342.953 113.5,357C 50.4546,360.752 12.4546,331.919 -0.5,270.5C -0.5,261.5 -0.5,252.5 -0.5,243.5C 7.23656,207.919 28.5699,184.419 63.5,173C 92.9844,164.356 120.984,167.689 147.5,183C 193.48,209.327 223.314,248.161 237,299.5C 238.964,311.916 241.297,324.249 244,336.5C 247.795,339.803 251.962,340.303 256.5,338C 259.585,299.813 252.085,263.646 234,229.5C 221.427,212.256 208.093,195.589 194,179.5C 182.86,165.889 174.86,150.556 170,133.5C 165.241,108.2 171.241,85.8664 188,66.5C 199.767,53.3881 213.267,42.5548 228.5,34C 250.524,23.9955 271.524,12.4955 291.5,-0.5 Z';
const GIGLIO = 'M294.504 168.985l-.754.008c-25.586 0-54.656 14.508-73.578 55.508-10.117 22.727-15.754 48.809-15.793 75.293h-8.102c0-54.859 13.848-102.258 33.922-124.641 5.582-6.531 14.633-9.508 23.773-8.531a29.16 29.16 0 0 1 5.5 1.129c-2.18-4.727-6.719-8.219-12.266-8.812-2.5-.266-4.922.09-7.117.938l7.105-9.211v.004c2.641-3.008 3.738-3.707 5.941-4.633l-.012.004c2.359-.84 4.891-1.098 7.363-.754 2.484.359 4.086 1.262 7.187 2.316 4.125 1.406 7.68 1.699 11.941 1.34a23.81 23.81 0 0 0 15.07-6.684c-4.309 1.258-8.918 1.309-13.281.09-4.512-1.367-7.297-3.648-12.934-5.723-2.902-1.078-6.039-1.266-9.02-.625l10.031-11.016h.004c1.957-2.121 4.672-4.137 5.621-4.797 2.773-1.844 5.27-2.977 7.34-3.664l-.004-.008c2-.629 4.074-.965 6.152-.988l-.019-.039c-1.852-2.988-1.633-6.945.797-9.734a8.22 8.22 0 0 1 11.594-.789 8.21 8.21 0 0 1 1.121 11.176c3.434.555 7.066-.504 9.688-3.18a11.11 11.11 0 0 0-.168-15.715c-.895-.879-1.965-1.633-3.035-2.145 0 0-1.023-.437-2.531-.789-2.141-.496-3.289-.824-3.289-.824a.55.55 0 0 1-.156-.098.56.56 0 0 1-.055-.789.54.54 0 0 1 .406-.187c2.492-.062 3.035-.164 3.035-.164s1.398 0 3.07-.43l-.004-.004c2.023-.504 3.707-1.668 4.883-3.207.699-.977 1.219-2.047 1.563-3.266.609-2.105.695-4.648.301-7.91-.68-5.719-.504-9.645-.504-9.645s-3.875.695-9.629.773c-3.281.047-5.793.469-7.797 1.344-1.164.508-2.16 1.168-3.031 1.984-1.371 1.367-2.301 3.191-2.531 5.266h-.004c-.211 1.711-.023 3.098-.023 3.098s-.031.551.238 3.027c.019.152-.023.309-.133.43a.56.56 0 0 1-.789.051c-.043-.043-.082-.09-.113-.141 0 0-.48-1.102-1.254-3.152-.543-1.449-1.117-2.402-1.117-2.402a11.69 11.69 0 0 0-2.531-2.73c-4.836-3.781-11.816-2.918-15.598 1.918a11.07 11.07 0 0 0-1.867 10.027c3.035-3.043 7.949-3.25 11.223-.371a8.22 8.22 0 0 1 .758 11.598c-2.441 2.777-6.336 3.516-9.539 2.078l-.047-.016c.254 2.063.195 4.168-.164 6.23l-.012-.004c-.441 2.344-1.344 5.258-3.082 8.598-.762 1.375-1.816 2.695-2.547 3.543l-11.289 12.379c.082-2.918-.613-5.844-2.078-8.43-2.746-4.871-5.473-7.262-7.715-11.848-1.898-4.113-2.586-8.676-2.031-13.129a23.8 23.8 0 0 0-4.195 15.941c.332 4.262 1.184 7.727 3.23 11.578 1.539 2.895 2.688 4.328 3.441 6.727.73 2.379.875 4.91.43 7.367-.504 2.367-2.105 4.777-2.934 5.906l-8.895 11.52a15.23 15.23 0 0 0-1.59-8.902c-2.563-4.957-7.465-7.918-12.66-8.242a28.78 28.78 0 0 1 3.047 4.719c2.25 4.344 3.445 9.059 3.465 13.656l-.008-.008c-.027 6.859-8.566 18.875-10.992 22.836-16.164 26.305-26.723 69.703-26.723 118.785h-8.031v-29.93c0-60.625 15.008-115.563 41.512-165.66 4.035-7.629 6.426-17.734 6.426-26.965l.004-.004.004-.871a54.05 54.05 0 0 0-11.102-32.902c-3.203-4.203-7.008-7.918-11.281-11.028-5.203-3.914-16.699-10.07-20.898-12.496A23.4 23.4 0 0 1 173.723 0a23.4 23.4 0 0 1-11.121 19.938c-4.195 2.426-15.691 8.582-20.895 12.496-4.277 3.109-8.078 6.824-11.285 11.027-6.961 9.129-11.102 20.531-11.102 32.902l.008.871v.004c0 9.23 2.398 19.336 6.43 26.965 26.504 50.098 41.512 105.035 41.512 165.66v29.93h-8.031c0-49.082-10.559-92.48-26.719-118.785-2.43-3.961-10.969-15.977-10.996-22.836l-.008.008c.019-4.598 1.219-9.312 3.465-13.656a28.78 28.78 0 0 1 3.047-4.719c-5.195.324-10.094 3.285-12.656 8.242-1.473 2.848-1.961 5.945-1.594 8.902l-8.895-11.52c-.824-1.129-2.43-3.539-2.93-5.906-.449-2.457-.301-4.988.426-7.367.758-2.398 1.902-3.832 3.441-6.727 2.047-3.852 2.902-7.316 3.234-11.578.52-5.496-.852-11.164-4.199-15.941.555 4.453-.133 9.016-2.031 13.129-2.242 4.586-4.969 6.977-7.711 11.848-1.469 2.586-2.164 5.512-2.082 8.43l-11.289-12.379c-.727-.848-1.781-2.168-2.547-3.543-1.738-3.34-2.641-6.254-3.086-8.598l-.004.004c-.363-2.062-.418-4.168-.168-6.23l-.043.016a8.23 8.23 0 0 1-9.543-2.078 8.22 8.22 0 0 1 .758-11.598 8.21 8.21 0 0 1 11.227.371c1-3.332.43-7.074-1.871-10.027-3.781-4.836-10.762-5.699-15.598-1.918a11.51 11.51 0 0 0-2.527 2.73s-.57.953-1.117 2.402c-.777 2.051-1.258 3.152-1.258 3.152-.031.051-.07.098-.113.141a.56.56 0 0 1-.789-.051c-.109-.121-.152-.277-.133-.43.27-2.477.238-3.027.238-3.027s.188-1.387-.02-3.098h-.004c-.23-2.074-1.16-3.898-2.531-5.266-.875-.817-1.867-1.477-3.035-1.984-2.004-.875-4.516-1.297-7.797-1.344-5.754-.078-9.629-.773-9.629-.773s.176 3.926-.504 9.645c-.395 3.262-.305 5.805.301 7.91.344 1.219.863 2.289 1.566 3.266 1.172 1.539 2.855 2.703 4.879 3.207l-.004.004c1.672.43 3.07.43 3.07.43s.543.102 3.035.164c.148 0 .301.066.406.188a.56.56 0 0 1-.055.789.55.55 0 0 1-.156.098s-1.156.328-3.289.824c-1.508.352-2.527.789-2.527.789a11.5 11.5 0 0 0-3.039 2.145 11.11 11.11 0 0 0-.168 15.715c2.621 2.676 6.254 3.734 9.688 3.18-2.609-3.414-2.164-8.309 1.121-11.176a8.22 8.22 0 0 1 12.391 10.523l-.02.039a21.28 21.28 0 0 1 6.152.988l-.004.008c2.07.688 4.57 1.82 7.34 3.664.953.66 3.664 2.676 5.625 4.797L87.993 136c-2.977-.641-6.113-.453-9.02.625-5.633 2.074-8.418 4.355-12.934 5.723-4.359 1.219-8.973 1.168-13.281-.09a23.81 23.81 0 0 0 15.066 6.684c4.266.359 7.82.066 11.949-1.34 3.094-1.055 4.699-1.957 7.184-2.316 2.477-.344 5.008-.086 7.363.754l-.012-.004c2.211.926 3.301 1.625 5.941 4.633v-.004l7.109 9.211a15.25 15.25 0 0 0-7.121-.937c-5.547.594-10.086 4.086-12.266 8.813 1.762-.543 3.598-.926 5.504-1.129 9.137-.977 18.187 2 23.77 8.531 20.074 22.383 33.922 69.781 33.926 124.641h-8.09c-.039-26.484-5.672-52.566-15.797-75.293-18.918-41-47.988-55.508-73.574-55.508-.066 0-.684-.008-.758-.008C23.707 168.985 0 192.695 0 221.945c0 21.422 12.715 39.871 31.012 48.215 5.25 2.391 10.648 4.566 16.461 5.867 13.141 2.941 21.379 5.023 29.074 9.746 4.609 2.684 7.707 7.68 7.707 13.398a15.44 15.44 0 0 1-4.625 11.043l.019-.004-4.246 3.93-2.008 1.711c-2.816 2.297-7.434 4.645-11.387 5.105-.418.055-.848-.102-1.133-.453a1.25 1.25 0 0 1-.266-.984l.004.019a11.36 11.36 0 0 0 .125-2.687c-.453-6.137-5.793-10.742-11.93-10.293a14.82 14.82 0 0 0-.715.078c-.016.004-.031.008-.047.008a9.28 9.28 0 0 0-.574.098c-.027.004-.059.012-.086.016l-.57.137c-.016 0-.031.004-.047.012-5.082 1.34-8.652 6.148-8.25 11.586a11.09 11.09 0 0 0 1.461 4.762c.02.027.039.055.055.086.074.125.152.246.23.371l.207.309a1.45 1.45 0 0 0 .09.125c.016.023.027.047.047.07.027.039.066.078.094.121.109.145.227.293.34.434.66.801 1.414 1.52 2.207 2.078 0 0 .285.195.793.461a11.54 11.54 0 0 0 1.645.785c1.984.836 3.047 1.344 3.047 1.344a.8.8 0 0 1 .137.121c.195.242.156.594-.082.789a.57.57 0 0 1-.434.121c-2.477-.363-3.035-.355-3.035-.355s-1.379-.238-3.102-.094v.004a8.81 8.81 0 0 0-5.375 2.34 10.45 10.45 0 0 0-2.105 2.969c-.953 1.977-1.477 4.484-1.645 7.773-.289 5.773-1.133 9.633-1.133 9.633s3.949-.043 9.66.84c3.258.504 5.816.496 7.949-.031a10.54 10.54 0 0 0 3.332-1.461c1.582-1.125 2.805-2.777 3.383-4.789h.004c.488-1.66.535-3.059.535-3.059s.121-.543.266-3.043a.56.56 0 0 1 .207-.398c.238-.195.594-.16.789.078.039.051.07.105.09.16a76.45 76.45 0 0 0 .703 3.254 10.92 10.92 0 0 0 .43 1.77c.164.547.289.871.289.871.391.891.941 1.777 1.59 2.578.117.145.234.289.355.426.035.039.063.082.102.117.02.019.039.039.059.063.035.031.07.074.105.109a16.89 16.89 0 0 0 .262.266c.102.102.211.199.316.301.023.019.051.047.074.066a11.08 11.08 0 0 0 4.363 2.402c5.242 1.496 10.672-1.027 13.02-5.734.008-.012.016-.027.023-.043l.246-.531c.012-.027.023-.051.031-.078a13.28 13.28 0 0 0 .215-.547.18.18 0 0 0 .016-.043c.078-.227.156-.449.219-.684 1.688-5.918-1.738-12.082-7.656-13.766-.887-.254-1.781-.395-2.664-.422l.019.004a1.26 1.26 0 0 1-.91-.457c-.281-.352-.348-.805-.211-1.199 1.254-3.785 4.238-7.277 6.926-9.727 1.688-1.547 6.738-5.746 10.715-11.109l.016-.004c.953-1.227 1.797-2.535 2.535-3.914 1.043-1.879 1.867-3.84 2.328-5.836.004-.012.008-.023.008-.035.512-1.891.824-3.859.922-5.883h-.004c.086-7.051-1.43-11.277-4.152-16.238-2.937-5.348-7.699-11.867-7.699-19.027 0-8.648 7.008-15.656 15.656-15.656 1.035 0 2.508.07 3.488.227 10.645 1.68 17.496 8.047 22.812 16.039l.012.012c7.695 11.867 12.199 26.039 12.297 41.207-6.512.23-12.477 3.781-15.754 9.453-3.383 5.863-3.383 13.09 0 18.953s9.645 9.473 16.418 9.473h20.234c-.031 1.09-.238 2.129-.605 3.063-6.137 15.684-30.602 22.617-64.707 37.055-18.148 7.684-22.836 19.711-23.195 29.402l.004.016c-.012.258-.012.512-.012.773 0 4.352.992 8.367 2.801 12.02a24.5 24.5 0 0 1 22.656-24.223c3.687-.273 7.617-.27 11.672-.27 1.379 0 2.445.047 3.672-.086 16.23-1.652 22.25-12.008 28.332-18.082s13.141-8.602 13.801-8.883c.836-.355 1.785-.477 2.746-.477 4.367 0 7.906 3.539 7.906 7.906a7.91 7.91 0 0 1-.152 1.562c-.066.328-.199.629-.332.926-5.109 11-19.051 15.859-42.973 25.988-12.723 5.391-16.012 13.824-16.266 20.621l.004.008-.008.547a18.83 18.83 0 0 0 1.965 8.426c.074-8.988 7.047-16.332 15.891-16.988 2.582-.191 5.34-.191 8.184-.191.969 0 1.719.035 2.578-.055 11.379-1.16 15.605-8.422 19.863-12.684 4.266-4.258 9.219-6.031 9.68-6.23.59-.246 1.254-.336 1.93-.336 3.063 0 5.543 2.484 5.543 5.547 0 .375-.035.742-.105 1.094-.121.492-1.07 5.684-4.582 10.582s-9.988 10.246-9.281 21.668c.445 7.238 2.391 10.328-.473 14.793 0 0 7.402-.594 13.207-8.473a.5.5 0 0 1 .406-.207.51.51 0 0 1 .508.504.53.53 0 0 1-.098.301c-7.477 10.512 1.906 20.816 4.016 24.094s3.223 8.543 3.223 8.543 1.121-5.262 3.227-8.543 11.492-13.582 4.016-24.094c-.062-.086-.098-.187-.098-.301 0-.277.227-.504.508-.504a.52.52 0 0 1 .41.207c5.797 7.879 13.199 8.473 13.199 8.473-2.863-4.465-.914-7.555-.465-14.793.699-11.422-5.781-16.77-9.289-21.668s-4.457-10.09-4.578-10.582c-.07-.352-.109-.719-.109-1.094a5.55 5.55 0 0 1 5.547-5.547c.672 0 1.336.09 1.926.336.465.199 5.418 1.973 9.676 6.23 4.27 4.262 8.492 11.523 19.875 12.684.855.09 1.605.055 2.574.055 2.844 0 5.602 0 8.184.191 8.84.656 15.82 8 15.887 16.988a18.73 18.73 0 0 0 1.969-8.426l-.008-.547v-.008c-.246-6.797-3.539-15.23-16.266-20.621-23.918-10.129-37.859-14.988-42.969-25.988-.137-.297-.266-.598-.332-.926a7.91 7.91 0 0 1-.156-1.562c0-4.367 3.539-7.906 7.906-7.906.961 0 1.91.121 2.754.477.656.281 7.715 2.813 13.797 8.883s12.098 16.43 28.332 18.082c1.223.133 2.293.086 3.672.086 4.055 0 7.984-.004 11.668.27 12.605.934 22.555 11.406 22.656 24.223 1.809-3.652 2.805-7.668 2.805-12.02l-.008-.773v-.016c-.363-9.691-5.047-21.719-23.195-29.402-34.109-14.437-58.57-21.371-64.707-37.055-.367-.934-.57-1.973-.602-3.063h19.883a18.94 18.94 0 0 0 16.406-28.422c-3.211-5.57-9.016-9.102-15.391-9.441.098-15.176 4.602-29.352 12.297-41.223l.012-.012c5.316-7.992 12.168-14.359 22.809-16.039.984-.156 2.457-.227 3.492-.227a15.66 15.66 0 0 1 15.66 15.656c0 7.16-4.766 13.68-7.699 19.027-2.723 4.961-4.246 9.188-4.152 16.238h-.008a27.59 27.59 0 0 0 .922 5.883.07.07 0 0 0 .008.027c.453 1.996 1.277 3.961 2.324 5.84a27.32 27.32 0 0 0 2.539 3.918l.016.004c3.977 5.363 9.027 9.563 10.715 11.109 2.684 2.449 5.668 5.941 6.926 9.727.137.395.066.848-.211 1.199a1.26 1.26 0 0 1-.91.457l.019-.004c-.883.027-1.773.168-2.664.422a11.14 11.14 0 0 0-7.656 13.766 12.68 12.68 0 0 0 .219.684.11.11 0 0 0 .019.043 7.16 7.16 0 0 0 .211.547c.012.027.023.051.035.078.074.18.156.355.242.531.008.016.012.031.019.043 2.348 4.707 7.781 7.23 13.02 5.734 1.676-.477 3.152-1.312 4.367-2.402.027-.019.047-.047.074-.066l.316-.301c.09-.086.176-.176.262-.266.035-.035.07-.078.109-.109.012-.023.039-.043.059-.062.031-.035.063-.078.098-.117.121-.137.238-.281.355-.426.648-.801 1.199-1.687 1.59-2.578 0 0 .125-.324.285-.871.199-.574.34-1.168.438-1.77.414-2.109.699-3.254.699-3.254.019-.055.051-.109.09-.16.195-.238.547-.273.789-.078a.56.56 0 0 1 .207.398c.145 2.5.266 3.043.266 3.043s.047 1.398.535 3.059a8.9 8.9 0 0 0 3.387 4.789 10.54 10.54 0 0 0 3.332 1.461c2.137.527 4.691.535 7.949.031 5.711-.883 9.656-.84 9.656-.84s-.84-3.859-1.129-9.633c-.168-3.289-.695-5.797-1.645-7.773-.551-1.148-1.25-2.121-2.102-2.969-1.426-1.32-3.289-2.187-5.383-2.34l.008-.004c-1.727-.145-3.109.094-3.109.094s-.555-.008-3.031.355c-.148.019-.309-.019-.434-.121a.56.56 0 0 1-.078-.789c.039-.047.086-.086.129-.121 0 0 1.063-.508 3.051-1.344.57-.219 1.121-.48 1.641-.785.508-.266.797-.461.797-.461.793-.559 1.547-1.277 2.203-2.078.121-.141.234-.289.344-.434.031-.043.066-.082.098-.121.012-.023.027-.047.047-.07a3.36 3.36 0 0 0 .082-.125l.211-.309c.082-.125.156-.246.23-.371.016-.031.031-.059.055-.086.813-1.414 1.336-3.027 1.465-4.762a11.14 11.14 0 0 0-8.254-11.586c-.016-.008-.031-.012-.047-.012-.187-.051-.379-.094-.57-.137-.027-.004-.059-.012-.086-.016-.191-.039-.383-.07-.578-.098a.23.23 0 0 1-.047-.008 13.66 13.66 0 0 0-.711-.078c-6.137-.449-11.477 4.156-11.93 10.293a11.16 11.16 0 0 0 .125 2.688v-.019c.055.34-.027.699-.262.984a1.24 1.24 0 0 1-1.129.453c-3.961-.461-8.574-2.809-11.391-5.105-.652-.531-2.008-1.711-2.008-1.711l-4.246-3.93.019.004a15.44 15.44 0 0 1-4.625-11.043c0-5.719 3.098-10.715 7.707-13.398 7.695-4.723 15.934-6.805 29.07-9.746 5.816-1.301 11.215-3.477 16.461-5.867 18.301-8.344 31.02-26.793 31.02-48.215 0-29.25-23.711-52.961-52.961-52.961';

/** Fleurs-de-lis strewn over the card as on the old French arms: rows of them, each row half a step along from the last. */
function fleur(small: boolean): string {
  const cols = small ? 2 : 3;
  const step = F.w / cols;
  const pitch = step * 0.98;
  const k = (step * 0.7) / 584;
  let all = '';
  for (let r = -Math.ceil(F.h / pitch / 2) - 1; r <= Math.ceil(F.h / pitch / 2) + 1; r++) {
    for (let c = -1; c <= cols; c++) {
      const [x, y] = [F.x + (c + 0.5 + (r % 2 ? 0.5 : 0)) * step, H / 2 + r * pitch];
      all += `<use href="#l" transform="translate(${n(x - 292 * k)} ${n(y - 296.5 * k)}) scale(${Math.round(k * 10000) / 10000})"/>`;
    }
  }
  return frame(`<defs><path id="l" d="${LIS}"/></defs>` + clipped(`<g fill="#fff" fill-rule="evenodd" stroke="none">${all}</g>`), 1, small);
}

/** The lily of Florence, alone in the middle of the card. */
function giglio(small: boolean): string {
  const k = Math.min((F.w * (small ? 0.98 : 0.9)) / 347.465, (F.h * 0.9) / 475.946);
  return frame(`<path d="${GIGLIO}" transform="translate(${n(W / 2 - (347.465 * k) / 2)} ${n(H / 2 - (475.946 * k) / 2)}) scale(${Math.round(k * 10000) / 10000})" fill="#fff" fill-rule="evenodd" stroke="none"/>`, 1, small);
}

/**
 * A lotus seen from the side, drawn the same on both halves: pointed petals fanned out from one foot, the nearer
 * ones lying over the farther, each with a vein down its middle; an arch over it and the water under it. (The petals
 * are painted one over another in a mask, each with a bare rim round it, so that a nearer one cuts into those behind.)
 */
function lotus(small: boolean): string {
  const [cx, by] = [W / 2, H / 2 + 15];
  const rim = small ? 2.6 : 1.5;
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  /** A petal from the foot: `lean` degrees off upright, `long` from foot to tip, `wide` at its widest, its foot `out` to the side. */
  const petal = (lean: number, long: number, wide: number, out = 0, vein = true): string => {
    const [dx, dy] = [Math.sin(rad(lean)), -Math.cos(rad(lean))];
    const [px, py] = [-dy, dx];
    const [bx, b2] = [cx + out, by];
    const at = (along: number, side: number): string => `${n(bx + dx * long * along + px * wide * side)} ${n(b2 + dy * long * along + py * wide * side)}`;
    const shape = `M${at(0, 0)}C${at(0.22, 0.95)} ${at(0.68, 1.05)} ${at(1, 0)}C${at(0.68, -1.05)} ${at(0.22, -0.95)} ${at(0, 0)}Z`;
    return (
      `<path d="${shape}" fill="#fff" stroke="#000" stroke-width="${rim * 2}" paint-order="stroke"/>` +
      (vein && !small ? `<path d="M${at(0.2, 0)}L${at(0.86, 0)}" stroke="#000" stroke-width="0.8" fill="none"/>` : '')
    );
  };
  // From the back to the front: the tall ones behind, then each pair further out and lower, then the short ones in front.
  const order: [lean: number, long: number, wide: number][] = [[0, 46, 9.5], [20, 43, 9], [40, 40, 9], [60, 37, 8.5], [79, 35, 7.5], [95, 31, 6]];
  let petals = '';
  for (const [lean, long, wide] of order) petals += lean ? petal(-lean, long, wide) + petal(lean, long, wide) : petal(0, long, wide);
  petals += petal(-30, 31, 8.5) + petal(30, 31, 8.5) + petal(-11, 28, 8) + petal(11, 28, 8) + petal(0, 24, 7.5);
  // The arch over it (two broken rings), and the water: lines under the foot, shorter and shorter.
  const ring = (r: number, from: number, to: number): string => `M${n(cx + r * Math.sin(rad(from)))} ${n(by - 14 - r * Math.cos(rad(from)))}A${r} ${r} 0 0 1 ${n(cx + r * Math.sin(rad(to)))} ${n(by - 14 - r * Math.cos(rad(to)))}`;
  const line = small ? 1.6 : 0.8;
  const arch = small ? ring(33, -62, 62) : ring(34, -82, 82) + ring(30, -38, 38) + ring(30, -70, -50) + ring(30, 50, 70);
  const water = [[30, 6], [22, 10], [13, 14]].map(([half, down]) => `M${n(cx - half!)} ${n(by + down!)}H${n(cx + half!)}`).join('');
  return frame(
    `<mask id="lo" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#000" stroke="none"/>` +
      `<path d="${arch}${small ? '' : water}" stroke="#fff" stroke-width="${line}" fill="none"/>${petals}</mask>` +
      `<rect x="${F.x}" y="${F.y}" width="${F.w}" height="${F.h}" fill="#fff" stroke="none" mask="url(#lo)"/>`,
    1,
    small,
  );
}

/**
 * The flower of life: circles all of one size, each through the middles of its six neighbours, so that every one is
 * cut into petals. They run over the whole card; the nineteen in the middle (seven on a small card) are ringed, and
 * drawn heavier.
 */
function flowerOfLife(small: boolean): string {
  const r = small ? 16.4 : (F.w / 2 - 3.4) / 3; // (so that the ring round the middle ones clears the sides of the field)
  const [cx, cy] = [W / 2, H / 2];
  const reach = small ? 1.05 : 2.05; // the middle ones: within this many radii
  let [mid, rest] = ['', ''];
  for (let j = -8; j <= 8; j++) {
    for (let i = -8; i <= 8; i++) {
      const [x, y] = [cx + (i + j / 2) * r, cy + ((j * Math.sqrt(3)) / 2) * r];
      if (x < F.x - r || x > F.x + F.w + r || y < F.y - r || y > F.y + F.h + r) continue;
      const circle = `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}"/>`;
      if (Math.hypot(x - cx, y - cy) < reach * r) mid += circle;
      else rest += circle;
    }
  }
  const out = (small ? 2 : 3) * r;
  return frame(
    clipped(
      `<g stroke-width="${small ? 0.9 : 0.45}" opacity="0.55">${rest}</g><g stroke-width="${small ? 1.5 : 0.85}">${mid}</g>` +
        `<circle cx="${cx}" cy="${cy}" r="${n(out)}" stroke-width="${small ? 2.2 : 1.5}"/>${small ? '' : `<circle cx="${cx}" cy="${cy}" r="${n(out + 2.2)}" stroke-width="0.5"/>`}`,
    ),
    1,
    small,
  );
}

// ---------------------------------------------------------------- the night sky
//
// Three backs in the manner of fortune-telling cards: fine lines and small solid shapes (moons, stars, an eye) inside
// a thin frame with its corners cut in. Each reads the same either way up, or nearly. These are what they share.

/** A four-pointed star, its points drawn in to the middle: `r` tall, a little narrower across. */
const spark = (x: number, y: number, r: number, across = 0.62): string =>
  `M${n(x)} ${n(y - r)}Q${n(x)} ${n(y)} ${n(x + r * across)} ${n(y)}Q${n(x)} ${n(y)} ${n(x)} ${n(y + r)}Q${n(x)} ${n(y)} ${n(x - r * across)} ${n(y)}Q${n(x)} ${n(y)} ${n(x)} ${n(y - r)}Z`;
/** A small star of two crossed hairlines. */
const twinkle = (x: number, y: number, r: number): string => `M${n(x)} ${n(y - r)}V${n(y + r)}M${n(x - r * 0.7)} ${n(y)}H${n(x + r * 0.7)}`;
/**
 * A crescent moon about (x, y), `r` across its back, its horns turned `turn` degrees from pointing right; `bite` is
 * how much is taken out of it (the nearer to 1, the thinner the moon).
 */
function crescent(x: number, y: number, r: number, turn: number, bite = 0.78): string {
  const [cut, off] = [r * bite * 1.08, r * 0.5];
  const ix = (off * off + r * r - cut * cut) / (2 * off);
  const iy = Math.sqrt(r * r - ix * ix);
  return `<path transform="translate(${n(x)} ${n(y)}) rotate(${turn})" d="M${n(ix)} ${n(-iy)}A${n(r)} ${n(r)} 0 1 0 ${n(ix)} ${n(iy)}A${n(cut)} ${n(cut)} 0 ${ix > off ? 1 : 0} 1 ${n(ix)} ${n(-iy)}Z" fill="#fff" stroke="none"/>`;
}
/** A ring of dots. */
const dotted = (x: number, y: number, r: number, size: number, gap: number): string => `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" stroke-width="${size}" stroke-dasharray="0 ${gap}"/>`;
/** Rays round (x, y), from `from` out to `long` and `short` by turns. */
function rays(x: number, y: number, count: number, from: number, long: number, short: number): string {
  let d = '';
  for (let i = 0; i < count; i++) {
    const a = (i / count) * 2 * Math.PI;
    const to = i % 2 ? short : long;
    d += `M${n(x + from * Math.cos(a))} ${n(y + from * Math.sin(a))}L${n(x + to * Math.cos(a))} ${n(y + to * Math.sin(a))}`;
  }
  return d;
}
/** The thin frame inside the card's own line: its corners cut in, a row of dots down each side. */
function skyFrame(small: boolean): string {
  const [x0, y0, x1, y1, c] = small ? [F.x + 1, F.y + 1, F.x + F.w - 1, F.y + F.h - 1, 7] : [F.x + 2, F.y + 2, F.x + F.w - 2, F.y + F.h - 2, 4.5];
  const line = `<path d="M${x0 + c} ${y0}H${x1 - c}A${c} ${c} 0 0 0 ${x1} ${y0 + c}V${y1 - c}A${c} ${c} 0 0 0 ${x1 - c} ${y1}H${x0 + c}A${c} ${c} 0 0 0 ${x0} ${y1 - c}V${y0 + c}A${c} ${c} 0 0 0 ${x0 + c} ${y0}Z" stroke-width="${small ? 1.1 : 0.5}"/>`;
  if (small) return line; // (a small card keeps the frame, heavier, without the rows of dots)
  return (
    line +
    `<path d="M${x0 + 2.2} ${y0 + 12}V${y1 - 12}M${x1 - 2.2} ${y0 + 12}V${y1 - 12}" stroke-width="0.7" stroke-dasharray="0 2.6"/>`
  );
}
/** What a small card keeps of the sky: the frame, a tall star in each corner, a spark at the top and at the bottom. */
const smallSky = (corners = true): string =>
  skyFrame(true) +
  (corners ? `<path d="${twinkle(W / 2 - 23, 24, 6)}${twinkle(W / 2 + 23, 24, 6)}${twinkle(W / 2 - 23, H - 24, 6)}${twinkle(W / 2 + 23, H - 24, 6)}" stroke-width="1.1"/>` : '') +
  `<path d="${spark(W / 2, 20, 4.6)}${spark(W / 2, H - 20, 4.6)}" fill="#fff" stroke="none"/>`;

/** Stars strewn in the four quarters of the card, the same in each: sparks (`big`) and twinkles (`fine`), given for the top right quarter. */
function strewn(big: [number, number, number][], fine: [number, number, number][]): string {
  const [cx, cy] = [W / 2, H / 2];
  let [solid, lines] = ['', ''];
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    for (const [x, y, r] of big) solid += spark(cx + sx * x, cy - sy * y, r);
    for (const [x, y, r] of fine) lines += twinkle(cx + sx * x, cy - sy * y, r);
  }
  return `<path d="${solid}" fill="#fff" stroke="none"/><path d="${lines}" stroke-width="0.45"/>`;
}

/** Two crescent moons, back to back at the top and bottom with their horns towards each other, a star between them, each in a ring of dots. */
function mysticMoons(small: boolean): string {
  const [cx, cy] = [W / 2, H / 2];
  const [r, away] = small ? [15.5, 24] : [11, 21];
  const moons = crescent(cx, cy - away, r, 90) + crescent(cx, cy + away, r, -90);
  if (small) return frame(smallSky(false) + dotted(cx, cy - away, 23.5, 1.4, 4.1) + dotted(cx, cy + away, 23.5, 1.4, 4.1) + `${moons}<path d="${spark(cx, cy, 9)}" fill="#fff" stroke="none"/><path d="${twinkle(cx - 26, cy, 4.5)}${twinkle(cx + 26, cy, 4.5)}" stroke-width="1.1"/>`, 1.2, true);
  const ticks = [-1, 1].map((s) => `M${cx - 17} ${cy + s * (away + 3)}l-3 ${-s * 1.2}M${cx - 17} ${cy + s * (away - 3)}l-3 ${s * 1.2}M${cx + 17} ${cy + s * (away + 3)}l3 ${-s * 1.2}M${cx + 17} ${cy + s * (away - 3)}l3 ${s * 1.2}`).join('');
  return frame(
    skyFrame(false) +
      dotted(cx, cy - away, 21, 0.7, 2.3) +
      dotted(cx, cy + away, 21, 0.7, 2.3) +
      moons +
      `<path d="${spark(cx, cy, 6.5)}${spark(cx, cy - 46, 3.6)}${spark(cx, cy + 46, 3.6)}" fill="#fff" stroke="none"/>` +
      `<path d="${ticks}M${cx - 12} ${cy}h-5M${cx + 12} ${cy}h5" stroke-width="0.5"/>` +
      strewn([[25, 40, 2.6]], [[27, 12, 2.2], [30, 30, 1.5], [20, 47, 1.6], [29, 3, 1.3]]),
    0.6,
    false,
  );
}

/** A moon and a star in a ring, with rays all round it and a ring of dots round those; four tall stars about it. */
function mysticSun(small: boolean): string {
  const [cx, cy] = [W / 2, H / 2];
  if (small) return frame(smallSky() + `<circle cx="${cx}" cy="${cy}" r="11.5" stroke-width="1.5"/>${crescent(cx - 1.6, cy, 8, 0, 0.8)}<path d="${spark(cx + 3.4, cy, 3.4)}" fill="#fff" stroke="none"/><path d="${rays(cx, cy, 28, 15.5, 27, 21.5)}" stroke-width="1.15"/>` + dotted(cx, cy, 31.5, 1.4, 4.1), 1.2, true);
  return frame(
    skyFrame(false) +
      `<circle cx="${cx}" cy="${cy}" r="8.6" stroke-width="0.6"/><circle cx="${cx}" cy="${cy}" r="10.2" stroke-width="0.4"/>` +
      crescent(cx - 1.2, cy, 6, 0, 0.8) +
      `<path d="${spark(cx + 2.4, cy, 2.6)}" fill="#fff" stroke="none"/>` +
      `<path d="${rays(cx, cy, 48, 12, 25, 20)}" stroke-width="0.5"/>` +
      dotted(cx, cy, 28.5, 0.7, 2.25) +
      `<path d="${twinkle(cx - 17, cy - 38, 6)}${twinkle(cx + 17, cy - 38, 6)}${twinkle(cx - 17, cy + 38, 6)}${twinkle(cx + 17, cy + 38, 6)}" stroke-width="0.6"/>` +
      `<path d="${spark(cx, cy - 45, 3)}${spark(cx, cy + 45, 3)}" fill="#fff" stroke="none"/>` +
      `<path d="M${cx} ${cy - 40}V${cy - 31}M${cx} ${cy + 40}V${cy + 31}" stroke-width="0.8" stroke-dasharray="0 2.2"/>` +
      strewn([], [[27, 44, 1.6], [28, 24, 1.4], [9, 36, 1.2], [26, 8, 1.3]]),
    0.6,
    false,
  );
}

/** An eye with a moon in it and lashes over it; over that a drop between two leaves, under it a hanging row of dots; stars about. */
function mysticEye(small: boolean): string {
  const [cx, cy] = [W / 2, H / 2 + 3];
  const [half, high] = small ? [29, 15] : [17, 8.5];
  const lid = `M${cx - half} ${cy}Q${cx} ${cy - high * 2} ${cx + half} ${cy}Q${cx} ${cy + high * 2} ${cx - half} ${cy}Z`;
  if (small) return frame(smallSky() + `<path d="${lid}" stroke-width="1.6"/><circle cx="${cx}" cy="${cy}" r="10" stroke-width="1.4"/>${crescent(cx, cy - 1.2, 6.8, -90, 0.75)}<path d="M${cx} ${cy - 20}v-7M${cx - 11} ${cy - 17}l-4 -6M${cx + 11} ${cy - 17}l4 -6M${cx - 21} ${cy - 11}l-5 -4M${cx + 21} ${cy - 11}l5 -4" stroke-width="1.2"/>` + [0, 1, 2].map((k) => `<circle cx="${cx}" cy="${cy + 22 + k * 7}" r="${n(2.4 - k * 0.6)}" fill="#fff" stroke="none"/>`).join('') + `<circle cx="${cx - 9}" cy="${cy + 20}" r="1.5" fill="#fff" stroke="none"/><circle cx="${cx + 9}" cy="${cy + 20}" r="1.5" fill="#fff" stroke="none"/>`, 1.2, true);
  let lashes = '';
  for (const deg of [-50, -25, 0, 25, 50]) {
    const a = ((deg - 90) * Math.PI) / 180;
    lashes += `M${n(cx + 13 * Math.cos(a))} ${n(cy + 3 + 13 * Math.sin(a))}L${n(cx + 17.5 * Math.cos(a))} ${n(cy + 3 + 17.5 * Math.sin(a))}`;
  }
  // The drop over the eye, and a pair of leaves curling away from its foot on each side.
  const top = cy - 26;
  const drop = `M${cx} ${top - 12}C${cx + 2.4} ${top - 4} ${cx + 1.6} ${top} ${cx} ${top}C${cx - 1.6} ${top} ${cx - 2.4} ${top - 4} ${cx} ${top - 12}Z`;
  const leaf = (s: number, out: number, up: number): string => `M${cx + s * 2.5} ${top + 2.5}C${cx + s * (out * 0.5)} ${top + 3} ${cx + s * out} ${top - up * 0.3} ${cx + s * out} ${top - up}C${cx + s * (out * 0.75)} ${top - up * 0.2} ${cx + s * (out * 0.4)} ${top + 0.5} ${cx + s * 2.5} ${top + 2.5}Z`;
  const hang = [0, 1, 2, 3].map((k) => `<circle cx="${cx}" cy="${n(cy + 15 + k * 4)}" r="${n(1.5 - k * 0.3)}" fill="#fff" stroke="none"/>`).join('') + [1, 2, 3].map((k) => [-1, 1].map((s) => `<circle cx="${n(cx + s * k * 4.6)}" cy="${n(cy + 15 - k * k * 0.5)}" r="${n(1.1 - k * 0.2)}" fill="#fff" stroke="none"/>`).join('')).join('');
  return frame(
    skyFrame(false) +
      `<path d="${lid}" stroke-width="0.7"/><circle cx="${cx}" cy="${cy}" r="6.2" stroke-width="0.6"/>` +
      crescent(cx, cy - 0.6, 4.2, -90, 0.75) +
      `<path d="${spark(cx, cy - 2.4, 1.7)}" fill="#fff" stroke="none"/>` +
      `<path d="${lashes}" stroke-width="0.55"/>` +
      `<path d="${drop}${leaf(1, 9, 5)}${leaf(-1, 9, 5)}${leaf(1, 6, 9)}${leaf(-1, 6, 9)}" fill="#fff" stroke="none"/><circle cx="${cx}" cy="${top + 3.4}" r="1.3" fill="#fff" stroke="none"/>` +
      hang +
      `<path d="${twinkle(cx - 22, 22, 5)}${twinkle(cx + 22, 22, 5)}${twinkle(cx - 22, H - 22, 5)}${twinkle(cx + 22, H - 22, 5)}" stroke-width="0.6"/>` +
      `<path d="${spark(cx, 19, 2.6)}${spark(cx, H - 19, 2.6)}" fill="#fff" stroke="none"/>` +
      strewn([], [[27, 34, 1.5], [12, 44, 1.4], [29, 12, 1.6], [24, 22, 1.1], [10, 30, 1]]),
    0.6,
    false,
  );
}

/** The sun: a disc in a ring, with sixteen rays round it, straight ones and shorter flames by turns, in a ring of dots; stars about it. */
function mysticDay(small: boolean): string {
  const [cx, cy] = [W / 2, H / 2];
  const [disc, from, long, short, wide] = small ? [8.6, 13.4, 27.5, 22, 3.2] : [7.2, 11.5, 25.5, 20.5, 2.5];
  let beams = '';
  for (let i = 0; i < 16; i++) {
    const reach = (i % 2 ? short : long) - from;
    // A straight ray is a thin spearhead; a flame is the same, bent one way and then the other.
    const bend = i % 2 ? (small ? 2.7 : 2.2) : 0;
    const d =
      `M${n(-wide)} ${n(-from)}C${n(-wide * 0.66 + bend)} ${n(-from - reach * 0.33)} ${n(-wide * 0.33 - bend)} ${n(-from - reach * 0.66)} 0 ${n(-from - reach)}` +
      `C${n(wide * 0.33 - bend)} ${n(-from - reach * 0.66)} ${n(wide * 0.66 + bend)} ${n(-from - reach * 0.33)} ${n(wide)} ${n(-from)}Z`;
    beams += `<path d="${d}" transform="translate(${cx} ${cy}) rotate(${i * 22.5})"/>`;
  }
  const sun = `<g fill="#fff" stroke="none">${beams}<circle cx="${cx}" cy="${cy}" r="${disc}"/></g><circle cx="${cx}" cy="${cy}" r="${n(disc + (small ? 2.6 : 2.2))}" stroke-width="${small ? 1.2 : 0.6}"/>`;
  if (small) return frame(smallSky() + sun + dotted(cx, cy, 31.5, 1.4, 4.1), 1.2, true);
  return frame(
    skyFrame(false) +
      sun +
      dotted(cx, cy, 29, 0.7, 2.25) +
      `<path d="${twinkle(cx - 17, cy - 39, 6)}${twinkle(cx + 17, cy - 39, 6)}${twinkle(cx - 17, cy + 39, 6)}${twinkle(cx + 17, cy + 39, 6)}" stroke-width="0.6"/>` +
      `<path d="${spark(cx, cy - 45, 3.2)}${spark(cx, cy + 45, 3.2)}" fill="#fff" stroke="none"/>` +
      `<path d="M${cx} ${cy - 40}V${cy - 32}M${cx} ${cy + 40}V${cy + 32}" stroke-width="0.8" stroke-dasharray="0 2.2"/>` +
      strewn([[28, 30, 1.8]], [[27, 44, 1.6], [9, 37, 1.2], [26, 9, 1.3], [29, 20, 1.1]]),
    0.6,
    false,
  );
}

/**
 * A star: one great eight-pointed star, tall and narrow, drawn as an outline with a smaller star and fine rays
 * inside it, in a sky of little six-pointed stars (strewn by a fixed roll of the dice, the same in the lower half
 * as in the upper turned round), with a rayed quarter-sun in two opposite corners.
 */
function mysticStar(small: boolean): string {
  const [cx, cy] = [W / 2, H / 2];
  /** An eight-pointed star about the middle: how far its points reach up and down, across, and slantwise; and how far out its inner corners are. */
  const star = (tall: number, across: number, slant: number, waist: number): string =>
    poly(
      Array.from({ length: 16 }, (_, k): [number, number] => {
        const r = k % 2 ? waist : k % 8 === 0 ? tall : k % 8 === 4 ? across : slant;
        const a = (k * 22.5 - 90) * (Math.PI / 180);
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      }),
    );
  // (A small card has the same things, fewer and heavier: a dozen little stars for forty, five rays to a corner for seven.)
  const hair = small ? 1 : 0.42;
  let fine = '';
  if (!small) {
    for (let k = 0; k < 8; k++) {
      const a = (k * 45 + 22.5 - 90) * (Math.PI / 180);
      fine += `M${n(cx + 9.5 * Math.cos(a))} ${n(cy + 9.5 * Math.sin(a))}L${n(cx + 15 * Math.cos(a))} ${n(cy + 15 * Math.sin(a))}`;
    }
  }
  // The little stars: each three crossed hairlines, turned any way; none on the great star, none too near another.
  const roll = dice(small ? 9 : 64);
  const [most, apart, least, more, fan] = small ? [14, 13.5, 2.7, 1.3, 19] : [46, 7.2, 1.3, 1.5, 13];
  const sky: { x: number; y: number }[] = [];
  for (let tries = 0; tries < 900 && sky.length < most; tries++) {
    const [x, y, r] = [F.x + 5 + roll() * (F.w - 10), F.y + 5 + roll() * (F.h / 2 - 5), least + roll() * more];
    const turn = roll() * Math.PI;
    if (Math.abs(x - cx) / (small ? 31 : 27) + Math.abs(y - cy) / (small ? 53 : 49) < 1.12) continue; // on the great star
    if (Math.hypot(x - (F.x + F.w), y - F.y) < fan + 4) continue; // in the corner with the quarter-sun
    if (sky.some((q) => Math.hypot(q.x - x, q.y - y) < apart)) continue;
    sky.push({ x, y }, { x: 2 * cx - x, y: 2 * cy - y });
    for (const [sx, sy] of [[x, y], [2 * cx - x, 2 * cy - y]]) for (let k = 0; k < 3; k++) fine += `M${n(sx! - r * Math.cos(turn + k * 1.047))} ${n(sy! - r * Math.sin(turn + k * 1.047))}L${n(sx! + r * Math.cos(turn + k * 1.047))} ${n(sy! + r * Math.sin(turn + k * 1.047))}`;
  }
  // A quarter of a rayed sun in the top right corner, and the same in the bottom left.
  const corner = (px: number, py: number, sx: number, sy: number): string => {
    const [inner, count] = [fan * 0.35, small ? 5 : 8];
    let d = `M${n(px + sx * fan)} ${py}A${fan} ${fan} 0 0 ${sx * sy > 0 ? 1 : 0} ${px} ${n(py + sy * fan)}M${n(px + sx * inner)} ${py}A${n(inner)} ${n(inner)} 0 0 ${sx * sy > 0 ? 1 : 0} ${px} ${n(py + sy * inner)}`;
    for (let k = 1; k < count; k++) {
      const a = (k / count) * (Math.PI / 2);
      d += `M${n(px + sx * (inner + 1.2) * Math.cos(a))} ${n(py + sy * (inner + 1.2) * Math.sin(a))}L${n(px + sx * (fan - 1) * Math.cos(a))} ${n(py + sy * (fan - 1) * Math.sin(a))}`;
    }
    return d;
  };
  const inset = small ? 1 : 2;
  const [x0, y0, x1, y1] = [F.x + inset, F.y + inset, F.x + F.w - inset, F.y + F.h - inset];
  return frame(
    `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" stroke-width="${small ? 1.1 : 0.5}"/>` +
      `<path d="${corner(x1, y0, -1, 1)}${corner(x0, y1, 1, -1)}" stroke-width="${small ? 1 : 0.45}"/>` +
      `<path d="${fine}" stroke-width="${hair}"/>` +
      (small
        ? `<path d="${star(47, 28, 19.5, 8.2)}" stroke-width="1.9" stroke-linejoin="miter" stroke-miterlimit="12"/><path d="${star(15, 10, 7.2, 2.8)}" fill="#fff" stroke="none"/>`
        : `<path d="${star(45, 26, 18.5, 7.2)}" stroke-width="1.05" stroke-linejoin="miter" stroke-miterlimit="12"/><path d="${star(14, 9, 6.5, 2.4)}" stroke-width="0.5" stroke-linejoin="miter" stroke-miterlimit="12"/><circle cx="${cx}" cy="${cy}" r="1.1" fill="#fff" stroke="none"/>`),
    0.6,
    small,
  );
}

/**
 * A sunburst: nothing in the middle but a bare disc, and spokes all round it, long ones, shorter ones between them
 * and a close ring of short ones at the hub; the long spokes reach further up and down the card than across it.
 */
function sunburst(small: boolean): string {
  const [cx, cy] = [W / 2, H / 2];
  const [count, hub, line] = small ? [28, 8.5, 1.15] : [56, 5.2, 0.5];
  /** How far a spoke may reach in a direction: to an oval that fills the card. */
  const reach = (a: number): number => 1 / Math.hypot(Math.cos(a) / (F.w / 2 - 3), Math.sin(a) / (F.h / 2 - 4));
  const roll = dice(15);
  let d = '';
  for (let i = 0; i < count; i++) {
    const a = (i / count) * 2 * Math.PI;
    const far = reach(a) * (i % 2 ? 0.66 + roll() * 0.1 : 0.9 + roll() * 0.1); // long and shorter by turns, none quite the same
    d += `M${n(cx + (hub + (i % 2 ? 4.5 : 2)) * Math.cos(a))} ${n(cy + (hub + (i % 2 ? 4.5 : 2)) * Math.sin(a))}L${n(cx + far * Math.cos(a))} ${n(cy + far * Math.sin(a))}`;
  }
  let close = '';
  for (let i = 0; i < count * 2; i++) {
    const a = ((i + 0.5) / (count * 2)) * 2 * Math.PI;
    close += `M${n(cx + (hub + 1) * Math.cos(a))} ${n(cy + (hub + 1) * Math.sin(a))}L${n(cx + (hub + (small ? 6 : 8.5)) * Math.cos(a))} ${n(cy + (hub + (small ? 6 : 8.5)) * Math.sin(a))}`;
  }
  return frame(`<path d="${d}" stroke-width="${line}"/><path d="${close}" stroke-width="${small ? 0.8 : 0.42}"/>`, 0.6, small);
}

/**
 * A tiled floor (after one the owner saw): big square tiles, tiles half their width set upright or on their sides,
 * and small dark squares, fitted together in a block five small squares each way that repeats: three big tiles,
 * five halves and three dark squares to a block. The dark squares are left bare; the lines between tiles are bare too.
 */
function bathroom(small: boolean): string {
  const across = small ? 5 : 10; // how many small squares wide the field is
  const u = F.w / across;
  const gap = small ? 1.3 : 0.75;
  // One block, by its small squares: [column, row, wide, high] of every pale tile (the three squares not named are the dark ones).
  const block: [number, number, number, number][] = [[1, 0, 2, 2], [3, 0, 2, 2], [0, 3, 2, 2], [0, 1, 1, 2], [1, 2, 2, 1], [3, 2, 1, 2], [2, 3, 1, 2], [4, 3, 1, 2]];
  let d = '';
  for (let by = 0; by * 5 * u < F.h; by++) {
    for (let bx = 0; bx * 5 < across; bx++) {
      for (const [c, r, w, h] of block) {
        const [x, y] = [F.x + (bx * 5 + c) * u + gap / 2, F.y + (by * 5 + r) * u + gap / 2];
        d += `M${n(x)} ${n(y)}h${n(w * u - gap)}v${n(h * u - gap)}h${n(-(w * u - gap))}Z`;
      }
    }
  }
  return frame(clipped(`<path d="${d}" fill="#fff" stroke="#fff" stroke-width="${small ? 0.5 : 0.3}" stroke-linejoin="round"/>`), 1, small);
}

/**
 * Hotel carpet: a honeycomb of hexagons in three nested tones, a white band at the edge of each, a half-white ring
 * within it and a small white hexagon at the heart, with thin lines of the card's colour between the cells.
 */
function corridor(small: boolean): string {
  const across = small ? 2 : 4;
  const wide = F.w / across; // across the flats
  const r = wide / Math.sqrt(3);
  const hex = (cx: number, cy: number, s: number): string => poly(Array.from({ length: 6 }, (_, i) => [cx + s * Math.sin((i * Math.PI) / 3), cy - s * Math.cos((i * Math.PI) / 3)] as const));
  let [white, half] = ['', ''];
  for (let row = -1; row * 1.5 * r < F.h + r; row++) {
    for (let c = -1; c <= across; c++) {
      const [cx, cy] = [F.x + (c + (row % 2 ? 0.5 : 0) + 0.5) * wide, F.y + row * 1.5 * r + r];
      white += hex(cx, cy, r * 0.93) + hex(cx, cy, r * 0.7) + hex(cx, cy, r * 0.2);
      half += hex(cx, cy, r * 0.52) + hex(cx, cy, r * 0.36);
    }
  }
  return frame(clipped(`<path d="${white}" fill="#fff" fill-rule="evenodd" stroke="none"/><path d="${half}" fill="${HALF}" fill-rule="evenodd" stroke="none"/>`), 1, small);
}

/**
 * The Overlook's carpet, in one colour: hexagons in two families, each a half-white heart in a ring of the card's
 * colour, and round every one a white band shared with its neighbours. Each ring opens into a stem, down out of one
 * family and up out of the other, that runs between two hexagons of the other family. (In apothems of the heart's
 * hexagon: rings out to 72/37, bands to 103/37; a family's hexagons 250/37 apart across, 347/37 down, the second
 * family half across from the first and 135/37 lower.)
 */
function overlook(small: boolean): string {
  const u = (F.w / (small ? 1.5 : 2.5)) / 250; // one unit of the carpet
  const [across, down, lower] = [250 * u, 347 * u, 135 * u];
  const [heart, ring, band, stem] = [37 * u, 72 * u, 103 * u, 22 * u];
  // A pointy-topped hexagon by its apothem.
  const hex = (cx: number, cy: number, a: number): string => poly(Array.from({ length: 6 }, (_, i) => [cx + ((2 * a) / Math.sqrt(3)) * Math.sin((i * Math.PI) / 3), cy - ((2 * a) / Math.sqrt(3)) * Math.cos((i * Math.PI) / 3)] as const));
  let [outer, inner, stems, hearts] = ['', '', '', ''];
  const [x0, y0] = [F.x + F.w / 2, F.y + F.h / 2 - lower / 2];
  for (let i = -Math.ceil(F.w / across) - 1; i * across < F.w + across; i++) {
    for (let j = -Math.ceil(F.h / down) - 1; j * down < F.h + down; j++) {
      for (const second of [false, true]) {
        const [cx, cy] = [x0 + i * across + (second ? across / 2 : 0), y0 + j * down + (second ? lower : 0)];
        outer += hex(cx, cy, band);
        inner += hex(cx, cy, ring);
        // (The stem is cut from the centre out through the band; beyond it, it is the ground between the other family's bands.)
        stems += `M${n(cx - stem)} ${n(cy)}h${n(2 * stem)}V${n(cy + (second ? -1 : 1) * band * 1.2)}h${n(-2 * stem)}Z`;
        hearts += hex(cx, cy, heart);
      }
    }
  }
  return frame(
    clipped(`<mask id="o"><path d="${outer}" fill="#fff" stroke="none"/><path d="${inner}" fill="#000" stroke="none"/><path d="${stems}" fill="#000" stroke="none"/></mask><rect x="${F.x}" y="${F.y}" width="${F.w}" height="${F.h}" fill="#fff" stroke="none" mask="url(#o)"/><path d="${hearts}" fill="${HALF}" stroke="none"/>`),
    1,
    small,
  );
}

/** A pointy-topped hexagon's corners, from the top round to the right: `r` from the middle to a corner. */
const hexCorners = (cx: number, cy: number, r: number, turn = 0): [number, number][] =>
  Array.from({ length: 6 }, (_, i) => [cx + r * Math.sin(((i + turn) * Math.PI) / 3), cy - r * Math.cos(((i + turn) * Math.PI) / 3)]);

/**
 * Frames: hollow cubes of square beams, seen from a corner. Each face is a frame round a hole, in its own tone, and
 * inside every hole the beams' inner sides show along the two edges the light does not reach.
 */
function frames(small: boolean): string {
  const a = small ? 17 : 12; // from the middle of a cube to a corner
  const t = 0.24; // a beam's width, as a part of a face's side
  const dx = (a * Math.sqrt(3)) / 2;
  const tone = ['#fff', HALF, 'rgba(255,255,255,0.75)', 'rgba(255,255,255,0.25)'];
  const paths = ['', '', '', ''];
  const mix = (p: [number, number], q: [number, number], f: number): [number, number] => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
  for (let row = -1; row * 1.5 * a < F.h + 2 * a; row++) {
    for (let col = -1; col * 2 * dx < F.w + 2 * dx; col++) {
      const [x, y] = [F.x + col * 2 * dx + (row % 2 ? dx : 0), F.y + row * 1.5 * a];
      const c = hexCorners(x, y, a);
      // The faces, each from the middle of the cube: the top, the right and the left.
      const faces: [number, number][][] = [[[x, y], c[5]!, c[0]!, c[1]!], [[x, y], c[1]!, c[2]!, c[3]!], [[x, y], c[3]!, c[4]!, c[5]!]];
      faces.forEach((q, f) => {
        // The hole: the face less a beam's width from each side (a rhombus, so the same part of each diagonal).
        const [o, p1, far, p2] = q as [[number, number], [number, number], [number, number], [number, number]];
        const hole: [number, number][] = [mix(o, far, t), mix(p1, p2, t), mix(far, o, t), mix(p2, p1, t)];
        paths[f] += poly(q) + poly(hole.slice().reverse());
        // Inside the hole, the inner sides of the two beams nearest the cube's middle, in shadow.
        const depth = t * 0.9;
        const [h0, h1, h2, h3] = hole as [[number, number], [number, number], [number, number], [number, number]];
        const sink = (pt: [number, number]): [number, number] => [pt[0] + (h2[0] - h0[0]) * depth, pt[1] + (h2[1] - h0[1]) * depth];
        paths[3] += poly([h3, h0, h1, sink(h1), sink(h0), sink(h3)]);
      });
    }
  }
  return frame(clipped(paths.map((d, f) => `<path d="${d}" fill="${tone[f]}" fill-rule="evenodd" stroke="none"/>`).join('')), 1, small);
}

/** Facets: a grid of triangles, every one with lines fanned from one of its corners, which corner falling as it may. */
function facets(small: boolean): string {
  const side = small ? 26 : 17;
  const h = (side * Math.sqrt(3)) / 2;
  const fan = small ? 5 : 7;
  const roll = dice(small ? 5 : 21);
  let d = '';
  for (let row = -1; row * h < F.h + h; row++) {
    for (let k = -2; (k / 2) * side < F.w + side; k++) {
      const x0 = F.x + (k * side) / 2 + (row % 2 ? side / 2 : 0);
      const y0 = F.y + row * h;
      const up = (k + 2) % 2 === 0;
      const tri: [number, number][] = up ? [[x0, y0 + h], [x0 + side / 2, y0], [x0 + side, y0 + h]] : [[x0, y0], [x0 + side, y0], [x0 + side / 2, y0 + h]];
      d += poly(tri);
      const i = Math.floor(roll() * 3);
      const [a, b, c] = [tri[i]!, tri[(i + 1) % 3]!, tri[(i + 2) % 3]!];
      for (let j = 1; j < fan; j++) d += pts([a, [b[0] + ((c[0] - b[0]) * j) / fan, b[1] + ((c[1] - b[1]) * j) / fan]]);
    }
  }
  return frame(clipped(`<path d="${d}"/>`), small ? 1.1 : 0.6, small);
}

/** Hatch: cubes seen from a corner, each face ruled in stripes along one of its edges, a different edge on every face. */
function hatch(small: boolean): string {
  const a = small ? 13 : 10.5; // from the middle of a cube to a corner
  const lines = small ? 3 : 4;
  const [dx, dy] = [(a * Math.sqrt(3)) / 2, a / 2];
  let d = '';
  for (let row = -1; row * 1.5 * a < F.h + 2 * a; row++) {
    for (let col = -1; col * 2 * dx < F.w + 2 * dx; col++) {
      const [x, y] = [F.x + col * 2 * dx + (row % 2 ? dx : 0), F.y + row * 1.5 * a];
      // Each face from the middle of the cube: two edges, the stripes running along the second.
      const faces: [[number, number], [number, number]][] = [[[-dx, -dy], [dx, -dy]], [[0, a], [-dx, -dy]], [[dx, -dy], [0, a]]];
      for (const [[ux, uy], [vx, vy]] of faces) {
        for (let j = 0; j < lines; j++) {
          const t = (j + 0.5) / lines;
          d += pts([[x + ux * t, y + uy * t], [x + ux * t + vx, y + uy * t + vy]]);
        }
      }
    }
  }
  return frame(clipped(`<path d="${d}" stroke-linecap="butt"/>`), (a / lines) * 0.48, small);
}

/**
 * The Penrose triangle: three square bars that each meet the next at a right angle and yet close into a triangle,
 * which no solid thing can. Drawn flat, as it always is: each bar an L in one tone (white, half, faint), running
 * along the outside of one side and the inside of the next. Two of them on a full card, the lower one turned over.
 */
function penroseTriangle(small: boolean): string {
  const [L, t] = [10, 1]; // the triangle's side and a bar's width, in steps of a three-way grid
  // One bar, by grid steps (i along the bottom, j up the left side): the outer band of the bottom, then the inner band of the right side.
  const bar: [number, number][] = [[0, t], [t, 0], [L - t, 0], [L - t, t], [L - 2 * t, t], [2 * t, L - 3 * t], [2 * t, L - 4 * t], [L - 3 * t, t]];
  /** The same bar a third of a turn on: each step along the bottom becomes one up the left side, and so round. */
  const turn = (p: [number, number][]): [number, number][] => p.map(([i, j]) => [L - i - j, i]);
  const bars = [bar, turn(bar), turn(turn(bar))];
  const tones = ['#fff', 'rgba(255,255,255,0.58)', 'rgba(255,255,255,0.26)'];
  const draw = (cx: number, cy: number, wide: number, flip: boolean): string => {
    const s = wide / L;
    const high = (L * s * Math.sqrt(3)) / 2;
    const at = ([i, j]: [number, number]): [number, number] => {
      const [x, y] = [cx - wide / 2 + (i + j / 2) * s, cy + high / 2 - ((j * Math.sqrt(3)) / 2) * s];
      return flip ? [2 * cx - x, 2 * cy - y] : [x, y];
    };
    return bars.map((b, k) => `<path d="${poly(b.map(at))}" fill="${tones[k]}"/>`).join('');
  };
  const wide = small ? F.w * 0.94 : 55;
  const high = (wide * Math.sqrt(3)) / 2;
  const body = small ? draw(W / 2, H / 2 + 2, wide, false) : draw(W / 2, H / 2 - high / 2 - 2.5, wide, false) + draw(W / 2, H / 2 + high / 2 + 2.5, wide, true);
  return frame(`<g stroke-width="${small ? 1.1 : 0.6}" stroke-linejoin="round">${body}</g>`, 1, small);
}

/**
 * Tumbling blocks: six-sided tiles each cut into three diamonds, a white one on top, a half-toned one to the left
 * and a bare one to the right, so that the card looks like a heap of cubes lit from above (or, looked at long
 * enough, like the same cubes seen from below).
 */
function blocks(small: boolean): string {
  const a = small ? 10.4 : 6; // from the middle of a tile to a corner
  const [dx, dy] = [(a * Math.sqrt(3)) / 2, a / 2];
  let [top, left] = ['', ''];
  for (let row = -1; row * 1.5 * a < F.h + a; row++) {
    for (let col = -1; col * 2 * dx < F.w + 2 * dx; col++) {
      const [x, y] = [F.x + col * 2 * dx + (row % 2 ? dx : 0), F.y + row * 1.5 * a];
      top += poly([[x, y], [x - dx, y - dy], [x, y - a], [x + dx, y - dy]]);
      left += poly([[x, y], [x - dx, y - dy], [x - dx, y + dy], [x, y + a]]);
    }
  }
  return frame(clipped(`<path d="${top}" fill="#fff" stroke="none"/><path d="${left}" fill="${HALF}" stroke="none"/>`), 1, small);
}

/**
 * Fans, as on an Art Deco wall: scales in rows, each row half a scale along from the last and lying over the one
 * above, every scale a fan with a heavy rim over its top and thin ribs spreading from its point. Every other row is
 * lit, most at the point. (A scale is a circle, less the two circles of the row below, which meet at its lowest
 * point: so a rib from there shows only once it is clear of them, and the ribs fan out from behind the rims.)
 */
function fans(small: boolean): string {
  const across = small ? 2 : 3;
  const r = F.w / (2 * across);
  const ribs = small ? 2 : 4; // on each side of the middle one
  const spread = (Math.PI / 180) * 40; // the outermost rib, from upright (at 45 degrees there is nothing left of one)
  const rim = r * 0.13;
  let lit = '';
  let rims = '';
  let lines = '';
  for (let row = 0; (row - 1) * r < F.h; row++) {
    const cy = F.y + row * r;
    for (let c = 0; c <= across; c++) {
      const cx = F.x + (2 * c + (row % 2 ? 0 : 1)) * r;
      if (row % 2) lit += `<path d="M${n(cx - r)} ${n(cy)}A${n(r)} ${n(r)} 0 0 1 ${n(cx + r)} ${n(cy)}A${n(r)} ${n(r)} 0 0 0 ${n(cx)} ${n(cy + r)}A${n(r)} ${n(r)} 0 0 0 ${n(cx - r)} ${n(cy)}Z" fill="url(#fan)" stroke="none"/>`;
      rims += `M${n(cx - r)} ${n(cy)}A${n(r)} ${n(r)} 0 0 1 ${n(cx + r)} ${n(cy)}`;
      for (let i = -ribs; i <= ribs; i++) {
        const a = (i * spread) / ribs;
        const [from, to] = [2 * r * Math.sin(Math.abs(a)) + rim / 2, 2 * r * Math.cos(a) - rim / 2];
        lines += `M${n(cx + from * Math.sin(a))} ${n(cy + r - from * Math.cos(a))}L${n(cx + to * Math.sin(a))} ${n(cy + r - to * Math.cos(a))}`;
      }
    }
  }
  const glow = `<radialGradient id="fan" cx="0.5" cy="1" r="1"><stop offset="0" stop-color="#fff" stop-opacity="0.6"/><stop offset="1" stop-color="#fff" stop-opacity="0.14"/></radialGradient>`;
  return frame(clipped(`${glow}${lit}<path d="${lines}" stroke-width="${n(small ? 0.9 : 0.5)}" stroke-linecap="butt"/><path d="${rims}" stroke-width="${n(rim)}" stroke-linecap="butt"/>`), 1, small);
}

/**
 * Tripods, the interlocking Ys: Ys all the same way up, one arm up and two down to the sides, their middles on a
 * lattice of triangles. Each side of the lattice is an arm of the Y at one end of it, whose point fits in between
 * two arms of the Y at the other, so that the Ys lock together; a line runs down the middle of every arm, and what is
 * left in the middle of each triangle of the lattice is a small triangle, shaded.
 */
function tripods(small: boolean): string {
  const d = F.w / ((small ? 2 : 3.5) * HR3); // from the middle of one Y to the next
  const h = d * 0.22; // half an arm's width
  const e = small ? 0.9 : 0.35; // half the line round every piece
  const w = small ? 0.9 : 0.6; // half the line down an arm
  const [side, face] = [h - e, h + e];
  /** A three-armed piece round (cx, cy), given by the points of one arm (`x` along it, `y` across), turned a third for each of the others. */
  const round = (cx: number, cy: number, arm: readonly [number, number][]): string =>
    poly([0, 1, 2].flatMap((k) => {
      const a = ((-90 + 120 * k) * Math.PI) / 180;
      return arm.map(([x, y]): [number, number] => [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)]);
    }));
  // An arm's point is cut by the edges of the next Y's two arms either side of it, and the next arm begins where the sides of the two meet.
  const shoulder = d - (face + side / 2) / HR3;
  const Y: [number, number][] = [[shoulder, -side], [d - face / HR3, 0], [shoulder, side], [side / Math.sqrt(3), side]];
  const lineEnd = d - (face + w / 2) / HR3;
  const line: [number, number][] = [[lineEnd, -w], [lineEnd, w], [w / Math.sqrt(3), w]];
  const k = 1 - (h + e) / (d / (2 * Math.sqrt(3))); // the shaded triangle, as a part of the lattice's
  // The lattice's two triangles at each Y, by their other two corners: the one up and to the right of it, and the one to the right.
  const triangles: [[number, number], [number, number]][] = [[[0, -d], [HR3 * d, -d / 2]], [[HR3 * d, -d / 2], [HR3 * d, d / 2]]];
  let ys = '';
  let tri = '';
  for (let i = -1; i * HR3 * d < F.w + d; i++) {
    for (let j = -1; j < F.h / d + 2; j++) {
      const [cx, cy] = [F.x + i * HR3 * d, F.y + (j + (i % 2 ? 0.5 : 0)) * d];
      ys += round(cx, cy, Y) + round(cx, cy, line);
      for (const [[ax, ay], [bx, by]] of triangles) {
        const [gx, gy] = [cx + (ax + bx) / 3, cy + (ay + by) / 3];
        tri += poly(([[0, 0], [ax, ay], [bx, by]] as const).map(([x, y]) => [gx + (cx + x - gx) * k, gy + (cy + y - gy) * k] as const));
      }
    }
  }
  return frame(clipped(`<path d="${ys}" fill="#fff" fill-rule="evenodd" stroke="none"/><path d="${tri}" fill="${HALF}" stroke="none"/>`), 1, small);
}

/**
 * The outline of a boteh, the teardrop of paisley, with its bulb (of radius 1) round (0, 0) and its tail rising from
 * it and curling over to the right. It is drawn about a line that bends more and more as it goes, as wide as the bulb
 * at its foot and narrowing to nothing at its tip; `grow` widens it by as much all round.
 */
function boteh(grow: number): [number, number][] {
  const steps = 40;
  const long = 3.3;
  const spine: [number, number, number][] = [];
  let [x, y] = [0, 0];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * long;
    const a = -Math.PI / 2 + 0.05 * t + 0.3 * t * t;
    spine.push([x, y, a]);
    [x, y] = [x + (Math.cos(a) * long) / steps, y + (Math.sin(a) * long) / steps];
  }
  const wide = (i: number): number => Math.max(0, (1 - i / steps) ** 1.25 + grow);
  const left = spine.map(([x, y, a], i): [number, number] => [x + Math.sin(a) * wide(i), y - Math.cos(a) * wide(i)]);
  const right = spine.map(([x, y, a], i): [number, number] => [x - Math.sin(a) * wide(i), y + Math.cos(a) * wide(i)]);
  const foot = Array.from({ length: 13 }, (_, i): [number, number] => [(1 + grow) * Math.cos((i * Math.PI) / 12), (1 + grow) * Math.sin((i * Math.PI) / 12)]);
  return [...foot, ...left, ...right.reverse()];
}

/**
 * Paisley: large botehs in rows, those of every other row turned the other way, each with a rim of dots round it, a
 * line inside it and a flower in its bulb; small ones head to tail with them, and little flowers and dots in the gaps.
 * A small card keeps only the large botehs, solid.
 */
function paisley(small: boolean): string {
  /** A shape round (x, y), `r` times as large, turned `turn` degrees, and with `flip` mirrored. */
  const place = (shape: readonly [number, number][], x: number, y: number, r: number, turn: number, flip: boolean): [number, number][] => {
    const a = (turn * Math.PI) / 180;
    return shape.map(([px, py]) => [x + r * ((flip ? -px : px) * Math.cos(a) - py * Math.sin(a)), y + r * ((flip ? -px : px) * Math.sin(a) + py * Math.cos(a))]);
  };
  const disc = (x: number, y: number, r: number): string => `M${n(x - r)} ${n(y)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0`;
  /** A flower of `count` round petals about a dot at (x, y), `r` across. */
  const bloom = (x: number, y: number, r: number, count: number): string => {
    let d = disc(x, y, r * 0.2);
    const [a0, b0] = [r * 0.35, r * Math.min(0.3, 1.3 / count)]; // a petal's half-length and half-width
    for (let i = 0; i < count; i++) {
      const a = (i / count) * 2 * Math.PI;
      const at = (k: number): string => `${n(x + r * k * Math.sin(a))} ${n(y - r * k * Math.cos(a))}`;
      const tilt = n((a * 180) / Math.PI - 90);
      d += `M${at(0.3)}A${n(a0)} ${n(b0)} ${tilt} 0 1 ${at(1)}A${n(a0)} ${n(b0)} ${tilt} 0 1 ${at(0.3)}Z`;
    }
    return d;
  };
  const R = small ? 9 : 7.8; // a large boteh's bulb
  const [sx, sy] = [F.w / 2, 34]; // from one large boteh to the next along a row, and from row to row
  const [outline, rim, inner] = [boteh(0), boteh(0.3), boteh(-0.24)];
  let [lines, fine, dots, solid] = ['', '', '', ''];
  for (let r = -1; r * sy < F.h + sy; r++) {
    const flip = r % 2 !== 0;
    const turn = flip ? 20 : -20;
    for (let c = -1; c <= 2; c++) {
      const [x, y] = [F.x + (c + (flip ? 0.5 : 0) + 0.32) * sx, F.y + r * sy + 18];
      const side = flip ? -1 : 1;
      // The small one lies by the large one's tail, the other way up.
      const [tx, ty] = [x + side * sx * 0.52, y - sy * 0.18];
      if (small) {
        solid += poly(place(outline, x, y, R, turn, flip));
        continue;
      }
      lines += poly(place(outline, x, y, R, turn, flip));
      fine += poly(place(inner, x, y, R, turn, flip));
      dots += poly(place(rim, x, y, R, turn, flip));
      solid += poly(place(outline, tx, ty, R * 0.4, turn + 180, flip)) + bloom(x, y, R * 0.6, 8) + bloom(tx - side * 1.5, ty + 10.5, 2.3, 5) + disc(tx + side * 3, ty - 7, 0.6) + disc(x - side * 11.5, y + 9, 0.6);
    }
  }
  return frame(
    clipped(`<path d="${lines}" stroke-width="0.9"/><path d="${fine}" stroke-width="0.45"/><path d="${dots}" stroke-width="0.9" stroke-dasharray="0 1.9"/><path d="${solid}" fill="#fff" fill-rule="evenodd" stroke="none"/>`),
    1,
    small,
  );
}

/**
 * Sashiko, the running stitch of Japanese mending, here in stepped diamonds. On a grid of squares, a motif is the edge
 * of every square within `k` steps of one square, for a few `k`s one inside the next, the smallest the square alone;
 * the motifs are set corner to corner. Each side of a square along an edge is one stitch, with a gap at either end of
 * it. A small card has one diamond round the square, larger.
 */
function sashiko(small: boolean): string {
  const [rings, apart, u] = small ? [[0, 2], 4, 5] : [[0, 2, 4], 6, 3.5]; // the diamonds; from one motif to the next across a row, in squares; a square's side
  const gap = u * 0.16; // cut from either end of a stitch
  const [cx, cy] = [F.x + F.w / 2, F.y + F.h / 2];
  let d = '';
  for (let i = -Math.ceil(F.w / 2 / (apart * u)) - 1; i * apart * u < F.w / 2 + apart * u; i++) {
    for (let j = -Math.ceil(F.h / 2 / (apart * u)) - 1; j * apart * u < F.h / 2 + apart * u; j++) {
      if ((i + j) % 2) continue; // every other place, so that the motifs are corner to corner
      for (const k of rings) {
        // The squares k steps out, and of each the sides facing further out.
        for (let x = -k; x <= k; x++) {
          for (const y of x === -k || x === k ? [0] : [k - Math.abs(x), Math.abs(x) - k]) {
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              if (Math.abs(x + dx) + Math.abs(y + dy) <= k) continue;
              const [mx, my] = [cx + (i * apart + x + dx / 2) * u, cy + (j * apart + y + dy / 2) * u]; // the middle of the side
              const [hx, hy] = [dy * (u / 2 - gap), dx * (u / 2 - gap)];
              d += `M${n(mx - hx)} ${n(my - hy)}L${n(mx + hx)} ${n(my + hy)}`;
            }
          }
        }
      }
    }
  }
  return frame(clipped(`<path d="${d}" stroke-width="${small ? 1.8 : 1.1}"/>`), 1, small);
}

/**
 * How each back but the plain one is made, the one place that says so. Drawn here: by `draw` (`small`: the simpler
 * drawing, for a card too small for the full one to read), and `figure` for a single figure on bare ground, which is
 * fitted whole to a card without an edge where a pattern fills it (see `bare`, above). Or a picture file of its name in
 * public/cards/backs, shown `small` times larger on a small card (another player's pile) so that only its middle
 * shows: a fine pattern needs more, and one that is a single figure is shown whole (1).
 */
export type BackArt = { k: 'drawn'; draw: (small: boolean) => string; figure: boolean } | { k: 'file'; small: number };
const pattern = (draw: (small: boolean) => string): BackArt => ({ k: 'drawn', draw, figure: false });
const figure = (draw: (small: boolean) => string): BackArt => ({ k: 'drawn', draw, figure: true });
const file = (small: number): BackArt => ({ k: 'file', small });
export const BACK_ART: Record<Exclude<Back, 'plain'>, BackArt> = {
  hilbert: pattern(hilbert),
  key: pattern(key),
  braid: pattern(braid),
  loops: pattern(loops),
  rings: pattern(rings),
  guilloche: figure(rosette),
  voronoi: pattern(voronoi),
  tree: figure(tree),
  dragon: figure(dragon),
  koch: figure(koch),
  mandelbrot: figure(mandelbrot),
  walk: figure(walk),
  mondrian: pattern(mondrian),
  diamonds: pattern(diamonds),
  herringbone: pattern(herringbone),
  honeycomb: pattern(honeycomb),
  starcross: pattern(starCross),
  houndstooth: pattern(houndstooth),
  shards: pattern(shards),
  pinwheel: pattern(pinwheel),
  mosaic: pattern(mosaic),
  flowers: pattern(flowers),
  compass: figure(compass),
  lightcone: figure(lightcone),
  arbor: figure(arbor),
  earth: figure(earth),
  fans: pattern(fans),
  tripods: pattern(tripods),
  paisley: pattern(paisley),
  sashiko: pattern(sashiko),
  waves: pattern(waves),
  flow: pattern(flow),
  life: pattern(life),
  penrose: pattern(penrose),
  bubbles: pattern(bubbles),
  'mystic-moons': figure(mysticMoons),
  'mystic-sun': figure(mysticSun),
  'mystic-eye': figure(mysticEye),
  'mystic-day': figure(mysticDay),
  'mystic-star': figure(mysticStar),
  sunburst: figure(sunburst),
  'penrose-triangle': figure(penroseTriangle),
  blocks: pattern(blocks),
  bathroom: pattern(bathroom),
  corridor: pattern(corridor),
  overlook: pattern(overlook),
  frames: pattern(frames),
  facets: pattern(facets),
  hatch: pattern(hatch),
  lotus: figure(lotus),
  'flower-of-life': pattern(flowerOfLife),
  fleur: pattern(fleur),
  giglio: figure(giglio),
  hat: pattern(hat),
  'hat-two': pattern((small) => hat(small, 2)),
  'hat-lines': pattern((small) => hat(small, 1)),
  chain: pattern(chain),
  pulsar: pattern(pulsar),
  'carpet-tint': file(1.8),
  waterlily: file(1.2),
  lilypads: file(1.2),
  maple: file(1.2),
  'dandelion-1': file(1.1),
  daisy: file(1.2),
  tulip: file(1.2),
  poppies: file(1.2),
  sequoia: file(1.25),
  birch: file(1.2),
  fronds: file(1.15),
  oak: file(1.3),
  thistle: file(1.2),
  clover: file(1.2),
  'clover-2': file(1.2),
  lily: file(1.2),
  rose: file(1.25),
  iris: file(1.15),
  sunflower: file(1.15),
  acanthus: file(1.7),
  fern: file(1.5),
  ginkgo: file(1),
  'ginkgo-ring': file(1.4),
  'ginkgo-scatter': file(2),
  piatnik: file(1.5),
  atlas: file(1.4),
  bicycle: file(1),
  lion: file(1),
  ornate: file(1.8),
  rosette: file(1.8),
  check: file(2.2),
  stars: file(2.4),
  cobble: file(2.8),
  'tarot-star-tint': file(2),
  'tarot-eye-tint': file(1.9),
};
const made = new Map<string, string>();

/**
 * A drawn back as a picture's address (a data: URL). Each is worked out once in this browser, the first time it is
 * wanted, and kept; the dice are fixed, so it is the same picture for everybody. `small`: the simpler drawing of it,
 * with heavier lines, for a card too small for the full one to read (other players' piles). `edgeless`: without the
 * white edge and the thin line, what is inside them drawn out to the edge of the card.
 */
export function drawnBack(back: Back, art: BackArt & { k: 'drawn' }, small = false, edgeless = false): string {
  const k = `${back} ${small} ${edgeless}`;
  let src = made.get(k);
  if (!src) {
    bare = edgeless ? (art.figure ? 'fit' : 'fill') : null;
    try {
      made.set(k, (src = `data:image/svg+xml,${encodeURIComponent(art.draw(small))}`));
    } finally {
      bare = null;
    }
  }
  return src;
}
