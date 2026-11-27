// A frame-rate log: what a window recorded of how smoothly it drew, and what was happening meanwhile, while the
// readout was on (`?fps`, client/perf.ts). Sent to the server, which keeps the last few (server/perflog.ts), for
// whoever is measuring a build on a real device to read back.

/** Where logs are posted, listed and read: `POST`, `GET`, and `GET <path>/<id>`. */
export const PERF_LOGS_PATH = '/perf-logs';
/** At most this much in one log (about ten minutes of frames, and the 30-odd messages a second that go with them at a busy table). */
export const PERF_LOG_MAX_BYTES = 3 << 20;

/**
 * Something that happened, at `t` ms from the log's start:
 * - `msg`: a message from the server, of type `type`, `bytes` long, that took `ms` to handle (what ran at once; a render React put off is in the frames, not here).
 * - `status`: the round's status became `at` (`lobby` at no round).
 * - `cards`: how many cards are on the table (sampled every quarter second, and only when it changes).
 * - `long`: a task of `ms` that held the main thread (where the browser tells of them).
 * - `hidden` / `shown`: the page went out of sight, or came back. Frames while it is out of sight are not counted.
 */
export type PerfEvent =
  | { t: number; k: 'msg'; type: string; bytes: number; ms: number }
  | { t: number; k: 'status'; at: string }
  | { t: number; k: 'cards'; n: number }
  | { t: number; k: 'long'; ms: number }
  | { t: number; k: 'hidden' }
  | { t: number; k: 'shown' };

export interface PerfLog {
  /** The address it was played at: which preview, or staging, or production, so a log says which version it measured. */
  host: string;
  /** The device, as the browser gives it. */
  device: { ua: string; dpr: number; w: number; h: number; cores: number | null };
  /** When the log began (ms since 1970), and how long it covers. */
  at: number;
  ms: number;
  /** Each frame: when it began, ms from the log's start, to a tenth. A frame's length is the gap to the next. */
  frames: number[];
  events: PerfEvent[];
  /** As the readout last showed it: the average frame rate, and the lowest in any one second. */
  summary: { fps: number; low: number; frames: number };
}
