/**
 * The game's own tooltip, in place of the browser's `title`. Any element with a `data-tip` shows that text beside it:
 * under a mouse (or pen) after a moment, at once while another tip is still fresh, and on keyboard focus. There is one
 * tooltip for the page, drawn over everything and taking no pointer events, so it never stands in the way of a click;
 * it goes under the element unless there is no room, then over it, and stays on screen. A press, Escape or the pointer
 * leaving puts it away, and a scroll puts away the pointer's. A touch has no hover, so a tap shows nothing: what a
 * control does is in its aria-label or its text, and the tip only says it again or adds a detail.
 *
 * An element with an empty `data-tip` has nothing to say, and keeps a tip of something around it from showing.
 */

export type Box = { left: number; top: number; width: number; height: number };
type Size = { width: number; height: number };

/** Space between the element and its tip, and the least between the tip and the window's edge. */
const GAP = 6;
const MARGIN = 8;
/** How long the pointer rests before a tip shows, and how long after one goes the next shows at once. */
const REST_MS = 450;
const FRESH_MS = 400;
/** Bigger than this, an element's tip stands by the pointer rather than under the whole element. */
const BIG = { width: 320, height: 72 };

/** Where the tip goes (its top left corner, in the window): under the anchor, or over it when only that fits, and
 *  centred on it but never closer than MARGIN to the window's edge. */
export function place(anchor: Box, tip: Size, view: Size): { x: number; y: number; above: boolean } {
  const below = anchor.top + anchor.height + GAP;
  const over = anchor.top - GAP - tip.height;
  const fitsBelow = below + tip.height <= view.height - MARGIN;
  const above = !fitsBelow && (over >= MARGIN || anchor.top > view.height - anchor.top - anchor.height);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  return {
    x: clamp(anchor.left + anchor.width / 2 - tip.width / 2, MARGIN, view.width - MARGIN - tip.width),
    y: clamp(above ? over : below, MARGIN, view.height - MARGIN - tip.height),
    above,
  };
}

/** The element whose tip a pointer or focus on `target` would show, if any (the nearest with a `data-tip`). */
function tipOf(target: EventTarget | null): HTMLElement | null {
  const el = target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;
  return el && el.dataset.tip ? el : null;
}

/** The one tip on the page: which element it is for, and whether a pointer or the keyboard brought it. */
type Shown = { el: HTMLElement; by: 'pointer' | 'focus'; at: { x: number; y: number } | null };

/** Set the page's tooltip going (once, at start): returns what takes it away again. */
export function startTips(doc: Document = document): () => void {
  const win = doc.defaultView!;
  const bubble = doc.createElement('div');
  bubble.className = 'tooltip';
  bubble.id = 'tooltip';
  bubble.setAttribute('role', 'tooltip');
  bubble.hidden = true;
  doc.body.append(bubble);

  let shown: Shown | null = null;
  let waiting: { el: HTMLElement; timer: number } | null = null;
  /** Pressed: its tip stays away until the pointer leaves it. */
  let pressed: HTMLElement | null = null;
  let goneAt = -Infinity;
  let frame = 0;

  const cancel = () => {
    if (waiting) win.clearTimeout(waiting.timer);
    waiting = null;
  };

  const hide = () => {
    cancel();
    if (!shown) return;
    if (shown.el.getAttribute('aria-describedby') === bubble.id) shown.el.removeAttribute('aria-describedby');
    shown = null;
    bubble.hidden = true;
    win.cancelAnimationFrame(frame);
    goneAt = win.performance.now();
  };

  /** Each frame while shown: the text as it is now, where the element is now; gone with the element or its tip. */
  const follow = () => {
    if (!shown) return;
    const text = shown.el.dataset.tip;
    if (!shown.el.isConnected || !text) return hide();
    if (bubble.textContent !== text) bubble.textContent = text;
    // By the pointer: a box around the arrow, so the tip goes just under it.
    const anchor = shown.at ? { left: shown.at.x, top: shown.at.y - 10, width: 0, height: 26 } : shown.el.getBoundingClientRect();
    const p = place(anchor, { width: bubble.offsetWidth, height: bubble.offsetHeight }, { width: win.innerWidth, height: win.innerHeight });
    bubble.style.left = `${Math.round(p.x)}px`;
    bubble.style.top = `${Math.round(p.y)}px`;
    frame = win.requestAnimationFrame(follow);
  };

  const show = (el: HTMLElement, by: Shown['by'], pointer?: { x: number; y: number }) => {
    cancel();
    if (shown?.el === el) return;
    hide();
    const r = el.getBoundingClientRect();
    shown = { el, by, at: by === 'pointer' && pointer && (r.width > BIG.width || r.height > BIG.height) ? pointer : null };
    bubble.textContent = el.dataset.tip ?? '';
    bubble.hidden = false;
    // Read out as the element's description, unless it only says the element's name again.
    if (!el.hasAttribute('aria-describedby') && el.dataset.tip !== el.getAttribute('aria-label')) el.setAttribute('aria-describedby', bubble.id);
    follow();
  };

  const hoverable = (e: PointerEvent) => e.pointerType === 'mouse' || e.pointerType === 'pen';

  const over = (e: PointerEvent) => {
    if (!hoverable(e)) return;
    const el = tipOf(e.target);
    if (el && el === pressed) return;
    pressed = null;
    if (!el) return shown?.by === 'pointer' ? hide() : cancel();
    if (el === shown?.el || el === waiting?.el) return;
    const at = { x: e.clientX, y: e.clientY };
    if (shown || win.performance.now() - goneAt < FRESH_MS) return show(el, 'pointer', at);
    cancel();
    waiting = { el, timer: win.setTimeout(() => show(el, 'pointer', at), REST_MS) };
  };

  const out = (e: PointerEvent) => {
    if (!hoverable(e)) return;
    const from = tipOf(e.target);
    if (from && tipOf(e.relatedTarget) === from) return; // within the same element
    if (from === pressed) pressed = null;
    if (waiting?.el === from) cancel();
    if (shown?.by === 'pointer' && shown.el === from) hide();
  };

  const down = (e: PointerEvent) => {
    pressed = tipOf(e.target);
    hide();
  };

  const focus = (e: FocusEvent) => {
    const el = tipOf(e.target);
    let byKeys = false;
    try {
      byKeys = !!el && el.matches(':focus-visible');
    } catch {
      /* a browser without :focus-visible shows no tip on focus */
    }
    if (el && byKeys && el !== pressed) show(el, 'focus');
  };

  const blur = (e: FocusEvent) => {
    if (shown?.by === 'focus' && shown.el === tipOf(e.target)) hide();
  };

  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') hide();
  };

  // A scroll moves the page from under the pointer; a tip from focus follows its element instead (focus can scroll).
  const scroll = () => {
    if (shown?.by !== 'focus') hide();
  };

  const listeners: [string, EventListener][] = [
    ['pointerover', over as EventListener],
    ['pointerout', out as EventListener],
    ['pointerdown', down as EventListener],
    ['focusin', focus as EventListener],
    ['focusout', blur as EventListener],
    ['keydown', key as EventListener],
    ['scroll', scroll],
    ['wheel', scroll],
  ];
  for (const [type, fn] of listeners) doc.addEventListener(type, fn, true);
  win.addEventListener('blur', hide);
  return () => {
    hide();
    for (const [type, fn] of listeners) doc.removeEventListener(type, fn, true);
    win.removeEventListener('blur', hide);
    bubble.remove();
  };
}
