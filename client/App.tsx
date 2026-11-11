// Screens around the table: home, lobby, round results.
import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { BOT_LEVELS, cleanName, isRoomCode, MAX_NAME_LENGTH, MAX_PLAYERS, MIN_PLAYERS, ROOM_CODE_LENGTH } from '../shared/protocol';
import type { BotLevel, RoomView } from '../shared/types';
import { backColour, BACKS, Face } from './cards/Face';
import { addBot, create, join, leave, removeBot, start, useNet } from './net';
import { Corner, TableRules } from './Settings';
import { useSounds } from './sound';
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

/** Sit down at table `room`, or with null ask the server to open a new one (it picks the code). */
function enter(room: string | null, name: string): void {
  write('localStorage', name);
  write('sessionStorage', name);
  if (room) join(room, name);
  else create(name);
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
  // The address always names the table we are at, so it can be shared and survives a reload.
  const code = room?.code;
  useEffect(() => {
    if (code) history.replaceState(null, '', `/?room=${code}`);
  }, [code]);
  useSounds(room, net.status === 'online');
  if (!room) {
    return (
      <>
        <Home error={net.error} busy={net.status !== 'idle'} />
        <Corner />
      </>
    );
  }
  return (
    <>
      <Corner />
      {room.game && room.phase !== 'lobby' && <Table room={room} sheet={<Results room={room} />} />}
      {room.phase === 'lobby' && <Lobby room={room} />}
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

/** For whoever deals, between rounds: seat a bot to play against, or send one away. */
function Bots({ room }: { room: RoomView }) {
  const [level, setLevel] = useState<BotLevel>('medium');
  const bots = room.players.filter((p) => p.bot);
  return (
    <div className="bots">
      <select value={level} onChange={(e) => setLevel(e.target.value as BotLevel)} aria-label="Bot speed">
        {BOT_LEVELS.map((l) => (
          <option key={l} value={l}>
            {l} bot
          </option>
        ))}
      </select>
      <button type="button" className="plain" disabled={room.players.length >= MAX_PLAYERS} onClick={() => addBot(level)}>
        Add bot
      </button>
      {bots.map((p) => (
        <button key={p.seat} type="button" className="quiet" onClick={() => removeBot(p.seat)}>
          Remove {p.name}
        </button>
      ))}
    </div>
  );
}

function Home({ error, busy }: { error: string | null; busy: boolean }) {
  const invited = roomInUrl();
  const [name, setName] = useState(() => read('localStorage'));
  const [code, setCode] = useState(invited);
  const clean = cleanName(name);
  const typed = code.trim().toUpperCase();
  const ready = !!clean && !busy;

  // Enter in the form does the obvious thing: join if a code is filled in, otherwise start a table.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    if (!typed) enter(null, clean);
    else if (isRoomCode(typed)) enter(typed, clean);
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
      </div>

      <Pad>
        <form onSubmit={submit}>
          <h2>Pull up a chair</h2>
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
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="ways">
            <div className="way">
              <label htmlFor="code">Join a table with its code</label>
              <div className="pair">
                <input
                  id="code"
                  className="code"
                  value={code}
                  maxLength={ROOM_CODE_LENGTH}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="ABCD"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="button" className={typed ? 'go' : 'plain'} disabled={!ready || !isRoomCode(typed)} onClick={() => enter(typed, clean)}>
                  {busy && typed ? 'Connecting…' : 'Join table'}
                </button>
              </div>
              {typed && !isRoomCode(typed) && <p className="hint">A table code is {ROOM_CODE_LENGTH} letters.</p>}
            </div>
            <button type="button" className={typed ? 'plain' : 'go'} disabled={!ready} onClick={() => enter(null, clean)}>
              {busy && !typed ? 'Connecting…' : 'Start a new table'}
            </button>
          </div>
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
              <span className="note">{[p.seat === room.you && 'you', p.isHost && 'deals', !p.connected && 'away', p.bot && `bot, ${p.bot}`].filter(Boolean).join(', ')}</span>
            </li>
          ))}
        </ul>
        <TableRules room={room} />
        {me?.isHost ? (
          <button className="go" disabled={!ready} onClick={start}>
            {ready ? 'Deal the first round' : 'Waiting for a second player'}
          </button>
        ) : (
          <p className="wait">Waiting for {host?.name ?? 'the host'} to deal.</p>
        )}
        {me?.isHost && <Bots room={room} />}
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
  // The sheet goes by the round's own lines (name and total included), so it stays right when someone has left since.
  const rows = [...(round?.scores ?? [])].sort((a, b) => b.total - a.total || b.delta - a.delta);
  const caller = rows.find((s) => s.seat === round?.calledBy);
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
            {rows.map((s) => (
              <tr key={s.seat} className={s.seat === room.you ? 'you' : ''}>
                <th scope="row">
                  <i className="chip" style={{ background: backColour(s.seat) }} />
                  {s.name}
                </th>
                <td>{signed(s.played)}</td>
                <td>{s.nertzLeft ? `${s.nertzLeft} left, ${signed(-2 * s.nertzLeft)}` : 'out'}</td>
                <td>{signed(s.delta)}</td>
                <td className="total">{s.total < 0 ? `−${-s.total}` : s.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <TableRules room={room} />
        {me?.isHost ? (
          <button className="go" disabled={!enoughToDeal(room)} onClick={start}>
            {enoughToDeal(room) ? 'Deal the next round' : 'Waiting for a second player'}
          </button>
        ) : (
          <p className="wait">Waiting for {host?.name ?? 'the host'} to deal the next round.</p>
        )}
        {me?.isHost && <Bots room={room} />}
        <button type="button" className="quiet" onClick={exit}>
          Leave table
        </button>
      </Pad>
    </main>
  );
}
