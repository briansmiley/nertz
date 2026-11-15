// Voice signalling is one message per offer, answer or ICE candidate: what the parser lets through at the frame limit,
// what it still refuses, and a whole offer relayed over real sockets.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { CHAT_MAX_LENGTH, SIGNAL_MAX_LENGTH } from '../shared/chat';
import { MAX_MESSAGE_BYTES, parseClientMsg, type ServerMsg } from '../shared/protocol';
import { startServer, type NertzServer } from './index';

const candidate = (i: number, type: 'host' | 'srflx' | 'relay', proto: 'udp' | 'tcp'): string =>
  `candidate:${1467250027 + i} 1 ${proto} ${2122260223 - i * 1000} ${type === 'host' ? `4a9c2f1e-8b7d-4e3a-9f6c-1d2e3b4a5c${10 + i}.local` : `203.0.113.${i}`} ${54321 + i} typ ${type}` +
  (type === 'host' ? '' : ` raddr 0.0.0.0 rport 0`) + (proto === 'tcp' ? ' tcptype passive' : '') + ` generation 0 ufrag Xk3d network-id ${1 + (i % 3)} network-cost 10`;
const CANDIDATES = [
  ...[0, 1, 2].flatMap((i) => [candidate(i, 'host', 'udp'), candidate(i + 3, 'host', 'tcp')]),
  ...[6, 7, 8].map((i) => candidate(i, 'srflx', 'udp')),
  ...[9, 10, 11].map((i) => candidate(i, 'relay', 'udp')),
];
/** About what Chrome offers for one microphone after an ICE restart, so with a dozen candidates (a TURN relay's among them) in it. */
const SDP = [
  'v=0', 'o=- 4611731400430051336 3 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=extmap-allow-mixed',
  'a=msid-semantic: WMS 3c4e5e7a-1f2b-4c9d-9a8e-0b1c2d3e4f50', 'm=audio 54321 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126', 'c=IN IP4 203.0.113.6',
  'a=rtcp:9 IN IP4 0.0.0.0', ...CANDIDATES.map((c) => `a=${c}`), 'a=ice-ufrag:Xk3d', 'a=ice-pwd:9Fq0vZ1pLr8mWbN2sT4yUe6c', 'a=ice-options:trickle',
  'a=fingerprint:sha-256 6B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08', 'a=setup:actpass', 'a=mid:0',
  'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level', 'a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
  'a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01', 'a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid', 'a=sendrecv',
  'a=msid:3c4e5e7a-1f2b-4c9d-9a8e-0b1c2d3e4f50 9d8c7b6a-5f4e-3d2c-1b0a-f9e8d7c6b5a4', 'a=rtcp-mux', 'a=rtcp-rsize', 'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc', 'a=fmtp:111 minptime=10;useinbandfec=1', 'a=rtpmap:63 red/48000/2', 'a=fmtp:63 111/111', 'a=rtpmap:9 G722/8000',
  'a=rtpmap:0 PCMU/8000', 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:13 CN/8000', 'a=rtpmap:110 telephone-event/48000', 'a=rtpmap:126 telephone-event/8000',
  'a=ssrc:1234567890 cname:abcdEFGHijklMNOP', 'a=ssrc:1234567890 msid:3c4e5e7a-1f2b-4c9d-9a8e-0b1c2d3e4f50 9d8c7b6a-5f4e-3d2c-1b0a-f9e8d7c6b5a4',
].map((l) => `${l}\r\n`).join(''); // prettier-ignore
const OFFER = JSON.stringify({ sdp: { type: 'offer', sdp: SDP } });
const ICE = JSON.stringify({ ice: { candidate: CANDIDATES[9], sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'Xk3d' } });

describe('signalling validation', () => {
  it('takes an offer or a candidate in one message, with room to spare', () => {
    for (const data of [OFFER, ICE]) expect(parseClientMsg(JSON.stringify({ t: 'signal', to: 1, data }))).toEqual({ t: 'signal', to: 1, data });
    expect(OFFER.length).toBeLessThan(SIGNAL_MAX_LENGTH / 2);
  });

  it('takes the longest signal however it escapes, and refuses a longer one', () => {
    const longest = JSON.stringify({ t: 'signal', to: 2 ** 40, data: '"'.repeat(SIGNAL_MAX_LENGTH) });
    expect(Buffer.byteLength(longest)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(parseClientMsg(longest)).not.toBeNull();
    expect(parseClientMsg(JSON.stringify({ t: 'signal', to: 1, data: 'x'.repeat(SIGNAL_MAX_LENGTH + 1) }))).toBeNull();
  });

  it('holds every other message to its own bounds, not the frame', () => {
    const token = 'tok-abcdefgh';
    const big = 'x'.repeat(10_000);
    const refused: unknown[] = [
      { t: 'create', name: 'x'.repeat(201), token }, { t: 'create', name: 'Ann', token: 'a'.repeat(65) },
      { t: 'join', room: big, name: 'Ann', token },
      { t: 'botName', seat: 0, name: 'x'.repeat(201) }, { t: 'botBack', seat: 0, lot: big }, { t: 'deck', deck: big },
      { t: 'settings', patch: { stockDeal: big } },
      { t: 'intent', seq: 0, intent: { k: 'hold', cardId: 'c'.repeat(65) } },
      { t: 'intent', seq: 0, intent: { k: 'move', cardId: 'c'.repeat(65), count: 1, to: { k: 'work', i: 0 } } },
      { t: 'drag', id: 'c'.repeat(65), w: 0, h: [0, 0], p: [0, 0] },
    ]; // prettier-ignore
    for (const msg of refused) {
      const raw = JSON.stringify(msg);
      expect(raw.length).toBeLessThan(MAX_MESSAGE_BYTES);
      expect(parseClientMsg(raw), raw.slice(0, 60)).toBeNull();
    }
    // What is kept is bounded too: long text is cut, unknown fields are dropped.
    expect(parseClientMsg(JSON.stringify({ t: 'chat', text: big }))).toEqual({ t: 'chat', text: 'x'.repeat(CHAT_MAX_LENGTH) });
    expect(parseClientMsg(JSON.stringify({ t: 'start', pad: big }))).toEqual({ t: 'start' });
    expect(parseClientMsg(JSON.stringify({ t: 'start', pad: 'x'.repeat(MAX_MESSAGE_BYTES) }))).toBeNull();
  });
});

/** A socket at a table (`room` null opens one), in voice, recording the signalling it is sent and any errors. */
async function inVoice(port: number, room: string | null, name: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const got = { me: -1, code: '', voice: 0, signals: [] as ServerMsg[], errors: [] as ServerMsg[] };
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as ServerMsg;
    if (msg.t === 'state') Object.assign(got, { me: msg.room.me, code: msg.room.code });
    if (msg.t === 'social') got.voice = msg.inVoice.length;
    if (msg.t === 'signal') got.signals.push(msg);
    if (msg.t === 'error') got.errors.push(msg);
  });
  await new Promise((ok, fail) => ws.once('open', ok).once('error', fail));
  const token = randomUUID();
  ws.send(JSON.stringify(room === null ? { t: 'create', name, token } : { t: 'join', room, name, token }));
  await vi.waitFor(() => expect(got.me).toBeGreaterThanOrEqual(0));
  ws.send(JSON.stringify({ t: 'voice', on: true, muted: false }));
  return { ws, got };
}

describe('signalling over real sockets', () => {
  let server: NertzServer | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await server?.close();
    server = undefined;
  });

  it('relays a whole offer, and the longest signal there can be, to the other side in one message each', async () => {
    server = await startServer({ port: 0, dist: '/nonexistent' });
    const a = await inVoice(server.port, null, 'Ann');
    const b = await inVoice(server.port, a.got.code, 'Bob');
    sockets.push(a.ws, b.ws);
    await vi.waitFor(() => expect([a.got.voice, b.got.voice]).toEqual([2, 2]));

    // The last is a piece as a page loaded before this server was put up sends it: forwarded as it is, and the new page drops it.
    const sent = [OFFER, ICE, '"'.repeat(SIGNAL_MAX_LENGTH), '+{"sdp":{"type":"offer","sdp":"v=0'];
    for (const data of sent) a.ws.send(JSON.stringify({ t: 'signal', to: b.got.me, data }));
    await vi.waitFor(() => expect(b.got.signals).toHaveLength(sent.length));
    expect(b.got.signals).toEqual(sent.map((data) => ({ t: 'signal', from: a.got.me, data })));
    expect(a.got.errors).toEqual([]);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });
});
