// Card backs drawn here, not fetched: each is a small SVG picture, white on nothing, that is laid over the player's
// colour like the one-colour picture backs (`backOf` in Face.tsx). A card is 90 x 126; every back has the same white
// edge and a thin line inside it, and its own pattern in the field within.
const W = 90;
const H = 126;
const n = (v: number): string => (Math.round(v * 100) / 100).toString();
const pts = (p: readonly (readonly [number, number])[]): string => p.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join('');

/** The field the pattern fills: inside the edge and the thin line. */
const F = { x: 9, y: 9, w: W - 18, h: H - 18 };

const frame = (body: string, stroke = 1.3): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
  `<path fill="#fff" fill-rule="evenodd" d="M0 0H${W}V${H}H0ZM4.5 7.5a3 3 0 0 1 3-3H${W - 7.5}a3 3 0 0 1 3 3V${H - 7.5}a3 3 0 0 1-3 3H7.5a3 3 0 0 1-3-3Z"/>` +
  `<g fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">` +
  `<rect x="6.6" y="6.6" width="${W - 13.2}" height="${H - 13.2}" rx="1.6" stroke-width="0.7"/>${body}</g></svg>`;

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
function hilbert(): string {
  const order = 16;
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
  return frame(`<path d="${pts(line)}"/>`, 1.2);
}

/** A Greek key: square spirals off a base line, row upon row, every other row turned round. */
function key(): string {
  const cols = 8;
  const rows = 12;
  const u = F.w / cols / 4; // a tile is 4 x 4 of these, and F.h / rows high
  const v = F.h / rows / 4;
  let d = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const flip = r % 2 === 1;
      const at = (i: number, j: number): [number, number] => [F.x + (flip ? cols - c - i / 4 : c + i / 4) * 4 * u, F.y + (r + j / 4) * 4 * v];
      // Up from the base line, over, down, back, up, over: a spiral that stops at its middle; then on along the base.
      d += pts([at(0, 3.5), at(0, 0.5), at(3, 0.5), at(3, 2.5), at(1, 2.5), at(1, 1.5), at(2, 1.5)]) + pts([at(0, 3.5), at(4, 3.5)]);
    }
  }
  return frame(`<path d="${d}"/>`, 1.25);
}

/** Braids: columns of two strands twisted round each other, each passing under the other in turn. */
function braid(): string {
  const cols = 5;
  const turns = 9; // half-turns down the card
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
        const under = (crossing + (side > 0 ? 0 : 1) + c) % 2 === 0 && Math.min(phase, 1 - phase) * half < 1.5 && crossing > 0 && crossing < turns;
        if (under) {
          if (run.length > 1) d += pts(run);
          run = [];
        } else run.push([cx + side * amp * Math.sin(Math.PI * t * turns), y]);
      }
      if (run.length > 1) d += pts(run);
    }
  }
  return frame(`<path d="${d}"/>`, 1.7);
}

/** Loops: quarter-circles in every square of a grid, turned this way or that by a fixed roll of the dice, which join up into wandering loops. */
function loops(): string {
  const cols = 8;
  const rows = 12;
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
  return frame(`<path d="${d}"/>`, 1.3);
}

/** Rings: rows of circles, each overlapping its neighbours, like mail. */
function rings(): string {
  const step = F.w / 6;
  const rad = step * 0.72;
  let body = `<clipPath id="f"><rect x="${F.x}" y="${F.y}" width="${F.w}" height="${F.h}"/></clipPath><g clip-path="url(#f)">`;
  for (let r = -1; r * step * 0.5 <= F.h + step; r++) {
    for (let c = -1; c <= 7; c++) body += `<circle cx="${n(F.x + (c + (r % 2 ? 0.5 : 0)) * step)}" cy="${n(F.y + r * step * 0.5)}" r="${n(rad)}"/>`;
  }
  return frame(`${body}</g>`, 0.8);
}

/** A rosette such as is engraved on banknotes: one line wound round and round, inside another, with small ones in the corners. */
function rosette(): string {
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
  let body = wind(cx, cy, F.w * 0.47, F.h * 0.4, 17, 0.42, 4) + wind(cx, cy, F.w * 0.25, F.h * 0.21, 11, 0.5, 3);
  for (const [x, y] of [[F.x + 8, F.y + 8], [F.x + F.w - 8, F.y + 8], [F.x + 8, F.y + F.h - 8], [F.x + F.w - 8, F.y + F.h - 8]] as const) body += wind(x, y, 7, 7, 7, 0.45, 2);
  return frame(body, 0.55);
}

/**
 * A Voronoi pattern: points scattered over the field (one to each square of a grid, anywhere in it, by a fixed roll
 * of the dice), and round each the patch of the field that is nearer to it than to any other: drawn a little short
 * of its edges, like paving.
 */
function voronoi(): string {
  const cols = 6;
  const rows = 8;
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
    d += `${pts(cell.map(([x, y]) => [cx + (x - cx) * 0.86, cy + (y - cy) * 0.86] as const))}Z`;
  }
  return frame(`<path d="${d}"/>`, 1.1);
}

const DRAW: Record<string, () => string> = { hilbert, key, braid, loops, rings, guilloche: rosette, voronoi };
const made = new Map<string, string>();

/** The backs drawn here, by their names in `CARD_BACKS`. */
export const isDrawn = (back: string): boolean => back in DRAW;

/** A drawn back as a CSS image. */
export function drawnBack(back: string): string {
  let url = made.get(back);
  if (!url) made.set(back, (url = `url("data:image/svg+xml,${encodeURIComponent(DRAW[back]!())}")`));
  return url;
}
