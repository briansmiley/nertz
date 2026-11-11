// Voice chat: an audio-only WebRTC mesh between the players who pressed
// "Join voice". Every pair has one RTCPeerConnection; offers, answers and ICE
// candidates travel through the game's websocket ({ t: 'signal' }) and the
// server only forwards them. Who is in voice comes from the server
// ({ t: 'social' }, see social.ts), and `sync` makes the connections match it.
//
// Of two players the one in the lower seat always makes the offer, so two
// offers can never cross.
import { useSyncExternalStore } from 'react';
import type { VoiceMember } from '../shared/chat';
import { current, post } from './net';

/**
 * STUN only: enough when at least one side of a pair can be reached directly,
 * which covers most home networks. Two players who are both behind strict
 * (symmetric) NATs or firewalls, as on some company, campus and mobile
 * networks, will not hear each other without a relay. A TURN server goes
 * here: { urls: 'turn:host:3478', username, credential }.
 */
export const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/** One signalling message is sent in pieces this long, so that a frame stays under the server's 2 KB cap even when escaped. */
const PIECE = 800;
const SPEAKING_LEVEL = 0.02;
const METER_MS = 120;

export interface VoiceState {
  /** 'asking' while the browser is asking for the microphone. */
  status: 'off' | 'asking' | 'on';
  muted: boolean;
  error: string | null;
  /** Seats making sound right now (this one included). */
  speaking: readonly number[];
}

interface Peer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  /** Candidates that arrived before the description they belong to. */
  queued: RTCIceCandidateInit[];
}

type Signal = { sdp: RTCSessionDescriptionInit } | { ice: RTCIceCandidateInit };

let state: VoiceState = { status: 'off', muted: false, error: null, speaking: [] };
const listeners = new Set<() => void>();
let mic: MediaStream | null = null;
let ctx: AudioContext | null = null;
let meterTimer: ReturnType<typeof setInterval> | undefined;
const peers = new Map<number, Peer>();
const meters = new Map<number, { node: AnalyserNode; source: MediaStreamAudioSourceNode }>();
/** Pieces of a signalling message received so far, per sender. */
const partial = new Map<number, string>();
/** Counts presses of Join, so an answer to an earlier microphone request is recognised as stale. */
let asks = 0;

function set(next: Partial<VoiceState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/** Read afresh: it changes while a function is waiting. */
const status = (): VoiceState['status'] => state.status;
const mySeat = (): number | undefined => current().room?.you;

// ---------------------------------------------------------------- the microphone

/** Asks for the microphone (only now) and joins the table's voice chat. Call from a click. */
export async function joinVoice(): Promise<void> {
  if (state.status !== 'off') return;
  set({ status: 'asking', error: null });
  const ask = ++asks;
  // Made inside the click, so the browser lets it (and the audio elements later) play.
  const made = new AudioContext();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    void made.close();
    if (ask === asks && status() === 'asking') set({ status: 'off', error: 'No microphone: check the browser permission.' });
    return;
  }
  if (ask !== asks || status() !== 'asking') {
    // Left the table, or voice was switched off, while the browser was asking.
    for (const t of stream.getTracks()) t.stop();
    void made.close();
    return;
  }
  mic = stream;
  ctx = made;
  void ctx.resume();
  for (const t of mic.getAudioTracks()) t.enabled = !state.muted;
  const seat = mySeat();
  if (seat !== undefined) meter(seat, mic);
  meterTimer = setInterval(measure, METER_MS);
  set({ status: 'on' });
  post({ t: 'voice', on: true, muted: state.muted });
}

/** Out of voice: every connection closed and the microphone released. `tell` is false when the server already knows. */
export function leaveVoice(tell = true): void {
  if (state.status === 'off') return;
  hangUp();
  for (const t of mic?.getTracks() ?? []) t.stop();
  mic = null;
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

// ---------------------------------------------------------------- the mesh

/** The websocket dropped: the connections are closed, the microphone is kept, and `sync` rejoins when we are back. */
export function hangUp(): void {
  for (const seat of [...peers.keys()]) closePeer(seat);
  partial.clear();
}

/** The server said who is in voice: connect to whoever is new, drop whoever has gone. */
export function sync(members: readonly VoiceMember[]): void {
  const me = mySeat();
  if (state.status !== 'on' || me === undefined) return;
  if (!members.some((m) => m.seat === me)) {
    // The server does not have us (this is a new socket after a reconnect): start over and say so.
    hangUp();
    post({ t: 'voice', on: true, muted: state.muted });
    return;
  }
  for (const seat of [...peers.keys()]) if (!members.some((m) => m.seat === seat)) closePeer(seat);
  for (const { seat } of members) {
    if (seat === me || peers.has(seat)) continue;
    const peer = open(seat);
    if (me < seat) void offer(seat, peer);
  }
}

function open(seat: number): Peer {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const audio = new Audio();
  audio.autoplay = true;
  const peer: Peer = { pc, audio, queued: [] };
  peers.set(seat, peer);
  for (const t of mic?.getAudioTracks() ?? []) pc.addTrack(t, mic!);
  pc.onicecandidate = (e) => {
    if (e.candidate) signal(seat, { ice: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    audio.srcObject = stream;
    // Normally allowed (we joined with a click and hold the microphone). If not, the next click anywhere starts it.
    audio.play().catch(() => document.addEventListener('pointerdown', () => void audio.play().catch(() => {}), { once: true }));
    meter(seat, stream);
  };
  pc.onconnectionstatechange = () => {
    // A path that died (a network change) is tried again by the side that offers.
    const me = mySeat();
    if (pc.connectionState === 'failed' && peers.get(seat) === peer && me !== undefined && me < seat) void offer(seat, peer, true);
  };
  return peer;
}

function closePeer(seat: number): void {
  const peer = peers.get(seat);
  if (!peer) return;
  peers.delete(seat);
  peer.pc.onicecandidate = peer.pc.ontrack = peer.pc.onconnectionstatechange = null;
  peer.pc.close();
  peer.audio.pause();
  peer.audio.srcObject = null;
  meters.get(seat)?.source.disconnect();
  meters.delete(seat);
}

async function offer(seat: number, peer: Peer, iceRestart = false): Promise<void> {
  try {
    await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart }));
    if (peers.get(seat) === peer && peer.pc.localDescription) signal(seat, { sdp: peer.pc.localDescription.toJSON() });
  } catch {
    // the connection was closed meanwhile
  }
}

function signal(to: number, what: Signal): void {
  const text = JSON.stringify(what);
  // '+' means more pieces follow, '.' ends the message. One socket keeps them in order.
  for (let i = 0; i < text.length; i += PIECE) post({ t: 'signal', to, data: (i + PIECE < text.length ? '+' : '.') + text.slice(i, i + PIECE) });
}

/** A piece of signalling from seat `from` (the server vouches for the seat). */
export async function onSignal(from: number, data: string): Promise<void> {
  const text = (partial.get(from) ?? '') + data.slice(1);
  if (data[0] === '+') return void partial.set(from, text.length > 64_000 ? '' : text);
  partial.delete(from);
  if (state.status !== 'on') return;
  try {
    const what = JSON.parse(text) as Partial<{ sdp: RTCSessionDescriptionInit; ice: RTCIceCandidateInit }>;
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

function meter(seat: number, stream: MediaStream): void {
  if (!ctx) return;
  meters.get(seat)?.source.disconnect();
  const node = ctx.createAnalyser();
  node.fftSize = 512;
  const source = ctx.createMediaStreamSource(stream);
  source.connect(node); // not to the speakers: the audio elements do the playing
  meters.set(seat, { node, source });
}

function measure(): void {
  const speaking: number[] = [];
  const samples = new Float32Array(512);
  for (const [seat, { node }] of meters) {
    node.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    if (Math.sqrt(sum / samples.length) > SPEAKING_LEVEL) speaking.push(seat);
  }
  speaking.sort((a, b) => a - b);
  if (speaking.join() !== state.speaking.join()) set({ speaking });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useVoice = (): VoiceState => useSyncExternalStore(subscribe, () => state);
