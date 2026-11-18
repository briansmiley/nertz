// Settings. Two kinds, kept apart:
// - `Corner`: on every screen, bottom left, one button (☰) and the menu it opens
//   (Menu.tsx): sound on or off (also a key of your choosing, M at first), what
//   can be done to the table during a round (actions.ts), and from there your
//   settings (sound, motion) and feedback. While the sound is off, a small badge
//   in the chat bar (Chat.tsx) says so, and turns it back on.
// - `TableRules`: the table's house rules, in the lobby and behind a gear on the
//   score sheet. The host changes them; everyone else reads them.
// Also the small icon buttons the sheets share (`Pop`, `Robot`; the rest are in icons.tsx).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TableSettings } from '../shared/settings';
import { fewestSeats, MAX_PLAYERS } from '../shared/protocol';
import type { RoomView } from '../shared/types';
import { pause, setSeats, setTableSettings } from './net';
import { canPause, canResume, tableActions } from './actions';
import { Back, Menu, type Panel } from './Menu';
import { MenuIcon } from './icons';
import { YourBacks } from './BackPicker';
import { useDismiss } from './dismiss';
import { FeedbackSlip } from './Feedback';
import { useCorners } from './fittings';
import type { ClockAt } from './layout';
import { SaidWord, useHotkey } from './hotkey';
import { BACKS } from './cards/Face';
import { calm, CHANNELS, getPrefs, HOTKEYS, keyName, setLevel, setPrefs, takeKey, touchOnly, usePrefs, type Channel, type Hotkey, type Prefs } from './prefs';
import { setSocial, useSocial } from './social';

/** Is this key press going into a text field (a name, a table code)? */
const typing = (el: EventTarget | null): boolean => (el instanceof HTMLInputElement ? !['range', 'checkbox'].includes(el.type) : el instanceof HTMLTextAreaElement);

/** Each hotkey as the settings list it. */
const HOTKEY_LABELS: Record<Hotkey, string> = { soundKey: 'Mute sound', voiceKey: 'Mute mic' };

/**
 * A small (i) beside a setting: its explanation shows on hover, on keyboard focus, or on a tap (which focuses it; a
 * tap anywhere else puts it away). Inside a checkbox's label, so a click on it must not tick the box.
 */
function Info({ children }: { children: ReactNode }) {
  return (
    <span
      className="info"
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

/** A robot's head; with a plus beside it (to add one) unless `plain`. */
export function Robot({ plain }: { plain?: boolean } = {}) {
  return (
    <svg viewBox={plain ? '0 2 15.5 17.5' : '0 0 24 24'} aria-hidden="true">
      <rect x="2" y="8" width="11.5" height="10" rx="2.5" />
      <path d="M7.75 8V5" />
      <circle cx="7.75" cy="4.2" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="5.7" cy="12.6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="9.8" cy="12.6" r="1.2" fill="currentColor" stroke="none" />
      {/* the plus, clear of the head */}
      {!plain && <path d="M19.8 10v5M17.3 12.5h5" />}
    </svg>
  );
}

/** An eye: standing up from the table to watch. */

/**
 * A round icon button that opens a small slip above it. A press anywhere else or Escape puts it away.
 */
export function Pop({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useDismiss(root, open, () => setOpen(false));
  return (
    <span className="pop-at" ref={root}>
      <button type="button" className={`icon${open ? ' on' : ''}`} aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen(!open)}>
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

/** The switch for those only watching: a pair of glasses, lit (yellow) while they are let in, faint while not. */
function Specs({ on, disabled, what, onChange }: { on: boolean; disabled: boolean; what: string; onChange: (on: boolean) => void }) {
  const says = on ? `Spectators can ${what} too. Press to keep them out` : `Spectators cannot ${what}. Press to let them`;
  return (
    <button type="button" className={`specs${on ? ' on' : ''}`} aria-pressed={on} aria-label={says} title={says} disabled={disabled} onClick={(e) => (onChange(!on), e.currentTarget.blur())}>
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
            title={CHANNEL_NAMES[ch][1]}
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
    <time className={`clock${at.small ? ' small' : ''}${clock.running ? '' : ' stopped'}`} style={{ left: at.x, top: at.y }} role="timer" aria-label={`Round time ${text}`} title="This round">
      {text}
    </time>
  );
}

/** The corner controls. Rendered once, by App, over whatever screen is up. */
export function Corner({ room }: { room?: RoomView | null }) {
  const prefs = usePrefs();
  const social = useSocial();
  const hosting = !!room?.players.find((p) => p.id === room.me)?.isHost;
  /** The slip that is open: the menu, or your settings or feedback (which it leads to). One at a time. */
  const [open, setOpen] = useState<Panel | null>(null);
  const root = useRef<HTMLDivElement>(null);
  /** The hotkey being chosen: the next key pressed is it (Escape leaves it as it was, Backspace takes it away). */
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
  useEffect(() => {
    if (open !== 'settings') setKeying(null);
  }, [open]);

  /** May the cards' style be changed now? Not once a round is under way (the count, and play). */
  const stage = room?.game?.status.at;
  const styling = stage !== 'countdown' && stage !== 'play' && stage !== 'grace';

  const pausable = canPause(room);
  const resumable = !!room && canResume(room);
  // The sound key mutes from anywhere (except while typing a name), and says so on the button.
  const said = useHotkey(prefs.soundKey, () => {
    const muted = !getPrefs().muted;
    setPrefs({ muted });
    return muted ? 'Muted' : 'Unmuted';
  });
  // P pauses or unpauses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'KeyP' && !typing(e.target) && (pausable || resumable)) pause(pausable);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pausable, resumable]);

  /** What can be done to the table now (actions.ts): none between rounds. */
  const actions = room ? tableActions(room) : [];
  useDismiss(root, !!open, () => setOpen(null));

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
        title="Menu"
        onClick={(e) => {
          setOpen(open ? null : 'menu');
          e.currentTarget.blur(); // keep Space for flipping
        }}
      >
        <MenuIcon />
        <SaidWord said={said} />
      </button>
      {open === 'menu' && <Menu room={room} actions={actions} muted={prefs.muted} onMute={() => setPrefs({ muted: !prefs.muted })} go={setOpen} onDone={() => setOpen(null)} />}
      {open === 'feedback' && <FeedbackSlip room={room} back={() => setOpen('menu')} />}
      {open === 'settings' && (
        <section className="slip" id="your-settings" aria-label="Settings">
          <header className="slip-head">
            <Back onClick={() => setOpen('menu')} />
            <h3>Settings</h3>
          </header>
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
            <input type="checkbox" checked={calm()} onChange={(e) => setPrefs({ calm: e.target.checked })} />
            <span>Reduce motion</span>
          </label>
          {/* Not while a round is being played (from the count on): cards changing under people's hands is untidy. Before Start, and between rounds, as you like. */}
          <div className={`level${styling ? '' : ' locked'}`}>
            <span>Card back</span>
            <YourBacks colour={BACKS[0]} locked={!styling} />
            {!styling && <small className="why">You can change card styles between rounds.</small>}
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
                    <button type="button" className={keying === k ? 'on' : ''} title="Press, then press the key you want. Backspace: no key." onClick={(e) => (setKeying(keying === k ? null : k), e.currentTarget.blur())}>
                      {keying === k ? 'Press a key…' : code ? keyName(code) : 'none'}
                    </button>
                  </p>
                );
              })}
            </div>
          )}
          {/* Whoever hosts: whether this table has text chat and voice at all. */}
          {hosting && (
            <div className="end-vote">
              <h3>Host</h3>
              {/* Each row: the switch for the table, and at its end the same for those only watching (the glasses). */}
              <div className="allow">
                <label className="check">
                  <input type="checkbox" checked={social.text} onChange={(e) => setSocial({ text: e.target.checked })} />
                  <span>Allow text chat</span>
                </label>
                <Specs on={social.text && social.watchText} disabled={!social.text} what="use text chat" onChange={(watchText) => setSocial({ watchText })} />
              </div>
              <div className="allow">
                <label className="check">
                  <input type="checkbox" checked={social.voice} onChange={(e) => setSocial({ voice: e.target.checked })} />
                  <span>Allow voice chat</span>
                </label>
                <Specs on={social.voice && social.watchVoice} disabled={!social.voice} what="join voice" onChange={(watchVoice) => setSocial({ watchVoice })} />
              </div>
            </div>
          )}
          <WholeScreen />
        </section>
      )}
    </div>
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
 * The table's house rules, in the lobby and behind the score sheet's gear. One row per option
 * of `TableSettings` that the host is offered, and the number of seats.
 */
export function TableRules({ room }: { room: RoomView }) {
  const host = room.players.find((p) => p.isHost);
  const mine = host?.id === room.me;
  const set = (patch: Partial<TableSettings>) => setTableSettings(patch);
  return (
    <fieldset className={`rules${mine ? '' : ' locked'}`} title={mine ? undefined : 'Only the room host can set these.'}>
      <legend>Table rules</legend>
      <label className="check">
        <input type="checkbox" checked={room.settings.tapToMove} disabled={!mine} onChange={(e) => set({ tapToMove: e.target.checked })} />
        <span>
          Move without dragging <Info>Tap or click a card, then where it goes.</Info>
        </span>
      </label>
      <SeatCount room={room} mine={mine} />
    </fieldset>
  );
}
