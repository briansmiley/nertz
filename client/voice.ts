// Voice chat: an audio-only WebRTC mesh between the players who pressed
// "Join". Every pair has one RTCPeerConnection; offers, answers and ICE
// candidates travel through the game's websocket ({ t: 'signal' }) and the
// server only forwards them. Who is in voice comes from the server
// ({ t: 'social' }, see social.ts), and `sync` makes the connections match it.
//
// Of two players the one with the lower id always makes the offer, so two
// offers can never cross.
import { useSyncExternalStore } from 'react';
import type { VoiceMember } from '../shared/chat';
import { current, post } from './net';
import { GATE_MAX, gateLevel, getPrefs, loudness, micGain, watchPrefs } from './prefs';

/**
 * STUN only: enough when at least one side of a pair can be reached directly,
 * which covers most home networks. Two players who are both behind strict
 * (symmetric) NATs or firewalls, as on some company, campus and mobile
 * networks, will not hear each other without a relay: a TURN server is given
 * to the game's server (its `ICE_SERVERS`, server/chat.ts), not put here.
 */
export const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
/** And whatever the game's server knows of besides (a TURN relay, if it was given one): it says so with the chat's state. */
let extraIce: RTCIceServer[] = [];
export function setIce(servers: readonly RTCIceServer[] | undefined): void {
  extraIce = servers ? [...servers] : [];
}

const SPEAKING_LEVEL = 0.02;
const METER_MS = 120;

export interface VoiceState {
  /** 'asking' while the browser is asking for the microphone. */
  status: 'off' | 'asking' | 'on';
  muted: boolean;
  error: string | null;
  /** Players (by id) making sound right now (this one included). */
  speaking: readonly number[];
  /** How the connection to each other player in voice (by id) stands: being set up, up, or not to be had (no path between the two networks). */
  links: Readonly<Record<number, Link>>;
}
export type Link = 'connecting' | 'on' | 'failed';

interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  /** Candidates that arrived before the description they belong to. */
  queued: RTCIceCandidateInit[];
}

type Signal = { sdp: RTCSessionDescriptionInit } | { ice: RTCIceCandidateInit };

let state: VoiceState = { status: 'off', muted: false, error: null, speaking: [], links: {} };
const link = (id: number, to: Link | null): void => {
  const { [id]: was, ...rest } = state.links;
  if (was !== (to ?? undefined)) set({ links: to ? { ...rest, [id]: to } : rest });
};
const listeners = new Set<() => void>();
let mic: MediaStream | null = null;
let ctx: AudioContext | null = null;
/**
 * What goes out to the others: the microphone through its level and its gate (`Prefs.mic`), and a tap between the two
 * for the gate's slider (`micInput`). Null without an audio context to do it in: then the microphone goes out as it is.
 */
interface Send {
  gain: GainNode;
  /** Null where the browser has no audio worklets: the level without the gate. */
  gate: AudioWorkletNode | null;
  input: AnalyserNode;
  stream: MediaStream;
}
let send: Send | null = null;
/** The stream the others are sent. */
const sent = (): MediaStream | null => send?.stream ?? mic;
let meterTimer: ReturnType<typeof setInterval> | undefined;
const peers = new Map<number, Peer>();
const meters = new Map<number, { node: AnalyserNode; source: MediaStreamAudioSourceNode }>();
/** Counts presses of Join, so an answer to an earlier microphone request is recognised as stale. */
let asks = 0;

function set(next: Partial<VoiceState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/** Read afresh: it changes while a function is waiting. */
const status = (): VoiceState['status'] => state.status;
const myId = (): number | undefined => current().room?.me;

// ---------------------------------------------------------------- the microphone

/** Asks for the microphone (only now) and joins the table's voice chat. Call from a click. */
export async function joinVoice(): Promise<void> {
  if (state.status !== 'off') return;
  set({ status: 'asking', error: null });
  const ask = ++asks;
  // Made inside the click, so the browser lets it (and the audio elements later) play. It only tells who is speaking: voice goes on without one.
  let made: AudioContext | null = null;
  try {
    made = new AudioContext();
    void made.resume();
  } catch {
    // the browser has none to give
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    void made?.close();
    if (ask === asks && status() === 'asking') set({ status: 'off', error: 'No microphone: check the browser permission.' });
    return;
  }
  // (A context that is not running would send silence: then the microphone goes out as it is.)
  const wired = made?.state === 'running' ? await wire(made, stream) : null;
  if (ask !== asks || status() !== 'asking') {
    // Left the table while the browser was asking.
    for (const t of [...stream.getTracks(), ...(wired?.stream.getTracks() ?? [])]) t.stop();
    void made?.close();
    return;
  }
  mic = stream;
  ctx = made;
  send = wired;
  tune();
  for (const t of mic.getAudioTracks()) t.enabled = !state.muted;
  const id = myId();
  // Your own ring goes by what is sent: after the level and the gate, silent while muted.
  if (id !== undefined) meter(id, sent()!);
  meterTimer = setInterval(measure, METER_MS);
  set({ status: 'on' });
  post({ t: 'voice', on: true, muted: state.muted });
}

/** Out of voice: every connection closed and the microphone released. `tell` is false when the server already knows. */
export function leaveVoice(tell = true): void {
  if (state.status === 'off') return;
  hangUp();
  for (const t of [...(mic?.getTracks() ?? []), ...(send?.stream.getTracks() ?? [])]) t.stop();
  mic = null;
  send = null;
  clearInterval(meterTimer);
  for (const m of meters.values()) m.source.disconnect();
  meters.clear();
  void ctx?.close();
  ctx = null;
  set({ status: 'off', speaking: [] });
  if (tell) post({ t: 'voice', on: false, muted: state.muted });
}

export function setMuted(muted: boolean): void {
  for (const t of mic?.getAudioTracks() ?? []) t.enabled = !muted;
  set({ muted });
  if (state.status === 'on') post({ t: 'voice', on: true, muted });
}

/** Mute yourself if you are not, unmute if you are, from the store as it is now (not as last rendered); answers whether you are now muted. */
export function toggleMuted(): boolean {
  setMuted(!state.muted);
  return state.muted;
}

/**
 * The gate, on the audio thread (so no timer of a hidden tab holds it up): it opens the moment a block of sound is at
 * its threshold or over, stays open a quarter of a second after the last one (the ends of words), and fades out then.
 * A threshold of 0 is always open.
 */
const GATE = `registerProcessor('gate', class extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'threshold', defaultValue: 0, minValue: 0, automationRate: 'k-rate' }]; }
  constructor() {
    super();
    this.gain = 1;
    this.held = 0;
    this.hold = Math.round((0.25 * sampleRate) / 128);
    this.attack = 1 - Math.exp(-1 / (0.002 * sampleRate));
    this.release = 1 - Math.exp(-1 / (0.06 * sampleRate));
  }
  process([input], [output], { threshold }) {
    const t = threshold[0], n = output[0] ? output[0].length : 128;
    let sum = 0;
    for (const ch of input) for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = input.length ? Math.sqrt(sum / (input.length * n)) : 0;
    if (t <= 0 || rms >= t) this.held = this.hold;
    else if (this.held > 0) this.held--;
    const to = this.held > 0 ? 1 : 0, k = to > this.gain ? this.attack : this.release;
    for (let i = 0; i < n; i++) {
      this.gain += (to - this.gain) * k;
      for (let c = 0; c < output.length; c++) output[c][i] = input[c] ? input[c][i] * this.gain : 0;
    }
    return true;
  }
});`;

/** The microphone through its level and its gate (`Send`); null if the browser will not have it. */
async function wire(c: AudioContext, stream: MediaStream): Promise<Send | null> {
  try {
    const gain = c.createGain();
    const input = c.createAnalyser();
    input.fftSize = 512;
    c.createMediaStreamSource(stream).connect(gain).connect(input);
    let gate: AudioWorkletNode | null = null;
    try {
      const url = URL.createObjectURL(new Blob([GATE], { type: 'text/javascript' }));
      await c.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      gate = new AudioWorkletNode(c, 'gate');
    } catch {
      // no worklets here
    }
    const out = c.createMediaStreamDestination();
    (gate ? gain.connect(gate) : gain).connect(out);
    return { gain, gate, input, stream: out.stream };
  } catch {
    return null;
  }
}

/** The level and the gate as the settings have them now: they change while you talk. */
function tune(): void {
  if (!send || !ctx) return;
  const m = getPrefs().mic;
  send.gain.gain.setTargetAtTime(micGain(m), ctx.currentTime, 0.02);
  const threshold = send.gate?.parameters.get('threshold');
  if (threshold) threshold.value = gateLevel(m);
}
watchPrefs(tune);

/**
 * How loud your microphone is right now, after its level and before the gate, on the gate's own scale (0..1, as
 * `Mic.gate`: over the gate is sent). Null when it cannot be told: not in voice, or no audio context.
 */
export function micInput(): number | null {
  return send ? Math.min(1, Math.sqrt(rms(send.input) / GATE_MAX)) : null;
}

// ---------------------------------------------------------------- the mesh

/** How loud the others' voices play: the voice chat's level (the game's mute is not for it). */
const heard = (): number => loudness(getPrefs(), 'voice');
watchPrefs(() => {
  for (const { audio } of peers.values()) audio.volume = heard();
});

/** The websocket dropped: the connections are closed, the microphone is kept, and `sync` rejoins when we are back. */
export function hangUp(): void {
  for (const id of [...peers.keys()]) closePeer(id);
}

/** The server said who is in voice: connect to whoever is new, drop whoever has gone. */
export function sync(members: readonly VoiceMember[]): void {
  const me = myId();
  if (state.status !== 'on' || me === undefined) return;
  if (!members.some((m) => m.id === me)) {
    // The server does not have us (a new socket after a reconnect, or our join is still on its way): say so. Were we kept out, it says that instead ({ t: 'outOfVoice' }).
    hangUp();
    post({ t: 'voice', on: true, muted: state.muted });
    return;
  }
  for (const id of [...peers.keys()]) if (!members.some((m) => m.id === id)) closePeer(id);
  for (const { id } of members) {
    if (id === me || peers.has(id)) continue;
    const peer = open(id);
    if (me < id) void offer(id, peer);
  }
}

function open(id: number): Peer {
  const pc = new RTCPeerConnection({ iceServers: [...ICE_SERVERS, ...extraIce] });
  const audio = new Audio();
  audio.autoplay = true;
  audio.volume = heard();
  const peer: Peer = { pc, audio, queued: [] };
  peers.set(id, peer);
  const out = sent();
  for (const t of out?.getAudioTracks() ?? []) pc.addTrack(t, out!);
  pc.onicecandidate = (e) => {
    if (e.candidate) signal(id, { ice: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    audio.srcObject = stream;
    // Normally allowed (we joined with a click and hold the microphone). If not, the next click anywhere starts it.
    audio.play().catch(() => document.addEventListener('pointerdown', () => void audio.play().catch(() => {}), { once: true }));
    meter(id, stream);
  };
  pc.onconnectionstatechange = () => {
    if (peers.get(id) !== peer) return;
    link(id, pc.connectionState === 'connected' ? 'on' : pc.connectionState === 'failed' ? 'failed' : 'connecting');
    // A path that died (a network change) is tried again by the side that offers.
    const me = myId();
    if (pc.connectionState === 'failed' && me !== undefined && me < id) void offer(id, peer, true);
  };
  link(id, 'connecting');
  return peer;
}

function closePeer(id: number): void {
  const peer = peers.get(id);
  if (!peer) return;
  peers.delete(id);
  peer.pc.onicecandidate = peer.pc.ontrack = peer.pc.onconnectionstatechange = null;
  peer.pc.close();
  peer.audio.pause();
  peer.audio.srcObject = null;
  link(id, null);
  meters.get(id)?.source.disconnect();
  meters.delete(id);
}

async function offer(id: number, peer: Peer, iceRestart = false): Promise<void> {
  try {
    await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart }));
    if (peers.get(id) === peer && peer.pc.localDescription) signal(id, { sdp: peer.pc.localDescription.toJSON() });
  } catch {
    // the connection was closed meanwhile
  }
}

function signal(to: number, what: Signal): void {
  post({ t: 'signal', to, data: JSON.stringify(what) });
}

/** Signalling from id `from` (the server vouches for the id). */
export async function onSignal(from: number, data: string): Promise<void> {
  if (state.status !== 'on') return;
  try {
    const what = JSON.parse(data) as Partial<{ sdp: RTCSessionDescriptionInit; ice: RTCIceCandidateInit }>;
    const peer = peers.get(from) ?? open(from);
    const { pc } = peer;
    if (what.sdp) {
      await pc.setRemoteDescription(what.sdp);
      for (const c of peer.queued.splice(0)) await pc.addIceCandidate(c);
      if (what.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        if (peers.get(from) === peer && pc.localDescription) signal(from, { sdp: pc.localDescription.toJSON() });
      }
    } else if (what.ice) {
      if (pc.remoteDescription) await pc.addIceCandidate(what.ice);
      else peer.queued.push(what.ice);
    }
  } catch {
    // malformed, or for a connection that has been closed since
  }
}

// ---------------------------------------------------------------- who is speaking

function meter(id: number, stream: MediaStream): void {
  if (!ctx) return;
  meters.get(id)?.source.disconnect();
  const node = ctx.createAnalyser();
  node.fftSize = 512;
  const source = ctx.createMediaStreamSource(stream);
  source.connect(node); // not to the speakers: the audio elements do the playing
  meters.set(id, { node, source });
}

const samples = new Float32Array(512);
/** The rms of what an analyser (of 512) has just heard. */
function rms(node: AnalyserNode): number {
  node.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

function measure(): void {
  const speaking: number[] = [];
  for (const [id, { node }] of meters) if (rms(node) > SPEAKING_LEVEL) speaking.push(id);
  speaking.sort((a, b) => a - b);
  if (speaking.join() !== state.speaking.join()) set({ speaking });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useVoice = (): VoiceState => useSyncExternalStore(subscribe, () => state);
