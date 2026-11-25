import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import type { Crop } from './account';

/** The window the picture is moved about in: a square, with the circle that will show inside it. */
const VIEW = 260;
/** How far in it may be drawn, past just covering the circle. */
const MOST = 5;

/** Where the picture lies in the window: its scale (window px to a picture px) and the window point its top left is at. */
type Lie = { s: number; x: number; y: number };

/** The least scale at which a picture `w` by `h` covers the window. */
const cover = (w: number, h: number): number => VIEW / Math.min(w, h);

/** A lie kept covering the window: never smaller than covering, never further in than MOST, no edge of it inside the window. */
function kept(l: Lie, w: number, h: number): Lie {
  const s = Math.min(Math.max(l.s, cover(w, h)), cover(w, h) * MOST);
  const clamp = (v: number, size: number) => Math.min(0, Math.max(VIEW - size * s, v));
  return { s, x: clamp(l.x, w), y: clamp(l.y, h) };
}

/** Scaled to `s` about the window point (px, py): that point stays over the same part of the picture. */
const zoomed = (l: Lie, s: number, px: number, py: number): Lie => ({ s, x: px - ((px - l.x) * s) / l.s, y: py - ((py - l.y) * s) / l.s });

/**
 * A picture of you, before it is put up: you see it in a square with the circle that will show, move it about by
 * dragging, and zoom with the slider, the wheel or two fingers. It always covers the circle. Save hands back the
 * square of the picture that is in the window; Cancel, Esc or a tap beside it, nothing.
 */
export function PictureCrop({ file, onSave, onCancel }: { file: Blob; onSave: (crop: Crop) => void; onCancel: () => void }) {
  const [url] = useState(() => URL.createObjectURL(file));
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  /** The picture's size as it is shown (turned upright, as its camera said). */
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [lie, setLie] = useState<Lie>({ s: 1, x: 0, y: 0 });
  /** The pointers down on the window, and where each was: one drags, two pinch. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const view = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const loaded = (img: HTMLImageElement) => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const s = cover(w, h);
    setSize({ w, h });
    setLie({ s, x: (VIEW - w * s) / 2, y: (VIEW - h * s) / 2 });
  };

  /** Where an event is, in the window's own px (it may be drawn at another size than VIEW). */
  const at = (cx: number, cy: number) => {
    const r = view.current!.getBoundingClientRect();
    return { x: ((cx - r.left) * VIEW) / r.width, y: ((cy - r.top) * VIEW) / r.height };
  };
  const move = (next: (l: Lie) => Lie) => size && setLie((l) => kept(next(l), size.w, size.h));

  const down = (e: ReactPointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, at(e.clientX, e.clientY));
  };
  const moved = (e: ReactPointerEvent) => {
    const was = pointers.current.get(e.pointerId);
    if (!was) return;
    const now = at(e.clientX, e.clientY);
    const others = [...pointers.current].filter(([id]) => id !== e.pointerId).map(([, p]) => p);
    pointers.current.set(e.pointerId, now);
    if (others.length === 0) return move((l) => ({ ...l, x: l.x + now.x - was.x, y: l.y + now.y - was.y }));
    // Two fingers: zoom by how much further apart they are, about the point between them.
    const o = others[0]!;
    const before = Math.hypot(was.x - o.x, was.y - o.y);
    const after = Math.hypot(now.x - o.x, now.y - o.y);
    if (before > 0) move((l) => zoomed(l, l.s * (after / before), (now.x + o.x) / 2, (now.y + o.y) / 2));
  };
  const up = (e: ReactPointerEvent) => pointers.current.delete(e.pointerId);
  const wheel = (e: ReactWheelEvent) => {
    const p = at(e.clientX, e.clientY);
    move((l) => zoomed(l, l.s * Math.exp(-e.deltaY * 0.0015), p.x, p.y));
  };
  // The slider: 0 just covering, 1 as far in as it goes, about the window's middle.
  const least = size ? cover(size.w, size.h) : 1;
  const slid = size ? Math.log(lie.s / least) / Math.log(MOST) : 0;
  const slide = (t: number) => move((l) => zoomed(l, least * MOST ** t, VIEW / 2, VIEW / 2));

  const save = () => size && onSave({ x: -lie.x / lie.s, y: -lie.y / lie.s, side: VIEW / lie.s });

  // Drawn at the top of the page, not inside the small picture it was opened from (whose styles are for it alone).
  return createPortal(
    <div className="asked" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="paper-card crop" role="dialog" aria-label="Your picture: move and zoom it to fit the circle">
        <div ref={view} className="window" onPointerDown={down} onPointerMove={moved} onPointerUp={up} onPointerCancel={up} onWheel={wheel}>
          <img
            src={url}
            alt=""
            draggable={false}
            onLoad={(e) => loaded(e.currentTarget)}
            style={size ? { width: size.w * lie.s, height: size.h * lie.s, transform: `translate(${lie.x}px, ${lie.y}px)` } : { visibility: 'hidden' }}
          />
          <span className="ring" aria-hidden="true" />
        </div>
        {/* The zoom: out at the left, in at the right. */}
        <label className="zoom">
          <Glass in={false} />
          <input type="range" aria-label="Zoom" min={0} max={1} step={0.001} value={slid} disabled={!size} onChange={(e) => slide(Number(e.target.value))} />
          <Glass in />
        </label>
        <div className="choose">
          <button type="button" className="plain" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="go" disabled={!size} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A magnifying glass with a − (out) or + (in) in it. */
function Glass({ in: zoomIn }: { in: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L20 20M7.5 10.5h6" />
      {zoomIn && <path d="M10.5 7.5v6" />}
    </svg>
  );
}
