// Card backs drawn here, not fetched: each is a small SVG picture, white on nothing, that is laid over the player's
// colour like the one-colour picture backs (`backOf` in Face.tsx). A card is 90 x 126; every back has the same white
// edge and a thin line inside it, and its own pattern in the field within.
const W = 90;
const H = 126;
const n = (v: number): string => (Math.round(v * 100) / 100).toString();
const pts = (p: readonly (readonly [number, number])[]): string => p.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join('');

/** The field the pattern fills: inside the edge and the thin line. */
const F = { x: 9, y: 9, w: W - 18, h: H - 18 };

const frame = (body: string, stroke = 1.3, small = false): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
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
 * the next turn. Every other band runs the other way.
 */
function key(small: boolean): string {
  const across = small ? 1 : 2; // turns of the key in a band
  const bands = small ? 2 : 4;
  // One turn is 16 across and 10 high, in steps of the gap between one line and the next.
  const TURN: [number, number][] = [[0, 10], [0, 0], [12, 0], [12, 8], [4, 8], [4, 4], [8, 4], [8, 6], [10, 6], [10, 2], [2, 2], [2, 10], [16, 10]];
  const u = F.w / (across * 16 + 0.6);
  const pitch = F.h / bands;
  let d = '';
  for (let b = 0; b < bands; b++) {
    const top = F.y + b * pitch + (pitch - 10 * u) / 2;
    const line: [number, number][] = [];
    for (let k = 0; k < across; k++) for (const [x, y] of k ? TURN.slice(1) : TURN) line.push([k * 16 + x, y]);
    // (It ends by turning up into the band's last upright, as if into another turn.)
    line.push([across * 16, 0]);
    d += pts(line.map(([x, y]) => [b % 2 ? W / 2 + (across * 8 - x) * u : W / 2 + (x - across * 8) * u, top + y * u] as const));
  }
  return frame(`<path d="${d}" stroke-linecap="square" stroke-linejoin="miter"/>`, small ? 2.6 : 1.4, small);
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

/** Shards: every tile cut from one corner into three long wedges, white, half and bare; each tile turned the other way from its neighbours. */
function shards(small: boolean): string {
  const cols = small ? 2 : 3;
  const rows = small ? 3 : 5;
  const [w, h] = [F.w / cols, F.h / rows];
  let white = '';
  let half = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [fx, fy] = [(r + c) % 2 ? -1 : 1, r % 2 ? -1 : 1];
      const at = (px: number, py: number): [number, number] => [F.x + (c + 0.5) * w + fx * (px - 0.5) * w, F.y + (r + 0.5) * h + fy * (py - 0.5) * h];
      white += poly([at(0, 1), at(0, 0), at(0.42, 0)]);
      half += poly([at(0, 1), at(0.42, 0), at(1, 0)]);
    }
  }
  return frame(`<path d="${white}" fill="#fff" stroke="none"/><path d="${half}" fill="${HALF}" stroke="none"/>`, 1, small);
}

/** Pinwheels: in every tile four blades round the middle, each a wedge with its tip cut off, all turning the same way. */
function pinwheel(small: boolean): string {
  const cols = small ? 2 : 3;
  const rows = small ? 3 : 4;
  const [w, h] = [F.w / cols, F.h / rows];
  let d = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let q = 0; q < 4; q++) {
        // One blade, in a tile that is 2 by 2 with its middle at (0, 0), turned a quarter for each of the four.
        const turn = ([x, y]: [number, number]): [number, number] => [[x, y], [-y, x], [-x, -y], [y, -x]][q] as [number, number];
        d += poly(([[0, 0], [0, -0.7], [0.45, -0.7], [0.45, -0.45]] as [number, number][]).map(turn).map(([x, y]) => [F.x + (c + 0.5 + x / 2) * w, F.y + (r + 0.5 + y / 2) * h] as const));
      }
    }
  }
  return frame(`<path d="${d}" fill="#fff" stroke="none"/>`, 1, small);
}

/** A mosaic: little stones, none quite square or straight, and two bands of white ones winding down the card across each other, their middles a half tone. */
function mosaic(small: boolean): string {
  const size = small ? 6 : 3.6;
  const cols = Math.round(F.w / size);
  const rows = Math.round(F.h / size);
  const [w, h] = [F.w / cols, F.h / rows];
  const roll = dice(41);
  const tones: Record<string, string> = { white: '', half: '', faint: '' };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [cx, cy] = [F.x + (c + 0.5) * w, F.y + (r + 0.5) * h];
      const swing = F.w * 0.3 * Math.sin((2 * Math.PI * (cy - F.y)) / (F.h / 2));
      const off = Math.min(Math.abs(cx - (W / 2 + swing)), Math.abs(cx - (W / 2 - swing)));
      const band = small ? 7 : 5.5;
      const tone = off < band * 0.38 ? 'half' : off < band ? 'white' : 'faint';
      const turn = (roll() - 0.5) * 0.5;
      const [rx, ry] = [(w / 2) * (0.74 + roll() * 0.14), (h / 2) * (0.74 + roll() * 0.14)];
      tones[tone] += poly(([[-rx, -ry], [rx, -ry], [rx, ry], [-rx, ry]] as const).map(([x, y]) => [cx + x * Math.cos(turn) - y * Math.sin(turn), cy + x * Math.sin(turn) + y * Math.cos(turn)] as const));
    }
  }
  return frame(`<path d="${tones.white}" fill="#fff" stroke="none"/><path d="${tones.half}" fill="${HALF}" stroke="none"/><path d="${tones.faint}" fill="rgba(255,255,255,0.2)" stroke="none"/>`, 1, small);
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

const DRAW: Record<string, (small: boolean) => string> = { hilbert, key, braid, loops, rings, guilloche: rosette, voronoi, tree, dragon, koch, mandelbrot, walk, mondrian, diamonds, herringbone, honeycomb, starcross: starCross, houndstooth, shards, pinwheel, mosaic, flowers, compass, lightcone, waves, flow, life };
const made = new Map<string, string>();

/** The backs drawn here, by their names in `CARD_BACKS`. */
export const isDrawn = (back: string): boolean => back in DRAW;

/**
 * A drawn back as a CSS image. Each is worked out once in this browser, the first time it is wanted, and kept; the
 * dice are fixed, so it is the same picture for everybody. `small`: the simpler drawing of it, with heavier lines,
 * for a card too small for the full one to read (other players' piles).
 */
export function drawnBack(back: string, small = false): string {
  const k = `${back} ${small}`;
  let url = made.get(k);
  if (!url) made.set(k, (url = `url("data:image/svg+xml,${encodeURIComponent(DRAW[back]!(small))}")`));
  return url;
}
