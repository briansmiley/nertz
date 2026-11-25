// Settings. Two kinds, kept apart:
// - `Corner`: on every screen, bottom left, one button (☰) and the menu it opens
//   (Menu.tsx): your settings at the top (`YourSettings`: sound, motion, keys),
//   and under them sound on or off (also a key of your choosing, M at first),
//   what can be done to the table during a round (actions.ts), and the way to
//   feedback. While the sound is off, a small badge in the chat bar (Chat.tsx)
//   says so, and turns it back on. The score sheet's gear opens the same menu.
//   Whoever hosts finds the table's own settings at the bottom of theirs: chat
//   and voice, and between rounds the house rules.
// - `TableRules`: the house rules on the lobby sheet, for everyone to read.
// Also the small icon buttons the sheets share (`Pop`, `Robot`, `RobotPlus`; the rest are in icons.tsx).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TableSettings } from '../shared/settings';
import { DECKS, fewestSeats, MAX_PLAYERS } from '../shared/protocol';
import type { RoomView } from '../shared/types';
import { setSeats, setTableSettings } from './net';
import { pauseKeyAction, perform, tableActions } from './actions';
import { Menu, openCorner, useCorner } from './Menu';
import { Gear, MenuIcon } from './icons';
import { YourBacks } from './BackPicker';
import { useDismiss } from './dismiss';
import { FeedbackSlip } from './Feedback';
import { UsageSlip } from './Usage';
import { signedIn, useAccount } from './account';
import { useCorners } from './fittings';
import type { ClockAt } from './layout';
import { SaidWord, useHotkey } from './hotkey';
import { BACKS } from './cards/Face';
import { calm, CHANNELS, FACES, getPrefs, HOTKEYS, keyName, setLevel, setPrefs, takeKey, touchOnly, usePrefs, type Channel, type Faces, type Hotkey, type Prefs } from './prefs';
import { setSocial, useSocial } from './social';

/** Each hotkey as the settings list it. */
const HOTKEY_LABELS: Record<Hotkey, string> = { soundKey: 'Mute sound', voiceKey: 'Mute mic', pauseKey: 'Pause' };

/** Each choice of whose faces you see on every card, as the settings list it, and as its (i) says it. */
const FACES_SAID: Record<Faces, [string, string]> = {
  owner: ["Owner's", "the style its owner chose"],
  mine: ['Mine', 'every card in your style (consistent)'],
  big: [DECKS.big, `every card in ${DECKS.big} (legible)`],
};

/**
 * A small (i) beside a setting: its explanation shows on hover, on keyboard focus, or on a tap (which focuses it; a
 * tap anywhere else puts it away). Inside a checkbox's label, so a click on it must not tick the box. Its empty
 * `data-tip` keeps the tip of what it sits in (the locked table rules) from showing over its own.
 */
function Info({ children }: { children: ReactNode }) {
  return (
    <span
      className="info"
      data-tip=""
      role="button"
      tabIndex={0}
      aria-label="More about this"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.focus();
      }}
    >
      i<span className="tip" role="tooltip">{children}</span>
    </span>
  );
}

/** A robot's head. */
export function Robot() {
  return (
    <svg viewBox="0 2 15.5 17.5" aria-hidden="true">
      <rect x="2" y="8" width="11.5" height="10" rx="2.5" />
      <path d="M7.75 8V5" />
      <circle cx="7.75" cy="4.2" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="5.7" cy="12.6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9.8" cy="12.6" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Add a bot: a robot's head, big (marigold antenna tips, a club and a spade for eyes, a red ear), and a plus beside it.
 * Drawn bare (no round button around it), so it is its own button (`Pop`'s `bare`).
 */
export function RobotPlus() {
  return (
    <svg className="robotplus" viewBox="0 0 24 24" aria-hidden="true">
      {/* (The head low in the square, level with the plus beside it, the antennae with the room above; tipped, as a card is.) */}
      <g transform="translate(0 2.2) rotate(-10 10 14.25)">
        <path d="M7 8.5V5.6M13 8.5V5.6" />
        <circle className="bulb" cx="7" cy="4.3" r="1.3" />
        <circle className="bulb" cx="13" cy="4.3" r="1.3" />
        <rect className="ear" x="1.3" y="11.6" width="2" height="4.4" rx="1" />
        <rect className="blank" x="3.3" y="8.5" width="13.4" height="11.5" rx="2.4" />
        <g className="eyes">
          <g transform="translate(7.5 12.9) scale(1.75)">
            <circle cy="-0.75" r="0.6" />
            <circle cx="-0.68" cy="0.28" r="0.6" />
            <circle cx="0.68" cy="0.28" r="0.6" />
            <path d="M-0.4 1.45 0 0.2 0.4 1.45Z" />
          </g>
          <path transform="translate(12.5 12.9) scale(1.75)" d="M0-1.35C.8-.45 1.3 0 1.3.58A.65.65 0 0 1 .18.95L.4 1.45H-.4L-.18.95A.65.65 0 0 1-1.3.58C-1.3 0-.8-.45 0-1.35Z" />
        </g>
        <path d="M8 17h4" />
      </g>
      <path className="plus" d="M21.1 14v5M18.6 16.5h5" />
    </svg>
  );
}

/**
 * A round icon button that opens a small slip above it. A press anywhere else or Escape puts it away. (`bare`: the icon
 * is the button itself, with no circle around it, in a plain square that is its hitbox.)
 */
export function Pop({ icon, label, bare, children }: { icon: ReactNode; label: string; bare?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useDismiss(root, open, () => setOpen(false));
  return (
    <span className="pop-at" ref={root}>
      <button type="button" className={`icon${bare ? ' bare' : ''}${open ? ' on' : ''}`} aria-expanded={open} aria-label={label} data-tip={label} onClick={() => setOpen(!open)}>
        {icon}
      </button>
      {open && (
        <div className="pop" role="dialog" aria-label={label}>
          {children}
        </div>
      )}
    </span>
  );
}

/** A pair of glasses: those who are only watching. */
function Glasses() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6.5" cy="13.5" r="3.6" />
      <circle cx="17.5" cy="13.5" r="3.6" />
      <path d="M10.1 13a2 2 0 0 1 3.8 0M2.9 13 4.6 7.2M21.1 13l-1.7-5.8" />
    </svg>
  );
}

/** The switch for those only watching: a pair of glasses, lit (yellow) while they are let in, faint while not. (`what`: the thing switched, for a screen reader, which is told on or off by `aria-pressed`.) */
function Specs({ on, disabled, what, onChange }: { on: boolean; disabled: boolean; what: string; onChange: (on: boolean) => void }) {
  return (
    <button type="button" className={`specs${on ? ' on' : ''}`} aria-pressed={on} aria-label={`${what} for spectators`} data-tip={`${on ? 'Enabled' : 'Disabled'} for spectators`} disabled={disabled} onClick={(e) => (onChange(!on), e.currentTarget.blur())}>
      <Glasses />
    </button>
  );
}

const percent = (v: number) => `${Math.round(v * 100)}%`;

/** Each channel as the row under Volume names it, and in full. */
const CHANNEL_NAMES: Record<Channel, [short: string, full: string]> = { mine: ['Yours', 'Your cards'], others: ['Others', "Other players' cards"], voice: ['Voice', 'Voice chat'] };

/** Volume, for everything; under it a row of the channels' levels, of which the one pressed opens its own slider. */
function Volume({ prefs }: { prefs: Prefs }) {
  const [open, setOpen] = useState<Channel | null>(null);
  const slider = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) slider.current?.focus();
  }, [open]);
  const { levels } = prefs;
  const quiet = (ch: Channel) => prefs.muted && ch !== 'voice';
  return (
    <div className="volume">
      <label className="level">
        <span>
          Volume <output>{percent(levels.master)}</output>
        </span>
        <input type="range" min="0" max="1" step="0.05" value={levels.master} onChange={(e) => setLevel('master', Number(e.target.value))} />
      </label>
      <div className="mix">
        {CHANNELS.map((ch) => (
          <button
            key={ch}
            type="button"
            className={`${open === ch ? 'on' : ''}${quiet(ch) ? ' quiet' : ''}`}
            aria-expanded={open === ch}
            aria-controls={open === ch ? 'mix-level' : undefined}
            data-tip={CHANNEL_NAMES[ch][1]}
            onClick={() => setOpen(open === ch ? null : ch)}
          >
            {CHANNEL_NAMES[ch][0]}
            <output>{percent(levels[ch])}</output>
          </button>
        ))}
      </div>
      {open && (
        <input
          id="mix-level"
          ref={slider}
          type="range"
          min="0"
          max="1"
          step="0.05"
          aria-label={CHANNEL_NAMES[open][1]}
          value={levels[open]}
          disabled={quiet(open)}
          onChange={(e) => setLevel(open, Number(e.target.value))}
        />
      )}
    </div>
  );
}

/**
 * On a phone, how to be rid of the browser's bars. Where the browser can take the whole screen when asked (Android),
 * a button does it. An iPhone cannot be asked: there the game has to be put on the home screen and opened from it.
 * Nothing is shown with a mouse, nor once the game already has the screen to itself.
 */
function WholeScreen() {
  const [full, setFull] = useState(() => !!document.fullscreenElement);
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const alone = window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || (navigator as { standalone?: boolean }).standalone === true;
  if (!window.matchMedia('(pointer: coarse)').matches || (alone && !full)) return null;
  const able = document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === 'function';
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return (
    <div className="whole">
      <b>Whole screen</b>
      {able ? (
        <button type="button" className="go" onClick={() => (full ? document.exitFullscreen() : document.documentElement.requestFullscreen({ navigationUI: 'hide' })).catch(() => {})}>
          {full ? 'Leave full screen' : 'Use the whole screen'}
        </button>
      ) : (
        <small>
          {apple
            ? 'To hide the browser\u2019s bars: in Safari tap Share, then \u201cAdd to Home Screen\u201d, and open Nertz from there.'
            : 'To hide the browser\u2019s bars: open the browser\u2019s menu, choose \u201cAdd to Home screen\u201d, and open Nertz from there.'}
        </small>
      )}
    </div>
  );
}

/** The round's clock, m:ss: counted on locally from what the last snapshot said while it runs (not while paused, nor once the round is over). It stands where the table has room for it (layout.ts, `Layout.clock`). */
export function Clock({ clock, at }: { clock: NonNullable<RoomView['clock']>; at: ClockAt }) {
  const [ms, setMs] = useState(clock.ms);
  useEffect(() => {
    setMs(clock.ms);
    if (!clock.running) return;
    const since = performance.now(); // `clock.ms` was the time when the snapshot was sent
    const timer = setInterval(() => setMs(clock.ms + performance.now() - since), 250);
    return () => clearInterval(timer);
  }, [clock]);
  const s = Math.floor(ms / 1000);
  const text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return (
    <time className={`clock${at.small ? ' small' : ''}${clock.running ? '' : ' stopped'}`} style={{ left: at.x, top: at.y }} role="timer" aria-label={`Round time ${text}`}>
      {text}
    </time>
  );
}

/** The corner controls. Rendered once, by App, over whatever screen is up. */
export function Corner({ room }: { room?: RoomView | null }) {
  const prefs = usePrefs();
  /** The slip that is open: the menu, or feedback or how much the game is played (which it leads to). One at a time. */
  const open = useCorner();
  const admin = !!signedIn(useAccount())?.admin;
  useEffect(() => () => openCorner(null), []); // (a slip does not follow you from one screen's corner to the next)
  const root = useRef<HTMLDivElement>(null);

  // The sound key mutes from anywhere (except while typing a name), and says so on the button.
  const said = useHotkey(prefs.soundKey, () => {
    const muted = !getPrefs().muted;
    setPrefs({ muted });
    return muted ? 'Muted' : 'Unmuted';
  });
  // The pause key pauses or unpauses, when you may; the card over a paused table says so, not the button.
  const pausing = pauseKeyAction(room);
  useHotkey(prefs.pauseKey, room && pausing ? () => (perform(pausing, room), pausing === 'pause' ? 'Paused' : 'Resumed') : null);

  /** What can be done to the table now (actions.ts). */
  const actions = room ? tableActions(room) : [];
  useDismiss(root, !!open, () => openCorner(null));

  /** Where the button stands (layout.ts: the table keeps clear of exactly that). */
  const at = useCorners(room);
  return (
    <div className={`corner${at.shape === 'tall' ? ' top' : ''}`} ref={root} style={{ left: at.knobs.x, top: at.knobs.y }}>
      <button
        type="button"
        className={`knob${open ? ' on' : ''}`}
        aria-expanded={!!open}
        aria-controls="menu"
        aria-label="Menu"
        data-tip="Menu"
        onClick={(e) => {
          openCorner(open ? null : 'menu');
          e.currentTarget.blur(); // keep Space for drawing
        }}
      >
        <MenuIcon />
        <SaidWord said={said} />
      </button>
      {open === 'menu' && (
        <Menu room={room} actions={actions} muted={prefs.muted} onMute={() => setPrefs({ muted: !prefs.muted })} onFeedback={() => openCorner('feedback')} onUsage={admin ? () => openCorner('usage') : undefined} onDone={() => openCorner(null)}>
          <YourSettings room={room} prefs={prefs} />
        </Menu>
      )}
      {open === 'feedback' && <FeedbackSlip room={room} back={() => openCorner('menu')} close={() => openCorner(null)} />}
      {open === 'usage' && admin && <UsageSlip back={() => openCorner('menu')} />}
    </div>
  );
}

/** Your settings, at the top of the corner's menu under a gear; whoever hosts finds the table's at the bottom of them. */
function YourSettings({ room, prefs }: { room?: RoomView | null; prefs: Prefs }) {
  const social = useSocial();
  const hosting = !!room?.players.find((p) => p.id === room.me)?.isHost;
  /** The hotkey being chosen: the next key pressed is it (Escape leaves it as it was, Backspace takes it away). Closing the menu drops it. */
  const [keying, setKeying] = useState<Hotkey | null>(null);
  useEffect(() => {
    if (!keying) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation(); // (not a game key, nor a hotkey itself, while one is being chosen)
      const taken = takeKey(getPrefs(), keying, e.code);
      if (e.code === 'Backspace' || e.code === 'Delete') setPrefs({ [keying]: null });
      else if (taken) setPrefs(taken); // (a hotkey of yours that had this key is left with none)
      else if (e.code !== 'Escape') return; // a key the game uses: wait for another
      setKeying(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [keying]);

  /** May the cards' style be changed now? Not once a round is under way (the count, and play). */
  const stage = room?.game?.status.at;
  const styling = stage !== 'countdown' && stage !== 'play' && stage !== 'grace';

  return (
    <section className="yours" aria-labelledby="your-settings">
      <h3 id="your-settings">
        <Gear />
        Settings
      </h3>
      <Volume prefs={prefs} />
      <label className="check">
        <input type="checkbox" checked={prefs.botVoice} disabled={prefs.muted} onChange={(e) => setPrefs({ botVoice: e.target.checked })} />
        <span>Bots say "Nertz"</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.chatOver} onChange={(e) => setPrefs({ chatOver: e.target.checked })} />
        <span>Show chat over the table</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.ping} onChange={(e) => setPrefs({ ping: e.target.checked })} />
        <span>Show ping</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={calm()} onChange={(e) => setPrefs({ calm: e.target.checked })} />
        <span>Reduce motion</span>
      </label>
      {/* (Any time, a round or not: it changes the cards for nobody but you.) */}
      <div className="faces">
        <span id="faces-label">
          Card faces{' '}
          <Info>
            How card faces display:
            {FACES.map((f) => (
              <span key={f} className="line">
                {FACES_SAID[f][0]}: {FACES_SAID[f][1]}
              </span>
            ))}
            <span className="line">Card backs don't change.</span>
          </Info>
        </span>
        <span role="radiogroup" aria-labelledby="faces-label">
          {FACES.map((f) => (
            <button key={f} type="button" role="radio" aria-checked={prefs.faces === f} className={prefs.faces === f ? 'on' : ''} onClick={(e) => (setPrefs({ faces: f }), e.currentTarget.blur())}>
              {FACES_SAID[f][0]}
            </button>
          ))}
        </span>
      </div>
      {/* Not while a round is being played (from the count on): cards changing under people's hands is untidy. Before Start, and between rounds, as you like. */}
      <div className={`level${styling ? '' : ' locked'}`}>
        <span>Card back</span>
        <YourBacks colour={BACKS[0]} locked={!styling} />
      </div>
      {/* Keys: only where there is a keyboard. */}
      {!touchOnly() && (
        <div className="hotkeys">
          <h3>Hotkeys</h3>
          {HOTKEYS.map((k) => {
            const code = prefs[k];
            return (
              <p key={k}>
                {HOTKEY_LABELS[k]}
                <button type="button" className={keying === k ? 'on' : ''} data-tip="Press, then press the key you want. Backspace: no key." onClick={(e) => (setKeying(keying === k ? null : k), e.currentTarget.blur())}>
                  {keying === k ? 'Press a key…' : code ? keyName(code) : 'none'}
                </button>
              </p>
            );
          })}
        </div>
      )}
      {/* Whoever hosts: whether this table has text chat and voice at all, and between rounds its house rules. */}
      {room && hosting && (
        <div className="end-vote">
          <h3>Host</h3>
          {/* Each row: the switch for the table, and at its end the same for those only watching (the glasses). */}
          <div className="allow">
            <label className="check">
              <input type="checkbox" checked={social.text} onChange={(e) => setSocial({ text: e.target.checked })} />
              <span>Allow text chat</span>
            </label>
            <Specs on={social.text && social.watchText} disabled={!social.text} what="Text chat" onChange={(watchText) => setSocial({ watchText })} />
          </div>
          <div className="allow">
            <label className="check">
              <input type="checkbox" checked={social.voice} onChange={(e) => setSocial({ voice: e.target.checked })} />
              <span>Allow voice chat</span>
            </label>
            <Specs on={social.voice && social.watchVoice} disabled={!social.voice} what="Voice chat" onChange={(watchVoice) => setSocial({ watchVoice })} />
          </div>
          {room.phase !== 'playing' && (
            <div className="rules">
              <Rules room={room} mine />
            </div>
          )}
        </div>
      )}
      <WholeScreen />
    </section>
  );
}

/** How many may sit at the table: a number between a minus and a plus. Each tap is one seat more or fewer; the server keeps it within its bounds. */
function SeatCount({ room, mine }: { room: RoomView; mine: boolean }) {
  const n = room.seats.of;
  return (
    <div className="stepper">
      <span id="seats-label">Seats</span>
      <span role="group" aria-labelledby="seats-label">
        <button type="button" aria-label="Fewer seats" disabled={!mine || n <= fewestSeats(room.seats)} onClick={() => setSeats(-1)}>
          −
        </button>
        <output aria-live="polite">{n}</output>
        <button type="button" aria-label="More seats" disabled={!mine || n >= MAX_PLAYERS} onClick={() => setSeats(1)}>
          +
        </button>
      </span>
    </div>
  );
}

/**
 * The table's house rules: one row per option of `TableSettings` that the host is offered, and the number of seats.
 * Set by whoever hosts (`mine`), between rounds; read by everyone else.
 */
function Rules({ room, mine }: { room: RoomView; mine: boolean }) {
  const set = (patch: Partial<TableSettings>) => setTableSettings(patch);
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={room.settings.tapToMove} disabled={!mine} onChange={(e) => set({ tapToMove: e.target.checked })} />
        <span>
          Tap to play <Info>Allows tapping a card then its destination, without dragging</Info>
        </span>
      </label>
      <SeatCount room={room} mine={mine} />
    </>
  );
}

/** The house rules on the lobby sheet: everyone sees what the table plays by; whoever hosts can change them there too. */
export function TableRules({ room }: { room: RoomView }) {
  const mine = room.players.find((p) => p.isHost)?.id === room.me;
  return (
    <fieldset className={`rules${mine ? '' : ' locked'}`} data-tip={mine ? undefined : 'Only the room host can set these.'}>
      <legend>Table rules</legend>
      <Rules room={room} mine={mine} />
    </fieldset>
  );
}
