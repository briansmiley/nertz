// The opening of a round, after the deal (GameState.status): the dealer's Start
// button while the table waits, "1, 2, 3" while the server counts, and the word
// as play opens. It decides nothing: the button sends `go`, the numbers are
// read off `timerMs`, and the word appears when the snapshot that opens play does.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { hasSay, plays } from '../shared/engine';
import { MIN_PLAYERS, START_BEAT_MS, START_BEATS, START_MS } from '../shared/protocol';
import type { PlayerView, RoomView } from '../shared/types';
import { backColour } from './cards/Face';
import { Dots } from './Dots';
import { Unplugged } from './icons';
import { go, ready } from './net';

/** How long the word stays up once play is open. It lets every click through. */
const WORD_MS = 650;
/** How soon after the warning a press is still the same one (a double click, a held key): too soon to have read it. */
const SAME_PRESS_MS = 400;

/** A Start the dealer has pressed while someone was not ready (the warning): when, and the ids of who it still waits on. */
export type Ask = { at: number; on: readonly number[] };

/**
 * What a press of Start does: goes at once when nobody is waited on; else the first one only asks (and warns), and
 * one after it (not the same press again) goes ahead. `ask` is the one showing, or null.
 */
export const pressStart = (late: number, ask: Ask | null, now: number): 'go' | 'ask' | 'same' => (late === 0 ? 'go' : ask === null ? 'ask' : now - ask.at < SAME_PRESS_MS ? 'same' : 'go');

/**
 * What the ones not ready changing does to an ask: once nobody is, it goes, as a press with everyone ready would;
 * while they only get fewer it stands, waiting on those who are left; anyone newly not ready (sat down since, or
 * took their ready back, even one it had waited on) ends it (null): Start is asked afresh.
 */
export const askAfter = (ask: Ask, late: readonly number[]): 'go' | Ask | null =>
  late.length === 0 ? 'go' : late.every((id) => ask.on.includes(id)) ? { at: ask.at, on: late } : null;

/**
 * Who the dealer is waiting on: everyone dealt in (bots count as ready, the server says so in `ready`) who has not
 * said they are ready, and is here to (someone away cannot answer, so is not waited on). The one place that says whether everyone is, for the button and for the list under it.
 */
export const notReady = (room: RoomView): PlayerView[] => {
  const game = room.game;
  if (game?.status.at !== 'ready') return [];
  return room.players.filter((p) => !p.isHost && hasSay(p) && !p.ready && game.players.some((g) => g.seat === p.seat));
};

/**
 * The tally under the names: of those dealt in who wait on the dealer (`waiting`), how many have said ready, out of those
 * here to say it. Someone away is out of both, as `notReady` leaves them out of what Start waits on: the tally is full
 * exactly when Start goes at once.
 */
export const readyCount = (waiting: readonly PlayerView[]): { ready: number; of: number } => {
  const here = waiting.filter(hasSay);
  return { ready: here.filter((p) => p.ready).length, of: here.length };
};

/** The number being said when `startMs` of the count are left: 1, 2, 3. */
export const beatAt = (startMs: number): number => Math.min(START_BEATS, Math.max(1, Math.floor((START_MS - startMs) / START_BEAT_MS) + 1));

/** Counts 1, 2, 3 locally from the duration the snapshot carried. A window that arrives late starts on the right number. */
function useBeat(startMs: number | null): number {
  const [beat, setBeat] = useState(startMs === null ? 0 : beatAt(startMs));
  useEffect(() => {
    if (startMs === null) return setBeat(0);
    const end = performance.now() + startMs; // `startMs` was what remained when the snapshot was sent
    setBeat(beatAt(startMs));
    const tick = setInterval(() => setBeat(beatAt(Math.max(0, end - performance.now()))), 40);
    return () => clearInterval(tick);
  }, [startMs]);
  return beat;
}

/**
 * `at` is the middle of the table (the centre of the felt), in the table's own coordinates. `onSeats`: for whoever deals,
 * to lay the table's sheet over it; absent while it is up (and Start's keys are the sheet's).
 */
export function Opening({ room, at, onSeats }: { room: RoomView; at: { x: number; y: number }; onSeats?: () => void }) {
  const stage = room.game?.status.at;
  const dealer = room.players.find((p) => p.isHost);
  const mine = stage === 'ready' && dealer?.id === room.me;
  /** Who was dealt in, and which of them have said they are ready. */
  const dealt = stage === 'ready' ? room.players.filter((p) => plays(p) && room.game!.players.some((g) => g.seat === p.seat)) : [];
  const me = dealt.find((p) => p.id === room.me);
  const waiting = dealt.filter((p) => !p.isHost);
  const late = notReady(room);
  /** Start is for a round someone will play against someone: not when all but one have got up from the cards dealt (the server's rule: `go`, server/room.ts). */
  const enough = dealt.length >= MIN_PLAYERS;
  const lateKey = late.map((p) => p.id).join();
  const tally = readyCount(waiting);
  const beat = useBeat(stage === 'countdown' ? room.timerMs : null);

  // The word, only in a window that watched the count: a reload into a round that is already on shows nothing.
  const was = useRef(stage);
  const [word, setWord] = useState(false);
  useEffect(() => {
    const from = was.current;
    was.current = stage;
    if (stage !== 'play') return setWord(false);
    if (from !== 'countdown') return;
    setWord(true);
    const done = setTimeout(() => setWord(false), WORD_MS);
    return () => clearTimeout(done);
  }, [stage]);

  // Start goes at once when everyone is ready. If not, the first press only asks (`warned`), and the next one goes
  // ahead: never a block. So does the last of them saying ready; anyone taking a ready back ends it, and so does the
  // dealer's Cancel. Otherwise it stands, for as long as it takes.
  const [ask, setAsk] = useState<Ask | null>(null);
  const warned = ask !== null;
  useEffect(() => {
    if (ask === null) return;
    const next = mine ? askAfter(ask, late.map((p) => p.id)) : null;
    if (next === 'go') go();
    setAsk(next === 'go' ? null : next);
  }, [lateKey, mine]);
  const press = () => {
    if (!enough) return;
    const now = Date.now();
    const does = pressStart(late.length, ask, now);
    if (does === 'go') (go(), setAsk(null));
    else if (does === 'ask') setAsk({ at: now, on: late.map((p) => p.id) });
  };

  // Space or Enter is the dealer's Start. (A focused button or the chat box keeps its own keys.)
  useEffect(() => {
    if (!mine || !onSeats) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.code !== 'Space' && e.code !== 'Enter') || e.repeat || (e.target as Element).closest?.('input,textarea,button,[role=button]')) return;
      e.preventDefault();
      press();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const inner =
    stage === 'ready' ? (
      <>
        {mine && !enough ? null : mine ? (
          <>
            {/* How many it waits on (the names say who), and Cancel, which takes the ask back: nothing goes when the rest say
                ready, and the button is plain Start again. Out of the flow, over the button, so nothing moves up into its
                place when it goes (a second tap on Cancel lands on bare felt, not on Start or the names). */}
            {warned && (
              <p className="waitfor">
                <span>
                  Waiting for {late.length} {late.length === 1 ? 'player' : 'players'}
                  <Dots />
                </span>
                <button type="button" className="unask" onClick={() => setAsk(null)}>
                  Cancel
                </button>
              </p>
            )}
            <button type="button" className={`kickoff${warned ? ' warned' : late.length === 0 ? ' all' : ''}`} onClick={press}>
              {warned ? 'Start anyway' : 'Start'}
            </button>
          </>
        ) : me ? (
          <button type="button" className={`kickoff readyup${me.ready ? ' on' : ''}`} aria-pressed={!!me.ready} onClick={(e) => (ready(!me.ready), e.currentTarget.blur())}>
            {me.ready ? 'Ready ✓' : 'Ready?'}
            {me.ready && <small>Waiting for {dealer?.name ?? 'the dealer'} to start</small>}
          </button>
        ) : (
          <p className="waiting">Waiting for {dealer?.name ?? 'the dealer'} to start</p>
        )}
        {/* Everyone who waits on the dealer: colour and name, three dots until they have said ready, then a tick; someone away, a
            plug pulled out (Start does not wait on them). Under them, how many have (`readyCount`).
            The dealer's opens the table's sheet (`onSeats`), the lobby's, to seat and unseat as there; alone, so does the line that says so. */}
        <div className={`roster${mine ? ' dealer' : ''}`} {...(mine && onSeats ? { role: 'button', tabIndex: 0, 'data-tip': 'Seats', onClick: onSeats, onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSeats()) } : {})}>
          {mine && !enough && <p className="waiting">Waiting for a second player</p>}
          {waiting.length > 0 && (
            <>
              <ul className="readies" aria-label="Who is ready">
                {waiting.map((p) => (
                  <li key={p.id} className={!hasSay(p) ? 'away' : p.ready ? 'on' : warned && late.includes(p) ? 'late' : ''} aria-label={`${p.name}: ${!hasSay(p) ? 'away' : p.ready ? 'ready' : 'not ready yet'}`}>
                    <i style={{ background: backColour(p.seat ?? 0) }} />
                    {p.name}
                    {!hasSay(p) ? (
                      <Unplugged />
                    ) : p.ready ? (
                      <b className="tick">✓</b>
                    ) : (
                      <span className="waiting-dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {tally.of > 0 && (
                <p className={`tally${warned ? ' late' : ''}`}>
                  {tally.ready}/{tally.of}
                </p>
              )}
            </>
          )}
        </div>
      </>
    ) : stage === 'countdown' && beat ? (
      <b key={beat} className="beat">
        {START_BEATS + 1 - beat}
      </b>
    ) : word ? (
      <b className="beat word">Nertz!</b>
    ) : null;
  return inner ? (
    <div className="opening" role="status" style={{ left: at.x, top: at.y }}>
      {inner}
    </div>
  ) : null;
}
