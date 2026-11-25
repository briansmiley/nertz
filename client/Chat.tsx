// Chat and voice, in the top-left corner of every screen of a table. Nothing here is a panel over the table: what is
// said is written on the cloth under the buttons, and "Chat" only adds a line to type in above it. The headset opens a
// small slip for voice: who is there, and Join; once in, mute yourself and Leave.
import { Fragment, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CHAT_MAX_LENGTH, type ChatLine, type Named } from '../shared/chat';
import type { RoomView } from '../shared/types';
import { backColour, nameColour } from './cards/Face';
import { useDismiss } from './dismiss';
import { SaidWord, useHotkey } from './hotkey';
import { hotkeyName, setPrefs, usePrefs } from './prefs';
import { RobotBroken, Sit, Speaker } from './icons';
import { useCorners } from './fittings';
import { chatLines } from './layout';
import { kick, sit } from './net';
import { PASSING_MS, say, setOpen, useSocial, type Open, type SocialState } from './social';
import { useWindow } from './viewport';
import { joinVoice, leaveVoice, toggleMuted, useVoice } from './voice';

/** How many of the last lines stand under the line you type in, at most: fewer where the felt is near (layout.ts, `chatLines`). */
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
  else if (line.k === 'reset') notice = <>{named(line.by)} reset the table</>;
  else {
    // Everyone who got Nertz is named first; then whoever scored most in the round wins it (as the table says at its
    // end), by name unless they are the very same people.
    const { end, best } = line;
    const out = typeof end === 'string' ? [] : end;
    const same = out.length === best.length && out.every((o) => best.some((b) => b.who === o.who));
    const wins = <>{best.length > 1 ? 'win' : 'wins'} ({signed(best[0]?.points ?? 0)})</>;
    notice = (
      <>
        Round {line.round} over
        {out.length > 0 ? (
          <>
            : {all(out)} got Nertz{best.length > 0 && (same ? <> and {wins}</> : <>, {all(best)} {wins}</>)}
          </>
        ) : (
          <>
            {best.length > 0 && <>: {all(best)} {wins}</>}
            {end === 'jam' ? ', the table jammed' : ', ended by agreement'}
          </>
        )}
      </>
    );
  }
  return <em className="notice">{notice}</em>;
}

/** What has just been said, under the buttons while you are not typing: plain words over the table, gone again after a while, and never in the way of the pointer. */
function Passing({ lines, colour, most }: { lines: SocialState['passing']; colour: Colour; most: number }) {
  const [, tick] = useState(0);
  const now = Date.now();
  const shown = lines.filter((p) => now - p.at < PASSING_MS).slice(-most);
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

/** `lost`: the line is down and its card put away (App.tsx): the broken robot is in the bar, and brings the card back. */
export function Chat({ room, lost }: { room: RoomView; lost?: () => void }) {
  const social = useSocial();
  const prefs = usePrefs();
  const voice = useVoice();
  const [draft, setDraft] = useState('');
  const { open } = social;
  const toggle = (what: Open) => setOpen(open === what ? null : what);
  const hosting = !!room.players.find((p) => p.id === room.me)?.isHost;
  const root = useRef<HTMLElement>(null);
  const name = (who: number) => room.players.find((p) => p.id === who)?.name ?? 'Someone';
  const seat = (who: number) => room.players.find((p) => p.id === who)?.seat ?? null;
  const colour: Colour = (who) => {
    const s = seat(who);
    return s === null ? undefined : nameColour(s);
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
  /** Where the buttons stand, and how wide each is, left to right (layout.ts: the table keeps clear of exactly that). */
  const at = useCorners(room);
  const { W } = useWindow();
  const wide = (i: number) => ({ minWidth: at.chatParts[i] });
  const voiceAt = mayText ? 1 : 0;
  const voiceSlip = open === 'voice' && mayVoice;
  // A press anywhere else puts a slip away.
  const slip = voiceSlip || open === 'watchers';
  useDismiss(root, slip, () => setOpen(null));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (social.text && draft.trim() && say(draft)) setDraft('');
  };

  const headset = <img className="art" src="/icons/headset.png" alt="" aria-hidden="true" />;
  /** A microphone; struck through in red for one that is muted. */
  const mic = (off: boolean) => <img className="art" src={off ? '/icons/mic-off.png' : '/icons/mic.png'} alt="" aria-hidden="true" />;
  /** The key that mutes you, to name on the button: none on a phone. */
  const key = hotkeyName(prefs.voiceKey);
  /** The key that turns the game's sound off and on. */
  const soundKey = hotkeyName(prefs.soundKey);

  // The key that mutes your microphone, from anywhere but a text field, while you are in voice; it says so on the button.
  const said = useHotkey(
    prefs.voiceKey,
    inVoice ? () => (toggleMuted() ? 'Muted' : 'Unmuted') : null,
  );

  /** Mute yourself: in the bar, a microphone (yellow, with a line through it, while muted). */
  const mute = inVoice && (
    <button type="button" className={`mic mute${voice.muted ? ' on' : ''}`} style={wide(voiceAt + 1)} aria-pressed={voice.muted} aria-label={voice.muted ? 'Unmute yourself' : 'Mute yourself'} data-tip={`${voice.muted ? 'You are muted: unmute yourself' : 'Mute yourself'}${key ? ` (${key})` : ''}`} onClick={() => toggleMuted()}>
      {mic(voice.muted)}
      <SaidWord said={said} />
    </button>
  );

  return (
    <aside
      ref={root}
      className={`chat${holding ? ' aside' : ''}${at.shape === 'tall' ? ' top' : ''}`}
      style={{ left: at.chat.x, top: at.chat.y }}
      aria-label="Chat"
      // Keys typed here are not game hotkeys (Space draws off the stock), and a button pressed here must not keep the focus for the same reason.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') setOpen(null);
      }}
      onClick={(e) => (e.target as HTMLElement).closest<HTMLElement>('button')?.blur()}
    >
      <div className="chat-bar">
        {mayText && (
          <button type="button" className={`chat-toggle${typing ? ' on' : ''}`} style={wide(0)} aria-expanded={typing} aria-label="Chat" data-tip="Chat" onClick={() => toggle('chat')}>
            <img className="art" src="/icons/chat.png" alt="" aria-hidden="true" />
            {!typing && social.unread.length > 0 && <i className="dot" aria-label={`${social.unread.length} unread`} />}
          </button>
        )}
        {/* The headset opens the voice slip. Out of voice it beckons while anyone is in it: yellow, with how many. */}
        {mayVoice && (
          <button
            type="button"
            className={`mic${inVoice ? '' : ' join'}${!inVoice && social.inVoice.length ? ' calling' : ''}${inVoice && voice.speaking.includes(room.me) && !voice.muted ? ' speaking' : ''}${voiceSlip ? ' open' : ''}`}
            style={wide(voiceAt)}
            aria-expanded={voiceSlip}
            aria-label={inVoice ? `In voice: ${social.inVoice.length}. Who is there, mute yourself, leave` : `Open voice${social.inVoice.length ? `: ${social.inVoice.length} in it` : ''}`}
            data-tip={social.inVoice.length ? `${inVoice ? 'In voice' : 'Open voice'}: ${social.inVoice.map((m) => name(m.id)).join(', ')}` : 'Open voice'}
            onClick={() => toggle('voice')}
          >
            {headset}
            {(inVoice || social.inVoice.length > 0) && social.inVoice.length}
          </button>
        )}
        {mute}
        {/* The game's sound is off (from the corner's menu, or the key): a small badge that turns it back on. */}
        {prefs.muted && (
          <button type="button" className="sound-off" aria-label="Sound is off. Unmute" data-tip={soundKey ? `Sound is off: unmute (${soundKey})` : 'Sound is off: unmute'} onClick={() => setPrefs({ muted: false })}>
            <Speaker off />
          </button>
        )}
        {lost && (
          <button type="button" className="lost" aria-label="Connection lost. Show" data-tip="Connection lost. Reconnecting…" onClick={lost}>
            <RobotBroken />
          </button>
        )}
        {/* Who is watching (no seat): an eye and how many; their names on hover, and in the lobby and on the score sheet. */}
        {watchers.length > 0 && (
          <button type="button" className={`mic eye${open === 'watchers' ? ' open' : ''}`} style={wide(at.chatParts.length - 1)} aria-expanded={open === 'watchers'} aria-label={`Spectating: ${watchers.length}. Who`} data-tip={`Spectating: ${watchers.map((p) => p.name).join(', ')}`} onClick={() => toggle('watchers')}>
            <img className="art" src="/icons/eye.png" alt="" aria-hidden="true" />
            {watchers.length}
          </button>
        )}
      </div>

      {/* Who is watching: a slip like the voice one. Whoever hosts can send one of them away. */}
      {open === 'watchers' && (
        <section className="voice-slip" aria-label="Spectating">
          <header>
            <h3>Spectating</h3>
          </header>
          <ul>
            {watchers.map((p) => (
              <li key={p.id} className={p.id === room.me ? 'you' : ''}>
                {p.name}
                {p.queued && <small>wants a seat</small>}
                {!p.connected && <small>away</small>}
                {/* A seat is had by asking for one: oneself, or whoever deals for someone. And given up again, to just watch. */}
                {!p.queued && (p.id === room.me || hosting) && (
                  <button type="button" className="seat-art" aria-label={p.id === room.me ? 'Take a seat' : `Seat ${p.name}`} data-tip={p.id === room.me ? 'Take a seat' : `Seat ${p.name}`} onClick={() => sit(true, p.id === room.me ? undefined : p.id)}>
                    <Sit />
                  </button>
                )}
                {p.queued && p.id === room.me && (
                  <button type="button" onClick={() => sit(false)}>
                    Just watch
                  </button>
                )}
                {hosting && p.id !== room.me && (
                  <button type="button" className="mic-at" aria-label={`Remove ${p.name}`} data-tip={`Remove ${p.name} from the table`} onClick={() => kick(p.id)}>
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Join where Leave will be; leaving keeps the slip open, Join back in its place. */}
      {voiceSlip && (
        <section className="voice-slip" aria-label="Voice">
          <header>
            <h3>Voice</h3>
            {inVoice ? (
              <button type="button" className="go leave" onClick={() => leaveVoice()}>
                Leave
              </button>
            ) : (
              <button type="button" className="go join" disabled={voice.status === 'asking'} onClick={() => void joinVoice()}>
                Join
              </button>
            )}
          </header>
          {!inVoice && voice.error && <small className="mic-error">{voice.error}</small>}
          {social.inVoice.length > 0 && (
            <ul>
              {social.inVoice.map((m) => {
                const me = m.id === room.me;
                const off = me ? voice.muted : m.muted;
                const at = seat(m.id);
                return (
                  <li key={m.id} className={`${voice.speaking.includes(m.id) && !off ? 'speaking' : ''}${me ? ' you' : ''}`}>
                    <i style={{ background: at === null ? undefined : backColour(at) }} />
                    {name(m.id)}
                    {/* Beside your own name the microphone is a button: it mutes you. Beside another's it only says that they are muted. */}
                    {me ? (
                      <button type="button" className={`mic-at${off ? ' on' : ''}`} aria-pressed={off} aria-label={off ? 'Unmute yourself' : 'Mute yourself'} data-tip={`${off ? 'Unmute yourself' : 'Mute yourself'}${key ? ` (${key})` : ''}`} onClick={() => toggleMuted()}>
                        {mic(off)}
                      </button>
                    ) : (
                      off && (
                        <span className="mic-at" role="img" aria-label="muted" data-tip="Muted">
                          {mic(true)}
                        </span>
                      )
                    )}
                    {!me && voice.links[m.id] === 'failed' && <small className="bad" data-tip="Your two networks cannot reach each other directly">can't connect</small>}
                    {!me && voice.links[m.id] === 'connecting' && <small>connecting…</small>}
                  </li>
                );
              })}
            </ul>
          )}
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
                {social.lines.slice(-chatLines(at, W, social.board, true, SHOWN)).map((l) => (
                  <li key={l.id} className={social.unread.includes(l.id) ? 'new' : undefined}>
                    <Line line={l} colour={colour} />
                  </li>
                ))}
              </ol>
            )
          ) : (
            prefs.chatOver && <Passing lines={social.passing} colour={colour} most={chatLines(at, W, social.board, false, Infinity)} />
          )}
        </div>
      )}
    </aside>
  );
}
