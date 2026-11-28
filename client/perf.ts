// The frame-rate readout and its log, for measuring a build on a real device: on only with `?fps` in the address
// (and then for the rest of the tab's life, so moving between pages keeps it). Off, nothing here runs.
//
// While on, every frame is noted (when it began), and so is what happened meanwhile (shared/perf.ts): each message
// from the server and what handling it took, the round's status, how many cards are on the table, long tasks, and the
// page going out of sight. The top of the screen shows the frame rate now, the average, and the lowest in any one
// second. A tap on it sends the log so far to the server (server/perflog.ts) and starts a new one.
import { PERF_LOGS_PATH, type PerfEvent, type PerfLog } from '../shared/perf';

const KEY = 'nertz-fps';
/** At most this many frames in one log (about eleven minutes at 60 a second): past it, frames are no longer noted. */
const MOST_FRAMES = 40_000;

function asked(): boolean {
  try {
    if (new URLSearchParams(location.search).has('fps')) sessionStorage.setItem(KEY, '1');
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Whether the readout is on in this tab. */
export const perfOn = typeof window !== 'undefined' && asked();

/** The log being kept: from `t0` (performance clock) and `at` (wall clock). */
let t0 = 0;
let at = 0;
let frames: number[] = [];
let events: PerfEvent[] = [];
/** Frames while the page is in sight, for the rates: when the recent ones began (the oldest still within the last second at `lo`), and how many since it came into sight. */
let seen: number[] = [];
let lo = 0;
let seenN = 0;
/** When the page last came into sight (a second must pass before a "lowest second" can be had), the time in sight before that, and the frames in it. */
let since = 0;
let sightMs = 0;
let sightFrames = 0;
let low = Infinity;
let shown = true;
let lastCards = -1;
let lastStatus = '';

const now = (): number => Math.round((performance.now() - t0) * 10) / 10;
const note = (e: PerfEvent): void => void (events.length < MOST_FRAMES && events.push(e));

function reset(): void {
  t0 = performance.now();
  at = Date.now();
  frames = [];
  events = [];
  seen = [];
  lo = 0;
  seenN = 0;
  since = 0;
  sightMs = 0;
  sightFrames = 0;
  low = Infinity;
  lastCards = -1;
  lastStatus = '';
}

/** A message from the server, `bytes` long, of type `type`, that took `ms` to handle (net.ts). */
export function perfMessage(type: string, bytes: number, ms: number): void {
  if (perfOn) note({ t: now(), k: 'msg', type, bytes, ms: Math.round(ms * 100) / 100 });
}

/** The round's status as a snapshot gives it (`lobby` at no round): noted when it changes. */
export function perfStatus(status: string): void {
  if (!perfOn || status === lastStatus) return;
  lastStatus = status;
  note({ t: now(), k: 'status', at: status });
}

const average = (): number => {
  const ms = sightMs + (shown ? now() - since : 0);
  const n = sightFrames + (shown ? seenN : 0);
  return ms > 0 ? (n * 1000) / ms : 0;
};
const current = (): number => seen.length - lo;

function frame(): void {
  const t = now();
  if (shown) {
    if (frames.length < MOST_FRAMES) frames.push(t);
    seen.push(t);
    seenN++;
    while (t - seen[lo]! >= 1000) lo++;
    if (lo > 600) (seen = seen.slice(lo)), (lo = 0);
    if (t - since >= 1000) low = Math.min(low, seen.length - lo);
  }
  requestAnimationFrame(frame);
}

function sight(): void {
  const visible = document.visibilityState === 'visible';
  if (visible === shown) return;
  const t = now();
  if (!visible) {
    sightMs += t - since;
    sightFrames += seenN;
  } else {
    since = t;
    seen = [];
    lo = 0;
    seenN = 0;
  }
  shown = visible;
  note({ t, k: visible ? 'shown' : 'hidden' });
}

function log(): PerfLog {
  return {
    host: location.host,
    device: { ua: navigator.userAgent, dpr: devicePixelRatio, w: innerWidth, h: innerHeight, cores: navigator.hardwareConcurrency ?? null },
    at,
    ms: now(),
    frames,
    events,
    summary: { fps: Math.round(average() * 10) / 10, low: Number.isFinite(low) ? low : 0, frames: frames.length },
  };
}

/** Puts the readout in its corner and starts the log. Called once, at start, if `perfOn`. */
export function startPerf(): void {
  if (!perfOn) return;
  reset();
  const box = document.createElement('button');
  box.type = 'button';
  box.title = 'Send this log'; // (frames a second now, on average, and in the worst second)
  box.style.cssText =
    // (Top middle: between the corner buttons, over nothing of the table's.)
    'position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top) + 10px);z-index:2147483647;white-space:nowrap;' +
    'font:600 10px/1.2 ui-monospace,Menlo,monospace;color:#fff;background:rgba(0,0,0,.55);border:0;border-radius:4px;padding:2px 5px;' +
    'font-variant-numeric:tabular-nums;pointer-events:auto;-webkit-tap-highlight-color:transparent';
  let said: string | null = null;
  const show = (): void => {
    box.textContent = said ?? `${current()} · avg ${Math.round(average())} · low ${Number.isFinite(low) ? low : '–'}`;
  };
  box.addEventListener('click', () => {
    if (said) return;
    said = 'sending…';
    show();
    const body = JSON.stringify(log());
    fetch(PERF_LOGS_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      .then((r) => (r.ok ? (r.json() as Promise<{ id: string }>) : Promise.reject(new Error(String(r.status)))))
      .then(({ id }) => {
        said = `sent ${id.slice(-4)}`;
        reset();
      })
      .catch(() => (said = 'not sent'))
      .finally(() => {
        show();
        setTimeout(() => ((said = null), show()), 2500);
      });
  });
  document.body.append(box);
  setInterval(show, 500);
  setInterval(() => {
    const n = document.getElementsByClassName('card').length;
    if (n !== lastCards) note({ t: now(), k: 'cards', n: (lastCards = n) });
  }, 250);
  document.addEventListener('visibilitychange', sight);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) note({ t: Math.round((e.startTime - t0) * 10) / 10, k: 'long', ms: Math.round(e.duration) });
    }).observe({ type: 'longtask', buffered: false });
  } catch {
    // (Safari tells of no long tasks: the frames say it anyway.)
  }
  requestAnimationFrame(frame);
}
