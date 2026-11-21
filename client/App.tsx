// Screens around the table: home, lobby, round results.
import { rename, sitter as sitterOf, signedIn as signedInAs, signIn, useAccount, waysIn } from './account';
import { SignIn } from './SignIn';
import { Profile } from './Profile';
import { Gallery } from './Gallery';
import { useAnimate } from 'motion/react';
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { BOT_LEVELS, cleanName, freeSeats, hasSeat, isRoomCode, MAX_NAME_LENGTH, MIN_PLAYERS, ROOM_CODE_LENGTH, shownBack, type Look } from '../shared/protocol';
import type { BotLevel, OpenTables, PlayerView, RoomView, TableSummary } from '../shared/types';
import { backColour, backOf, BACKS, Face } from './cards/Face';
import { BackPicker, YourBackPicker, YourBacks } from './BackPicker';
import { calm, lookOf, usePrefs } from './prefs';
import { Chat, signed } from './Chat';
import { useDismiss } from './dismiss';
import { Name } from './Host';
import { Back, ICONS, openCorner, Sure, useCorner } from './Menu';
import { press, tableActions, type ActionId } from './actions';
import { addBot, botBack, create, join, kick, nameBot, passHost, removeBot, roomInUrl, pickSeat, sit, start, useNet, useRtt } from './net';
import { Corner, Pop, Robot, TableRules } from './Settings';
import { Check, CopyIcon, Eye, Gear } from './icons';
import { useSounds } from './sound';
import { Spread } from './Spread';
import { Table } from './Table';
import { rememberedName, rememberName } from './name';

/** Sit down at table `room`, or with null ask the server to open a new one (it picks the code). A guest's name is remembered by the browser; an account's is the account's. */
function enter(room: string | null, name: string, guest: boolean): void {
  if (guest) rememberName(name);
  if (room) join(room, name);
  else create(name);
}

/** The time to the server and back, small in the corner, if you asked for it (Settings) and there is a line. */
function Ping() {
  const { ping } = usePrefs();
  const rtt = useRtt();
  if (!ping || rtt === null) return null;
  return (
    <span className="ping">
      {Math.round(rtt)} ms
    </span>
  );
}

export function App() {
  const net = useNet();
  const room = net.room;
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
  const me = room.players.find((p) => p.id === room.me);
  // Without a seat: watching, whatever the table is doing: by choice, until they ask for one; or having asked, until there is one (the table is full, or a round is on). With one, but come in the middle of a round: watching until the next.
  const nextRound = 'Spectating - You can join next round';
  const free = freeSeats(room.seats);
  /** How many are before you in the queue for a seat (the list is in the order they will be seated). */
  const ahead = room.players.filter((p) => p.queued && p.connected).findIndex((p) => p.id === room.me);
  const spectating = !me
    ? null
    : me.left
      ? 'You are Spectating'
      : hasSeat(me)
      ? room.phase === 'playing' && !room.game?.players.some((p) => p.seat === me.seat)
        ? nextRound
        : null
      : !me.queued
        ? 'You are Spectating'
        : ahead < free
          ? nextRound
          : ahead === free
            ? 'Spectating - the table is full. You get the first seat that frees up'
            : 'Spectating - the table is full. You are in the queue for a seat';
  return (
    <>
      <Corner room={room} />
      {room.game && room.phase !== 'lobby' && <Table room={room} sheet={<Results room={room} />} />}
      {room.phase === 'lobby' && <Lobby room={room} />}
      <Chat room={room} />
      <Sure room={room} />
      <Ping />
      {net.status === 'reconnecting' ? (
        <p className="banner">Connection lost. Reconnecting…</p>
      ) : (
        spectating && (
          <p className="banner low">
            {spectating}
            {/* A seat is had only by asking for it; and whoever asked can think again. */}
            {me && !hasSeat(me) && (
              <button type="button" onClick={() => sit(!me.queued)}>
                {me.queued ? 'Just watch' : free > 0 ? 'Take a seat' : 'Join the queue'}
              </button>
            )}
          </p>
        )
      )}
    </>
  );
}

/** The server deals only to players who are connected, and needs two of them. */
const enoughToDeal = (room: RoomView): boolean => room.players.filter((p) => p.connected && hasSeat(p)).length >= MIN_PLAYERS;

/** Each half of the pad's turn over: edge-on, then down again on its other side. */
const PAD_HALF = 0.2;
/** Held through the turn (from nothing it would swell the pad toward the viewer). */
const PAD_PERSPECTIVE = [1400, 1400];

/**
 * The score pad. Given a `side`, it is a slip with sides: a new side comes up by the pad turning over like a card,
 * showing what it had until it is edge-on and the new side from there, away from the side it was first shown on and
 * back the other way. Reduced motion (`calm`): the new side, without the turn.
 */
function Pad({ children, wide, side }: { children: ReactNode; wide?: boolean; side?: string }) {
  const [scope, animate] = useAnimate<HTMLElement>();
  /** The side up now: behind `side` while the pad turns away from it. */
  const [up, setUp] = useState(side);
  const first = useRef(side);
  /** What the side up showed last, kept on it while it turns away. */
  const shown = useRef(children);
  if (up === side) shown.current = children;
  const turned = useRef(false);
  useEffect(() => {
    const pad = scope.current;
    if (up === side) {
      // Settled (or turned back before edge-on): down flat, from wherever the turn had got to. Flat, it drops its
      // transform: the held perspective would leave the pad a containing block, trapping a fixed overlay (the delete
      // confirm) inside it on phones.
      if (!turned.current) return;
      let off = false;
      void animate(pad, { rotateY: 0, transformPerspective: PAD_PERSPECTIVE }, { duration: calm() ? 0 : PAD_HALF, ease: 'easeOut' }).then(() => {
        if (!off) pad.style.transform = '';
      });
      return () => {
        off = true;
      };
    }
    if (calm()) return setUp(side);
    turned.current = true;
    const way = side === first.current ? -90 : 90;
    let off = false;
    void animate(pad, { rotateY: way, transformPerspective: PAD_PERSPECTIVE }, { duration: PAD_HALF, ease: 'easeIn' }).then(() => {
      if (off) return;
      void animate(pad, { rotateY: -way }, { duration: 0 });
      setUp(side);
    });
    return () => {
      off = true;
    };
  }, [up, side, animate, scope]);
  return (
    <section ref={scope} className={`pad${wide ? ' wide' : ''}`}>
      {up === side ? children : shown.current}
    </section>
  );
}

/** A small card, used as decoration and as each player's colour swatch. */
function Mini({ seat, suit, rank, style, look }: { seat?: number; suit?: 'S' | 'H' | 'D' | 'C'; rank?: number; style?: CSSProperties; look?: Look }) {
  const { deck, night } = usePrefs(); // a card shown for its own sake is one of yours
  return (
    <span className="mini" style={style}>
      {suit && rank ? (
        <span className="front">
          <Face suit={suit} rank={rank} mini={false} deck={deck} night={night} />
        </span>
      ) : (
        <span {...backOf(backColour(seat ?? 0), look ? shownBack(look.backs) : 'plain', !!look?.bare, true)} />
      )}
    </span>
  );
}

/** For whoever deals, between rounds: a robot button that opens a slip for seating a bot. */
function AddBot({ room }: { room: RoomView }) {
  const [level, setLevel] = useState<BotLevel>('medium');
  const full = freeSeats(room.seats) === 0;
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

/** A small × beside a name, for whoever deals: a bot is sent away; a person is put out of the table, as if they had left. */
function Unseat({ who }: { who: PlayerView }) {
  return (
    <button type="button" className="unseat" aria-label={`Remove ${who.name}`} title={who.bot ? `Remove ${who.name}` : `Remove ${who.name} from the table`} onClick={() => (who.bot ? who.seat !== null && removeBot(who.seat) : kick(who.id))}>
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
  useDismiss(root, open, () => setOpen(false));
  /** Yours (ticked), and every colour nobody has. */
  const free = BACKS.map((c, i) => ({ c, i })).filter(({ i }) => i === seat || !room.players.some((p) => p.seat === i));
  return (
    <span className="colour" ref={root}>
      <button type="button" className="dot" style={{ background: backColour(seat) }} aria-expanded={open} aria-label="Change your colour" title={free.length > 1 ? 'Change your colour' : 'Every other colour is taken'} disabled={free.length < 2} onClick={() => setOpen(!open)} />
      {open && (
        <span className="free" role="radiogroup" aria-label="Your colour, and those nobody has">
          {free.map(({ c, i }) => (
            <button key={c} type="button" role="radio" aria-checked={i === seat} aria-label={i === seat ? `Colour ${i + 1}: yours` : `Colour ${i + 1}`} className={i === seat ? 'mine' : ''} style={{ background: c }} onClick={() => (i === seat || pickSeat(i), setOpen(false))} />
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * Up from the table to watch: your own row, or (whoever deals) someone else's. An eye; the × beside it sends away
 * altogether. Whoever hosts the table is asked first whether to hand it on, and to whom: some go on dealing from the side.
 */
function StandUp({ room, who }: { room: RoomView; who: PlayerView }) {
  const mine = who.id === room.me;
  const says = mine ? 'Stand up: watch without playing' : `Stand ${who.name} up: they watch without playing`;
  const heirs = mine && who.isHost ? room.players.filter((p) => hasSeat(p) && !p.bot && p.id !== who.id) : [];
  const [step, setStep] = useState<'ask' | 'pick' | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  useDismiss(root, !!step, () => setStep(null));
  const up = () => (sit(false, mine ? undefined : who.id), setStep(null));
  return (
    <span className="pop-at" ref={root}>
      <button type="button" className="standup" aria-label={says} title={says} onClick={() => (heirs.length ? setStep(step ? null : 'ask') : up())}>
        <Eye />
      </button>
      {step && (
        <div className="pop handon" role="dialog" aria-label="Transfer host role">
          {step === 'ask' ? (
            <>
              <h3>You're the room host. Transfer host role?</h3>
              <div>
                <button type="button" className="plain" onClick={() => setStep('pick')}>
                  Yes
                </button>
                <button type="button" className="plain" onClick={up}>
                  No
                </button>
              </div>
            </>
          ) : (
            <>
              <h3>New host</h3>
              <div>
                {heirs.map((p) => (
                  <button key={p.id} type="button" className="plain" onClick={() => (passHost(p.id), up())}>
                    {p.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}

/** Those without a seat: who has asked for one (in the order they will be seated), and who is just watching. A seat is had by asking: oneself, or whoever deals for someone; whoever deals can also send one away. */
function Watching({ room }: { room: RoomView }) {
  const host = room.players.find((p) => p.id === room.me)?.isHost;
  const list = (label: string, them: PlayerView[]) =>
    them.length > 0 && (
      <p className="watching">
        <small>{label}</small>
        {them.map((p) => (
          <span key={p.id} className={p.id === room.me ? 'you' : ''}>
            {p.name}
            {!p.queued && (p.id === room.me || host) && (
              <button type="button" className="sit" onClick={() => sit(true, p.id === room.me ? undefined : p.id)}>
                {p.id === room.me ? 'Take a seat' : 'Seat'}
              </button>
            )}
            {p.queued && p.id === room.me && (
              <button type="button" className="sit" onClick={() => sit(false)}>
                Just watch
              </button>
            )}
            {host && p.id !== room.me && <Unseat who={p} />}
          </span>
        ))}
      </p>
    );
  return (
    <>
      {list('Waiting for a seat', room.players.filter((p) => p.seat === null && p.queued))}
      {list('Watching', room.players.filter((p) => p.seat === null && !p.queued))}
    </>
  );
}

/** One of the table's actions (actions.ts) as an icon among the sheet's tools, while it is open to you. */
function Act({ id, room }: { id: ActionId; room: RoomView }) {
  const a = tableActions(room).find((t) => t.id === id);
  if (!a) return null;
  const Icon = ICONS[id];
  return (
    <button type="button" className="icon" aria-label={a.label} title={a.label} onClick={() => press(id, room)}>
      <Icon />
    </button>
  );
}

/** How often the tables are asked for again while the home page is up, ms. */
const TABLES_MS = 5000;

/** What a table is doing, as its line of the list says it. */
const roundOf = (t: TableSummary): string => (t.playing ? `round ${t.round}` : t.round > 0 ? `after round ${t.round}` : 'not started');

/** The tables someone is at just now (server/index.ts `/tables`), how many beside the word; pressed, the list; a line of it, that table. */
function Tables({ onPick }: { onPick: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const [known, setKnown] = useState<OpenTables | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch('/tables', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as OpenTables;
        if (live) setKnown(body);
      } catch {
        // the server is out of reach: what is shown stays as it was, and is asked for again
      }
    };
    void load();
    const again = setInterval(load, TABLES_MS);
    return () => {
      live = false;
      clearInterval(again);
    };
  }, [open]); // (asked for at once when the list is opened, too)
  return (
    <div className="tables">
      <button type="button" className="quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
        Tables{known && ` (${known.open})`}
      </button>
      {open &&
        known &&
        (known.tables.length ? (
          <ul>
            {known.tables.map((t) => (
              <li key={t.code}>
                <button type="button" title={t.watching ? `${t.watching} watching` : undefined} onClick={() => onPick(t.code)}>
                  <b>{t.code}</b>
                  <span className="names">{t.names.join(', ')}</span>
                  <span>
                    {t.names.length}/{t.seats}
                  </span>
                  <span>{roundOf(t)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">No tables yet</p>
        ))}
    </div>
  );
}

/** Your picture, or where there is none (or it will not load) the first letter of your name; a plain disc for no name yet. */
function Avatar({ image, name }: { image: string | null; name: string | null }) {
  const [broken, setBroken] = useState(false);
  if (image && !broken) return <img src={image} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
  return <i aria-hidden="true">{name ? [...name][0]!.toUpperCase() : ''}</i>;
}

function Home({ error, busy }: { error: string | null; busy: boolean }) {
  const invited = roomInUrl();
  /** The name written in the field: a guest's own (the browser remembers it), or the first for an account with none yet. Never an account's name. */
  const [name, setName] = useState(rememberedName);
  const account = useAccount();
  const signedIn = signedInAs(account);
  const ways = waysIn(account);
  /** A guest: chose to sit down under a name of their own, or did so before (the browser remembers it). */
  const [guest, setGuest] = useState(() => !!rememberedName());
  const sits = sitterOf(account, guest);
  const clean = cleanName(name);
  /** The name you sit down under: your account's, or the one written in the field. */
  const sitAs = sits === 'you' ? signedIn!.name! : sits === 'name' ? clean : '';
  /** Sits down. Signed in with no name yet, the one written becomes the name you go by. */
  const go = (room: string | null): void => {
    if (signedIn && sits === 'name') void rename(sitAs);
    enter(room, sitAs, !signedIn);
  };
  /**
   * Which way the pad is turned, if not to the form: to your page, or to the way in. Signing in from the way in turns
   * it to your page; signing out of your page turns it back to the form, never through the way in.
   */
  const [turned, setTurned] = useState<'page' | 'in' | null>(null);
  useEffect(() => {
    if (signedIn) setTurned((t) => (t === 'in' ? 'page' : t));
    else setTurned((t) => (t === 'page' ? null : t));
  }, [signedIn]);
  /** The side of the pad up: the form, your page, or the way in. */
  const side = turned && signedIn ? 'page' : turned === 'in' && ways ? 'in' : 'form';
  /** Sign in: the ways in, on the pad; or straight to Google, where it is the only way. */
  const signInNow = () => (ways?.length === 1 && ways[0] === 'google' ? void signIn() : setTurned('in'));
  const [code, setCode] = useState(invited);
  const nameField = useRef<HTMLInputElement>(null);
  const typed = code.trim().toUpperCase();
  const ready = !!sitAs && !busy;
  /** A table picked off the list: as if its code were typed and Join pressed; without a name yet, the code waits in its field for one (still to choose: as a guest). */
  const pick = (room: string) => {
    if (busy) return;
    setCode(room);
    if (ready) go(room);
    else if (sits === 'choose') setGuest(true);
    else nameField.current?.focus();
  };

  // Enter in the form does the obvious thing: join if a code is filled in, otherwise start a table.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    if (!typed) go(null);
    else if (isRoomCode(typed)) go(typed);
  };

  return (
    <main className="home">
      <div className="hero">
        <Spread />
        <h1>Nertz!</h1>
      </div>

      <Pad side={side}>
        {side === 'page' && signedIn ? (
          <Profile account={signedIn} head={<Back onClick={() => setTurned(null)} />} />
        ) : side === 'in' && ways ? (
          <SignIn ways={ways} head={<Back onClick={() => setTurned(null)} />} />
        ) : (
          <form onSubmit={submit}>
            <h2>Pull up a chair</h2>
            {sits === 'you' && signedIn ? (
              <div className="named">
                <button type="button" className="you" onClick={() => setTurned('page')}>
                  <Avatar image={signedIn.image} name={signedIn.name} />
                  <span>{signedIn.name}</span>
                </button>
                <YourBacks colour={BACKS[0]} compact />
              </div>
            ) : sits === 'choose' ? (
              <div className="named choose">
                <span className="either">
                  <button type="button" className="plain" onClick={signInNow}>
                    Sign in
                  </button>
                  <button type="button" className="plain" onClick={() => setGuest(true)}>
                    Guest
                  </button>
                </span>
                <YourBacks colour={BACKS[0]} compact />
              </div>
            ) : sits === 'name' ? (
              <div className="named">
                <span className="guest">
                  {signedIn && (
                    <button type="button" className="you" aria-label="Your page" title="Your page" onClick={() => setTurned('page')}>
                      <Avatar image={signedIn.image} name={null} />
                    </button>
                  )}
                  <input
                    ref={nameField}
                    autoFocus
                    aria-label="Name"
                    placeholder="Name"
                    value={name}
                    maxLength={MAX_NAME_LENGTH}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="nickname"
                  />
                  {ways && !signedIn && (
                    <button type="button" className="who" onClick={signInNow}>
                      Sign in
                    </button>
                  )}
                </span>
                <YourBacks colour={BACKS[0]} compact />
              </div>
            ) : (
              <div className="named" />
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="ways">
              <button type="button" className="go" disabled={!ready} onClick={() => go(null)}>
                {busy && !typed ? 'Connecting…' : 'New Table'}
              </button>
              <div className="way">
                <label htmlFor="code">Join existing table</label>
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
                  <button type="button" className="go" disabled={!ready || !isRoomCode(typed)} onClick={() => go(typed)}>
                    {busy && typed ? '…' : 'Join'}
                  </button>
                </div>
              </div>
            </div>
            <Tables onPick={pick} />
          </form>
        )}
      </Pad>
    </main>
  );
}

function Lobby({ room }: { room: RoomView }) {
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}/?room=${room.code}`;
  const me = room.players.find((p) => p.id === room.me);
  const prefs = usePrefs();
  /** Whose backs are being chosen (the seat), if the sheet of backs is open: your own, or a bot's. */
  const [picking, setPicking] = useState<number | null>(null);
  const picked = room.players.filter(hasSeat).find((p) => p.seat === picking && (p.id === room.me || (me?.isHost && p.bot)));
  /** The back a bot whose backs are being chosen has now: plain, for a lot not drawn yet. */
  const botHas = (picked && shownBack(picked.look.backs)) ?? 'plain';
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
          <Act id="leave" room={room} />
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
          <span className="link">{link}</span>
          <button type="button" onClick={copy} aria-label="Copy link" title={copied ? 'Copied' : 'Copy link'}>
            {copied ? <Check /> : <CopyIcon />}
          </button>
        </div>
        <ul className="seats">
          {room.players
            .filter(hasSeat)
            .map((p) => (
            <li key={p.id} className={`${p.connected ? '' : 'away'}${p.id === room.me ? ' you' : ''}`}>
              {/* The card beside a name is that player's back. Your own, and (if you deal) a bot's, opens the backs to choose another. */}
              {p.id === room.me || (me?.isHost && p.bot) ? (
                <button type="button" className="swatch" aria-label={p.id === room.me ? 'Change your card backs' : `Change ${p.name}'s card backs`} title={p.id === room.me ? (prefs.random ? 'Your card backs: drawn by lot when the round is dealt. Change them' : 'Change your card backs') : `Change ${p.name}'s card backs`} onClick={() => setPicking(p.seat)}>
                  <Mini seat={p.seat} look={p.id === room.me ? lookOf(prefs) : p.look} />
                </button>
              ) : (
                <Mini seat={p.seat} look={p.look} />
              )}
              {/* The name, with the dealer's button. On a phone the note and what you may do go on a small line under it. */}
              <span className="person" title={p.name}>
                <Name host={p.isHost} className="name">
                  {me?.isHost && p.bot ? <BotName name={p.name} seat={p.seat} /> : p.name}
                </Name>
              </span>
              <span className="note">
                {[p.id === room.me && 'you', p.left ? 'left' : !p.connected && 'away'].filter(Boolean).join(', ')}
                {/* A bot: the robot, and how quick it is. */}
                {p.bot && (
                  <span className="botnote" title={`${p.bot} bot`} aria-label={`${p.bot} bot`}>
                    <Robot plain />
                    {p.bot === 'medium' ? 'med' : p.bot}
                  </span>
                )}
              </span>
              <span className="deeds">
                {!p.bot && (p.id === room.me || me?.isHost) && <StandUp room={room} who={p} />}
                {me?.isHost && p.id !== room.me && <Unseat who={p} />}
              </span>
            </li>
            ))}
        </ul>
        <Watching room={room} />
        {picked &&
          (picked.id === room.me ? (
            <YourBackPicker colour={backColour(picked.seat)} onClose={() => setPicking(null)} />
          ) : (
            <BackPicker
              title={`${picked.name}'s card backs`}
              colour={backColour(picked.seat)}
              bare={false}
              back={botHas}
              random={picked.look.backs.k === 'lot' ? picked.look.backs.lot : null}
              onPick={(back) => (botBack(picked.seat, { k: 'own', back }), setPicking(null))}
              onRandom={(lot) => botBack(picked.seat, lot ? { k: 'lot', lot, drawn: null } : { k: 'own', back: botHas })}
              onClose={() => setPicking(null)}
            />
          ))}
        {/* Your backs: the card, and a button to change it. */}
        {me && hasSeat(me) && (
          <div className="yourback">
            {/* One button: the card, and tucked under its bottom edge a small yellow tag saying what pressing it does. */}
            <button type="button" className="change" aria-label="Change your card back" onClick={() => setPicking(me.seat)}>
              <Mini seat={me.seat} look={lookOf(prefs)} />
              <span>Change</span>
            </button>
            {/* Your colour is your seat. Until the first deal it can be changed for any that nobody has: a dot of it, and behind the dot the ones still free. */}
            {room.round === 0 && <Colour room={room} seat={me.seat} />}
          </div>
        )}
        <TableRules room={room} />
        {/* Whoever is watching (they stood up, or came in to a full table): a seat is theirs for the asking. */}
        {me && !hasSeat(me) && !me.queued && (
          <button className="go" onClick={() => sit(true)}>
            {freeSeats(room.seats) > 0 ? 'Take a seat' : 'Join the queue for a seat'}
          </button>
        )}
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

/** On the score sheet: your settings (the same as the corner's menu leads to, opened there), and if you host, the table's at the bottom of them. */
function SettingsGear() {
  const open = useCorner() === 'settings';
  return (
    <button type="button" className={`icon${open ? ' on' : ''}`} aria-expanded={open} aria-controls={open ? 'your-settings' : undefined} aria-label="Settings" title="Settings" onClick={() => openCorner('settings')}>
      <Gear />
    </button>
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
  const me = room.players.find((p) => p.id === room.me);
  const host = room.players.find((p) => p.isHost);
  // The sheet goes by the round's own lines (name and total included), so it stays right when someone has left since.
  const rows = (round?.scores ?? []).filter((s) => !s.gone).sort((a, b) => b.total - a.total || b.delta - a.delta);
  const end = round?.end;
  /** The seats that got Nertz: each has the stamp in their line. */
  const out = end?.by === 'nertz' ? end.out : [];
  // Snipes: whoever beat others to a pile most often, and every pair of who did it to whom.
  /** Whose line of the round this is, if they are still in the room: a line goes by who played it, not by who has its seat now. */
  const of = (s: { id: number }) => room.players.find((p) => p.id === s.id);
  const who = (seat: number) => {
    const line = round?.scores.find((s) => s.seat === seat);
    return line?.id === room.me ? 'You' : (line?.name ?? `Seat ${seat + 1}`);
  };
  const tally = new Map<number, number>();
  for (const s of round?.snipes ?? []) tally.set(s.by, (tally.get(s.by) ?? 0) + s.n);
  const top = [...tally].map(([by, n]) => ({ by, n })).sort((a, b) => b.n - a.n)[0];
  /** A total with, under it, how many rounds it is the sum of: said only where that is fewer than the table has played (someone who came later, or was away). */
  const total = (score: number, rounds: number, calls: number) => (
    <>
    {/* Before it, the other thing kept across rounds: how many of them they ended by calling Nertz. */}
    <td className="total calls">{calls}</td>
    <td className="total">
      {score < 0 ? `−${-score}` : score}
      {rounds > 0 && rounds < room.round && <small title={`over ${rounds} of the table's ${room.round} rounds`}>({rounds})</small>}
    </td>
    </>
  );

  return (
    <main className="solo over">
      <Pad wide>
        <h2>Round {room.round}</h2>
        {/* Who got Nertz is said in their own lines of the sheet, with the stamp in the Nertz column; only a round that ended some other way gets a sentence. (Not if all who got it were sent away since: a bot that called, then removed.) */}
        {!rows.some((s) => out.includes(s.seat)) && <p className="lead">{end?.by === 'jam' ? 'The table jammed: nobody could move. Scored as it stands.' : end?.by === 'vote' ? 'Everyone agreed to end the round. Scored as it stands.' : 'Round over.'}</p>}
        <table className="scores">
          <thead>
            <tr>
              <th scope="col" rowSpan={2}>Player</th>
              <th scope="col" rowSpan={2}>Played</th>
              <th scope="col" rowSpan={2}>Nertz</th>
              <th scope="col" rowSpan={2}>Round</th>
              <th scope="colgroup" colSpan={2} className="over">Total</th>
            </tr>
            <tr>
              <th scope="col">Nertz</th>
              <th scope="col">Points</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const p = of(s);
              return (
              <tr key={s.seat} className={s.id === room.me ? 'you' : ''}>
                <th scope="row">
                  <span className="who">
                  <i className="chip" style={{ background: backColour(s.seat) }} />
                  <Name host={p?.isHost} className="nm">
                    {me?.isHost && p?.bot && p.seat !== null ? <BotName name={p.name} seat={p.seat} /> : s.name}
                  </Name>
                  {p && !p.bot && p.seat !== null && (p.id === room.me || me?.isHost) && <StandUp room={room} who={p} />}
                  {p && me?.isHost && p.id !== room.me && <Unseat who={p} />}
                  </span>
                </th>
                <td>{signed(s.played)}</td>
                {/* Whoever got Nertz has no cards left in that pile: where the 0 would be, the stamp that lay across their hand. */}
                <td>
                  {out.includes(s.seat) ? (
                    <span className="called" title={`${s.id === room.me ? 'You' : s.name} got Nertz`}>
                      Nertz!
                    </span>
                  ) : s.nertzLeft ? (
                    <>
                      <small className="left" title={`${s.nertzLeft} left in the nertz pile`}>{s.nertzLeft}</small>
                      {signed(-2 * s.nertzLeft)}
                    </>
                  ) : (
                    '0'
                  )}
                </td>
                <td className="round">{signed(s.delta)}</td>
                {total(s.total, s.rounds, s.calls)}
              </tr>
              );
            })}
            {/* Whoever sat down since the round (a bot just added, someone who has just joined) has no line of it: they are shown under it, as coming in at the next deal. */}
            {room.players
              .filter(hasSeat)
              .filter((p) => !rows.some((s) => s.id === p.id))
              .map((p) => (
                <tr key={`new${p.id}`} className={`joining${p.id === room.me ? ' you' : ''}`}>
                  <th scope="row">
                    <span className="who">
                    <i className="chip" style={{ background: backColour(p.seat) }} />
                    <Name host={p.isHost} className="nm">{p.name}</Name>
                    {!p.bot && (p.id === room.me || me?.isHost) && <StandUp room={room} who={p} />}
                    {me?.isHost && p.id !== room.me && <Unseat who={p} />}
                    </span>
                  </th>
                  <td colSpan={3} className="note">
                    In next round
                  </td>
                  {total(p.score, p.rounds, p.calls)}
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
          <SettingsGear />
          {me?.isHost && <AddBot room={room} />}
          <Act id="reset" room={room} />
          <Act id="leave" room={room} />
        </div>
      </Pad>
    </main>
  );
}
