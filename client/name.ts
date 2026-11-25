// The name you last sat down under, remembered across visits (localStorage): it pre-fills the form, and names a report
// sent from away from any table. What makes a reload sit back down is the window's own session, kept by client/net.ts.
import { cleanName } from '../shared/protocol';

const KEY = 'nertz.name';
/** The name you last sat down under at all, signed in or not: who you are offline, where nobody is signed in. */
const LAST_KEY = 'nertz.name.last';

const read = (key: string): string => {
  try {
    return cleanName(localStorage.getItem(key) ?? '');
  } catch {
    return '';
  }
};
const write = (key: string, name: string): void => {
  try {
    localStorage.setItem(key, name);
  } catch {
    // storage unavailable: the name just is not remembered
  }
};

export const lastName = (): string => read(LAST_KEY) || read(KEY);
export const satDownAs = (name: string): void => write(LAST_KEY, name);

export const rememberedName = (): string => read(KEY);
export const rememberName = (name: string): void => write(KEY, name);
