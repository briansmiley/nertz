// Notices that stack while they last (the snipes told of on the felt, client/Table.tsx): each new one goes under those
// still showing, and each goes on its own once its time is up. How long that is, is the stylesheet's: a notice is gone
// when its animation ends (`done`).
import { useCallback, useEffect, useRef, useState } from 'react';

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
