// Sound. One function per cue; `useSounds` drives them from the rendered
// state (see soundEvents.ts for which change makes which sound).
//
// Card noises are short recordings (sounds/, see sounds/CREDITS.md); tones are
// synthesised. Everything is a one-shot through its own gain envelope into
// the gain of its channel (yours, or other players' cards: prefs.ts `Levels`)
// and one limiter, and at most MAX_VOICES play at once, so a
// busy table gets denser but never clicks or clips. Nothing sounds before the
// first click or key press: browsers do not let a page start audio by itself.
import { useEffect, useRef } from 'react';
import type { RoomView } from '../shared/types';
import type { Sorting } from './Finale';
import { dealTimes, type Stage } from './layout';
import { getPrefs, loudness, watchPrefs } from './prefs';
import { allotment, graceTicking, SORT_SOUND, soundCues, type Cue, type Frame, type SortSound, type Who } from './soundEvents';
import { Voices, type Voice } from './voices';

const FILES = import.meta.glob<string>('./sounds/*.mp3', { eager: true, query: '?url', import: 'default' });

const MAX_VOICES = 18;
/** Other players' cards at "100%" are still well under your own. */
const OTHERS = 0.7;

interface Sample {
  buffer: AudioBuffer;
  /** Where the sound actually starts (the lead-in an mp3 encoder adds is skipped). */
  at: number;
}

let ctx: AudioContext | null = null;
/** Where a one-shot goes, by whose it is. */
let buses: Record<Who, GainNode> | null = null;
const cap = new Voices(MAX_VOICES);
const samples = new Map<string, Sample>();

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const pick = <T>(of: readonly T[]): T => of[Math.floor(Math.random() * of.length)]!;

function level(who: Who): number {
  const p = getPrefs();
  return who === 'other' ? OTHERS * loudness(p, 'others') : loudness(p, 'mine');
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
    limiter.connect(ctx.destination);
    const bus = (who: Who): GainNode => {
      const g = ctx!.createGain();
      g.gain.value = level(who);
      g.connect(limiter);
      return g;
    };
    buses = { me: bus('me'), other: bus('other') };
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
    if (ctx && buses) for (const who of ['me', 'other'] as const) buses[who].gain.setTargetAtTime(level(who), ctx.currentTime, 0.015);
  });
}

interface Shot {
  gain?: number;
  /** Seconds from now. */
  delay?: number;
  who?: Who;
}

/** Whether a one-shot `length` seconds long may sound: when it starts, at what gain (before its channel's), and its place under the cap. Null = stay silent. */
function admit(o: Shot, length: number): { t: number; g: number; voice: Voice } | null {
  if (!ctx || !buses || ctx.state !== 'running') return null;
  const g = o.gain ?? 1;
  if (g * level(o.who ?? 'me') < 0.002) return null;
  const t = ctx.currentTime + (o.delay ?? 0);
  const voice = cap.take(ctx.currentTime, t, t + length);
  return voice && { t, g, voice };
}

type Stop = () => void;
const NOTHING: Stop = () => {};

/**
 * Plays a recording. `rate` is playback speed (pitch); `dull` low-passes it; `thin` high-passes it (the body of the
 * knock goes, the papery edge stays); `attack` is the fade-in in seconds (longer: no click at the front). Returns a
 * way to cut it short.
 */
function hit(name: string, o: Shot & { rate?: number; dull?: number; thin?: number; attack?: number } = {}): Stop {
  const s = samples.get(name);
  if (!s) return NOTHING;
  const rate = o.rate ?? 1;
  const length = (s.buffer.duration - s.at) / rate;
  const a = admit(o, length);
  if (!a || !ctx || !buses) return NOTHING;
  const { t, g, voice } = a;
  const src = ctx.createBufferSource();
  src.buffer = s.buffer;
  src.playbackRate.value = rate;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  const attack = Math.min(o.attack ?? 0.003, length / 2);
  env.gain.linearRampToValueAtTime(g, t + attack);
  env.gain.setValueAtTime(g, t + Math.max(attack + 0.001, length - 0.015));
  env.gain.linearRampToValueAtTime(0, t + length);
  let last: AudioNode = src;
  if (o.dull) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = o.dull;
    last = src.connect(filter);
  }
  if (o.thin) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = o.thin;
    last = last.connect(filter);
  }
  last.connect(env).connect(buses[o.who ?? 'me']);
  src.onended = () => env.disconnect();
  src.start(t, s.at);
  const audio = ctx;
  return () => {
    const now = audio.currentTime;
    env.gain.cancelScheduledValues(now);
    env.gain.setTargetAtTime(0, now, 0.02);
    const end = Math.max(now, t) + 0.1;
    src.stop(end);
    voice.end = Math.min(voice.end, end);
  };
}

/** A soft bell-like tone: a few sine partials under one fast-attack, exponential-decay envelope. */
function tone(freq: number, o: Shot & { dur?: number; partials?: readonly (readonly [number, number])[] } = {}): void {
  const dur = o.dur ?? 0.45;
  const a = admit(o, dur + 0.03);
  if (!a || !ctx || !buses) return;
  const { t, g } = a;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(g, t + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0005, t + dur);
  env.gain.linearRampToValueAtTime(0, t + dur + 0.02);
  env.connect(buses[o.who ?? 'me']);
  (o.partials ?? BELL).forEach(([ratio, amp], i) => {
    const osc = ctx!.createOscillator();
    osc.frequency.value = freq * ratio;
    const part = ctx!.createGain();
    part.gain.value = amp;
    osc.connect(part).connect(env);
    osc.start(t);
    osc.stop(t + dur + 0.03);
    if (i === 0) {
      osc.onended = () => env.disconnect();
    }
  });
}

/** A note that slides from `from` to `to` (Hz) as it sounds, fading out as it goes. */
function glide(from: number, to: number, o: Shot & { dur?: number; partials?: readonly (readonly [number, number])[] } = {}): void {
  const dur = o.dur ?? 0.2;
  const a = admit(o, dur + 0.03);
  if (!a || !ctx || !buses) return;
  const { t, g } = a;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(g, t + 0.004);
  env.gain.linearRampToValueAtTime(g * 0.5, t + dur * 0.6);
  env.gain.linearRampToValueAtTime(0, t + dur);
  env.connect(buses[o.who ?? 'me']);
  (o.partials ?? ([[1, 1], [2, 0.2]] as const)).forEach(([ratio, amp], i) => {
    const osc = ctx!.createOscillator();
    osc.frequency.setValueAtTime(from * ratio, t);
    osc.frequency.exponentialRampToValueAtTime(to * ratio, t + dur);
    const part = ctx!.createGain();
    part.gain.value = amp;
    osc.connect(part).connect(env);
    osc.start(t);
    osc.stop(t + dur + 0.03);
    if (i === 0) {
      osc.onended = () => env.disconnect();
    }
  });
}

const BELL = [[1, 1], [2, 0.3], [3, 0.1], [4.2, 0.04]] as const;
const CHIME = [[1, 1], [2, 0.45], [3, 0.22], [4, 0.1], [5.4, 0.05]] as const;
const TICK = [[1, 1], [2.4, 0.35]] as const;
/** A dull, low voice: little but the note itself. */
const DULL = [[1, 1], [2, 0.12]] as const;

const FLICKS = ['flick-1', 'flick-2', 'flick-3'];
const PLACES = ['place-1', 'place-2', 'place-3'];
const TAPS = ['tap-1', 'tap-2'];
const SLIDES = ['slide-1', 'slide-2'];

// ---------------------------------------------------------------- the cues

/** One card dealt: a soft flick, never twice quite the same. Call it once per card as the card lands. */
export function deal(delay = 0): void {
  hit(pick(FLICKS), { gain: rand(0.2, 0.34), rate: rand(0.9, 1.2), delay });
}

/** The deal at the start of a round: a flick as each card of your layout lands, on the animation's own schedule. */
export function dealBurst(work: number): void {
  dealTimes(work).forEach((t) => deal(t));
}

export function pickup(who: Who = 'me'): void {
  hit('lift', { gain: 0.13, rate: rand(1.05, 1.25), who });
}

export function workDrop(who: Who = 'me'): void {
  hit(pick(PLACES), { gain: 0.5, rate: rand(0.94, 1.06), who });
}

/** One card counted off the stock: a faint papery whisper, thinned and eased in so there is no knock in it. */
export function stockCard(who: Who = 'me'): void {
  hit(pick(FLICKS), { gain: rand(0.09, 0.12), rate: rand(1.15, 1.35), thin: 1800, attack: 0.012, who });
}

/** A hand opened out (the decks page): one soft sweep of cards (the start of the fanning sound, quick and quiet), not a run of clicks. */
export function riffle(): void {
  const stop = hit('fan', { gain: 0.16, rate: rand(1.45, 1.65), thin: 700, attack: 0.02 });
  setTimeout(stop, 240);
}

/** A pile of backs dealt out (the decks page): five light cards put down one after another, a little unevenly, each softer than a card played at the table, and thinned so that there is the pat of the card but no knock of the table under it. */
export function layOut(): void {
  for (let i = 0; i < 5; i++) hit(pick(PLACES), { gain: rand(0.14, 0.19), rate: rand(1.3, 1.5), thin: 600, delay: i * 0.062 + rand(0, 0.014) });
}

export function recycle(who: Who = 'me'): void {
  hit('slide-2', { gain: 0.3, rate: 1.1, who });
}

/** A card to the middle: the same firm card sound whatever its rank. */
export function centre(who: Who = 'me'): void {
  hit('place-2', { gain: 0.58, rate: rand(0.97, 1.03), who });
}

/**
 * The King: a fuller thunk and one short, soft note under it. A mark that a pile is done, no more: nothing that
 * rises or rings on, which would be taken for someone going out (`nertz` is the bright chord, and the only one).
 */
export function king(who: Who = 'me'): void {
  hit('place-2', { gain: 0.62, rate: 0.9, who });
  tone(392, { gain: 0.07, dur: 0.28, delay: 0.015, partials: BELL, who });
}

export function clearPile(who: Who = 'me'): void {
  hit('slide-1', { gain: 0.42, who });
}

/** A card going back where it came from: a quiet, dull tap. */
export function home(who: Who = 'me'): void {
  hit(pick(TAPS), { gain: 0.36, rate: rand(0.8, 0.9), dull: 900, who });
}

/** Somebody got there first: the card's tap, then a womp. */
export function lost(): void {
  home('me');
  womp();
}

/**
 * Two low, dull notes, each sagging as it sounds, the second lower and longer. Once for a race lost, though it is
 * told twice when the move was sent (the snapshot that refuses it, and the server's word of the snipe): whichever
 * comes first.
 */
const WOMP_MS = 500;
let wompAt = -Infinity;
function womp(): void {
  const now = performance.now();
  if (now - wompAt < WOMP_MS) return;
  wompAt = now;
  glide(196, 150, { gain: 0.26, dur: 0.16, delay: 0.03, partials: DULL });
  glide(156, 110, { gain: 0.28, dur: 0.42, delay: 0.2, partials: DULL });
}

/**
 * A snipe: somebody put the very card down that somebody else was about to. A dart and where it lands: a quick zip
 * downwards into a low thud. Your own (`me`: you were the one who did it) is at full strength; one between two
 * others is as loud as other players' cards are.
 */
export function sniped(who: Who = 'me'): void {
  glide(1500, 300, { gain: 0.16, dur: 0.11, who });
  tone(98, { gain: 0.4, dur: 0.28, delay: 0.1, partials: DULL, who });
  tone(2400, { gain: 0.05, dur: 0.04, delay: 0.1, partials: TICK, who });
}

/** You were sniped (the server says so: client/Table.tsx): the womp of a race lost, after the card's tap home. */
export function beaten(): void {
  womp();
}

/**
 * A bot that goes out says so: "Nertz", in the browser's own speech, in as mechanical a voice as it has (one of the
 * old novelty voices of macOS if there is one; otherwise whatever voice there is, pitched down and slowed). Only if
 * you have it switched on, and no louder than the rest: it is the table's call of Nertz, so it goes by your own level
 * (not other players' cards, nor voice chat: it is not a person). Where the browser cannot speak, nothing happens.
 */
const ROBOTS = ['Zarvox', 'Trinoids', 'Cellos', 'Fred', 'Ralph', 'Albert', 'Junior'];
export function botSays(): void {
  const p = getPrefs();
  const loud = Math.sqrt(loudness(p, 'mine')); // (speech by the slider itself, not squared, as it always was)
  if (!p.botVoice || loud <= 0 || typeof speechSynthesis === 'undefined') return;
  try {
    const say = new SpeechSynthesisUtterance('Nertz');
    const voices = speechSynthesis.getVoices();
    const robot = ROBOTS.map((name) => voices.find((v) => v.name.startsWith(name))).find(Boolean);
    if (robot) say.voice = robot;
    else {
      say.pitch = 0.1;
      say.rate = 0.8;
    }
    say.volume = Math.min(1, loud);
    speechSynthesis.cancel(); // (never two at once: a second table's call, or one still queued)
    speechSynthesis.speak(say);
  } catch {
    // no speech here
  }
}
// (Browsers load their voices late: asking once, early, means they are there by the time a bot goes out.)
if (typeof speechSynthesis !== 'undefined') speechSynthesis.getVoices();

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

/** One card's worth of a player's cards arriving at their pile, `delay` seconds from now. */
function arrival(how: SortSound, delay: number): Stop {
  if (how === 'swish') return hit(pick(SLIDES), { gain: rand(0.28, 0.36), rate: rand(1.5, 1.8), thin: 900, attack: 0.02, delay });
  return hit(pick(FLICKS), { gain: rand(0.16, 0.28), rate: rand(0.95, 1.25), delay });
}

/**
 * The wash: a riffle while the cards are mixed up, then each player's cards as they are sorted out to them, on the
 * canvas's own schedule (`sortings`, ms from now: the finale's clock starts as the wash does). A player whose cards
 * never reached the middle is silent. The table's sound, like the wash: on your own channel, whoever's cards they are.
 */
export function wash(sorts: readonly Sorting[], how: SortSound = SORT_SOUND): void {
  hush();
  finale.push(hit('shuffle', { gain: 0.5 }));
  for (const { lands } of sorts) for (const at of allotment(lands, how)) finale.push(arrival(how, at / 1000));
}

/** The score sheet is up. */
export function flourish(): void {
  hush();
  hit('fan', { gain: 0.42 });
  [659.25, 783.99, 1046.5].forEach((hz, i) => tone(hz, { gain: 0.1, dur: 0.7, delay: 0.12 + i * 0.09 }));
}

/** The end-of-round sequence moved on (Table.tsx calls this as its stage changes). */
export function stage(from: Stage, to: Stage, sorts: readonly Sorting[]): void {
  if (from === to) return;
  if (to === 'spread') wash(sorts);
  else if (to === 'sheet') flourish();
  else if (to === 'live') hush();
}

function play(cue: Cue): void {
  switch (cue.k) {
    case 'deal':
      return dealBurst(cue.work);
    case 'pickup':
      return pickup(cue.who);
    case 'work':
      return workDrop(cue.who);
    case 'stock':
      return stockCard(cue.who);
    case 'recycle':
      return recycle(cue.who);
    case 'centre':
      return centre(cue.who);
    case 'king':
      return king(cue.who);
    case 'clear':
      return clearPile(cue.who);
    case 'home':
      return home(cue.who);
    case 'lost':
      return lost();
    case 'nertz':
      if (cue.bot) botSays();
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
