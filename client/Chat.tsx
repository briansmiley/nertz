// The chat panel: text chat, voice controls and the host's two switches, docked
// in the bottom-left corner of every screen of a table. Collapsed it is one
// small button (with a dot for unread lines), so it never lies over a pile;
// open during a round, it is only as wide as the felt to the left of the piles.
import { useViewport } from './viewport';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CHAT_MAX_LENGTH } from '../shared/chat';
import type { RoomView } from '../shared/types';
import { backColour } from './cards/Face';
import { computeLayout, isTall } from './layout';
import { usePrefs } from './prefs';
import { PASSING_MS, say, setOpen, setSocial, useSocial, type SocialState } from './social';
import { joinVoice, leaveVoice, setMuted, useVoice } from './voice';

const WIDEST = 290;
const NARROWEST = 150;
const EDGE = 10;

/**
 * How wide the open panel may be: during a round, the free felt between the
 * window's left edge and your hand or the felt in the middle, whichever is nearer, so
 * it covers no pile. In a window too small for that it is NARROWEST and can
 * lie over the edge of your nertz pile until it is hidden again.
 */
function useWidth(room: RoomView, open: boolean): number {
  const size = useViewport();
  const game = open && room.phase === 'playing' ? room.game : null;
  const [W, H] = size;
  return useMemo(() => {
    if (isTall(W, H)) return Math.min(WIDEST, W - 2 * EDGE); // upright there is no room beside the table: the panel lies over it
    if (!game) return WIDEST;
    const L = computeLayout(W, H, game, room.you, undefined, undefined, undefined, undefined, undefined, room.players.map((p) => p.seat));
    const left = Math.min(L.middle.x, ...(L.me ? [L.me.box.x] : []));
    return Math.max(NARROWEST, Math.min(WIDEST, left - 2 * EDGE));
  }, [W, H, game, room.you, room.players.map((p) => p.seat).join()]);
}

/** What has just been said, under the chat button while the chat is closed: plain words over the table, gone again after a while, and never in the way of the pointer. */
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
  const width = useWidth(room, social.open);
  const voice = useVoice();
  const [draft, setDraft] = useState('');
  const log = useRef<HTMLOListElement>(null);
  const me = room.players.find((p) => p.seat === room.you);
  const isHost = !!me?.isHost;
  const name = (seat: number) => room.players.find((p) => p.seat === seat)?.name ?? `Seat ${seat + 1}`;
  // With a card in hand the panel lets the pointer through, so it can never take a drop or a click meant for the table.
  const holding = room.phase === 'playing' && !!room.game?.players.find((p) => p.seat === room.you)?.holding;
  const inVoice = voice.status === 'on';

  // Keep the newest line in view.
  const last = social.lines.at(-1)?.id;
  useEffect(() => {
    if (social.open && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [last, social.open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (social.text && draft.trim() && say(draft)) setDraft('');
  };

  const mute = inVoice && (
    <button type="button" className={voice.muted ? 'on' : ''} aria-pressed={voice.muted} onClick={() => setMuted(!voice.muted)}>
      {voice.muted ? 'Unmute' : 'Mute'}
    </button>
  );

  return (
    <aside
      className={`chat${social.open ? ' open' : ''}${holding ? ' aside' : ''}`}
      aria-label="Chat"
      style={social.open ? { width } : undefined}
      // Keys typed here are not game hotkeys (Space flips the stock), and a button pressed here must not keep the focus for the same reason.
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => (e.target as HTMLElement).closest<HTMLElement>('button, input[type=checkbox]')?.blur()}
    >
      {!social.open ? (
        <div className="chat-bar">
          <button type="button" className="chat-toggle" onClick={() => setOpen(true)}>
            Chat
            {social.unread > 0 && <i className="dot" aria-label={`${social.unread} unread`} />}
          </button>
          {inVoice && (
            <span className={`mic${voice.speaking.includes(room.you) ? ' speaking' : ''}`} role="img" aria-label={`In voice: ${social.inVoice.length}`} title={`In voice: ${social.inVoice.length}`}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4.5 14v-2a7.5 7.5 0 0 1 15 0v2" />
                <rect x="3" y="13" width="4.2" height="6.5" rx="1.6" />
                <rect x="16.8" y="13" width="4.2" height="6.5" rx="1.6" />
              </svg>
              {social.inVoice.length}
            </span>
          )}
          {mute}
          {prefs.chatOver && social.text && <Passing lines={social.passing} />}
        </div>
      ) : (
        <>
          <header>
            <h3>Chat</h3>
            <button type="button" className="chat-close" onClick={() => setOpen(false)} aria-label="Hide chat">
              Hide
            </button>
          </header>

          {social.voice ? (
            <div className="voice">
              {inVoice ? (
                <>
                  {mute}
                  <button type="button" onClick={() => leaveVoice()}>
                    Leave voice
                  </button>
                </>
              ) : (
                <button type="button" disabled={voice.status === 'asking'} onClick={() => void joinVoice()}>
                  {voice.status === 'asking' ? 'Waiting for the microphone…' : 'Join voice'}
                </button>
              )}
              {voice.error && <p className="chat-note">{voice.error}</p>}
              {social.inVoice.length > 0 && (
                <ul>
                  {social.inVoice.map((m) => (
                    <li key={m.seat} className={voice.speaking.includes(m.seat) && !m.muted ? 'speaking' : ''}>
                      <i style={{ background: backColour(m.seat) }} />
                      {name(m.seat)}
                      {m.muted && <small>muted</small>}
                      {inVoice && m.seat !== room.you && voice.links[m.seat] === 'failed' && <small className="bad" title="Your two networks cannot reach each other directly">can't connect</small>}
                      {inVoice && m.seat !== room.you && voice.links[m.seat] === 'connecting' && <small>connecting…</small>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="chat-note">Voice chat is switched off{isHost ? '.' : ' by the host.'}</p>
          )}

          <ol ref={log} className="lines">
            {social.lines.length === 0 && <li className="chat-note">Nothing said yet.</li>}
            {social.lines.map((l) => (
              <li key={l.id}>
                <b style={{ color: backColour(l.seat) }}>{l.name}</b> {l.text}
              </li>
            ))}
          </ol>

          <form onSubmit={submit}>
            <input
              value={draft}
              maxLength={CHAT_MAX_LENGTH}
              disabled={!social.text}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={social.text ? 'Say something' : 'Text chat is switched off'}
              aria-label="Message"
              autoComplete="off"
            />
            <button type="submit" disabled={!social.text || !draft.trim()}>
              Send
            </button>
          </form>

          <fieldset className="switches" disabled={!isHost}>
            <legend>{isHost ? 'You host this table' : 'Set by the host'}</legend>
            <label>
              <input type="checkbox" checked={social.text} onChange={(e) => setSocial({ text: e.target.checked })} /> Text chat
            </label>
            <label>
              <input type="checkbox" checked={social.voice} onChange={(e) => setSocial({ voice: e.target.checked })} /> Voice chat
            </label>
          </fieldset>
        </>
      )}
    </aside>
  );
}
