// Sound. One function per cue; `useSounds` drives them from the rendered
// state (see soundEvents.ts for which change makes which sound).
//
// Card noises are short recordings (sounds/, see sounds/CREDITS.md); tones are
// synthesised. Everything is a one-shot through its own gain envelope into
// one master gain and a limiter, and at most MAX_VOICES play at once, so a
// busy table gets denser but never clicks or clips. Nothing sounds before the
// first click or key press: browsers do not let a page start audio by itself.
import { useEffect, useRef } from 'react';
import type { RoomView } from '../shared/types';
import { TIMING } from './Finale';
import { DEAL, dealWait, type Stage } from './layout';
import { DEAL_MS } from '../shared/protocol';
import { getPrefs, watchPrefs } from './prefs';
import { graceTicking, soundCues, type Cue, type Frame, type Who } from './soundEvents';

const FILES = import.meta.glob<string>('./sounds/*.mp3', { eager: true, query: '?url', import: 'default' });

const MAX_VOICES = 18;
/** Other players' cards at "100%" are still well under your own. */
const OTHERS = 0.7;
const { wash: WASH_MS, sortEach: SORT_MS } = TIMING; // flicks while the first couple of piles are gathered

interface Sample {
  buffer: AudioBuffer;
  /** Where the sound actually starts (the lead-in an mp3 encoder adds is skipped). */
  at: number;
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let voices = 0;
const samples = new Map<string, Sample>();

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const pick = <T>(of: readonly T[]): T => of[Math.floor(Math.random() * of.length)]!;

function level(): number {
  const p = getPrefs();
  return p.muted ? 0 : p.volume * p.volume; // squared: the slider feels even
}

function onset(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]!));
  let i = 0;
  while (i < data.length && Math.abs(data[i]!) < peak * 0.04) i++;
  return Math.max(0, i / buffer.sampleRate - 0.004);
}

/** First user gesture: make the audio context and fetch the samples. Later gestures: wake it if the browser put it to sleep. */
function wake(): void {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 10;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    master = ctx.createGain();
    master.gain.value = level();
    master.connect(limiter).connect(ctx.destination);
    const audio = ctx;
    for (const [path, url] of Object.entries(FILES)) {
      const name = path.slice(path.lastIndexOf('/') + 1, -4);
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((bytes) => audio.decodeAudioData(bytes))
        .then((buffer) => samples.set(name, { buffer, at: onset(buffer) }))
        .catch(() => {}); // a sample that will not load is a cue that stays silent
    }
  }
  if (ctx.state !== 'running') void ctx.resume().catch(() => {});
}

if (typeof window !== 'undefined') {
  for (const type of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(type, wake, { capture: true, passive: true });
  watchPrefs(() => {
    if (ctx && master) master.gain.setTargetAtTime(level(), ctx.currentTime, 0.015);
  });
}

interface Shot {
  gain?: number;
  /** Seconds from now. */
  delay?: number;
  who?: Who;
}

/** Whether a one-shot at this gain may start now, and at what level. 0 = stay silent. */
function admit(o: Shot): number {
  if (!ctx || !master || ctx.state !== 'running' || level() === 0 || voices >= MAX_VOICES) return 0;
  const g = (o.gain ?? 1) * (o.who === 'other' ? OTHERS * getPrefs().others : 1);
  return g < 0.003 ? 0 : g;
}

type Stop = () => void;
const NOTHING: Stop = () => {};

/** Plays a recording. `rate` is playback speed (pitch); `dull` low-passes it. Returns a way to cut it short. */
function hit(name: string, o: Shot & { rate?: number; dull?: number } = {}): Stop {
  const s = samples.get(name);
  const g = admit(o);
  if (!s || !g || !ctx || !master) return NOTHING;
  const rate = o.rate ?? 1;
  const t = ctx.currentTime + (o.delay ?? 0);
  const length = (s.buffer.duration - s.at) / rate;
  const src = ctx.createBufferSource();
  src.buffer = s.buffer;
  src.playbackRate.value = rate;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(g, t + 0.003);
  env.gain.setValueAtTime(g, t + Math.max(0.004, length - 0.015));
  env.gain.linearRampToValueAtTime(0, t + length);
  let last: AudioNode = src;
  if (o.dull) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = o.dull;
    last = src.connect(filter);
  }
  last.connect(env).connect(master);
  voices++;
  src.onended = () => {
    voices--;
    env.disconnect();
  };
  src.start(t, s.at);
  const audio = ctx;
  return () => {
    const now = audio.currentTime;
    env.gain.cancelScheduledValues(now);
    env.gain.setTargetAtTime(0, now, 0.02);
    src.stop(Math.max(now, t) + 0.1);
  };
}

/** A soft bell-like tone: a few sine partials under one fast-attack, exponential-decay envelope. */
function tone(freq: number, o: Shot & { dur?: number; partials?: readonly (readonly [number, number])[] } = {}): void {
  const g = admit(o);
  if (!g || !ctx || !master) return;
  const t = ctx.currentTime + (o.delay ?? 0);
  const dur = o.dur ?? 0.45;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(g, t + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0005, t + dur);
  env.gain.linearRampToValueAtTime(0, t + dur + 0.02);
  env.connect(master);
  voices++;
  (o.partials ?? BELL).forEach(([ratio, amp], i) => {
    const osc = ctx!.createOscillator();
    osc.frequency.value = freq * ratio;
    const part = ctx!.createGain();
    part.gain.value = amp;
    osc.connect(part).connect(env);
    osc.start(t);
    osc.stop(t + dur + 0.03);
    if (i === 0) {
      osc.onended = () => {
        voices--;
        env.disconnect();
      };
    }
  });
}

const BELL = [[1, 1], [2, 0.3], [3, 0.1], [4.2, 0.04]] as const;
const CHIME = [[1, 1], [2, 0.45], [3, 0.22], [4, 0.1], [5.4, 0.05]] as const;
const TICK = [[1, 1], [2.4, 0.35]] as const;

/**
 * One note per rank, Ace low to King high: a major pentatonic scale over two
 * and a half octaves (E4 .. A6), so any piles being built at once ring together.
 */
const STEPS = [4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31, 33]; // semitones above C4
export const rankHz = (rank: number): number => 261.63 * 2 ** (STEPS[Math.max(1, Math.min(13, rank)) - 1]! / 12);

const FLICKS = ['flick-1', 'flick-2', 'flick-3'];
const PLACES = ['place-1', 'place-2', 'place-3'];
const TAPS = ['tap-1', 'tap-2'];

// ---------------------------------------------------------------- the cues

/** One card dealt: a soft flick, never twice quite the same. Call it once per card as the card lands. */
export function deal(delay = 0): void {
  hit(pick(FLICKS), { gain: rand(0.2, 0.34), rate: rand(0.9, 1.2), delay });
}

/** The deal at the start of a round: a flick as each card of your layout lands, on the animation's own schedule. */
export function dealBurst(cards = 23): void {
  for (let i = 0; i < cards; i++) deal(((dealWait(i, DEAL_MS) ?? 0) + DEAL.duration * 700) / 1000);
}

export function pickup(who: Who = 'me'): void {
  hit('lift', { gain: 0.13, rate: rand(1.05, 1.25), who });
}

export function workDrop(who: Who = 'me'): void {
  hit(pick(PLACES), { gain: 0.5, rate: rand(0.94, 1.06), who });
}

/** One card off the stock onto the waste: one soft flick. */
export function stockCard(who: Who = 'me'): void {
  hit(pick(FLICKS), { gain: rand(0.24, 0.3), rate: rand(0.95, 1.1), who });
}

export function recycle(who: Who = 'me'): void {
  hit('slide-2', { gain: 0.3, rate: 1.1, who });
}

/** A card to the middle: the same firm card sound whatever its rank. */
export function centre(_rank: number, who: Who = 'me'): void {
  hit('place-2', { gain: 0.58, rate: rand(0.97, 1.03), who });
}

/** The King: a fuller thunk and two notes, a fourth apart. */
export function king(who: Who = 'me'): void {
  hit('place-2', { gain: 0.62, rate: 0.9, who });
  tone(783.99, { gain: 0.17, dur: 0.8, delay: 0.015, partials: CHIME, who });
  tone(1046.5, { gain: 0.17, dur: 1.0, delay: 0.135, partials: CHIME, who });
}

export function clearPile(who: Who = 'me'): void {
  hit('slide-1', { gain: 0.42, who });
}

/** A card going back where it came from: a quiet, dull tap. */
export function home(who: Who = 'me'): void {
  hit(pick(TAPS), { gain: 0.36, rate: rand(0.8, 0.9), dull: 900, who });
}

/** Nertz is called: the one loud sound, the same for everyone, landing with the stamp. */
export function nertz(): void {
  const at = 0.11; // the stamp takes about this long to come down
  hit('place-1', { gain: 1, rate: 0.82, delay: at });
  hit('place-2', { gain: 0.9, rate: 0.7, delay: at });
  [523.25, 659.25, 783.99, 1046.5].forEach((hz, i) => tone(hz, { gain: 0.2, dur: 1.2, delay: at + i * 0.012, partials: CHIME }));
}

/** One number of the dealer's "1, 2, 3": a knock and a short low note, the same for everyone. */
export function countBeat(delay = 0): void {
  hit('tap-1', { gain: 0.55, rate: 1.2, delay });
  tone(587.33, { gain: 0.15, dur: 0.14, delay, partials: TICK });
}

/** "NERTZ!" at the start: play is open. A bright, light hit; nothing like the loud call that ends a round. */
export function opened(): void {
  hit('place-1', { gain: 0.5, rate: 1.15 });
  [880, 1174.66, 1760].forEach((hz, i) => tone(hz, { gain: 0.13, dur: 0.5, delay: i * 0.01, partials: CHIME }));
}

/** One second of the grace countdown. */
export function tick(): void {
  tone(1174.66, { gain: 0.1, dur: 0.07, partials: TICK });
}

let finale: Stop[] = [];
function hush(): void {
  for (const stop of finale.splice(0)) stop();
}

/** The wash: a riffle while the cards swirl, then quick flicks as they sort into their piles. */
export function wash(): void {
  hush();
  finale.push(hit('shuffle', { gain: 0.5 }));
  const flicks = 16;
  for (let i = 0; i < flicks; i++) {
    finale.push(hit(pick(FLICKS), { gain: rand(0.16, 0.28), rate: rand(0.95, 1.25), delay: (WASH_MS + (i / flicks) * SORT_MS * 2) / 1000 + rand(0, 0.03) }));
  }
}

/** The score sheet is up. */
export function flourish(): void {
  hush();
  hit('fan', { gain: 0.42 });
  [659.25, 783.99, 1046.5].forEach((hz, i) => tone(hz, { gain: 0.1, dur: 0.7, delay: 0.12 + i * 0.09 }));
}

/** The end-of-round sequence moved on (Table.tsx calls this as its stage changes). */
export function stage(from: Stage, to: Stage): void {
  if (from === to) return;
  if (to === 'wash') wash();
  else if (to === 'sheet') flourish();
  else if (to === 'live') hush();
}

function play(cue: Cue): void {
  switch (cue.k) {
    case 'deal':
      return dealBurst();
    case 'pickup':
      return pickup(cue.who);
    case 'work':
      return workDrop(cue.who);
    case 'stock':
      return stockCard(cue.who);
    case 'flip':
      return; // the group turning up makes no noise of its own: each of its cards has already flicked
    case 'recycle':
      return recycle(cue.who);
    case 'centre':
      return centre(cue.rank, cue.who);
    case 'king':
      return king(cue.who);
    case 'clear':
      return clearPile(cue.who);
    case 'home':
      return home(cue.who);
    case 'nertz':
      return nertz();
    case 'count':
      return cue.at.forEach(countBeat);
    case 'open':
      return opened();
  }
}

/** Sounds for whatever changes between one rendered room and the next, and the tick of the grace countdown. */
export function useSounds(room: RoomView | null, online: boolean): void {
  const last = useRef<Frame | null>(null);
  useEffect(() => {
    const next: Frame = { room, online };
    for (const cue of soundCues(last.current, next)) play(cue);
    last.current = next;
  }, [room, online]);

  const ticking = graceTicking(room);
  useEffect(() => {
    if (!ticking) return;
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [ticking]);
}
