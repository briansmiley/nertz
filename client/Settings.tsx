// Settings. Two kinds, kept apart:
// - `Corner`: your own (sound, motion), on every screen, bottom left: a
//   one-click mute button (also the M key) and a gear that opens a small slip.
// - `TableRules`: the table's house rules, in the lobby and behind a gear on the
//   score sheet. The host changes them; everyone else reads them.
// Also the small icon buttons the sheets share (`Pop`, `Gear`, `Robot`, `Door`).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TableSettings } from '../shared/settings';
import type { RoomView } from '../shared/types';
import { pause, send, setTableSettings } from './net';
import { YourBacks } from './BackPicker';
import { BACKS } from './cards/Face';
import { calm, DECKS, setPrefs, usePrefs } from './prefs';

/** Is this key press going into a text field (a name, a table code)? */
const typing = (el: EventTarget | null): boolean => (el instanceof HTMLInputElement ? !['range', 'checkbox'].includes(el.type) : el instanceof HTMLTextAreaElement);

function Speaker({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z" fill="currentColor" stroke="none" />
      {off ? <path d="M15.5 9.2l5 5.6M20.5 9.2l-5 5.6" /> : <path d="M15.2 9.3a4 4 0 0 1 0 5.4M17.6 6.9a7.4 7.4 0 0 1 0 10.2" />}
    </svg>
  );
}

export function Gear() {
  const teeth = Array.from({ length: 8 }, (_, i) => <rect key={i} x="10.6" y="2.6" width="2.8" height="4.4" rx="0.9" transform={`rotate(${i * 45} 12 12)`} fill="currentColor" stroke="none" />);
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {teeth}
      <circle cx="12" cy="12" r="5.1" strokeWidth="3" />
    </svg>
  );
}

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

export function Robot() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="8" width="13" height="10" rx="2.5" />
      <path d="M10 8V5" />
      <circle cx="10" cy="4.2" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="7.6" cy="12.6" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12.4" cy="12.6" r="1.25" fill="currentColor" stroke="none" />
      <path d="M20.5 9v6M17.5 12h6" />
    </svg>
  );
}

export function Door() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13 4.5h5.5v15H13" />
      <path d="M14.5 12H4.5M8 8.5 4.5 12 8 15.5" />
    </svg>
  );
}

/**
 * A round icon button that opens a small slip above it. A press anywhere else or Escape puts it away.
 */
export function Pop({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
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

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Can you pause the round right now? While it is being played, before anyone calls Nertz, if you were dealt in. */
export function canPause(room: RoomView | null | undefined): boolean {
  const g = room?.game;
  return !!room && room.phase === 'playing' && !room.paused && !!g && g.stage === 'play' && g.nertzCalledBy === null && !g.ended && g.players.some((p) => p.seat === room.you);
}

/** Can you carry on from a pause? Whoever paused, the dealer, or anyone once whoever paused is away. */
export function canResume(room: RoomView): boolean {
  if (!room.paused) return false;
  const by = room.players.find((p) => p.seat === room.paused!.by);
  return room.paused.by === room.you || !!room.players.find((p) => p.seat === room.you)?.isHost || !by?.connected;
}

const percent = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Ending the round where it stands, for a round that drags on (everyone voting: bots go along). Shown while a round
 * is in play and you are in it.
 */
function EndVote({ room }: { room: RoomView }) {
  const game = room.game;
  const me = game?.players.find((p) => p.seat === room.you);
  if (room.phase !== 'playing' || !game || game.stage !== 'play' || game.nertzCalledBy !== null || !me) return null;
  const people = room.players.filter((p) => p.connected && !p.bot);
  const voted = people.filter((p) => p.ending || (p.seat === room.you && me.ending)).length;
  return (
    <div className="end-vote">
      <h3>This round</h3>
      <button type="button" className={me.ending ? 'on' : ''} onClick={() => send({ k: 'end', on: !me.ending })}>
        {me.ending ? 'Take back my vote' : 'Vote to end the round'}
      </button>
      <small>
        {voted} of {people.length} voted. When everyone has, it ends where it stands and is scored as usual.
      </small>
    </div>
  );
}

/** The corner controls. Rendered once, by App, over whatever screen is up. */
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

/** The round's clock, m:ss: counted on locally from what the last snapshot said while it runs (not while paused, nor once the round is over). */
function Clock({ clock }: { clock: NonNullable<RoomView['clock']> }) {
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
    <time className={`clock${clock.running ? '' : ' stopped'}`} role="timer" aria-label={`Round time ${text}`} title="This round">
      {text}
    </time>
  );
}

export function Corner({ room }: { room?: RoomView | null }) {
  const prefs = usePrefs();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const pausable = canPause(room);
  const resumable = !!room && canResume(room);
  // M mutes from anywhere (except while typing a name), P pauses or carries on; Escape puts the slip away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'KeyM' && !typing(e.target)) setPrefs({ muted: !prefs.muted });
      else if (e.code === 'KeyP' && !typing(e.target) && (pausable || resumable)) pause(pausable);
      else if (e.code === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prefs.muted, pausable, resumable]);

  // A press anywhere else closes the slip (and still does whatever it was meant to do).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const sound = prefs.muted ? 'Sound is off' : 'Sound is on';
  return (
    <div className="corner" ref={root}>
      {room?.clock && room.phase !== 'lobby' && <Clock clock={room.clock} />}
      <button
        type="button"
        className={`knob${prefs.muted ? ' off' : ''}`}
        aria-pressed={prefs.muted}
        aria-label={`${sound}. ${prefs.muted ? 'Unmute' : 'Mute'} (M)`}
        title={`${sound} (M)`}
        onClick={(e) => {
          setPrefs({ muted: !prefs.muted });
          e.currentTarget.blur(); // keep Space for flipping
        }}
      >
        <Speaker off={prefs.muted} />
        {prefs.muted && <span>Muted</span>}
      </button>
      {pausable && (
        <button
          type="button"
          className="knob"
          aria-label="Pause the round (P)"
          title="Pause the round (P)"
          onClick={(e) => {
            pause(true);
            e.currentTarget.blur();
          }}
        >
          <PauseIcon />
        </button>
      )}
      <button type="button" className={`knob${open ? ' on' : ''}`} aria-expanded={open} aria-controls="your-settings" aria-label="Your settings" title="Your settings" onClick={() => setOpen(!open)}>
        <Gear />
      </button>
      {open && (
        <section className="slip" id="your-settings" aria-label="Your settings">
          <h3>Your settings</h3>
          <label className="check">
            <input type="checkbox" checked={!prefs.muted} onChange={(e) => setPrefs({ muted: !e.target.checked })} />
            <span>
              Sound <small>M switches it from anywhere</small>
            </span>
          </label>
          <label className="level">
            <span>
              Volume <output>{percent(prefs.volume)}</output>
            </span>
            <input type="range" min="0" max="1" step="0.05" value={prefs.volume} disabled={prefs.muted} onChange={(e) => setPrefs({ volume: Number(e.target.value) })} />
          </label>
          <label className="level">
            <span>
              Other players' cards <output>{percent(prefs.others)}</output>
            </span>
            <input type="range" min="0" max="1" step="0.05" value={prefs.others} disabled={prefs.muted} onChange={(e) => setPrefs({ others: Number(e.target.value) })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={prefs.botVoice} disabled={prefs.muted} onChange={(e) => setPrefs({ botVoice: e.target.checked })} />
            <span>
              Bots say "Nertz" <small>in a robot voice, when one goes out</small>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={prefs.chatOver} onChange={(e) => setPrefs({ chatOver: e.target.checked })} />
            <span>
              Show chat over the table <small>what is said appears at the top left for a moment</small>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={calm()} onChange={(e) => setPrefs({ calm: e.target.checked })} />
            <span>
              Reduce motion <small>{prefs.calm === null ? 'following your system setting' : 'cards jump instead of gliding'}</small>
            </span>
          </label>
          <label className="level">
            <span>Card faces</span>
            <a className="mybacks" href="/?decks" target="_blank" rel="noreferrer">
              <span className="what">
                <b>{DECKS[prefs.deck]}</b>
                <small>Change</small>
              </span>
            </a>
            <label className="check">
              <input type="checkbox" checked={prefs.night} onChange={(e) => setPrefs({ night: e.target.checked })} />
              <span>Dark cards</span>
            </label>
            <span>Card backs</span>
            <YourBacks colour={BACKS[0]} />
          </label>
          <WholeScreen />
          {room && <EndVote room={room} />}
        </section>
      )}
    </div>
  );
}

/**
 * The table's house rules, in the lobby and behind the score sheet's gear. One row per option
 * of `TableSettings`; further table-wide controls (`children`) go underneath.
 */
export function TableRules({ room, children }: { room: RoomView; children?: ReactNode }) {
  const host = room.players.find((p) => p.isHost);
  const mine = host?.seat === room.you;
  const set = (patch: Partial<TableSettings>) => setTableSettings(patch);
  return (
    <fieldset className="rules">
      <legend>Table rules</legend>
      <label className="check">
        <input type="checkbox" checked={room.settings.centre === 'spots'} disabled={!mine} onChange={(e) => set({ centre: e.target.checked ? 'spots' : 'free' })} />
        <span>
          Crystallized Nertz <Info>On: the middle is a grid, with a marked place for every pile. Off: an Ace starts its pile wherever you put it down in the middle, as long as there is room for the card.</Info>
        </span>
      </label>
      {children}
      {!mine && <p className="hint">{host?.name ?? 'The host'} sets these.</p>}
    </fieldset>
  );
}
