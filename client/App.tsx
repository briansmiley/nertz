// Screens around the table: home, lobby, round results.
import { rename, sitter as sitterOf, signedIn as signedInAs, signIn, useAccount, waysIn } from './account';
import { goBack, showPage, useAddressed, type Addressed } from './address';
import { SignIn } from './SignIn';
import { Follow, FollowingList, Profile, Theirs } from './Profile';
import { Gallery } from './Gallery';
import { useAnimate } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { BOT_LEVELS, cleanName, freeSeats, hasSeat, isRoomCode, MAX_NAME_LENGTH, MAX_PLAYERS, MIN_PLAYERS, ROOM_CODE_LENGTH, shownBack, type Look } from '../shared/protocol';
import type { BotLevel, OpenTables, PlayerView, RoomView, TableSummary } from '../shared/types';
import { backColour, backOf, BACKS, Face } from './cards/Face';
import { BackPicker, YourBackPicker, YourBacks } from './BackPicker';
import { calm, lookOf, setPrefs, usePrefs } from './prefs';
import { Chat, signed } from './Chat';
import { useDismiss } from './dismiss';
import { usePicture } from './picture';
import { Dots } from './Dots';
import { Dropdown } from './Dropdown';
import { Name } from './Host';
import { Back, ICONS, openCorner, Sure, useCorner } from './Menu';
import { openAction, press, type ActionId } from './actions';
import { addBot, botBack, create, join, kick, nameBot, passHost, removeBot, roomInUrl, pickSeat, reachOf, sit, start, useNet, useReach, useRtt, type Reach } from './net';
import { Corner, Pop, Robot, RobotPlus, TableRules } from './Settings';
import { Chair, Check, Gear, LinkIcon, Riffle, RobotBroken, RobotFixed, SignInDoor, Sit } from './icons';
import { useSounds } from './sound';
import { Spread } from './Spread';
import { Table } from './Table';
import { lastName, rememberedName, rememberName, satDownAs } from './name';

/**
 * Sit down at table `room`, or with null ask the server to open a new one (it picks the code). A guest's name is
 * remembered by the browser (`remember`); an account's is the account's, and so may the one sat down under offline be
 * (`lastName`), where nobody is signed in to say.
 */
function enter(room: string | null, name: string, remember: boolean): void {
  if (remember) rememberName(name);
  satDownAs(name);
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

/** How long the banner says the line is back. */
const BACK_MS = 3000;

/**
 * Whether the line has just come back: true for `BACK_MS` from when the window is online again after `reconnecting`.
 * Not at the first connect, nor after `updating` (that one reloads the page).
 */
function useBack(status: Status): boolean {
  const [was, setWas] = useState(status);
  const [back, setBack] = useState(false);
  if (status !== was) {
    setWas(status);
    setBack(was === 'reconnecting' && status === 'online');
  }
  useEffect(() => {
    if (!back) return;
    const t = setTimeout(() => setBack(false), BACK_MS);
    return () => clearTimeout(t);
  }, [back]);
  return back;
}

/**
 * A card at the top of the window saying what the line is doing (`say`). Over the chat bar and the menu on a phone, so
 * its × puts it away: until it has something else to say; or, given `onShut`, as that says.
 */
function Toast({ say, className, onShut, children }: { say: string; className: string; onShut?: () => void; children: ReactNode }) {
  const [shut, setShut] = useState<string | null>(null);
  if (shut === say) return null;
  return (
    <p className={`banner net ${className}`} role="status">
      {children}
      <button type="button" className="shut" aria-label="Dismiss" onClick={() => (onShut ? onShut() : setShut(say))}>
        ×
      </button>
    </p>
  );
}

/**
 * The line to the table, lost and then back: one card, tipped while the line is down, that sets itself straight with the
 * mended robot when it is back. Both robots and both words are in it at once, one of each shown, so it keeps its size.
 * Put away while the line is down, it leaves the broken robot in the chat bar (`onTuck`), which brings it back.
 */
function Line({ back, onTuck }: { back: boolean; onTuck: () => void }) {
  return (
    <Toast say={back ? 'back' : 'lost'} className={back ? 'line mended' : 'line'} onShut={back ? undefined : onTuck}>
      <span className="stack robots">
        <RobotBroken />
        <RobotFixed />
      </span>
      <span className="stack says">
        <span>Connection lost. Reconnecting…</span>
        <span>Reconnected!</span>
      </span>
    </Toast>
  );
}

/** The card saying the line is lost is put away, its robot in the chat bar: for as long as the line stays lost. */
function useTucked(status: Status): [boolean, (on: boolean) => void] {
  const [was, setWas] = useState(status);
  const [tucked, setTucked] = useState(false);
  if (status !== was) {
    setWas(status);
    if (status !== 'reconnecting') setTucked(false);
  }
  return [tucked, setTucked];
}

export function App() {
  const net = useNet();
  const room = net.room;
  const account = useAccount();
  const reach = reachOf(net);
  /** Whose page the address is: yours is the home page's pad turned over; anyone else's, a page of its own. With no server to ask, no one's. */
  const addressed = useAddressed();
  const page = reach.server ? addressed : null;
  useSounds(room, net.status === 'online');
  if (!room && new URLSearchParams(location.search).has('decks')) return <Gallery />;
  // (A reload at a table sits straight back down: nothing of the home page meanwhile, unless it cannot.)
  if (!room && net.status === 'rejoining') return null;
  // (Whose it is, yours or not, is not known until the server says who is signed in.)
  if (!room && page && page.handle !== signedInAs(account)?.handle) return account === 'unknown' ? null : <Someone handle={page.handle} />;
  if (!room) {
    return (
      <>
        <Home key={net.offline ? 'offline' : 'online'} error={net.error} busy={net.status !== 'idle'} yours={page} reach={reach} />
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
      {room.game && room.phase !== 'lobby' && <Table room={room} sheet={<Results room={room} />} seats={(close) => <TableSheet room={room} onClose={close} />} />}
      {room.phase === 'lobby' && <Lobby room={room} />}
      <Chat room={room} lost={tucked ? () => setTucked(false) : undefined} />
      <Sure room={room} />
      {reach.others && <Ping />}
      {net.status === 'reconnecting' || net.status === 'updating' ? (
        <p className="banner">{net.status === 'updating' ? <>Updating the game<Dots /></> : 'Connection lost. Reconnecting…'}</p>
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

/**
 * Someone's page (`/u/<handle>`), on a pad of its own: for you signed in, theirs; otherwise the way in, which comes back
 * here. Back is the home page.
 */
function Someone({ handle }: { handle: string }) {
  const account = useAccount();
  const ways = waysIn(account);
  const home = <Back onClick={() => goBack()} />;
  return (
    <main className="solo">
      <Pad>{signedInAs(account) ? <Theirs handle={handle} head={home} /> : ways ? <SignIn ways={ways} head={home} /> : null}</Pad>
    </main>
  );
}

/**
 * A name at the table, as a link to their page where you are told it (someone else's, they and you signed in: `PlayerView.handle`).
 * It opens in a tab of its own, so this one stays at the table.
 */
function Named({ who, children }: { who: PlayerView | undefined; children: ReactNode }) {
  if (!who?.handle) return children;
  return (
    <a className="page" href={`/u/${who.handle}`} target="_blank" rel="noopener">
      {children}
    </a>
  );
}

/** On the button that deals, while there is nobody to deal to but you: whom it is waiting for; or, where nobody else can come, what to do about it. */
function Short() {
  return useReach().others ? 'Waiting for a second player' : 'Add a bot to deal';
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
function Pad({ children, wide, side, onUp, className }: { children: ReactNode; wide?: boolean; side?: string; onUp?: (side: string | undefined) => void; className?: string }) {
  const [scope, animate] = useAnimate<HTMLElement>();
  /** The side up now: behind `side` while the pad turns away from it. Told to `onUp` as it changes, before it is seen. */
  const [up, setUp] = useState(side);
  useLayoutEffect(() => onUp?.(up), [up]);
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
    <section ref={scope} className={`pad${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`}>
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

/** For whoever deals, between rounds and before their Start: a robot's head and a plus, bare, a button that opens a slip for seating a bot. */
function AddBot({ room }: { room: RoomView }) {
  const [level, setLevel] = useState<BotLevel>('medium');
  // A full table has no slip to open: the robot is there, faded, and says why.
  if (freeSeats(room.seats) === 0) {
    return (
      <span className="pop-at">
        <button type="button" className="icon bare" aria-disabled="true" aria-label="Add a bot: the table is full" data-tip="The table is full">
          <RobotPlus />
        </button>
      </span>
    );
  }
  return (
    <Pop icon={<RobotPlus />} label="Add a bot" bare>
      <h3>Add a bot</h3>
      <div className="bots">
        <Dropdown value={level} options={BOT_LEVELS} choose={setLevel} label="Bot speed" />
        <button type="button" className="plain" onClick={() => addBot(level)}>
          Add
        </button>
      </div>
    </Pop>
  );
}

/** A small × beside a name, for whoever deals: a bot is sent away; a person is put out of the table, as if they had left. */
function Unseat({ who }: { who: PlayerView }) {
  return (
    <button type="button" className="unseat" aria-label={`Remove ${who.name}`} data-tip={who.bot ? `Remove ${who.name}` : `Remove ${who.name} from the table`} onClick={() => (who.bot ? who.seat !== null && removeBot(who.seat) : kick(who.id))}>
      ×
    </button>
  );
}

/** A bot's name, for whoever deals: written over where it stands, and taken when the field is left or Enter is pressed. */
function BotName({ name, seat }: { name: string; seat: number }) {
  const justIn = useRef(false);
  return (
    <input
      key={name}
      className="botname"
      aria-label={`Rename ${name}`}
      data-tip="Rename this bot"
      defaultValue={name}
      maxLength={MAX_NAME_LENGTH}
      size={Math.max(4, name.length)}
      spellCheck={false}
      // Pressed, the whole name is chosen, so typing writes a new one. (The click's own mouseup would put a caret in it: the
      // first one after coming in is let go.)
      onFocus={(e) => ((justIn.current = true), e.currentTarget.select())}
      onMouseUp={(e) => justIn.current && ((justIn.current = false), e.preventDefault())}
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
      <button type="button" className="dot" style={{ background: backColour(seat) }} aria-expanded={open} aria-label="Change your colour" data-tip={free.length > 1 ? 'Change your colour' : 'Every other colour is taken'} disabled={free.length < 2} onClick={() => setOpen(!open)} />
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
  const may = useReach().others;
  const mine = who.id === room.me;
  const says = mine ? 'Stand up (spectate)' : `Stand ${who.name} up (spectate)`;
  const heirs = mine && who.isHost ? room.players.filter((p) => hasSeat(p) && !p.bot && p.id !== who.id) : [];
  const [step, setStep] = useState<'ask' | 'pick' | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  useDismiss(root, !!step, () => setStep(null));
  const up = () => (sit(false, mine ? undefined : who.id), setStep(null));
  if (!may) return null;
  return (
    <span className="pop-at" ref={root}>
      <button type="button" className="standup" aria-label={says} data-tip={says} onClick={() => (heirs.length ? setStep(step ? null : 'ask') : up())}>
        <Chair />
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
/** `butYou`: leave you out, where you have a place of your own (the lobby's top line). */
function Watching({ room, butYou }: { room: RoomView; butYou?: boolean }) {
  const host = room.players.find((p) => p.id === room.me)?.isHost;
  const list = (label: string, them: PlayerView[]) =>
    them.length > 0 && (
      <p className="watching">
        <small>{label}</small>
        {them.map((p) => (
          <span key={p.id} className={p.id === room.me ? 'you' : ''}>
            <Named who={p}>{p.name}</Named>
            {p.handle && <Follow handle={p.handle} name={p.name} small />}
            {!p.queued && (p.id === room.me || host) && (
              <button type="button" className="sit seat-art" aria-label={p.id === room.me ? 'Take a seat' : `Seat ${p.name}`} data-tip={p.id === room.me ? 'Take a seat' : `Seat ${p.name}`} onClick={() => sit(true, p.id === room.me ? undefined : p.id)}>
                <Sit />
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
      {list('Waiting for a seat', room.players.filter((p) => p.seat === null && p.queued && !(butYou && p.id === room.me)))}
      {list('Spectating', room.players.filter((p) => p.seat === null && !p.queued && !(butYou && p.id === room.me)))}
    </>
  );
}

/** One of the table's actions (actions.ts) as an icon among the sheet's tools, while it is open to you. */
function Act({ id, room }: { id: ActionId; room: RoomView }) {
  const a = openAction(room, id);
  if (!a) return null;
  const Icon = ICONS[id];
  return (
    <button type="button" className="icon" aria-label={a.label} data-tip={a.label} onClick={() => press(id, room)}>
      <Icon />
    </button>
  );
}

/** How often the tables are asked for again while the home page is up, ms. */
const TABLES_MS = 5000;

/** What a table is doing, as its line of the list says it. */
const roundOf = (t: TableSummary): string => (t.playing ? `round ${t.round}` : t.round > 0 ? `after round ${t.round}` : 'not started');

/** The tables someone is at just now (server/index.ts `/tables`), how many beside the word; pressed, the list; a line of it, that table. */
/** `aside`: what stands at the other end of its line (the pad's foot). */
function Tables({ onPick, aside }: { onPick: (code: string) => void; aside: ReactNode }) {
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
      <div className="foot">
        <button type="button" className="quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
          Tables{known && ` (${known.open})`}
        </button>
        {aside}
      </div>
      {open &&
        known &&
        (known.tables.length ? (
          <ul>
            {known.tables.map((t) => (
              <li key={t.code}>
                <button type="button" data-tip={t.watching ? `${t.watching} watching` : undefined} onClick={() => onPick(t.code)}>
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

/**
 * At the foot of the home page's pad, in both: Online or Offline, the one you are in underlined, the other pressed to
 * change to it (client/net.ts `NetState.offline`). Offline, your tables are your own, with bots.
 */
function Mode({ offline }: { offline: boolean }) {
  const way = (to: boolean, name: string) => (
    <button type="button" role="radio" aria-checked={offline === to} className={offline === to ? 'on' : ''} onClick={() => setPrefs({ offline: to })}>
      {name}
    </button>
  );
  return (
    <span className="mode" role="radiogroup" aria-label="Online or offline">
      {way(false, 'Online')}
      {way(true, 'Offline')}
    </span>
  );
}

/** Your picture, or where there is none (or it will not load) the first letter of your name; for no name yet (a guest's, or an account's), the figure of nobody in particular. */
function Avatar({ image, name }: { image: string | null; name: string | null }) {
  const picture = usePicture(image);
  if (picture.src) return <img src={picture.src} alt="" referrerPolicy="no-referrer" onError={picture.onError} />;
  if (!name)
    return (
      <i className="nobody" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="8.5" r="4.6" />
          <path d="M2.5 25c0-6.2 4.3-10.2 9.5-10.2s9.5 4 9.5 10.2z" />
        </svg>
      </i>
    );
  return <i aria-hidden="true">{[...name][0]!.toUpperCase()}</i>;
}

/** The home page; `yours`, with the pad turned over to your page, or on it who you follow (the address is yours: `useAddressed`). */
function Home({ error, busy, yours, reach }: { error: string | null; busy: boolean; yours: Addressed | null; reach: Reach }) {
  const invited = reach.others ? roomInUrl() : '';
  /** The name written in the field: a guest's own (the browser remembers it), or the first for an account with none yet. Never an account's name. With no server to say who is signed in: the one you last sat down under. */
  const [name, setName] = useState(reach.server ? rememberedName : lastName);
  const mode = <Mode offline={!reach.others} />;
  const account = useAccount();
  const signedIn = signedInAs(account);
  const ways = waysIn(account);
  /** This browser has sat down as a guest before (it remembers the name). */
  const [before] = useState(() => !!rememberedName());
  const sits = sitterOf(account, before);
  const clean = cleanName(name);
  /** The name you sit down under: your account's, or the one written in the field. */
  const sitAs = sits === 'you' ? signedIn!.name! : sits === 'wait' ? '' : clean;
  /** Sits down. Signed in with no name yet, the one written becomes the name you go by. */
  const go = (room: string | null): void => {
    if (signedIn && sits === 'name') void rename(sitAs);
    enter(room, sitAs, !signedIn && reach.server);
  };
  /**
   * The pad turned over to the way in. Signing in from it turns it to your page; signing out of your page turns it
   * back to the form (client/account.ts), never through the way in.
   */
  const [wayIn, setWayIn] = useState(false);
  useEffect(() => {
    if (signedIn && wayIn) (setWayIn(false), showPage(signedIn.handle));
  }, [signedIn, wayIn]);
  /** The side of the pad up: the form, your page, who you follow, or the way in. */
  const side = yours && signedIn ? (yours.following ? 'following' : 'page') : wayIn && ways ? 'in' : 'form';
  /** The side the pad shows, which is `side` once it has turned over to it: on your page (or who you follow), the page is laid out for it. */
  const [up, setUp] = useState<string | undefined>(side);
  /** Sign in: the ways in, on the pad; or straight to Google, where it is the only way. */
  const signInNow = () => (ways?.length === 1 && ways[0] === 'google' ? void signIn() : setWayIn(true));
  const [code, setCode] = useState(invited);
  const nameField = useRef<HTMLInputElement>(null);
  const typed = code.trim().toUpperCase();
  const ready = !!sitAs && !busy;
  /** A table picked off the list: as if its code were typed and Join pressed; without a name yet, the code waits in its field for one. */
  const pick = (room: string) => {
    if (busy) return;
    setCode(room);
    if (ready) go(room);
    else nameField.current?.focus();
  };
  const field = (
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
  );

  // Enter in the form does the obvious thing: join if a code is filled in, otherwise start a table.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    if (!typed) go(null);
    else if (isRoomCode(typed)) go(typed);
  };

  return (
    <main className={`home${up === 'page' || up === 'following' ? ' ownpage' : ''}`}>
      <div className="hero">
        <Spread />
        <h1>Nertz!</h1>
      </div>

      <Pad side={side} onUp={setUp}>
        {side === 'following' && signedIn ? (
          <FollowingList head={<Back onClick={() => goBack(signedIn.handle)} />} />
        ) : side === 'page' && signedIn ? (
          <Profile account={signedIn} head={<Back onClick={() => goBack()} />} />
        ) : side === 'in' && ways ? (
          <SignIn ways={ways} head={<Back onClick={() => setWayIn(false)} />} />
        ) : (
          <form onSubmit={submit}>
            <h2>Pull up a chair</h2>
            {sits === 'you' && signedIn ? (
              <div className="named">
                <button type="button" className="you" onClick={() => showPage(signedIn.handle)}>
                  <Avatar image={signedIn.picture ?? signedIn.image} name={signedIn.name} />
                  <span>{signedIn.name}</span>
                </button>
                <YourBacks colour={BACKS[0]} compact />
              </div>
            ) : sits === 'guest' ? (
              <>
                <div className="named">
                  <span className="guest">
                    <span className="you">
                      <Avatar image={null} name={null} />
                      <span>Guest</span>
                    </span>
                    {ways && (
                      <button type="button" className="signin-now" onClick={signInNow}>
                        <SignInDoor />
                        Sign in
                      </button>
                    )}
                  </span>
                  <YourBacks colour={BACKS[0]} compact />
                </div>
                <div className="plays">{field}</div>
              </>
            ) : sits === 'name' ? (
              <div className="named">
                <span className="own">
                  {signedIn && (
                    <button type="button" className="you" aria-label="Your page" data-tip="Your page" onClick={() => showPage(signedIn.handle)}>
                      <Avatar image={signedIn.picture ?? signedIn.image} name={null} />
                    </button>
                  )}
                  {field}
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
              {reach.others && <div className="way">
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
              </div>}
            </div>
            {reach.others ? <Tables onPick={pick} aside={mode} /> : <div className="foot">{mode}</div>}
          </form>
        )}
      </Pad>
    </main>
  );
}

/**
 * The table's sheet: its head (the code, the link, and the tools), everyone at it and watching (`Sitters`), and a foot.
 * In the lobby the foot deals (`Lobby`); after the deal, until Start, whoever deals has it over the felt with Done
 * (`TableSheet`). One sheet, so what is done to the table before Start is done where it was done before the deal.
 */
function Lobby({ room }: { room: RoomView }) {
  const me = room.players.find((p) => p.id === room.me);
  const host = room.players.find((p) => p.isHost);
  const ready = enoughToDeal(room);
  return (
    <main className="solo">
      <Pad className="lobby">
        <TableHead room={room} />
        <Sitters room={room} />
        <TableRules room={room} />
        {me?.isHost ? (
          <button className="go" disabled={!ready} onClick={start}>
            {ready ? 'Deal the first round' : <Short />}
          </button>
        ) : (
          <p className="wait">Waiting for {host?.name ?? 'the host'} to deal.</p>
        )}
      </Pad>
    </main>
  );
}

/**
 * The lobby's sheet over the felt, for whoever deals, between the deal and their Start (opened from the names under
 * Start: Opening.tsx). The same head and seats; not the table's rules, which the round was dealt by (the server takes no
 * change to them in a round). Done, a press beside the sheet, or Escape puts it away.
 */
function TableSheet({ room, onClose }: { room: RoomView; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <main className="solo over lobby" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <Pad className="lobby">
        <TableHead room={room} />
        <Sitters room={room} />
        <button className="go" autoFocus onClick={onClose}>
          Done
        </button>
      </Pad>
    </main>
  );
}

/** Copies `text` to the clipboard, and says so for a moment. Where the clipboard is blocked, nothing: what it would copy is there to read. */
function useCopy(text: string): [copied: boolean, copy: () => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked
    }
  };
  return [copied, copy];
}

/** The head of the table's sheet: the tools (a bot, for whoever deals; leaving), and the table's code and its link to copy. */
function TableHead({ room }: { room: RoomView }) {
  const me = room.players.find((p) => p.id === room.me);
  const [codeCopied, copyCode] = useCopy(room.code);
  const [copied, copy] = useCopy(`${location.origin}/?room=${room.code}`);
  const { others } = useReach();

  return (
    <>
        <div className="tools top">
          {me?.isHost && <AddBot room={room} />}
          <Act id="leave" room={room} />
        </div>
        {/* A table nobody else can come to has no code to give anyone: where it would be, that says so. */}
        {!others ? <h2>Table <span className="code">Offline</span></h2> : <h2>
          Table{' '}
          {/* The code itself is a button: pressed, it is copied (just the code, for saying or typing; the chain after it copies the link). */}
          <button type="button" className="code copy" aria-label={`Table code ${room.code}: copy it`} data-tip="Copy the code" onClick={copyCode}>
            {room.code}
            {codeCopied && <small>Copied</small>}
          </button>
          <button type="button" className="invite" onClick={copy} aria-label="Copy the link to this table" data-tip={copied ? 'Copied' : 'Copy the link'}>
            {copied ? <Check /> : <LinkIcon />}
          </button>
        </h2>}
    </>
  );
}

/** Everyone at the table and watching: you under the head, the others' places, then who watches; and the backs being chosen. */
function Sitters({ room }: { room: RoomView }) {
  const me = room.players.find((p) => p.id === room.me);
  const prefs = usePrefs();
  /** Whose backs are being chosen, if the sheet of backs is open: yours (seated or watching), or a bot's (by its seat). */
  const [picking, setPicking] = useState<'you' | number | null>(null);
  const picked = room.players.filter(hasSeat).find((p) => p.seat === picking && me?.isHost && p.bot);
  /** The back a bot whose backs are being chosen has now: plain, for a lot not drawn yet. */
  const botHas = (picked && shownBack(picked.look.backs)) ?? 'plain';
  const seated = room.players.filter(hasSeat);
  /** Everyone else at the table, in the order they sat down (their seat is their colour, not their place in the list). */
  const rest = seated.filter((p) => p.id !== room.me).sort((a, b) => (a.sat ?? 0) - (b.sat ?? 0));
  /** One player's place on the sheet: their back, their name, a note, and what you may do to them. */
  const place = (p: (typeof seated)[number]) => (
    <li key={p.id} className={`${p.connected ? '' : 'away'}${p.id === room.me ? ' you' : ''}`}>
      {/* The card beside a name is that player's back. A bot's, if you deal, opens the backs to choose another. */}
      {me?.isHost && p.bot ? (
        <button type="button" className="swatch" aria-label={`Change ${p.name}'s card backs`} data-tip={`Change ${p.name}'s card backs`} onClick={() => setPicking(p.seat)}>
          <Mini seat={p.seat} look={p.look} />
        </button>
      ) : (
        <Mini seat={p.seat} look={p.look} />
      )}
      {/* The name, with the dealer's button. On a phone the note and what you may do go on a small line under it. */}
      <span className="person" data-tip={p.name}>
        {p.picture && <img className="face" src={p.picture} alt="" />}
        <Name host={p.isHost} className="name">
          {me?.isHost && p.bot ? <BotName name={p.name} seat={p.seat} /> : <Named who={p}>{p.name}</Named>}
        </Name>
      </span>
      <span className="note">
        {[p.id === room.me && 'you', p.left ? 'left' : !p.connected && 'away'].filter(Boolean).join(', ')}
        {/* A bot: the robot, and how quick it is. */}
        {p.bot && (
          <span className="botnote" data-tip={`${p.bot} bot`} aria-label={`${p.bot} bot`}>
            <Robot />
            {p.bot === 'medium' ? 'med' : p.bot}
          </span>
        )}
      </span>
      <span className="deeds">
        {p.handle && <Follow handle={p.handle} name={p.name} small />}
        {!p.bot && (p.id === room.me || me?.isHost) && <StandUp room={room} who={p} />}
        {me?.isHost && p.id !== room.me && <Unseat who={p} />}
      </span>
    </li>
  );

  return (
    <>
        {/* Under the title: you. Your colour, your backs (the card, which changes them) and your name; or, watching, the same in grey,
            with a tag that says so. You keep this place whether you sit or watch. */}
        {me && (
          <div className={`top${me.connected ? '' : ' away'}${hasSeat(me) ? '' : ' watcher'}`}>
            {/* Your colour is your seat. Until the first deal it can be changed for any that nobody has: a dot of it, and behind
                the dot the ones still free. Watching, you have none: the dot is grey and still. Not once dealt: your seat is your hand. */}
            {room.phase === 'lobby' && room.round === 0 &&
              (hasSeat(me) ? (
                <Colour room={room} seat={me.seat} />
              ) : (
                <span className="colour">
                  <button type="button" className="dot" disabled aria-label="No colour while watching" />
                </span>
              ))}
            {/* One button: the card, and tucked under its bottom edge a small yellow tag saying what pressing it does. Watching, in grey. */}
            <button type="button" className="change" aria-label="Change your card back" data-tip={prefs.random ? 'Your card backs: drawn by lot when the round is dealt. Change them' : 'Change your card backs'} onClick={() => setPicking('you')}>
              <Mini seat={hasSeat(me) ? me.seat : 0} look={lookOf(prefs)} />
              <span>Change</span>
            </button>
            <span className="who">
              <span className="person" data-tip={me.name}>
                <Name host={me.isHost} className="name">
                  {me.name}
                </Name>
                {!hasSeat(me) && <span className="badge">{me.queued ? 'Waiting' : 'Spectating'}</span>}
              </span>
              <span className="note">
                you
                {hasSeat(me) && <StandUp room={room} who={me} />}
                {/* Spectating (you stood up, or came in to a full table): a seat is yours for the asking, the chair tucked in where
                    standing up's was; at a full table, words, since a chair cannot say you will wait for one. */}
                {!hasSeat(me) && !me.queued && freeSeats(room.seats) > 0 && (
                  <button type="button" className="standup seat-art" aria-label="Take a seat" data-tip="Take a seat" onClick={() => sit(true)}>
                    <Sit />
                  </button>
                )}
                {!hasSeat(me) && !me.queued && freeSeats(room.seats) === 0 && (
                  <button type="button" className="sit" onClick={() => sit(true)}>
                    Join the queue
                  </button>
                )}
                {me.queued && (
                  <button type="button" className="sit" onClick={() => sit(false)}>
                    Just watch
                  </button>
                )}
              </span>
            </span>
          </div>
        )}
        {/* Every other place a table can ever have, so the sheet is one size however many sit down (or seats there are):
            who sits, then the table's empty seats, then bare lines. Three by three. */}
        <ul className="seats">
          {rest.map(place)}
          {Array.from({ length: Math.max(0, MAX_PLAYERS - 1 - rest.length) }, (_, i) => (
            <li key={`place-${i}`} className={i < room.seats.of - seated.length ? 'open' : 'bare'} aria-hidden="true">
              <span className="mini" />
            </li>
          ))}
        </ul>
        <Watching room={room} butYou />
        {picking === 'you' && me && <YourBackPicker colour={backColour(hasSeat(me) ? me.seat : 0)} onClose={() => setPicking(null)} />}
        {picked && (
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
        )}
    </>
  );
}

/** On the score sheet: your settings, which is to say the corner's menu opened there (they head it), and if you host, the table's at the bottom of them. */
function SettingsGear() {
  const open = useCorner() === 'menu';
  return (
    <button type="button" className={`icon${open ? ' on' : ''}`} aria-expanded={open} aria-controls={open ? 'menu' : undefined} aria-label="Settings" data-tip="Settings" onClick={() => openCorner('menu')}>
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
      <button type="button" className="top" aria-expanded={all} data-tip={all ? 'Hide the snipes' : 'Show every snipe'} onClick={() => setAll(!all)}>
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
            <li key={`${s.by}>${s.of}`} data-tip={`${who(s.by)} sniped ${who(s.of)}${s.n > 1 ? ` ${s.n} times` : ''}`}>
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
      {rounds > 0 && rounds < room.round && <small data-tip={`over ${rounds} of the table's ${room.round} rounds`}>({rounds})</small>}
    </td>
    </>
  );

  return (
    <main className="solo over">
      <Pad wide>
        <h2>Round {room.round}</h2>
        {/* Who got Nertz is said in their own lines of the sheet, with the stamp in the Nertz column; only a round that ended some other way gets a sentence. (Not if all who got it were sent away since: a bot that called, then removed.) */}
        {!rows.some((s) => out.includes(s.seat)) && <p className="lead">{end?.by === 'jam' ? 'The table jammed: nobody could move. Scored as it stands.' : end?.by === 'vote' ? (end.voters > 1 ? 'Everyone agreed to end the round. Scored as it stands.' : 'Scored as it stands.') : 'Round over.'}</p>}
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
              /** No longer at the table: they stood up since (watching, or waiting for a seat again), or left. Their line is the round's, faint, the chip an outline: the colour is not theirs any more. */
              const up = !p ? 'Left' : hasSeat(p) ? null : p.queued ? 'Waiting for a seat' : 'Spectating';
              return (
              <tr key={s.seat} className={`${s.id === room.me ? 'you' : ''}${up ? ' up' : ''}`}>
                <th scope="row">
                  <span className="who">
                  <i className="chip" style={up ? { borderColor: backColour(s.seat) } : { background: backColour(s.seat) }} data-tip={up ?? undefined} />
                  <Name host={p?.isHost} className="nm">
                    {me?.isHost && p?.bot && p.seat !== null ? <BotName name={p.name} seat={p.seat} /> : <Named who={p}>{s.name}</Named>}
                  </Name>
                  {p?.handle && <Follow handle={p.handle} name={p.name} small />}
                  {p && !p.bot && p.seat !== null && (p.id === room.me || me?.isHost) && <StandUp room={room} who={p} />}
                  {p && me?.isHost && p.id !== room.me && <Unseat who={p} />}
                  </span>
                </th>
                <td>{signed(s.played)}</td>
                {/* Whoever got Nertz has no cards left in that pile: where the 0 would be, the stamp that lay across their hand. */}
                <td>
                  {out.includes(s.seat) ? (
                    <span className="called" data-tip={`${s.id === room.me ? 'You' : s.name} got Nertz`}>
                      Nertz!
                    </span>
                  ) : s.nertzLeft ? (
                    <>
                      <small className="left" data-tip={`${s.nertzLeft} left in the nertz pile`}>{s.nertzLeft}</small>
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
                    <Name host={p.isHost} className="nm">
                      <Named who={p}>{p.name}</Named>
                    </Name>
                    {p.handle && <Follow handle={p.handle} name={p.name} small />}
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
            {enoughToDeal(room) ? 'Next round' : <Short />}
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
