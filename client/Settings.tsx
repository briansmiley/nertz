// Settings. Two kinds, kept apart:
// - `Corner`: your own (sound, motion), on every screen, bottom left: a
//   one-click mute button (also a key of your choosing, M at first) and a gear
//   that opens a small slip.
// - `TableRules`: the table's house rules, in the lobby and behind a gear on the
//   score sheet. The host changes them; everyone else reads them.
// Also the small icon buttons the sheets share (`Pop`, `Gear`, `Robot`, `Door`).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TableSettings } from '../shared/settings';
import type { RoomView } from '../shared/types';
import { pause, redeal, send, setTableSettings } from './net';
import { YourBacks } from './BackPicker';
import { Feedback } from './Feedback';
import { BACKS } from './cards/Face';
import { calm, getPrefs, HOTKEYS, hotkeyName, hotkeyPressed, keyName, takeKey, setPrefs, touchOnly, usePrefs, type Hotkey } from './prefs';
import { setSocial, useSocial } from './social';

/** Is this key press going into a text field (a name, a table code)? */
const typing = (el: EventTarget | null): boolean => (el instanceof HTMLInputElement ? !['range', 'checkbox'].includes(el.type) : el instanceof HTMLTextAreaElement);

/** Each hotkey as the settings list it. */
const HOTKEY_LABELS: Record<Hotkey, string> = { soundKey: 'Mute sound', voiceKey: 'Mute mic' };

function Speaker({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z" fill="currentColor" stroke="none" />
      <path d="M15.2 9.3a4 4 0 0 1 0 5.4M17.6 6.9a7.4 7.4 0 0 1 0 10.2" />
      {off && <path d="M4.5 4.5l15 15" strokeWidth="2.4" />}
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
  return !!room && room.phase === 'playing' && !room.paused && !!g && g.stage === 'play' && g.nertzCalledBy === null && !g.ended && g.players.some((p) => p.seat === room.seat);
}

/** Can you carry on from a pause? Whoever paused, the dealer, or anyone once whoever paused is away. */
export function canResume(room: RoomView): boolean {
  if (!room.paused) return false;
  const by = room.players.find((p) => p.id === room.paused!.by);
  return room.paused.by === room.me || !!room.players.find((p) => p.id === room.me)?.isHost || !by?.connected;
}

const percent = (v: number) => `${Math.round(v * 100)}%`;

/**
 * Ending the round where it stands, for a round that drags on (everyone voting: bots go along). Shown while a round
 * is in play and you are in it.
 */
function EndVote({ room }: { room: RoomView }) {
  const game = room.game;
  const me = game?.players.find((p) => p.seat === room.seat);
  if (room.phase !== 'playing' || !game || game.stage !== 'play' || game.nertzCalledBy !== null || !me) return null;
  const people = room.players.filter((p) => p.connected && !p.bot && p.seat !== null);
  const voted = people.filter((p) => p.ending || (p.id === room.me && me.ending)).length;
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

/** For whoever deals, during a round: deal it over (someone was left out, or dropped at the start). Asked twice, since the round in play is thrown away. */
function DealAgain({ room }: { room: RoomView }) {
  const [sure, setSure] = useState(false);
  const mine = room.players.find((p) => p.id === room.me)?.isHost;
  useEffect(() => setSure(false), [room.round, room.phase]);
  if (!mine || room.phase !== 'playing' || !room.game) return null;
  return (
    <div className="end-vote">
      <h3>Deal again</h3>
      <small>This round is dealt over from the start. Nothing of it is scored, and everyone at the table now is dealt in.</small>
      <button
        type="button"
        className="plain"
        onClick={() => {
          if (sure) redeal();
          setSure(!sure);
        }}
      >
        {sure ? 'Yes, deal this round again' : 'Deal this round again'}
      </button>
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
  const social = useSocial();
  const hosting = !!room?.players.find((p) => p.id === room.me)?.isHost;
  const [open, setOpen] = useState(false);
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
    if (!open) setKeying(null);
  }, [open]);

  /** May the cards' style be changed now? Not once a round is under way (the count, and play). */
  const stage = room?.phase === 'playing' ? room.game?.stage : undefined;
  const styling = stage !== 'countdown' && stage !== 'play';

  const pausable = canPause(room);
  const resumable = !!room && canResume(room);
  // The sound key mutes from anywhere (except while typing a name), P pauses or carries on; Escape puts the slip away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (hotkeyPressed(e, prefs.soundKey)) setPrefs({ muted: !prefs.muted });
      else if (e.code === 'KeyP' && !typing(e.target) && (pausable || resumable)) pause(pausable);
      else if (e.code === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prefs.muted, prefs.soundKey, pausable, resumable]);

  // A press anywhere else closes the slip (and still does whatever it was meant to do).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      // (The sheet of cards opened from here is put straight into the page, outside this corner: a press in it is not a press elsewhere. Closing the slip would take the sheet with it.)
      if (!root.current?.contains(e.target as Node) && !(e.target as Element).closest?.('.picker')) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const sound = prefs.muted ? 'Sound is off' : 'Sound is on';
  const soundKey = hotkeyName(prefs.soundKey);
  return (
    <div className="corner" ref={root}>
      {room?.clock && room.phase !== 'lobby' && <Clock clock={room.clock} />}
      <button
        type="button"
        className={`knob${prefs.muted ? ' off' : ''}`}
        aria-pressed={prefs.muted}
        aria-label={`${sound}. ${prefs.muted ? 'Unmute' : 'Mute'}`}
        title={soundKey ? `${sound} (${soundKey})` : sound}
        onClick={(e) => {
          setPrefs({ muted: !prefs.muted });
          e.currentTarget.blur(); // keep Space for flipping
        }}
      >
        <Speaker off={prefs.muted} />
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
      <button type="button" className={`knob${open ? ' on' : ''}`} aria-expanded={open} aria-controls="your-settings" aria-label="Settings" title="Settings" onClick={() => setOpen(!open)}>
        <Gear />
      </button>
      <Feedback room={room} />
      {open && (
        <section className="slip" id="your-settings" aria-label="Settings">
          <h3>Settings</h3>
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
                <Specs on={social.text && social.watchText !== false} disabled={!social.text} what="use text chat" onChange={(watchText) => setSocial({ watchText })} />
              </div>
              <div className="allow">
                <label className="check">
                  <input type="checkbox" checked={social.voice} onChange={(e) => setSocial({ voice: e.target.checked })} />
                  <span>Allow voice chat</span>
                </label>
                <Specs on={social.voice && social.watchVoice !== false} disabled={!social.voice} what="join voice" onChange={(watchVoice) => setSocial({ watchVoice })} />
              </div>
            </div>
          )}
          <WholeScreen />
          {room && <EndVote room={room} />}
          {room && <DealAgain room={room} />}
        </section>
      )}
    </div>
  );
}

/**
 * The table's house rules, in the lobby and behind the score sheet's gear. One row per option
 * of `TableSettings` that the host is offered.
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
    </fieldset>
  );
}
