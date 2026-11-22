// The address, as the one thing that says whose page is up: `/u/<handle>` is someone's (yours, on the home page's
// pad turned over), anything else is no one's. Nothing here keeps a copy: it is read from `location` whenever it is
// wanted, and whoever wants it is told when it changes, by going to a page or back here, or by the browser's own back.
import { useSyncExternalStore } from 'react';
import { isHandle } from '../shared/protocol';

/** Whose page `path` is (`/u/<handle>`), if it is one. */
export function pageIn(path: string): string | null {
  const [, handle] = /^\/u\/([^/]+)\/?$/.exec(path) ?? [];
  return handle && isHandle(handle) ? handle : null;
}

const listeners = new Set<() => void>();
const changed = (): void => listeners.forEach((l) => l());
if (typeof window !== 'undefined') window.addEventListener('popstate', changed);

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Whose page the address is, if it is one. */
export function useAddressed(): string | null {
  return pageIn(useSyncExternalStore(subscribe, () => location.pathname));
}

/** Marks an address gone to from here, so that coming back from it is the browser's own back. */
const FROM_HERE = 'nertz.from-here';

/** Goes to `handle`'s page, from here: the browser's back comes back. */
export function showPage(handle: string): void {
  history.pushState(FROM_HERE, '', `/u/${handle}`);
  changed();
}

/**
 * Back from a page to the home page: the browser's own back where the page was gone to from here, else the address
 * made the home page's in its place (a page opened in a tab of its own, or by a link, has nothing here to go back to).
 */
export function goHome(): void {
  if (history.state === FROM_HERE) return history.back();
  history.replaceState(null, '', '/');
  changed();
}
