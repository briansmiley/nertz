// Notices that stack while they last (the snipes and the reshuffle told of on the felt, client/Table.tsx): each new one
// goes under those still showing, and each goes on its own once its time is up. How long that is, is the stylesheet's:
// a notice is gone when its animation ends (`done`).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { calm } from './prefs';

/** At most this many at once: a new one beyond it puts out the oldest. */
const MOST = 4;

/** One notice in a feed: what it tells of, and a key of its own. */
export type Line<T> = T & { id: number };

/** A feed, emptied whenever `fresh` changes (a new round): its notices, how to add one, and how to say one is over. */
export function useFeed<T extends object>(fresh: unknown): [readonly Line<T>[], (t: T) => void, (id: number) => void] {
  const [lines, setLines] = useState<readonly Line<T>[]>([]);
  const next = useRef(0);
  useEffect(() => setLines([]), [fresh]);
  const add = useCallback((t: T) => {
    const id = ++next.current;
    setLines((ls) => [...ls, { ...t, id }].slice(-MOST));
  }, []);
  const done = useCallback((id: number) => setLines((ls) => ls.filter((l) => l.id !== id)), []);
  return [lines, add, done];
}

/** How a line moves up when another comes under it (or down, when one above the foot goes). */
const SLIDE = { duration: 450, easing: 'cubic-bezier(0.4, 0, 0.1, 1)' } as const;

/**
 * For what holds a feed's lines (`ids`: their keys, joined): when the lines change, each one still up slides from where
 * it lay to where it now lies. Only the feed's own few lines are measured, and only then; the slide itself is the
 * browser's (Web Animations), so nothing is reckoned per frame.
 */
export function useSlide(ids: string): RefObject<HTMLDivElement | null> {
  const box = useRef<HTMLDivElement>(null);
  const tops = useRef(new Map<Element, number>());
  useLayoutEffect(() => {
    const was = tops.current;
    const now = new Map<Element, number>();
    for (const el of box.current?.children ?? []) {
      const top = (el as HTMLElement).offsetTop;
      now.set(el, top);
      const laid = was.get(el);
      if (laid === undefined || laid === top || calm()) continue;
      // From where it is seen now: where it lay, and how far along a slide still under way had brought it from there.
      const off = parseFloat(getComputedStyle(el).translate.split(' ')[1] ?? '0') || 0;
      for (const a of el.getAnimations()) if (!(a instanceof CSSAnimation)) a.cancel(); // (the slide, not the line's own fade)
      el.animate([{ translate: `0 ${laid + off - top}px` }, { translate: '0 0' }], SLIDE);
    }
    tops.current = now;
  }, [ids]);
  return box;
}
