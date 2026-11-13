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

/** A Greek key: square spirals off a base line, row upon row, every other row turned round. */
function key(small: boolean): string {
  const cols = small ? 3 : 5;
  const rows = small ? 4 : 8;
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
  return frame(`<path d="${d}"/>`, small ? 3 : 1.7, small);
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
    const least = small ? 22 : 13;
    if (depth === 0 || (w < least * 2 && h < least * 2) || (depth < 3 && roll() < 0.18)) {
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
  cut(F.x, F.y, F.w, F.h, small ? 3 : 5);
  let body = '';
  for (const [x, y, w, h] of leaves) {
    const r = roll();
    const fill = r < 0.2 ? '#fff' : r < 0.36 ? 'rgba(255,255,255,0.45)' : 'none';
    body += `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}"/>`;
  }
  return frame(body, small ? 3.4 : 2.1, small);
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
 * thread goes over two and under two, stepping one along each row. What shows at a crossing is whichever thread is on
 * top there; the broken checks with their teeth come of that. One repeat is eight threads by eight.
 */
function houndstooth(small: boolean): string {
  const white = (i: number, j: number): boolean => {
    const over = (((i - j) % 4) + 4) % 4 < 2; // the upright thread is on top here
    return (over ? i : j) % 8 < 4;
  };
  const across = small ? 3 : 5; // repeats across the card
  const cell = F.w / (across * 8);
  let d = '';
  const down = Math.ceil(F.h / cell);
  for (let j = 0; j < down; j++) {
    for (let i = 0; i < across * 8; i++) {
      if (!white(i, j)) continue;
      let end = i;
      while (end + 1 < across * 8 && white(end + 1, j)) end++;
      d += `M${n(F.x + i * cell)} ${n(F.y + j * cell)}h${n((end - i + 1) * cell)}v${n(cell + 0.1)}h${n(-(end - i + 1) * cell)}z`;
      i = end;
    }
  }
  return frame(clipped(`<path d="${d}" fill="#fff" stroke="none"/>`), 1, small);
}

const DRAW: Record<string, (small: boolean) => string> = { hilbert, key, braid, loops, rings, guilloche: rosette, voronoi, tree, dragon, koch, mandelbrot, walk, mondrian, diamonds, herringbone, honeycomb, starcross: starCross, houndstooth };
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
