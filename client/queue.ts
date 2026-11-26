// What this browser keeps to send the server later (feedback, client/outbox.ts; rounds played offline, client/record.ts):
// a list in localStorage, every window's of this browser. Each thing kept has an id, a window sends them one at a time
// under a lock the windows share (`navigator.locks`), and takes out exactly the one it sent. So each goes once, however
// many windows are open when it can.

export const newId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * POSTs `body` to `path` as JSON, and what came back is what `read` makes of it; or, where nothing did, what `lost`
 * makes of whether it is worth trying again in a while: so if it was not answered within `patience`, not so with no
 * network to send on (which says when it is back).
 */
export async function send<A>(path: string, body: unknown, patience: number, read: (res: Response) => Promise<A>, lost: (again: boolean) => A): Promise<A> {
  const waiting = new AbortController();
  const late = setTimeout(() => waiting.abort(), patience);
  try {
    return await read(await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: waiting.signal }));
  } catch {
    return lost(waiting.signal.aborted);
  } finally {
    clearTimeout(late);
  }
}

/**
 * What is kept under `key`. `flush` sends it, under the lock, the one `next` picks of it each time (read anew: another
 * window may have sent some while this one waited its turn), as `go` does, until there is none or `go` says to stop.
 * `again` flushes it in `againMs`: once, however often that is asked.
 */
export function queue<T extends { id: string }>(key: string, againMs: number, next: (kept: T[]) => T | undefined, go: (item: T) => Promise<boolean>) {
  function kept(): T[] {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
      return Array.isArray(v) ? (v as T[]) : [];
    } catch {
      return [];
    }
  }

  /** Writes what is kept; false if the browser would not take it (no storage, or no room in it). */
  function write(items: T[]): boolean {
    try {
      if (items.length) localStorage.setItem(key, JSON.stringify(items));
      else localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }

  /** Takes `id` out of what is kept, or puts `as` in its place: that one, wherever it is by now, and no other. */
  const settle = (id: string, as?: T): boolean => write(kept().flatMap((r) => (r.id !== id ? [r] : as ? [as] : [])));

  let retry: ReturnType<typeof setTimeout> | undefined;
  function again(): void {
    clearTimeout(retry);
    retry = setTimeout(() => void flush(), againMs);
  }

  /** Runs `fn` while no other window of this browser is running one: under the lock they share, where the browser has such a thing. */
  const alone = (fn: () => Promise<void>): Promise<void> => (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(key, fn) : fn());

  let flushing = false;
  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      await alone(async () => {
        for (let item = next(kept()); item; item = next(kept())) if (!(await go(item))) return;
      });
    } finally {
      flushing = false;
    }
  }

  return { kept, write, settle, again, flush };
}
