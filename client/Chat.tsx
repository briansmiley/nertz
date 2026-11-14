// Chat and voice, in the top-left corner of every screen of a table. Nothing here is a panel over the table: what is
// said is written on the cloth under the buttons, and "Chat" only adds a line to type in above it. The headset joins
// voice, and once in it opens a small slip (who is there, mute yourself, leave).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CHAT_MAX_LENGTH } from '../shared/chat';
import type { RoomView } from '../shared/types';
import { backColour } from './cards/Face';
import { keyName, touchOnly, usePrefs } from './prefs';
import { PASSING_MS, say, setOpen, useSocial, type SocialState } from './social';
import { joinVoice, leaveVoice, setMuted, useVoice } from './voice';

/** How many of the last lines stand under the line you type in. */
const SHOWN = 8;

/** What has just been said, under the buttons while you are not typing: plain words over the table, gone again after a while, and never in the way of the pointer. */
function Passing({ lines }: { lines: SocialState['passing'] }) {
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
          <b style={{ color: backColour(line.seat) }}>{line.name}</b> {line.text}
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
  /** The voice slip, open or not. (It and the line to type in are never open together.) */
  const [voiceOpen, setVoiceOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const name = (seat: number) => room.players.find((p) => p.seat === seat)?.name ?? `Seat ${seat + 1}`;
  // With a card in hand everything here lets the pointer through, so it can never take a drop or a click meant for the table.
  const holding = room.phase === 'playing' && !!room.game?.players.find((p) => p.seat === room.you)?.holding;
  const inVoice = voice.status === 'on';
  const typing = social.open && social.text;
  useEffect(() => {
    if (!inVoice) setVoiceOpen(false);
  }, [inVoice]);
  // A press anywhere else puts the voice slip away.
  useEffect(() => {
    if (!voiceOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setVoiceOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [voiceOpen]);

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
  const key = prefs.voiceKey && !touchOnly() ? keyName(prefs.voiceKey) : null;

  // The key that mutes your microphone, from anywhere but a text field, while you are in voice.
  useEffect(() => {
    if (!inVoice || !prefs.voiceKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== prefs.voiceKey || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || (e.target as Element).closest?.('input,textarea,[data-keying]')) return;
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
        if (e.key === 'Escape') (setOpen(false), setVoiceOpen(false));
      }}
      onClick={(e) => (e.target as HTMLElement).closest<HTMLElement>('button')?.blur()}
    >
      <div className="chat-bar">
        {social.text && (
          <button type="button" className={`chat-toggle${typing ? ' on' : ''}`} aria-expanded={typing} onClick={() => (setOpen(!social.open), setVoiceOpen(false))}>
            Chat
            {!typing && social.unread > 0 && <i className="dot" aria-label={`${social.unread} unread`} />}
          </button>
        )}
        {/* Voice is one press away, and says so: yellow, with how many are in it, while anyone is. */}
        {social.voice && !inVoice && (
          <button
            type="button"
            className={`mic join${social.inVoice.length ? ' calling' : ''}`}
            disabled={voice.status === 'asking'}
            aria-label={social.inVoice.length ? `Join voice: ${social.inVoice.length} in it` : 'Join voice'}
            title={social.inVoice.length ? `Join voice: ${social.inVoice.map((m) => name(m.seat)).join(', ')}` : 'Join voice'}
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
            className={`mic${voice.speaking.includes(room.you) && !voice.muted ? ' speaking' : ''}${voiceOpen ? ' open' : ''}`}
            aria-expanded={voiceOpen}
            aria-label={`In voice: ${social.inVoice.length}. Who is there, mute yourself, leave`}
            title={`In voice: ${social.inVoice.map((m) => name(m.seat)).join(', ')}`}
            onClick={() => (setVoiceOpen(!voiceOpen), setOpen(false))}
          >
            {headset}
            {social.inVoice.length}
          </button>
        )}
        {mute}
      </div>

      {voiceOpen && inVoice && (
        <section className="voice-slip" aria-label="Voice">
          <header>
            <h3>Voice</h3>
            <button type="button" onClick={() => leaveVoice()}>
              Leave
            </button>
          </header>
          <ul>
            {social.inVoice.map((m) => {
              const me = m.seat === room.you;
              const off = me ? voice.muted : m.muted;
              return (
                <li key={m.seat} className={`${voice.speaking.includes(m.seat) && !off ? 'speaking' : ''}${me ? ' you' : ''}`}>
                  <i style={{ background: backColour(m.seat) }} />
                  {name(m.seat)}
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
                  {!me && voice.links[m.seat] === 'failed' && <small className="bad" title="Your two networks cannot reach each other directly">can't connect</small>}
                  {!me && voice.links[m.seat] === 'connecting' && <small>connecting…</small>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* Under the buttons, on the cloth: the line to type in (once Chat is pressed), and what is being said. */}
      {social.text && !voiceOpen && (
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
                    <b style={{ color: backColour(l.seat) }}>{l.name}</b> {l.text}
                  </li>
                ))}
              </ol>
            )
          ) : (
            prefs.chatOver && <Passing lines={social.passing} />
          )}
        </div>
      )}
    </aside>
  );
}
