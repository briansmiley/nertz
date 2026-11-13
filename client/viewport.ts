import { useEffect, useState } from 'react';

/**
 * The window's size, kept up to date. A phone that is turned can fire `resize` before `innerWidth` / `innerHeight`
 * have their new values (iOS Safari), which would leave the table laid out for the old shape on half the screen:
 * so the size is also read on `orientationchange` and on the visual viewport's own `resize`, and once more a frame
 * and a moment later.
 */
export function useViewport(): [number, number] {
  const [size, setSize] = useState<[number, number]>([window.innerWidth, window.innerHeight]);
  useEffect(() => {
    let frame = 0;
    let later: ReturnType<typeof setTimeout> | undefined;
    const read = () => setSize((was) => (was[0] === window.innerWidth && was[1] === window.innerHeight ? was : [window.innerWidth, window.innerHeight]));
    const on = () => {
      read();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
      clearTimeout(later);
      later = setTimeout(read, 350);
    };
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    window.visualViewport?.addEventListener('resize', on);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
      window.visualViewport?.removeEventListener('resize', on);
      cancelAnimationFrame(frame);
      clearTimeout(later);
    };
  }, []);
  return size;
}

let probe: HTMLElement | null = null;
/**
 * What the screen keeps for itself at its edges, in px (`viewport-fit=cover`: the page runs under a phone's notch and
 * its bottom bar, and says here how far they reach). Read off an unseen element whose padding is those insets.
 */
export function insets(): { l: number; r: number; b: number } {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:0 env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.appendChild(probe);
  }
  const c = getComputedStyle(probe);
  const px = (v: string) => Math.round(parseFloat(v) || 0);
  return { l: px(c.paddingLeft), r: px(c.paddingRight), b: px(c.paddingBottom) };
}
