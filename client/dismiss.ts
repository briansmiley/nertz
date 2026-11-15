import { useEffect, useRef, type RefObject } from 'react';

/**
 * A slip that puts itself away: while `open`, a press anywhere outside `root` (which still does whatever it was meant
 * to do) or Escape calls `close`. The sheet of backs counts as inside: it is put straight into the page, outside any
 * slip it was opened from, and closing that slip would take the sheet with it.
 */
export function useDismiss(root: RefObject<Element | null>, open: boolean, close: () => void): void {
  const shut = useRef(close);
  shut.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node) && !(e.target as Element).closest?.('.picker')) shut.current();
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
