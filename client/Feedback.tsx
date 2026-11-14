// The bug button in the corner: a slip with a text box and an optional screenshot (a file, dropped, or pasted), sent to the
// server's /feedback (server/feedback.ts), which passes it on. Bug report or feature request: the same slip.
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from 'react';
import type { RoomView } from '../shared/types';

const MAX_TEXT = 2000;
/** A screenshot is scaled down to fit this (the longer side) and sent as a JPEG: small enough for the server's cap. */
const MAX_SIDE = 1600;

function BugIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="14" rx="4.6" ry="5.8" />
      <path d="M9.2 8.6a2.9 2.9 0 0 1 5.6 0M9.5 5 8 3.3M14.5 5 16 3.3M12 9v10.6M7.4 12.5H3.8M7.4 16H4.3l-.9 2.6M16.6 12.5h3.6M16.6 16h3.1l.9 2.6M7.8 10.2 5 8.4M16.2 10.2 19 8.4" />
    </svg>
  );
}

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

export function Feedback({ room }: { room?: RoomView | null }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'bug' | 'idea'>('bug');
  const [text, setText] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [state, setState] = useState<{ k: 'idle' | 'sending' | 'sent' } | { k: 'error'; message: string }>({ k: 'idle' });
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
    const me = room?.players.find((p) => p.seat === room.you);
    const stage = room ? (room.phase === 'playing' ? `round ${room.round}, ${room.game?.stage ?? 'playing'}` : room.phase === 'results' ? `score sheet, round ${room.round}` : 'lobby') : 'first page';
    const context = `${stage} · ${room?.players.length ?? 0} at the table · ${window.innerWidth}×${window.innerHeight} · ${navigator.userAgent}`;
    try {
      const res = await fetch('/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, text, name: me?.name, room: room?.code, context, image }) });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!res.ok || !body?.ok) return setState({ k: 'error', message: body?.message ?? 'That did not go through. Try again in a moment.' });
      setText('');
      setImage(null);
      setState({ k: 'sent' });
    } catch {
      setState({ k: 'error', message: 'That did not go through. Try again in a moment.' });
    }
  };

  return (
    <span className="pop-at" ref={root}>
      <button
        type="button"
        className={`knob${open ? ' on' : ''}`}
        aria-expanded={open}
        aria-label="Report a bug or ask for a feature"
        title="Report a bug or ask for a feature"
        onClick={(e) => {
          setOpen(!open);
          if (state.k !== 'sending') setState({ k: 'idle' });
          e.currentTarget.blur();
        }}
      >
        <BugIcon />
      </button>
      {open && (
        // (Keys typed here are not the game's: Space deals, M mutes.)
        <form className="slip feedback" aria-label="Feedback" onSubmit={submit} onPaste={onPaste} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onKeyDown={(e) => e.stopPropagation()}>
          <h3>Feedback</h3>
          {state.k === 'sent' ? (
            <>
              <p className="hint">Got it, thank you.</p>
              <button type="button" className="plain" onClick={() => setState({ k: 'idle' })}>
                Send more
              </button>
            </>
          ) : (
            <>
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
              <textarea autoFocus rows={5} maxLength={MAX_TEXT} value={text} onChange={(e) => setText(e.target.value)} placeholder={kind === 'bug' ? "What's wrong?" : 'What do you want?'} aria-label="Your report" />
              {image ? (
                <div className="shot">
                  <img src={image} alt="The attached screenshot" />
                  <button type="button" className="trash" aria-label="Remove the screenshot" title="Remove the screenshot" onClick={() => setImage(null)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M5 7h14M10 7V4.8h4V7M7 7l.8 12.2h8.4L17 7M10.3 10.5v5.5M13.7 10.5v5.5" />
                    </svg>
                  </button>
                </div>
              ) : (
                <label className="attach">
                  <input type="file" accept="image/*" onChange={(e) => (void attach(e.target.files?.[0]), (e.target.value = ''))} />
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="14" rx="2" />
                    <circle cx="8.5" cy="10" r="1.6" />
                    <path d="M4 17.5l5-5 3.5 3.5 2.5-2.5 5 4.5" />
                  </svg>
                  Screenshot <small>(click, drag, or paste)</small>
                </label>
              )}
              {state.k === 'error' && (
                <p className="error" role="alert">
                  {state.message}
                </p>
              )}
              <button type="submit" className="go" disabled={!text.trim() || state.k === 'sending'}>
                {state.k === 'sending' ? 'Sending…' : kind === 'bug' ? 'Report bug' : 'Suggest'}
              </button>
            </>
          )}
        </form>
      )}
    </span>
  );
}
