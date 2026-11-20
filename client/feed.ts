// Notices that stack while they last (the snipes told of on the felt, client/Table.tsx): each new one goes under those
// still showing, and each goes on its own once its time is up.
import { useCallback, useEffect, useRef, useState } from 'react';

/** At most this many at once: a new one beyond it puts out the oldest. */
const MOST = 4;

/** One notice in a feed: what it tells of, and a key of its own. */
export type Line<T> = T & { id: number };

/** A feed whose notices last `life` ms each, emptied whenever `fresh` changes (a new round). */
export function useFeed<T extends object>(life: number, fresh: unknown): [readonly Line<T>[], (t: T) => void] {
  const [lines, setLines] = useState<readonly Line<T>[]>([]);
  const next = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    setLines([]);
    const all = timers.current;
    return () => {
      for (const t of all) clearTimeout(t);
      all.clear();
    };
  }, [fresh]);
  const add = useCallback(
    (t: T) => {
      const id = ++next.current;
      setLines((ls) => [...ls, { ...t, id }].slice(-MOST));
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        setLines((ls) => ls.filter((l) => l.id !== id));
      }, life);
      timers.current.add(timer);
    },
    [life],
  );
  return [lines, add];
}
