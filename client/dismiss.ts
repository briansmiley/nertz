import { useEffect, useRef, type RefObject } from 'react';

/** How long the click after a closing press is waited for: a press that turns into a drag never clicks. */
const CLICK_MS = 1000;

/**
 * A slip that puts itself away: while `open`, a press anywhere outside `root` or Escape calls `close`. The press only
 * puts it away: the click it ends in is held back, so nothing under it is pressed, opened or toggled (the press itself
 * goes on, as cards drag from it). The sheet of backs counts as inside: it is put straight into the page, outside any
 * slip it was opened from, and closing that slip would take the sheet with it.
 */
export function useDismiss(root: RefObject<Element | null>, open: boolean, close: () => void): void {
  const shut = useRef(close);
  shut.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current?.contains(e.target as Node) || (e.target as Element).closest?.('.picker')) return;
      shut.current();
      holdClick();
    };
    const onKey = (e: KeyboardEvent) => e.code === 'Escape' && shut.current();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, root]);
}

/** Holds back the next click, if one comes before the next press or within CLICK_MS. (It outlives the slip, which is gone by then.) */
function holdClick(): void {
  const stop = (e: MouseEvent) => (e.preventDefault(), e.stopPropagation(), done());
  const done = () => {
    clearTimeout(timer);
    window.removeEventListener('click', stop, true);
    window.removeEventListener('pointerdown', done, true);
  };
  const timer = setTimeout(done, CLICK_MS);
  window.addEventListener('click', stop, true);
  window.addEventListener('pointerdown', done, true); // (not called for the press that armed it: it is added while that press is on window)
}
