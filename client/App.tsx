// Screens around the table: home, lobby, round results.
import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { cleanName, isRoomCode, MAX_NAME_LENGTH, MIN_PLAYERS, randomRoomCode, ROOM_CODE_LENGTH } from '../shared/protocol';
import type { RoomView } from '../shared/types';
import { backColour, BACKS, Face } from './cards/Face';
import { join, leave, start, useNet } from './net';
import { Table } from './Table';

// The name is remembered across visits (localStorage) only to pre-fill the
// form. What makes a reload rejoin by itself is the per-window copy
// (sessionStorage), so a second window still gets to pick its own name.
const NAME_KEY = 'nertz.name';
const read = (store: 'localStorage' | 'sessionStorage'): string => {
  try {
    return cleanName(window[store].getItem(NAME_KEY) ?? '');
  } catch {
    return '';
  }
};
const write = (store: 'localStorage' | 'sessionStorage', name: string | null): void => {
  try {
    if (name === null) window[store].removeItem(NAME_KEY);
    else window[store].setItem(NAME_KEY, name);
  } catch {
    // storage unavailable: the name just is not remembered
  }
};

function roomInUrl(): string {
  const code = (new URLSearchParams(location.search).get('room') ?? '').trim().toUpperCase();
  return isRoomCode(code) ? code : '';
}

function enter(room: string, name: string): void {
  write('localStorage', name);
  write('sessionStorage', name);
  history.replaceState(null, '', `/?room=${room}`);
  join(room, name);
}

function exit(): void {
  write('sessionStorage', null);
  history.replaceState(null, '', '/');
  leave();
}

/** On page load: if this window was already seated at the table in the URL, sit back down. */
export function resume(): void {
  const room = roomInUrl();
  const name = read('sessionStorage');
  if (room && name) join(room, name);
}

export function App() {
  const net = useNet();
  const room = net.room;
  if (!room) return <Home error={net.error} busy={net.status !== 'idle'} />;
  return (
    <>
      {room.game && room.phase !== 'lobby' && <Table room={room} frozen={room.phase === 'results'} />}
      {room.phase === 'lobby' && <Lobby room={room} />}
      {room.phase === 'results' && <Results room={room} />}
      {net.status === 'reconnecting' ? (
        <p className="banner">Connection lost. Reconnecting…</p>
      ) : (
        room.phase === 'playing' &&
        !room.game?.players.some((p) => p.seat === room.you) && <p className="banner low">You were away when this round was dealt. You are in for the next one.</p>
      )}
    </>
  );
}

/** The server deals only to players who are connected, and needs two of them. */
const enoughToDeal = (room: RoomView): boolean => room.players.filter((p) => p.connected).length >= MIN_PLAYERS;

function Pad({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <section className={`pad${wide ? ' wide' : ''}`}>{children}</section>;
}

/** A small card, used as decoration and as each player's colour swatch. */
function Mini({ seat, suit, rank, style }: { seat?: number; suit?: 'S' | 'H' | 'D' | 'C'; rank?: number; style?: CSSProperties }) {
  return (
    <span className="mini" style={style}>
      {suit && rank ? (
        <span className="front">
          <Face suit={suit} rank={rank} mini={false} />
        </span>
      ) : (
        <span className="back" style={{ '--back': backColour(seat ?? 0) } as CSSProperties} />
      )}
    </span>
  );
}

function Home({ error, busy }: { error: string | null; busy: boolean }) {
  const invited = roomInUrl();
  const [name, setName] = useState(() => read('localStorage'));
  const [code, setCode] = useState('');
  const clean = cleanName(name);
  const typed = code.trim().toUpperCase();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!clean || busy) return;
    enter(invited || (isRoomCode(typed) ? typed : randomRoomCode()), clean);
  };

  return (
    <main className="home">
      <div className="hero">
        <div className="spread" aria-hidden="true">
          {BACKS.map((_, seat) => (
            <Mini key={seat} seat={seat} style={{ '--i': seat } as CSSProperties} />
          ))}
          <Mini suit="S" rank={1} style={{ '--i': 6 } as CSSProperties} />
        </div>
        <h1>Nertz!</h1>
        <p>Everybody plays solitaire at the same time, into the same middle. Empty your nertz pile first and shout.</p>
      </div>

      <Pad>
        <form onSubmit={submit}>
          <h2>{invited ? `Join table ${invited}` : 'Pull up a chair'}</h2>
          <label>
            Your name
            <input
              autoFocus
              value={name}
              maxLength={MAX_NAME_LENGTH}
              onChange={(e) => setName(e.target.value)}
              placeholder="What the others will see"
              autoComplete="nickname"
            />
          </label>
          {!invited && (
            <label>
              Table code <small>leave blank to start a new table</small>
              <input
                className="code"
                value={code}
                maxLength={ROOM_CODE_LENGTH}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCD"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          {error && <p className="error">{error}</p>}
          {!invited && typed && !isRoomCode(typed) && <p className="hint">A table code is {ROOM_CODE_LENGTH} letters.</p>}
          <button className="go" disabled={!clean || busy || (!invited && !!typed && !isRoomCode(typed))}>
            {busy ? 'Connecting…' : invited || typed ? 'Join table' : 'Start a new table'}
          </button>
          {invited && (
            <a className="quiet" href="/">
              Start a new table instead
            </a>
          )}
        </form>
      </Pad>
    </main>
  );
}

function Lobby({ room }: { room: RoomView }) {
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}/?room=${room.code}`;
  const me = room.players.find((p) => p.seat === room.you);
  const host = room.players.find((p) => p.isHost);
  const ready = enoughToDeal(room);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked: the link is selectable right there
    }
  };

  return (
    <main className="solo">
      <Pad>
        <h2>
          Table <span className="code">{room.code}</span>
        </h2>
        <p className="lead">Send this link to the people you want to play with.</p>
        <div className="invite">
          <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
          <button type="button" onClick={copy}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
        <ul className="seats">
          {room.players.map((p) => (
            <li key={p.seat} className={p.connected ? '' : 'away'}>
              <Mini seat={p.seat} />
              <span className="name">{p.name}</span>
              <span className="note">{[p.seat === room.you && 'you', p.isHost && 'deals', !p.connected && 'away'].filter(Boolean).join(', ')}</span>
            </li>
          ))}
        </ul>
        {me?.isHost ? (
          <button className="go" disabled={!ready} onClick={start}>
            {ready ? 'Deal the first round' : 'Waiting for a second player'}
          </button>
        ) : (
          <p className="wait">Waiting for {host?.name ?? 'the host'} to deal.</p>
        )}
        <button type="button" className="quiet" onClick={exit}>
          Leave table
        </button>
      </Pad>
    </main>
  );
}

function Results({ room }: { room: RoomView }) {
  const round = room.lastRound;
  const me = room.players.find((p) => p.seat === room.you);
  const host = room.players.find((p) => p.isHost);
  const caller = room.players.find((p) => p.seat === round?.calledBy);
  const rows = (round?.scores ?? [])
    .map((s) => ({ s, p: room.players.find((p) => p.seat === s.seat) }))
    .sort((a, b) => (b.p?.score ?? 0) - (a.p?.score ?? 0) || b.s.delta - a.s.delta);
  const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

  return (
    <main className="solo over">
      <Pad wide>
        <h2>Round {room.round}</h2>
        <p className="lead">{caller ? `${caller.seat === room.you ? 'You' : caller.name} called Nertz.` : 'Round over.'}</p>
        <table className="scores">
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">In the middle</th>
              <th scope="col">Nertz pile</th>
              <th scope="col">Round</th>
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, p }) => (
              <tr key={s.seat} className={s.seat === room.you ? 'you' : ''}>
                <th scope="row">
                  <i className="chip" style={{ background: backColour(s.seat) }} />
                  {p?.name ?? `Seat ${s.seat + 1}`}
                </th>
                <td>{signed(s.foundation)}</td>
                <td>{s.nertzLeft ? `${s.nertzLeft} left, ${signed(-2 * s.nertzLeft)}` : 'out'}</td>
                <td>{signed(s.delta)}</td>
                <td className="total">{p?.score ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {me?.isHost ? (
          <button className="go" disabled={!enoughToDeal(room)} onClick={start}>
            {enoughToDeal(room) ? 'Deal the next round' : 'Waiting for a second player'}
          </button>
        ) : (
          <p className="wait">Waiting for {host?.name ?? 'the host'} to deal the next round.</p>
        )}
        <button type="button" className="quiet" onClick={exit}>
          Leave table
        </button>
      </Pad>
    </main>
  );
}
