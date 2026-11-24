// The address, as the one thing that says whose page is up: `/u/<handle>` is someone's (yours, on the home page's
// pad turned over), `/u/<handle>/following` who they follow (yours alone to see: on anyone else's it is their page),
// anything else is no one's. Nothing here keeps a copy: it is read from `location` whenever it is wanted, and whoever
// wants it is told when it changes, by going to a page or back, or by the browser's own back.
import { useSyncExternalStore } from 'react';
import { handleOf } from '../shared/protocol';

/** Where the address is: whose page, and whether on it who they follow. */
export interface Addressed {
  handle: string;
  following: boolean;
}

/** Where `path` is (`/u/<handle>`, in any case, and `/following` after it), if it is a page. */
export function addressIn(path: string): Addressed | null {
  const [, at, following] = /^\/u\/([^/]+)(\/following)?\/?$/.exec(path) ?? [];
  const handle = at ? handleOf(at) : null;
  return handle ? { handle, following: !!following } : null;
}

const pathOf = ({ handle, following }: Addressed): string => `/u/${handle}${following ? '/following' : ''}`;

const listeners = new Set<() => void>();
const changed = (): void => listeners.forEach((l) => l());
if (typeof window !== 'undefined') window.addEventListener('popstate', changed);

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Where the address is, if it is a page. */
export function useAddressed(): Addressed | null {
  return addressIn(useSyncExternalStore(subscribe, () => location.pathname));
}

/** Marks an address gone to from here, so that coming back from it is the browser's own back. */
const FROM_HERE = 'nertz.from-here';

/** Goes to `handle`'s page (or, `following`, who they follow), from here: the browser's back comes back. */
export function showPage(handle: string, following = false): void {
  history.pushState(FROM_HERE, '', pathOf({ handle, following }));
  changed();
}

/** Your page's address, once you have moved it from `was` to `now`: followed where it is up, as if it had been there all along. */
export function moved(was: string, now: string): void {
  const here = addressIn(location.pathname);
  if (here?.handle !== was) return;
  history.replaceState(history.state, '', pathOf({ ...here, handle: now }));
  changed();
}

/**
 * Back: the browser's own back where this address was gone to from here, else the address made `to`'s page in its
 * place, the home page for none (a page opened in a tab of its own, or by a link, has nothing here to go back to).
 */
export function goBack(to: string | null = null): void {
  if (history.state === FROM_HERE) return history.back();
  history.replaceState(null, '', to ? pathOf({ handle: to, following: false }) : '/');
  changed();
}
