// Settings. Two kinds, kept apart:
// - `Corner`: on every screen, bottom left, one button (☰) and the menu it opens
//   (Menu.tsx): your settings at the top (`YourSettings`: sound, motion, keys),
//   and under them sound on or off (also a key of your choosing, M at first),
//   what can be done to the table during a round (actions.ts), and on a phone
//   the way to feedback (elsewhere it has a button of its own, bottom right).
//   While the sound is off, a small badge in the chat bar (Chat.tsx)
//   says so, and turns it back on. The score sheet's gear opens the same menu.
//   Whoever hosts finds the table's own settings at the bottom of theirs: chat
//   and voice, and between rounds the house rules.
// - `TableRules`: the seats and house rules on the lobby sheet, for everyone to read.
// Also the small icon buttons the sheets share (`Pop`, `Robot`, `RobotPlus`; the rest are in icons.tsx).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TableSettings } from '../shared/settings';
import { DECKS, fewestSeats, MAX_PLAYERS } from '../shared/protocol';
import type { RoomView } from '../shared/types';
import { setSeats, setTableSettings, setUnlisted, useConnected, useReach } from './net';
import { actionsAt, pauseKeyAction, perform } from './actions';
import { Menu, openCorner, useCorner } from './Menu';
import { Bug, Gear, MenuIcon } from './icons';
import { YourBacks } from './BackPicker';
import { useDismiss } from './dismiss';
import { FeedbackSlip } from './Feedback';
import { UsageSlip } from './Usage';
import { signedIn, useAccount } from './account';
import { remembered } from './record';
import { useCorners } from './fittings';
import type { ClockAt } from './layout';
import { SaidWord, useHotkey } from './hotkey';
import { BACKS } from './cards/Face';
import { calm, CHANNELS, FACES, getPrefs, HOTKEYS, keyName, setLevel, setPrefs, takeKey, touchOnly, usePrefs, type Channel, type Faces, type Hotkey, type Mic, type Prefs } from './prefs';
import { micInput, micShown, setMicLevel, useVoice } from './voice';
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
      {/* (The head and the plus level with each other and with the centre of the round buttons beside it, the antennae in the room above; tipped, as a card is.) */}
      <g transform="translate(0 -1) rotate(-10 10 14.25)">
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
      <path className="plus" d="M21.1 10.8v5M18.6 13.3h5" />
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
/** `voice`: there is voice chat to have a level for. */
function Volume({ prefs, voice }: { prefs: Prefs; voice: boolean }) {
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
      <div className={`mix${voice ? '' : ' few'}`}>
        {CHANNELS.filter((ch) => voice || ch !== 'voice').map((ch) => (
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

/** The two of your microphone, as the row under the channels names them, and in full. */
const MIC_NAMES: Record<keyof Mic, [short: string, full: string]> = { level: ['Mic', 'Your microphone'], gate: ['Gate', 'Microphone threshold'] };

/**
 * Your microphone as voice chat sends it: its level and its gate, in a row like the channels', of which the one pressed
 * opens its slider. Under Volume, and in the voice slip (Chat.tsx).
 */
export function MicLevels({ prefs }: { prefs: Prefs }) {
  const [open, setOpen] = useState<keyof Mic | null>(null);
  const slider = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) slider.current?.focus();
  }, [open]);
  const { mic } = prefs;
  const { muted } = useVoice();
  const shown: Mic = { ...mic, level: micShown(mic.level, muted) };
  return (
    <div className="mic-levels">
      <div className="mix">
        {(['level', 'gate'] as const).map((k) => (
          <button key={k} type="button" className={open === k ? 'on' : ''} aria-expanded={open === k} data-tip={MIC_NAMES[k][1]} onClick={() => setOpen(open === k ? null : k)}>
            {MIC_NAMES[k][0]}
            <output>{k === 'gate' && !mic.gate ? 'off' : k === 'level' && muted ? 'Muted' : percent(shown[k])}</output>
          </button>
        ))}
      </div>
      {open && (
        <div className="mic-slider">
          <input
            ref={slider}
            type="range"
            min="0"
            max={open === 'level' ? 2 : 1}
            step={open === 'level' ? 0.05 : 0.01}
            aria-label={MIC_NAMES[open][1]}
            value={shown[open]}
            onChange={(e) => (open === 'level' ? setMicLevel(Number(e.target.value)) : setPrefs({ mic: { ...getPrefs().mic, gate: Number(e.target.value) } }))}
          />
          {open === 'gate' && <Heard gate={mic.gate} />}
        </div>
      )}
    </div>
  );
}

/** Under the gate's slider while you are in voice: how loud you are now, on the slider's scale, green where it is sent. */
function Heard({ gate }: { gate: number }) {
  const on = useVoice().status === 'on';
  const [loud, setLoud] = useState<number | null>(null);
  useEffect(() => {
    if (!on) return setLoud(null);
    // (Falling back slowly, as a level meter does: the gate itself holds open a moment after a word.)
    const timer = setInterval(() => {
      const now = micInput();
      setLoud((was) => (now === null ? null : Math.max(now, (was ?? 0) * 0.85)));
    }, 50);
    return () => clearInterval(timer);
  }, [on]);
  if (loud === null) return null;
  return (
    <span className={`heard${loud >= gate ? ' over' : ''}`} role="meter" aria-label="Your microphone now" aria-valuemin={0} aria-valuemax={1} aria-valuenow={loud}>
      <i style={{ width: `${loud * 100}%` }} />
    </span>
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
  const actions = actionsAt(room ?? null, useReach(), useConnected());
  useDismiss(root, !!open, () => openCorner(null));

  /** Where the buttons stand (layout.ts: the table keeps clear of exactly that). */
  const at = useCorners(room);
  /** Feedback has a button of its own, bottom right; where there is no room for one (a phone), the menu leads to it. */
  const own = at.feedback;
  /** The menu, or a slip it led to, is up: the menu's button is lit, and pressed puts it away. */
  const menuUp = !!open && !(own && open === 'feedback');
  const feedback = open === 'feedback' && <FeedbackSlip room={room} back={own ? undefined : () => openCorner('menu')} close={() => openCorner(null)} />;
  return (
    // (One root for both: a press on either is inside, and leaves the other's slip to it.)
    <div className="corners" ref={root}>
      <div className={`corner${at.shape === 'tall' ? ' top' : ''}`} style={{ left: at.knobs.x, top: at.knobs.y }}>
        <button
          type="button"
          className={`knob${menuUp ? ' on' : ''}`}
          aria-expanded={menuUp}
          aria-controls="menu"
          aria-label="Menu"
          data-tip="Menu"
          onClick={(e) => {
            openCorner(menuUp ? null : 'menu');
            e.currentTarget.blur(); // keep Space for drawing
          }}
        >
          <MenuIcon />
          <SaidWord said={said} />
        </button>
        {open === 'menu' && (
          <Menu room={room} actions={actions} muted={prefs.muted} onMute={() => setPrefs({ muted: !prefs.muted })} onFeedback={own ? undefined : () => openCorner('feedback')} onUsage={admin ? () => openCorner('usage') : undefined} onDone={() => openCorner(null)}>
            <YourSettings room={room} prefs={prefs} />
          </Menu>
        )}
        {!own && feedback}
        {open === 'usage' && admin && <UsageSlip back={() => openCorner('menu')} />}
      </div>
      {own && (
        <div className="corner right" style={{ left: own.x, top: own.y }}>
          <button
            type="button"
            className={`icon${open === 'feedback' ? ' on' : ''}`}
            aria-expanded={open === 'feedback'}
            aria-label="Feedback"
            data-tip="Feedback"
            onClick={(e) => {
              openCorner(open === 'feedback' ? null : 'feedback');
              e.currentTarget.blur(); // keep Space for drawing
            }}
          >
            <Bug />
          </button>
          {feedback}
        </div>
      )}
    </div>
  );
}

/** Your settings, at the top of the corner's menu under a gear; whoever hosts finds the table's at the bottom of them. */
function YourSettings({ room, prefs }: { room?: RoomView | null; prefs: Prefs }) {
  const social = useSocial();
  /** Whether anyone else can come to the table (client/net.ts `Reach`): if not, nothing here of chat, of voice, or of the line to the server. Without the server, and with someone signed in here last (client/record.ts), whether rounds played count once it is back. */
  const { others, server } = useReach();
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

  return (
    <section className="yours" aria-labelledby="your-settings">
      <h3 id="your-settings">
        <Gear />
        Settings
      </h3>
      {/* Sound: what you hear (Output), and your microphone as voice chat sends it (Input). Offline there is no voice to send. */}
      <div className="sound">
        <h3>Sound</h3>
        <h4>Output</h4>
        <Volume prefs={prefs} voice={others} />
        <label className="check">
          <input type="checkbox" checked={prefs.botVoice} disabled={prefs.muted} onChange={(e) => setPrefs({ botVoice: e.target.checked })} />
          <span>Bots say "Nertz"</span>
        </label>
        {others && (
          <>
            <h4 className="input">Input</h4>
            <MicLevels prefs={prefs} />
          </>
        )}
      </div>
      {others && (
        <>
          <label className="check">
            <input type="checkbox" checked={prefs.chatOver} onChange={(e) => setPrefs({ chatOver: e.target.checked })} />
            <span>Show chat over the table</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={prefs.ping} onChange={(e) => setPrefs({ ping: e.target.checked })} />
            <span>Show ping</span>
          </label>
        </>
      )}
      {!server && remembered() && (
        <label className="check">
          <input type="checkbox" checked={prefs.saveStats} onChange={(e) => setPrefs({ saveStats: e.target.checked })} />
          <span>
            Save stats <Info>Games will count towards your record against bots when you go back online</Info>
          </span>
        </label>
      )}
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
      {/* Any time, a round or not: everyone sees your cards in the new back at once. */}
      <div className="level">
        <span>Card back</span>
        <YourBacks colour={BACKS[0]} />
      </div>
      {/* Keys: only where there is a keyboard. */}
      {!touchOnly() && (
        <div className="hotkeys">
          <h3>Hotkeys</h3>
          {HOTKEYS.filter((k) => others || k !== 'voiceKey').map((k) => {
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
      {/* Whoever hosts: whether this table has text chat and voice at all, whether it is listed, and between rounds its house rules. */}
      {/* (Where nobody else can come there are only the house rules, between rounds: in a round, nothing.) */}
      {room && hosting && (others || room.phase !== 'playing') && (
        <div className="end-vote">
          <h3>{others ? 'Host' : 'Table'}</h3>
          {/* Each row: the switch for the table, and at its end the same for those only watching (the glasses). */}
          {others && <><div className="allow">
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
          </div></>}
          {/* (Between rounds it is with the house rules below; mid-round, when they are hidden, here on its own.) */}
          {room.phase === 'playing' && <Private room={room} mine />}
          {room.phase !== 'playing' && (
            <>
              <SeatCount room={room} mine />
              <div className="rules">
                <Rules room={room} mine />
              </div>
            </>
          )}
        </div>
      )}
      <WholeScreen />
    </section>
  );
}

/**
 * How many may sit at the table: a number between a minus and a plus. Each tap is one seat more or fewer; the server keeps it within its bounds.
 * Not a house rule, so it sits above them. Set by whoever hosts (`mine`); greyed for everyone else, as the rules are.
 */
function SeatCount({ room, mine }: { room: RoomView; mine: boolean }) {
  const n = room.seats.of;
  // (Where nobody else can come, the seats are for bots alone, and are as many as you seat.)
  if (!useReach().others) return null;
  return (
    <div className={`stepper${mine ? '' : ' locked'}`} data-tip={mine ? undefined : 'Only the room host can set this.'}>
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
 * The table's house rules: one row per option of `TableSettings` that the host is offered, and whether the table is private.
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
      <Private room={room} mine={mine} />
    </>
  );
}

/** Whether the table is left off the open tables list. Unlike the house rules it can be switched mid-round too. */
function Private({ room, mine }: { room: RoomView; mine: boolean }) {
  // (A table nobody else can come to is on no list, and has no code.)
  if (!useReach().others) return null;
  return (
    <label className="check">
      <input type="checkbox" checked={room.unlisted} disabled={!mine} onChange={(e) => setUnlisted(e.target.checked)} />
      <span>
        Private table <Info>Left off the open tables list. Anyone with the code can still join.</Info>
      </span>
    </label>
  );
}

/** The seats and house rules on the lobby sheet: everyone sees what the table plays by; whoever hosts can change them there too. */
export function TableRules({ room }: { room: RoomView }) {
  const mine = room.players.find((p) => p.isHost)?.id === room.me;
  /** Where nobody else can come there is the one rule: it stands by itself, with no heading over it. */
  const { others } = useReach();
  return (
    <>
      <SeatCount room={room} mine={mine} />
      <fieldset className={`rules${mine ? '' : ' locked'}${others ? '' : ' one'}`} data-tip={mine ? undefined : 'Only the room host can set these.'} aria-label="Table rules">
        {others && <legend>Table rules</legend>}
        <Rules room={room} mine={mine} />
      </fieldset>
    </>
  );
}
