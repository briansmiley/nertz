// The name you last sat down under, remembered across visits (localStorage): it pre-fills the form, and names a report
// sent from away from any table. What makes a reload sit back down is the window's own session, kept by client/net.ts.
import { cleanName } from '../shared/protocol';

const KEY = 'nertz.name';

export function rememberedName(): string {
  try {
    return cleanName(localStorage.getItem(KEY) ?? '');
  } catch {
    return '';
  }
}

export function rememberName(name: string): void {
  try {
    localStorage.setItem(KEY, name);
  } catch {
    // storage unavailable: the name just is not remembered
  }
}
