/**
 * The game's own tooltip, in place of the browser's `title`. Any element with a `data-tip` shows that text beside it:
 * under a mouse (or pen) after a moment, at once while another tip is still fresh, and on keyboard focus. There is one
 * tooltip for the page, drawn over everything and taking no pointer events, so it never stands in the way of a click;
 * it goes under the element unless there is no room, then over it, and stays on screen. A press, Escape or the pointer
 * leaving puts it away, and a scroll puts away the pointer's. A touch has no hover, so a tap shows nothing: what a
 * control does is in its aria-label or its text, and the tip only says it again or adds a detail.
 *
 * The pointer must come to rest: the wait starts again while it moves. By a big element the tip stands where the
 * pointer stopped, and goes again once it moves on.
 *
 * What a tip says is also the element's accessible description (`aria-description`, kept in step with `data-tip` at
 * all times, as `title` was), unless it only says the element's name again, so a screen reader hears it whether or not
 * the tip is showing: on a disabled control, in browse mode, by touch.
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
/** How far the pointer may drift by a big element before its tip goes. */
const DRIFT = 6;

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

/** An element's description is what its tip says, unless that is only its name again or nothing. */
export function describe(el: HTMLElement): void {
  if (!el.hasAttribute('data-tip')) return el.removeAttribute('aria-description');
  const tip = el.dataset.tip;
  if (tip && tip !== el.getAttribute('aria-label')) {
    if (el.getAttribute('aria-description') !== tip) el.setAttribute('aria-description', tip);
  } else el.removeAttribute('aria-description');
}

/** Keep descriptions in step with what changed: tips and names set or changed, elements added. */
function described(changes: MutationRecord[]): void {
  for (const c of changes) {
    if (c.type === 'attributes') {
      if (c.target instanceof HTMLElement && (c.attributeName === 'data-tip' || c.target.hasAttribute('data-tip'))) describe(c.target);
      continue;
    }
    for (const n of c.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      if (n.hasAttribute('data-tip')) describe(n);
      for (const el of n.querySelectorAll<HTMLElement>('[data-tip]')) describe(el);
    }
  }
}

/** The one tip on the page: which element it is for, and whether a pointer or the keyboard brought it. */
type Shown = { el: HTMLElement; by: 'pointer' | 'focus'; at: { x: number; y: number } | null };

/** Set the page's tooltip going (once, at start): returns what takes it away again. */
export function startTips(doc: Document = document): () => void {
  const win = doc.defaultView!;
  const bubble = doc.createElement('div');
  bubble.className = 'tooltip';
  bubble.id = 'tooltip';
  // The tip only shows what each element's description already says.
  bubble.setAttribute('aria-hidden', 'true');
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

  /** The wait for a rest starts again where the pointer is now; by a big element, a tip it has left behind goes. */
  const move = (e: PointerEvent) => {
    if (!hoverable(e)) return;
    const at = { x: e.clientX, y: e.clientY };
    if (waiting) {
      const el = waiting.el;
      win.clearTimeout(waiting.timer);
      waiting = { el, timer: win.setTimeout(() => show(el, 'pointer', at), REST_MS) };
    } else if (shown?.by === 'pointer' && shown.at && Math.hypot(at.x - shown.at.x, at.y - shown.at.y) > DRIFT) {
      const el = shown.el;
      hide();
      waiting = { el, timer: win.setTimeout(() => show(el, 'pointer', at), REST_MS) };
    }
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
    ['pointermove', move as EventListener],
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
  for (const el of doc.querySelectorAll<HTMLElement>('[data-tip]')) describe(el);
  const watch = new win.MutationObserver(described);
  watch.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tip', 'aria-label'] });
  return () => {
    watch.disconnect();
    hide();
    for (const [type, fn] of listeners) doc.removeEventListener(type, fn, true);
    win.removeEventListener('blur', hide);
    bubble.remove();
  };
}
