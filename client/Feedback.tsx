// Feedback, from the corner's menu: a slip with a text box, Send, and beside it an optional screenshot (a file, dropped, or pasted), sent
// to the server's /feedback (server/feedback.ts), which keeps it and passes it on. Bug report or feature request: the same slip.
// On a phone, while its keyboard is up, the slip is laid across what of the screen the keyboard leaves: the words, and Send.
import { useEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type FormEvent } from 'react';
import type { RoomView } from '../shared/types';
import { Back } from './Menu';
import { thisDevice } from './device';
import { Bug as BugIcon } from './icons';
import { rememberedName } from './name';
import { touchOnly } from './prefs';
import { useAboveKeyboard } from './viewport';

const MAX_TEXT = 2000;
/** "Sending…" is said at least this long, however quick the server: a report that goes off at once reads as nothing done. */
const SENDING_MS = 600;
/** How long "Sent" stays, folded down and green, before it goes. */
const SENT_MS = 1200;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sent: Send says so where it stands, then the slip zips up onto it, draws in to its own width, and turns green; after
 * a moment it goes. Its anchored corner stays put throughout, by the menu's button.
 */
async function foldAway(f: HTMLFormElement): Promise<void> {
  const go = f.querySelector<HTMLElement>('.go');
  if (!go) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const run = (el: Element, frames: Keyframe[], ms: number, more: KeyframeAnimationOptions = {}) =>
    el.animate(frames, { duration: still ? 0 : ms, easing: 'cubic-bezier(.5, 0, .2, 1)', fill: 'forwards', ...more }).finished;
  const [w, h] = [f.offsetWidth, f.offsetHeight];
  go.style.width = 'max-content';
  const [gw, gh] = [Math.ceil(go.getBoundingClientRect().width), go.offsetHeight];
  go.style.width = '';
  const rest = [...f.children].filter((c): c is HTMLElement => c !== go && c instanceof HTMLElement);

  // Says "Sent" where it stands for a moment first.
  await wait(still ? 0 : 500);
  // Zips up: the paper closes down onto Send, all else fading out of it.
  for (const c of rest) void run(c, [{ opacity: 1 }, { opacity: 0 }], 200);
  void run(f, [{ opacity: 1 }, { opacity: 0 }], 200, { pseudoElement: '::before' });
  // (Each side's padding by name: iOS gives no value for the shorthand.)
  const p = getComputedStyle(f);
  const [pt, pr, pb, pl] = [p.paddingTop, p.paddingRight, p.paddingBottom, p.paddingLeft];
  const none = { paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px' };
  await run(f, [{ height: `${h}px`, paddingTop: pt, paddingRight: pr, paddingBottom: pb, paddingLeft: pl, borderRadius: '3px' }, { height: `${gh}px`, ...none, borderRadius: '8px' }], 420);
  // Draws in to Send's own width. (What the zip hid is gone now, and Send's shadow may show below it.)
  for (const c of rest) c.style.display = 'none';
  f.style.overflow = 'visible';
  await wait(still ? 0 : 80);
  await run(f, [{ width: `${w}px` }, { width: `${gw}px` }], 360);
  await wait(still ? 0 : 80);
  // Turns green: the paper gone from behind it.
  const was = getComputedStyle(go);
  void run(f, [{ backgroundColor: getComputedStyle(f).backgroundColor, boxShadow: getComputedStyle(f).boxShadow }, { backgroundColor: 'transparent', boxShadow: 'none' }], 280);
  await run(go, [{ backgroundColor: was.backgroundColor, color: was.color, boxShadow: was.boxShadow }, { backgroundColor: '#2f8f5b', color: '#fffdf7', boxShadow: '0 4px 0 #1f6440' }], 280);
  await wait(still ? 600 : SENT_MS);
  await run(f, [{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '0 6px' }], 400, { easing: 'ease-in' });
}

/** A screenshot is scaled down to fit this (the longer side) and sent as a JPEG: small enough for the server's cap. */
const MAX_SIDE = 1600;

function BulbIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 17.2h6M9.8 20.3h4.4M8.7 14.6a6 6 0 1 1 6.6 0c-.6.5-.9 1.2-.9 2v.6H9.6v-.6c0-.8-.3-1.5-.9-2z" />
    </svg>
  );
}

/** The picture as a JPEG data URL, no larger than MAX_SIDE on its longer side. */
async function shrink(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.82);
}

/** The slip, as the corner's menu opens it (Settings.tsx `Corner`). `back`: to the menu; `close`: put it away. */
export function FeedbackSlip({ room, back, close }: { room?: RoomView | null; back: () => void; close: () => void }) {
  const [kind, setKind] = useState<'bug' | 'idea'>('bug');
  const [text, setText] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [state, setState] = useState<{ k: 'idle' | 'sending' | 'sent' } | { k: 'error'; message: string }>({ k: 'idle' });
  const form = useRef<HTMLFormElement>(null);
  // Sent: the slip folds away to Send, saying so, and then puts itself away. (Closed before then, it is simply gone.)
  useEffect(() => {
    if (state.k !== 'sent' || !form.current) return;
    let here = true;
    void foldAway(form.current).catch(() => {}).then(() => here && close()); // (folded or not, it goes)
    return () => void (here = false);
  }, [state.k]);
  /** The words have the focus. */
  const [focused, setFocused] = useState(false);
  /** Writing with a phone's keyboard up: the slip is laid over what of the screen the keyboard leaves. */
  const pad = useAboveKeyboard(focused);

  const attach = async (file: Blob | null | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    try {
      setImage(await shrink(file));
    } catch {
      setState({ k: 'error', message: 'That picture could not be read.' });
    }
  };
  /** A picture dragged from elsewhere and let go anywhere on the slip. */
  const onDrop = (e: DragEvent) => {
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    e.preventDefault(); // (whatever it was: the browser must not open it in place of the game)
    if (file) void attach(file);
  };
  const onPaste = (e: ClipboardEvent) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (file) (e.preventDefault(), void attach(file));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || state.k === 'sending') return;
    setState({ k: 'sending' });
    const me = room?.players.find((p) => p.id === room.me);
    const stage = room ? (room.phase === 'playing' ? `round ${room.round}, ${room.game?.status.at ?? 'playing'}` : room.phase === 'results' ? `score sheet, round ${room.round}` : 'lobby') : 'first page';
    try {
      const context = `${stage} · ${room?.players.length ?? 0} at the table · ${window.innerWidth}×${window.innerHeight} · ${await thisDevice()}`;
      const [res] = await Promise.all([fetch('/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, text, name: me?.name ?? (rememberedName() || undefined), room: room?.code, context, image }) }), wait(SENDING_MS)]);
      const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!res.ok || !body?.ok) return setState({ k: 'error', message: body?.message ?? 'That did not go through. Try again in a moment.' });
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); // (on a phone the keyboard goes, and the slip back to its own place, to say it)
      setState({ k: 'sent' });
    } catch {
      setState({ k: 'error', message: 'That did not go through. Try again in a moment.' });
    }
  };

  return (
    // (Keys typed here are not the game's: Space deals, M mutes.)
    <form ref={form} className={`slip feedback${pad ? ' writing' : ''}${state.k === 'sent' ? ' sent' : ''}`} style={pad ? ({ left: pad.x, top: pad.y, width: pad.w, '--under': `${Math.max(0, document.documentElement.clientHeight - pad.y - pad.h)}px` } as CSSProperties) : undefined} aria-label="Feedback" onSubmit={submit} onPaste={onPaste} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onKeyDown={(e) => e.stopPropagation()}>
      <header className="slip-head">
        <Back onClick={back} />
        <h3>Feedback</h3>
      </header>
      <div className="kinds" role="radiogroup" aria-label="What kind">
        <button type="button" role="radio" aria-checked={kind === 'bug'} className={kind === 'bug' ? 'on' : ''} onClick={() => setKind('bug')}>
          <BugIcon />
          Bug
        </button>
        <button type="button" role="radio" aria-checked={kind === 'idea'} className={kind === 'idea' ? 'on' : ''} onClick={() => setKind('idea')}>
          <BulbIcon />
          Idea
        </button>
      </div>
      {/* (On a phone the keyboard comes up when the words are pressed, not with the slip: what kind, and the screenshot, are seen first.) */}
      <textarea
        autoFocus={!touchOnly()}
        rows={5}
        maxLength={MAX_TEXT}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={kind === 'bug' ? "What's wrong?" : 'What do you want?'}
        aria-label="Your report"
      />
      {state.k === 'error' && (
        <p className="error" role="alert">
          {state.message}
        </p>
      )}
      {/* (Pressed while writing on a phone, it leaves the focus in the words: the keyboard stays up, and the slip where it is, until they are sent.) */}
      <button type="submit" className="go" disabled={!text.trim() || state.k === 'sending' || state.k === 'sent'} onMouseDown={pad ? (e) => e.preventDefault() : undefined}>
        {state.k === 'sending' ? 'Sending…' : state.k === 'sent' ? 'Sent ✓' : kind === 'bug' ? 'Report bug' : 'Suggest'}
      </button>
      {/* (After Send, at its side: Tab from the words goes to Send. A screenshot can as well be dragged or pasted anywhere on the slip.) */}
      {image ? (
        <div className="shot">
          <img src={image} alt="The attached screenshot" />
          <button type="button" className="trash" aria-label="Remove the screenshot" data-tip="Remove the screenshot" onClick={() => setImage(null)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 7h14M10 7V4.8h4V7M7 7l.8 12.2h8.4L17 7M10.3 10.5v5.5M13.7 10.5v5.5" />
            </svg>
          </button>
        </div>
      ) : (
        <label className="attach" data-tip="Screenshot: click, drag, or paste">
          <input type="file" accept="image/*" aria-label="Add a screenshot" onChange={(e) => (void attach(e.target.files?.[0]), (e.target.value = ''))} />
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <circle cx="8.5" cy="10" r="1.6" />
            <path d="M4 17.5l5-5 3.5 3.5 2.5-2.5 5 4.5" />
          </svg>
        </label>
      )}
    </form>
  );
}
