// Text chat and voice chat: wire messages, limits and inbound validation.
// Kept apart from protocol.ts (which only adds these to its unions) because
// none of it touches the game: chat is never part of a snapshot.

/** Longest chat message, after cleaning. */
export const CHAT_MAX_LENGTH = 300;
/** Messages a room remembers; older ones are forgotten. */
export const CHAT_HISTORY = 200;
/** A player may send CHAT_RATE_COUNT messages per CHAT_RATE_MS; the excess is dropped quietly. */
export const CHAT_RATE_COUNT = 5;
export const CHAT_RATE_MS = 5000;
/**
 * Longest `data` of one signalling message (an offer, an answer or an ICE
 * candidate, as JSON text), which the server forwards as it is. An audio offer
 * is a few KB. Escaped as badly as JSON can (every character doubled), it
 * still fits one websocket frame (MAX_MESSAGE_BYTES).
 */
export const SIGNAL_MAX_LENGTH = 8000;

/** Is `v` a player's id (`PlayerView.id`), as far as its shape goes? */
export const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Someone, as a line names them: their `PlayerView.id` (its colour is that of the seat they have now, if any), and their name when it was written, so the line stays right after they leave. */
export interface Named {
  who: number;
  name: string;
}

/** Someone and their points for a round, as the score sheet's Round column has them (`RoundScore.delta`). */
export type Scored = Named & { points: number };

/** What a line of the chat is: something someone said, or a notice from the table. */
export type ChatEvent =
  | { k: 'said'; by: Named; text: string }
  /** `by` beat `of` to a pile in the middle. */
  | { k: 'sniped'; by: Named; of: Named }
  /** Round `round` has started: play is open (once a round: not again when it is dealt over and started anew). */
  | { k: 'started'; round: number }
  /**
   * Round `round` is over: called by `end` (with their points), or ended without a call (`RoundResult.ended`). `best`
   * scored the most in it and so won it, all of them if it is a tie; the one who called is not always among them.
   */
  | { k: 'over'; round: number; end: Scored | 'jam' | 'vote'; best: Scored[] }
  /** `by` started the table over: every score back to nothing. */
  | { k: 'reset'; by: Named };

export type ChatLine = ChatEvent & {
  /** Rises by one per line in a room. */
  id: number;
  /** Server clock, ms since the epoch. */
  at: number;
};

/** The host's four switches. All default to on. */
export interface SocialSettings {
  text: boolean;
  voice: boolean;
  /** May those watching a full table (no seat) take part in the text chat, and in voice? */
  watchText: boolean;
  watchVoice: boolean;
}

export interface VoiceMember {
  /** Their `PlayerView.id`. */
  id: number;
  muted: boolean;
}

/** A server that helps two players' voice connections find each other (STUN), or carries the sound between them when they cannot reach each other directly (TURN: with a name and a password). */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type SocialClientMsg =
  | { t: 'chat'; text: string }
  /** Host only: flip one or both switches. */
  | { t: 'social'; text?: boolean; voice?: boolean; watchText?: boolean; watchVoice?: boolean }
  /** Join or leave the table's voice chat, and say whether the microphone is muted. */
  | { t: 'voice'; on: boolean; muted: boolean }
  /** WebRTC signalling for the player `to` (an id); the server forwards it as it is. */
  | { t: 'signal'; to: number; data: string };

export type SocialServerMsg =
  /** New lines, or with `history` everything the room remembers (sent once to a connection when it sits down). */
  | { t: 'chat'; lines: ChatLine[]; history: boolean }
  /** The switches and who is in voice. Sent when a connection sits down and whenever any of it changes. */
  | ({ t: 'social'; inVoice: VoiceMember[]; ice?: IceServer[] } & SocialSettings)
  /** `from` (an id) is stamped by the server. */
  | { t: 'signal'; from: number; data: string };

/** Control characters become spaces; trimmed and capped. May return ''. */
export function cleanChat(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .trim()
    .slice(0, CHAT_MAX_LENGTH)
    .trim();
}

/** Returns a clean copy of a well-formed chat or voice message, or null. `v` is already-parsed JSON. Never throws. */
export function parseSocialMsg(v: Record<string, unknown>): SocialClientMsg | null {
  switch (v.t) {
    case 'chat': {
      if (typeof v.text !== 'string') return null;
      const text = cleanChat(v.text);
      return text ? { t: 'chat', text } : null;
    }
    case 'social': {
      const ok = (x: unknown) => x === undefined || typeof x === 'boolean';
      if (!ok(v.text) || !ok(v.voice) || !ok(v.watchText) || !ok(v.watchVoice) || (v.text === undefined && v.voice === undefined && v.watchText === undefined && v.watchVoice === undefined)) return null;
      return { t: 'social', ...(typeof v.text === 'boolean' && { text: v.text }), ...(typeof v.voice === 'boolean' && { voice: v.voice }), ...(typeof v.watchText === 'boolean' && { watchText: v.watchText }), ...(typeof v.watchVoice === 'boolean' && { watchVoice: v.watchVoice }) };
    }
    case 'voice':
      return typeof v.on === 'boolean' && typeof v.muted === 'boolean' ? { t: 'voice', on: v.on, muted: v.muted } : null;
    case 'signal': {
      const { to, data } = v;
      if (!isId(to)) return null;
      return typeof data === 'string' && data.length > 0 && data.length <= SIGNAL_MAX_LENGTH ? { t: 'signal', to, data } : null;
    }
    default:
      return null;
  }
}
