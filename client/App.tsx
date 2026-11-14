// Screens around the table: home, lobby, round results.
import { Gallery } from './Gallery';
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { BOT_LEVELS, cleanName, isRoomCode, MAX_NAME_LENGTH, MAX_PLAYERS, MIN_PLAYERS, ROOM_CODE_LENGTH } from '../shared/protocol';
import type { BotLevel, RoomView } from '../shared/types';
import { backColour, backOf, BACKS, Face } from './cards/Face';
import { BackPicker, YourBacks } from './BackPicker';
import { choiceAt, deckOf, setPrefs, usePrefs } from './prefs';
import { backNamed, isBack } from '../shared/protocol';
import { Chat } from './Chat';
import { addBot, botBack, create, join, kick, leave, nameBot, removeBot, resetTable, sit, stand, start, useNet } from './net';
import { Corner, Door, Gear, Pop, Robot, TableRules } from './Settings';
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
  if (!room && new URLSearchParams(location.search).has('decks')) return <Gallery />;
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
      <Corner room={room} />
      {room.game && room.phase !== 'lobby' && <Table room={room} sheet={<Results room={room} />} />}
      {room.phase === 'lobby' && <Lobby room={room} />}
      <Chat room={room} />
      {net.status === 'reconnecting' ? (
        <p className="banner">Connection lost. Reconnecting…</p>
      ) : (
        // Without a seat (the table was full): watching, whatever the table is doing. With one, but come in the middle of a round: watching until the next.
        (room.players.find((p) => p.seat === room.you)?.watching ? (
          <p className="banner low">{room.players.find((p) => p.seat === room.you)?.standing ? 'Spectating - you stood up. Sit down again from the eye, top left' : room.players.filter((p) => !p.watching).length >= MAX_PLAYERS ? 'Spectating - the table is full. You get the first seat that frees up' : 'Spectating - You can join next round'}</p>
        ) : (
          room.phase === 'playing' && !room.game?.players.some((p) => p.seat === room.you) && <p className="banner low">Spectating - You can join next round</p>
        ))
      )}
    </>
  );
}

/** The server deals only to players who are connected, and needs two of them. */
const enoughToDeal = (room: RoomView): boolean => room.players.filter((p) => p.connected && !p.watching).length >= MIN_PLAYERS;

function Pad({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <section className={`pad${wide ? ' wide' : ''}`}>{children}</section>;
}

/** A small card, used as decoration and as each player's colour swatch. */
function Mini({ seat, suit, rank, style, back }: { seat?: number; suit?: 'S' | 'H' | 'D' | 'C'; rank?: number; style?: CSSProperties; back?: string }) {
  const deck = deckOf(usePrefs()); // a card shown for its own sake is one of yours
  return (
    <span className="mini" style={style}>
      {suit && rank ? (
        <span className="front">
          <Face suit={suit} rank={rank} mini={false} deck={deck} />
        </span>
      ) : (
        <span {...backOf(backColour(seat ?? 0), back, true)} />
      )}
    </span>
  );
}

/** For whoever deals, between rounds: a robot button that opens a slip for seating a bot. */
function AddBot({ room }: { room: RoomView }) {
  const [level, setLevel] = useState<BotLevel>('medium');
  const full = room.players.filter((p) => !p.watching).length >= MAX_PLAYERS;
  return (
    <Pop icon={<Robot />} label="Add a bot">
      <h3>Add a bot</h3>
      {full ? (
        <p className="hint">The table is full.</p>
      ) : (
        <div className="bots">
          <select value={level} onChange={(e) => setLevel(e.target.value as BotLevel)} aria-label="Bot speed">
            {BOT_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <button type="button" className="plain" onClick={() => addBot(level)}>
            Add
          </button>
        </div>
      )}
    </Pop>
  );
}

/** A small × beside a bot's name, for whoever deals. */
/** For whoever deals: send a bot away, or (`person`) a person: they are put out of the table, as if they had left. */
function Unseat({ name, seat, person }: { name: string; seat: number; person?: boolean }) {
  return (
    <button type="button" className="unseat" aria-label={`Remove ${name}`} title={person ? `Remove ${name} from the table` : `Remove ${name}`} onClick={() => (person ? kick(seat) : removeBot(seat))}>
      ×
    </button>
  );
}

/** A bot's name, for whoever deals: written over where it stands, and taken when the field is left or Enter is pressed. */
function BotName({ name, seat }: { name: string; seat: number }) {
  return (
    <input
      key={name}
      className="botname"
      aria-label={`Rename ${name}`}
      title="Rename this bot"
      defaultValue={name}
      maxLength={MAX_NAME_LENGTH}
      size={Math.max(4, name.length)}
      spellCheck={false}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') (e.currentTarget.value = name), e.currentTarget.blur();
      }}
      onBlur={(e) => {
        const next = cleanName(e.currentTarget.value);
        if (next && next !== name) nameBot(seat, next);
        else e.currentTarget.value = name;
      }}
    />
  );
}

/** In the lobby, before the first deal: a dot of your colour; pressed, the colours nobody has, to take one. */
function Colour({ room, seat }: { room: RoomView; seat: number }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.code === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  /** Yours (ticked), and every colour nobody has. */
  const free = BACKS.map((c, i) => ({ c, i })).filter(({ i }) => i === seat || !room.players.some((p) => p.seat === i));
  return (
    <span className="colour" ref={root}>
      <button type="button" className="dot" style={{ background: backColour(seat) }} aria-expanded={open} aria-label="Change your colour" title={free.length > 1 ? 'Change your colour' : 'Every other colour is taken'} disabled={free.length < 2} onClick={() => setOpen(!open)} />
      {open && (
        <span className="free" role="radiogroup" aria-label="Your colour, and those nobody has">
          {free.map(({ c, i }) => (
            <button key={c} type="button" role="radio" aria-checked={i === seat} aria-label={i === seat ? `Colour ${i + 1}: yours` : `Colour ${i + 1}`} className={i === seat ? 'mine' : ''} style={{ background: c }} onClick={() => (i === seat || sit(i), setOpen(false))} />
          ))}
        </span>
      )}
    </span>
  );
}

/** Up from the table to watch: your own row, or (whoever deals) someone else's. An eye; the × beside it sends away altogether. */
function StandUp({ name, seat, mine }: { name: string; seat: number; mine: boolean }) {
  const says = mine ? 'Stand up: watch without playing' : `Stand ${name} up: they watch without playing`;
  return (
    <button type="button" className="standup" aria-label={says} title={says} onClick={() => stand(true, mine ? undefined : seat)}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
        <circle cx="12" cy="12" r="2.8" />
      </svg>
    </button>
  );
}

/** Those without a seat (the table is full): who is watching, in the order they will be seated. Whoever deals can send one away. */
function Watching({ room }: { room: RoomView }) {
  const them = room.players.filter((p) => p.watching);
  const host = room.players.find((p) => p.seat === room.you)?.isHost;
  if (!them.length) return null;
  return (
    <p className="watching">
      <small>Watching</small>
      {them.map((p) => (
        <span key={p.seat} className={p.seat === room.you ? 'you' : ''}>
          {p.name}
          {/* Someone who stood up by choice gets no seat until they (or whoever deals) say so. */}
          {p.standing && (p.seat === room.you || host) && (
            <button type="button" className="sit" onClick={() => stand(false, p.seat === room.you ? undefined : p.seat)}>
              {p.seat === room.you ? 'Sit down' : 'Seat'}
            </button>
          )}
          {host && p.seat !== room.you && <Unseat name={p.name} seat={p.seat} person />}
        </span>
      ))}
    </p>
  );
}

function Leave() {
  return (
    <button type="button" className="icon" aria-label="Leave table" title="Leave table" onClick={exit}>
      <Door />
    </button>
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
          {/* (Six, as the fan was drawn: the table seats ten now, the picture does not have to.) */}
          {BACKS.slice(0, 6).map((_, seat) => (
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
            {/* Beside your name, the backs of your cards: a card to press, to choose others. */}
            <span className="named">
              <input
                autoFocus
                value={name}
                maxLength={MAX_NAME_LENGTH}
                onChange={(e) => setName(e.target.value)}
                placeholder="What the others will see"
                autoComplete="nickname"
              />
              <YourBacks colour={BACKS[0]} compact />
            </span>
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
              {busy && !typed ? 'Connecting…' : 'New Table'}
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
  const prefs = usePrefs();
  /** My backs at this table: chosen here, or my usual ones. */
  const chosen = choiceAt(room.code, prefs);
  /** Whose backs are being chosen (the seat), if the sheet of backs is open: your own, or a bot's. */
  const [picking, setPicking] = useState<number | null>(null);
  const picked = room.players.find((p) => p.seat === picking && (p.seat === room.you || (me?.isHost && p.bot)));
  const host = room.players.find((p) => p.isHost);
  const ready = enoughToDeal(room);

  const [codeCopied, setCodeCopied] = useState(false);
  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(room.code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 1500);
    } catch {
      // clipboard blocked: the code is there to read
    }
  };
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
        <div className="tools top">
          {me?.isHost && <AddBot room={room} />}
          <Leave />
        </div>
        <h2>
          Table{' '}
          {/* The code itself is a button: pressed, it is copied (just the code, for saying or typing; the link is below). */}
          <button type="button" className="code copy" aria-label={`Table code ${room.code}: copy it`} title="Copy the code" onClick={copyCode}>
            {room.code}
            {codeCopied && <small>Copied</small>}
          </button>
        </h2>
        <div className="invite">
          <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
          <button type="button" onClick={copy}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
        <ul className="seats">
          {room.players
            .filter((p) => !p.watching)
            .map((p) => (
            <li key={p.seat} className={`${p.connected ? '' : 'away'}${p.seat === room.you ? ' you' : ''}`}>
              {/* The card beside a name is that player's back. Your own, and (if you deal) a bot's, opens the backs to choose another. */}
              {p.seat === room.you || (me?.isHost && p.bot) ? (
                <button type="button" className="swatch" aria-label={p.seat === room.you ? 'Change your card backs' : `Change ${p.name}'s card backs`} title={p.seat === room.you ? (chosen.random ? 'Your card backs: drawn by lot when the round is dealt. Change them' : 'Change your card backs at this table') : `Change ${p.name}'s card backs`} onClick={() => setPicking(p.seat)}>
                  <Mini seat={p.seat} back={p.seat === room.you ? (chosen.random ? 'any' : backNamed(chosen.back, prefs.bare)) : p.back} />
                </button>
              ) : (
                <Mini seat={p.seat} back={p.back} />
              )}
              <span className="name">{me?.isHost && p.bot ? <BotName name={p.name} seat={p.seat} /> : p.name}</span>
              <span className="note">
                {[p.seat === room.you && 'you', !p.connected && 'away'].filter(Boolean).join(', ')}
                {/* A bot: the robot, and how quick it is. */}
                {p.bot && (
                  <span className="botnote" title={`${p.bot} bot`} aria-label={`${p.bot} bot`}>
                    <Robot plain />
                    {p.bot === 'medium' ? 'med' : p.bot}
                  </span>
                )}
              </span>
              {!p.bot && (p.seat === room.you || me?.isHost) && <StandUp name={p.name} seat={p.seat} mine={p.seat === room.you} />}
              {me?.isHost && p.seat !== room.you && <Unseat name={p.name} seat={p.seat} person={!p.bot} />}
            </li>
            ))}
        </ul>
        <Watching room={room} />
        {picked &&
          (picked.seat === room.you ? (
            <BackPicker
              faces
              title="Deck style"
              colour={backColour(picked.seat)}
              bare={prefs.bare}
              back={chosen.back}
              random={chosen.random}
              onPick={(back) => (setPrefs({ back, random: null }), setPicking(null))}
              onRandom={(random) => setPrefs({ random })}
              onBare={(bare) => setPrefs({ bare })}
              onClose={() => setPicking(null)}
            />
          ) : (
            <BackPicker
              title={`${picked.name}'s card backs`}
              colour={backColour(picked.seat)}
              bare={false}
              back={isBack(picked.back) ? picked.back : 'plain'}
              random={picked.lot ?? null}
              onPick={(back) => (botBack(picked.seat, { back, lot: null }), setPicking(null))}
              onRandom={(lot) => botBack(picked.seat, { lot })}
              onClose={() => setPicking(null)}
            />
          ))}
        {/* Your backs at this table: the card, and a button to change it. */}
        {me && !me.watching && (
          <div className="yourback">
            {/* One button: the card in a yellow frame, deeper at the bottom, where it says what pressing it does. */}
            <button type="button" className="frame" aria-label="Change your card back" onClick={() => setPicking(me.seat)}>
              <Mini seat={me.seat} back={chosen.random ? 'any' : backNamed(chosen.back, prefs.bare)} />
              <span>Change</span>
            </button>
            {/* Your colour is your seat. Until the first deal it can be changed for any that nobody has: a dot of it, and behind the dot the ones still free. */}
            {room.round === 0 && <Colour room={room} seat={me.seat} />}
          </div>
        )}
        <TableRules room={room} />
        {me?.isHost ? (
          <button className="go" disabled={!ready} onClick={start}>
            {ready ? 'Deal the first round' : 'Waiting for a second player'}
          </button>
        ) : (
          <p className="wait">Waiting for {host?.name ?? 'the host'} to deal.</p>
        )}
      </Pad>
    </main>
  );
}

/** For whoever deals, on the score sheet: start the table over (every score to nothing, back to before the first deal). Asked twice, since it cannot be undone. */
function StartOver() {
  return (
    <Pop icon={<Again />} label="Start over">
      <h3>Start over?</h3>
      <p className="hint">Everyone's score goes back to 0 and the table to before round 1. This cannot be undone.</p>
      <button type="button" className="plain" onClick={resetTable}>
        Reset the scores
      </button>
    </Pop>
  );
}

/** A turning arrow: again from the start. */
function Again() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.5 12a6.5 6.5 0 1 0 2.2-4.9" />
      <path d="M5 4.5v3.4h3.4" />
    </svg>
  );
}

/** The round's snipes, kept small: one line for the top sniper, and behind a button who did it to whom, the most first. */
function Snipes({ snipes, top, who }: { snipes: NonNullable<NonNullable<RoomView['lastRound']>['snipes']>; top: { by: number; n: number }; who: (seat: number) => string }) {
  const [all, setAll] = useState(false);
  return (
    <section className="snipes" aria-label="Snipes">
      {/* The whole line is the button: a chevron right after it says there is more underneath. */}
      <button type="button" className="top" aria-expanded={all} title={all ? 'Hide the snipes' : 'Show every snipe'} onClick={() => setAll(!all)}>
        <small>Top sniper</small>
        <i className="chip" style={{ background: backColour(top.by) }} />
        <b>{who(top.by)}</b>
        <span className="n">×{top.n}</span>
        <svg className="chev" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 5.5l6.5 6.5L9 18.5" />
        </svg>
      </button>
      {all && (
        <ul>
          {snipes.map((s) => (
            <li key={`${s.by}>${s.of}`} title={`${who(s.by)} sniped ${who(s.of)}${s.n > 1 ? ` ${s.n} times` : ''}`}>
              <i className="chip" style={{ background: backColour(s.by) }} />
              {who(s.by)}
              <span className="to" aria-label="sniped">
                →
              </span>
              <i className="chip" style={{ background: backColour(s.of) }} />
              {who(s.of)}
              {s.n > 1 && <span className="n">×{s.n}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Results({ room }: { room: RoomView }) {
  const round = room.lastRound;
  const me = room.players.find((p) => p.seat === room.you);
  const host = room.players.find((p) => p.isHost);
  // The sheet goes by the round's own lines (name and total included), so it stays right when someone has left since.
  const rows = (round?.scores ?? []).filter((s) => !s.gone).sort((a, b) => b.total - a.total || b.delta - a.delta);
  const caller = rows.find((s) => s.seat === round?.calledBy);
  const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
  // Snipes: whoever beat others to a pile most often, and every pair of who did it to whom.
  const who = (seat: number) => (seat === room.you ? 'You' : (round?.scores.find((s) => s.seat === seat)?.name ?? room.players.find((p) => p.seat === seat)?.name ?? `Seat ${seat + 1}`));
  const tally = new Map<number, number>();
  for (const s of round?.snipes ?? []) tally.set(s.by, (tally.get(s.by) ?? 0) + s.n);
  const top = [...tally].map(([by, n]) => ({ by, n })).sort((a, b) => b.n - a.n)[0];
  /** A total with, under it, how many rounds it is the sum of: said only where that is fewer than the table has played (someone who came later, or was away). */
  const total = (score: number, rounds: number) => (
    <td className="total">
      {score < 0 ? `−${-score}` : score}
      {rounds > 0 && rounds < room.round && <small title={`over ${rounds} of the table's ${room.round} rounds`}>({rounds})</small>}
    </td>
  );

  return (
    <main className="solo over">
      <Pad wide>
        <h2>Round {room.round}</h2>
        {/* Who called it is said in their own line of the sheet, with the stamp; only a round that ended some other way gets a sentence. */}
        {!caller && <p className="lead">{round?.ended === 'jam' ? 'The table jammed: nobody could move. Scored as it stands.' : round?.ended === 'vote' ? 'Everyone agreed to end the round. Scored as it stands.' : 'Round over.'}</p>}
        <table className="scores">
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Played</th>
              <th scope="col">Nertz</th>
              <th scope="col">Round</th>
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.seat} className={s.seat === room.you ? 'you' : ''}>
                <th scope="row">
                  <span className="who">
                  <i className="chip" style={{ background: backColour(s.seat) }} />
                  <span className="nm">{me?.isHost && room.players.some((p) => p.seat === s.seat && p.bot) ? <BotName name={room.players.find((p) => p.seat === s.seat)!.name} seat={s.seat} /> : s.name}</span>
                  {s.seat === round?.calledBy && (
                    <span className="called" title={`${s.seat === room.you ? 'You' : s.name} called Nertz`}>
                      Nertz!
                    </span>
                  )}
                  {room.players.some((p) => p.seat === s.seat && !p.bot) && (s.seat === room.you || me?.isHost) && <StandUp name={s.name} seat={s.seat} mine={s.seat === room.you} />}
                  {me?.isHost && s.seat !== room.you && room.players.some((p) => p.seat === s.seat) && <Unseat name={s.name} seat={s.seat} person={!room.players.some((p) => p.seat === s.seat && p.bot)} />}
                  </span>
                </th>
                <td>{signed(s.played)}</td>
                <td>
                  {s.nertzLeft ? (
                    <>
                      <small className="left" title={`${s.nertzLeft} left in the nertz pile`}>{s.nertzLeft}</small>
                      {signed(-2 * s.nertzLeft)}
                    </>
                  ) : (
                    '0'
                  )}
                </td>
                <td className="round">{signed(s.delta)}</td>
                {total(s.total, s.rounds)}
              </tr>
            ))}
            {/* Whoever sat down since the round (a bot just added, someone who has just joined) has no line of it: they are shown under it, as coming in at the next deal. */}
            {room.players
              .filter((p) => !p.watching && !rows.some((s) => s.seat === p.seat))
              .map((p) => (
                <tr key={`new${p.seat}`} className={`joining${p.seat === room.you ? ' you' : ''}`}>
                  <th scope="row">
                    <i className="chip" style={{ background: backColour(p.seat) }} />
                    {p.name}
                    {me?.isHost && p.seat !== room.you && <Unseat name={p.name} seat={p.seat} person={!p.bot} />}
                  </th>
                  <td colSpan={3} className="note">
                    In next round
                  </td>
                  {total(p.score, p.rounds)}
                </tr>
              ))}
          </tbody>
        </table>
        <Watching room={room} />
        {round?.snipes && top && <Snipes snipes={round.snipes} top={top} who={who} />}
        {me?.isHost ? (
          <button className="go" disabled={!enoughToDeal(room)} onClick={start}>
            {enoughToDeal(room) ? 'Next round' : 'Waiting for a second player'}
          </button>
        ) : (
          <p className="wait">Waiting for {host?.name ?? 'the host'} to deal the next round.</p>
        )}
        <div className="tools">
          <Pop icon={<Gear />} label="Table rules">
            <TableRules room={room} />
          </Pop>
          {me?.isHost && <AddBot room={room} />}
          {me?.isHost && <StartOver />}
          <Leave />
        </div>
      </Pad>
    </main>
  );
}
