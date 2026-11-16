// Chat and voice, in the top-left corner of every screen of a table. Nothing here is a panel over the table: what is
// said is written on the cloth under the buttons, and "Chat" only adds a line to type in above it. The headset joins
// voice, and once in it opens a small slip (who is there, mute yourself, leave).
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CHAT_MAX_LENGTH, type ChatLine, type Named } from '../shared/chat';
import type { RoomView } from '../shared/types';
import { backColour } from './cards/Face';
import { hotkeyName, hotkeyPressed, usePrefs } from './prefs';
import { kick, takeSeat } from './net';
import { outOfVoice, PASSING_MS, say, setOpen, useSocial, type Open, type SocialState } from './social';
import { joinVoice, setMuted, useVoice } from './voice';

/** How many of the last lines stand under the line you type in. */
const SHOWN = 8;

/** The colour a name is written in: that of the seat its player has now. Someone watching (or gone) has no seat and no colour: the colour of the words. */
type Colour = (who: number) => string | undefined;

/** Points as the score sheet writes them: with their sign, and a true minus. */
export const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

/** One line: a name in its colour and what was said; or a notice from the table (a snipe, a round started or over, the table started over). */
function Line({ line, colour }: { line: ChatLine; colour: Colour }) {
  const named = (n: Named) => <b style={{ color: colour(n.who) }}>{n.name}</b>;
  /** "A", "A and B", "A, B and C". */
  const all = (them: readonly Named[]) =>
    them.map((n, i) => (
      <Fragment key={n.who}>
        {i === 0 ? '' : i === them.length - 1 ? ' and ' : ', '}
        {named(n)}
      </Fragment>
    ));
  if (line.k === 'said') {
    return (
      <>
        {named(line.by)} {line.text}
      </>
    );
  }
  let notice: ReactNode;
  if (line.k === 'sniped') notice = <>{named(line.by)} sniped {named(line.of)}</>;
  else if (line.k === 'started') notice = <>Round {line.round} started</>;
  else if (line.k === 'reset') notice = <>{named(line.by)} started the table over</>;
  else {
    // Whoever scored most in the round wins it (as the table says at its end); whoever called Nertz is named too when that is someone else.
    const { end, best } = line;
    const caller = typeof end === 'string' ? null : end;
    notice = (
      <>
        Round {line.round} over
        {best.length > 0 && (
          <>
            : {all(best)} {best.length > 1 ? 'win' : 'wins'} ({signed(best[0]!.points)})
          </>
        )}
        {caller ? !best.some((b) => b.who === caller.who) && <>, {named(caller)} called Nertz ({signed(caller.points)})</> : end === 'jam' ? ', the table jammed' : ', ended by agreement'}
      </>
    );
  }
  return <em className="notice">{notice}</em>;
}

/** What has just been said, under the buttons while you are not typing: plain words over the table, gone again after a while, and never in the way of the pointer. */
function Passing({ lines, colour }: { lines: SocialState['passing']; colour: Colour }) {
  const [, tick] = useState(0);
  const now = Date.now();
  const shown = lines.filter((p) => now - p.at < PASSING_MS);
  const next = shown[0] ? shown[0].at + PASSING_MS - now : null;
  useEffect(() => {
    if (next === null) return;
    const t = setTimeout(() => tick((n) => n + 1), next + 20);
    return () => clearTimeout(t);
  }, [next, lines]);
  if (!shown.length) return null;
  return (
    <ol className="passing" aria-live="polite">
      {shown.map(({ line }) => (
        <li key={line.id}>
          <Line line={line} colour={colour} />
        </li>
      ))}
    </ol>
  );
}

export function Chat({ room }: { room: RoomView }) {
  const social = useSocial();
  const prefs = usePrefs();
  const voice = useVoice();
  const [draft, setDraft] = useState('');
  const { open } = social;
  const toggle = (what: Open) => setOpen(open === what ? null : what);
  const hosting = !!room.players.find((p) => p.id === room.me)?.isHost;
  const root = useRef<HTMLElement>(null);
  const name = (who: number) => room.players.find((p) => p.id === who)?.name ?? 'Someone';
  const colour: Colour = (who) => {
    const seat = room.players.find((p) => p.id === who)?.seat;
    return seat == null ? undefined : backColour(seat);
  };
  // With a card in hand everything here lets the pointer through, so it can never take a drop or a click meant for the table.
  const holding = room.phase === 'playing' && !!room.game?.players.find((p) => p.seat === room.seat)?.holding;
  const inVoice = voice.status === 'on';
  /** Those without a seat (waiting for one, or just watching), and whether you are one: the host may keep them out of the chat, or of voice. */
  const watchers = room.players.filter((p) => p.seat === null);
  const watching = room.seat === null;
  const mayText = social.text && (!watching || social.watchText);
  const mayVoice = social.voice && (!watching || social.watchVoice);
  const typing = open === 'chat' && mayText;
  // Stood up while in voice, at a table where those watching are kept out of it: out, and the microphone released.
  useEffect(() => {
    if (inVoice && !mayVoice) outOfVoice(false);
  }, [inVoice, mayVoice]);
  // A press anywhere else puts a slip away.
  const slip = open === 'voice' || open === 'watchers';
  useEffect(() => {
    if (!slip) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [slip]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (social.text && draft.trim() && say(draft)) setDraft('');
  };

  const headset = (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.6 12.5V11a7.4 7.4 0 0 1 14.8 0v1.5" />
      <rect x="3" y="11.5" width="4.2" height="6.4" rx="1.6" />
      <rect x="16.8" y="11.5" width="4.2" height="6.4" rx="1.6" />
      {/* the microphone, on its arm round to the mouth */}
      <path d="M18.9 17.9c0 2-1.5 3.1-3.6 3.1h-1.6" />
      <rect x="10.3" y="19.7" width="3.6" height="2.6" rx="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
  /** A microphone; with a line through it for one that is muted. */
  const mic = (off: boolean) => (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
      {off && <path d="M4.5 4.5l15 15" strokeWidth="2.4" />}
    </svg>
  );
  /** The key that mutes you, to name on the button: none on a phone. */
  const key = hotkeyName(prefs.voiceKey);

  // The key that mutes your microphone, from anywhere but a text field, while you are in voice.
  useEffect(() => {
    if (!inVoice || !prefs.voiceKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (!hotkeyPressed(e, prefs.voiceKey)) return;
      setMuted(!voice.muted);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inVoice, prefs.voiceKey, voice.muted]);

  /** Mute yourself: in the bar, a microphone (yellow, with a line through it, while muted). */
  const mute = inVoice && (
    <button type="button" className={`mic mute${voice.muted ? ' on' : ''}`} aria-pressed={voice.muted} aria-label={voice.muted ? 'Unmute yourself' : 'Mute yourself'} title={`${voice.muted ? 'You are muted: unmute yourself' : 'Mute yourself'}${key ? ` (${key})` : ''}`} onClick={() => setMuted(!voice.muted)}>
      {mic(voice.muted)}
    </button>
  );

  return (
    <aside
      ref={root}
      className={`chat${holding ? ' aside' : ''}`}
      aria-label="Chat"
      // Keys typed here are not game hotkeys (Space flips the stock), and a button pressed here must not keep the focus for the same reason.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') setOpen(null);
      }}
      onClick={(e) => (e.target as HTMLElement).closest<HTMLElement>('button')?.blur()}
    >
      <div className="chat-bar">
        {mayText && (
          <button type="button" className={`chat-toggle${typing ? ' on' : ''}`} aria-expanded={typing} onClick={() => toggle('chat')}>
            Chat
            {!typing && social.unread > 0 && <i className="dot" aria-label={`${social.unread} unread`} />}
          </button>
        )}
        {/* Voice is one press away, and says so: yellow, with how many are in it, while anyone is. */}
        {mayVoice && !inVoice && (
          <button
            type="button"
            className={`mic join${social.inVoice.length ? ' calling' : ''}`}
            disabled={voice.status === 'asking'}
            aria-label={social.inVoice.length ? `Join voice: ${social.inVoice.length} in it` : 'Join voice'}
            title={social.inVoice.length ? `Join voice: ${social.inVoice.map((m) => name(m.id)).join(', ')}` : 'Join voice'}
            onClick={() => void joinVoice()}
          >
            {headset}
            {social.inVoice.length > 0 && social.inVoice.length}
          </button>
        )}
        {!inVoice && voice.error && <small className="mic-error">{voice.error}</small>}
        {inVoice && (
          <button
            type="button"
            className={`mic${voice.speaking.includes(room.me) && !voice.muted ? ' speaking' : ''}${open === 'voice' ? ' open' : ''}`}
            aria-expanded={open === 'voice'}
            aria-label={`In voice: ${social.inVoice.length}. Who is there, mute yourself, leave`}
            title={`In voice: ${social.inVoice.map((m) => name(m.id)).join(', ')}`}
            onClick={() => toggle('voice')}
          >
            {headset}
            {social.inVoice.length}
          </button>
        )}
        {mute}
        {/* Who is watching (no seat): an eye and how many; their names on hover, and in the lobby and on the score sheet. */}
        {watchers.length > 0 && (
          <button type="button" className={`mic eye${open === 'watchers' ? ' open' : ''}`} aria-expanded={open === 'watchers'} aria-label={`Watching: ${watchers.length}. Who`} title={`Watching: ${watchers.map((p) => p.name).join(', ')}`} onClick={() => toggle('watchers')}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
              <circle cx="12" cy="12" r="2.8" />
            </svg>
            {watchers.length}
          </button>
        )}
      </div>

      {/* Who is watching: a slip like the voice one. Whoever hosts can send one of them away. */}
      {open === 'watchers' && (
        <section className="voice-slip" aria-label="Watching">
          <header>
            <h3>Watching</h3>
          </header>
          <ul>
            {watchers.map((p) => (
              <li key={p.id} className={p.id === room.me ? 'you' : ''}>
                {p.name}
                {p.queued && <small>wants a seat</small>}
                {!p.connected && <small>away</small>}
                {/* A seat is had by asking for one: oneself, or whoever deals for someone. And given up again, to just watch. */}
                {!p.queued && (p.id === room.me || hosting) && (
                  <button type="button" onClick={() => takeSeat(true, p.id === room.me ? undefined : p.id)}>
                    {p.id === room.me ? 'Take a seat' : 'Seat'}
                  </button>
                )}
                {p.queued && p.id === room.me && (
                  <button type="button" onClick={() => takeSeat(false)}>
                    Just watch
                  </button>
                )}
                {hosting && p.id !== room.me && (
                  <button type="button" className="mic-at" aria-label={`Remove ${p.name}`} title={`Remove ${p.name} from the table`} onClick={() => kick(p.id)}>
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {open === 'voice' && (
        <section className="voice-slip" aria-label="Voice">
          <header>
            <h3>Voice</h3>
            <button type="button" onClick={() => outOfVoice()}>
              Leave
            </button>
          </header>
          <ul>
            {social.inVoice.map((m) => {
              const me = m.id === room.me;
              const off = me ? voice.muted : m.muted;
              return (
                <li key={m.id} className={`${voice.speaking.includes(m.id) && !off ? 'speaking' : ''}${me ? ' you' : ''}`}>
                  <i style={{ background: colour(m.id) }} />
                  {name(m.id)}
                  {/* Beside your own name the microphone is a button: it mutes you. Beside another's it only says that they are muted. */}
                  {me ? (
                    <button type="button" className={`mic-at${off ? ' on' : ''}`} aria-pressed={off} aria-label={off ? 'Unmute yourself' : 'Mute yourself'} title={`${off ? 'Unmute yourself' : 'Mute yourself'}${key ? ` (${key})` : ''}`} onClick={() => setMuted(!voice.muted)}>
                      {mic(off)}
                    </button>
                  ) : (
                    off && (
                      <span className="mic-at" role="img" aria-label="muted" title="Muted">
                        {mic(true)}
                      </span>
                    )
                  )}
                  {!me && voice.links[m.id] === 'failed' && <small className="bad" title="Your two networks cannot reach each other directly">can't connect</small>}
                  {!me && voice.links[m.id] === 'connecting' && <small>connecting…</small>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Under the buttons, on the cloth: the line to type in (once Chat is pressed), and what is being said. */}
      {social.text && !slip && (
        <div className="chat-under">
          {typing && (
            <form onSubmit={submit}>
              <input autoFocus value={draft} maxLength={CHAT_MAX_LENGTH} onChange={(e) => setDraft(e.target.value)} placeholder="Say something" aria-label="Message" autoComplete="off" enterKeyHint="send" />
            </form>
          )}
          {typing ? (
            social.lines.length > 0 && (
              <ol className="passing still" aria-live="polite">
                {social.lines.slice(-SHOWN).map((l) => (
                  <li key={l.id}>
                    <Line line={l} colour={colour} />
                  </li>
                ))}
              </ol>
            )
          ) : (
            prefs.chatOver && <Passing lines={social.passing} colour={colour} />
          )}
        </div>
      )}
    </aside>
  );
}
