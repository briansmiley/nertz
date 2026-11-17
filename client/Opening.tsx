// The opening of a round, after the deal (GameState.status): the dealer's Start
// button while the table waits, "1, 2, 3" while the server counts, and the word
// as play opens. It decides nothing: the button sends `go`, the numbers are
// read off `timerMs`, and the word appears when the snapshot that opens play does.
import { useEffect, useRef, useState } from 'react';
import { START_BEAT_MS, START_BEATS, START_MS } from '../shared/protocol';
import type { PlayerView, RoomView } from '../shared/types';
import { backColour } from './cards/Face';
import { go, ready } from './net';

/** How long the word stays up once play is open. It lets every click through. */
const WORD_MS = 650;
/** How long a warned Start waits for the second press before it is forgotten. */
const WARN_MS = 5000;

/**
 * Who the dealer is waiting on: everyone dealt in (bots count as ready, the server says so in `ready`) who has not
 * said they are ready, and is here to (someone away cannot answer, so is not waited on). The one place that says whether everyone is, for the button and for the list under it.
 */
export const notReady = (room: RoomView): PlayerView[] => {
  const game = room.game;
  if (game?.status.at !== 'ready') return [];
  return room.players.filter((p) => !p.isHost && p.connected && !p.ready && game.players.some((g) => g.seat === p.seat));
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

/** `at` is the middle of the table (the centre of the felt), in the table's own coordinates. */
export function Opening({ room, at }: { room: RoomView; at: { x: number; y: number } }) {
  const stage = room.game?.status.at;
  const dealer = room.players.find((p) => p.isHost);
  const mine = stage === 'ready' && dealer?.id === room.me;
  /** Who was dealt in, and which of them have said they are ready. */
  const dealt = stage === 'ready' ? room.players.filter((p) => room.game!.players.some((g) => g.seat === p.seat)) : [];
  const me = dealt.find((p) => p.id === room.me);
  const waiting = dealt.filter((p) => !p.isHost);
  const late = notReady(room);
  const lateKey = late.map((p) => p.id).join();
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

  // Start goes at once when everyone is ready. If not, the first press only shows who is not (`warned`), and the
  // next one goes ahead: never a block. It lapses after a while, and whenever the ones not ready change.
  const [warned, setWarned] = useState(false);
  useEffect(() => {
    setWarned(false);
  }, [lateKey]);
  useEffect(() => {
    if (!warned) return;
    const lapse = setTimeout(() => setWarned(false), WARN_MS);
    return () => clearTimeout(lapse);
  }, [warned]);
  const press = () => (late.length > 0 && !warned ? setWarned(true) : go());

  // Space or Enter is the dealer's Start. (A focused button or the chat box keeps its own keys.)
  useEffect(() => {
    if (!mine) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.code !== 'Space' && e.code !== 'Enter') || e.repeat || (e.target as Element).closest?.('input,textarea,button')) return;
      e.preventDefault();
      press();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const inner =
    stage === 'ready' ? (
      <>
        {mine ? (
          <button type="button" className={`kickoff${warned ? ' warned' : ''}`} onClick={press}>
            {warned ? 'Start anyway' : 'Start'}
          </button>
        ) : me ? (
          <button type="button" className={`kickoff readyup${me.ready ? ' on' : ''}`} aria-pressed={!!me.ready} onClick={(e) => (ready(!me.ready), e.currentTarget.blur())}>
            {me.ready ? 'Ready ✓' : 'Ready?'}
            <small>{me.ready ? `Waiting for ${dealer?.name ?? 'the dealer'} to start` : 'Press when you are set'}</small>
          </button>
        ) : (
          <p className="waiting">Waiting for {dealer?.name ?? 'the dealer'} to start</p>
        )}
        {/* Everyone who waits on the dealer: colour and name, three dots until they have said ready, then a tick. Under them, how many have. */}
        {waiting.length > 0 && (
          <>
            <ul className="readies" aria-label="Who is ready">
              {waiting.map((p) => (
                <li key={p.id} className={p.ready ? 'on' : warned && p.connected ? 'late' : ''} aria-label={`${p.name}: ${p.ready ? 'ready' : 'not ready yet'}`}>
                  <i style={{ background: backColour(p.seat ?? 0) }} />
                  {p.name}
                  {p.ready ? (
                    <b className="tick">✓</b>
                  ) : (
                    <span className="dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className={`tally${warned ? ' late' : ''}`}>
              {waiting.filter((p) => p.ready).length}/{waiting.length}
            </p>
          </>
        )}
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
