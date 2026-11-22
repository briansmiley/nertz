// What a report was sent from: the browser, the system under it and the chip, as far as the browser will say.
//
// Its user agent no longer says. Every Mac's reads "Intel Mac OS X 10_15_7" (10.15 in Firefox), whatever the Mac and
// whatever it runs; Chrome's is as fixed on every other system. Chrome and its kin say the truth when asked instead
// (User-Agent Client Hints, `navigator.userAgentData`), and that is what a report gives. Safari and Firefox are not to
// be asked: of theirs the user agent is given, less that Mac, which nothing bears out.

/** A browser by name and version, as the hints list it. */
interface Brand {
  brand: string;
  version: string;
}

/** What a browser says when asked (`getHighEntropyValues`): any of it may be missing, or empty. */
export interface Hints {
  platform?: string;
  platformVersion?: string;
  architecture?: string;
  bitness?: string;
  /** The device, where it is a phone or a tablet. */
  model?: string;
  fullVersionList?: Brand[];
}

/** How long the browser has to answer: a report is not held up for it. */
const ASK_MS = 500;

/** The Mac every user agent claims to be on: an Intel one, on macOS 10.15. */
const FROZEN_MAC = /; Intel Mac OS X 10[._]15(?:[._]7)?(?=[;)])/;

/**
 * The browser, among the names it gives: its own (Google Chrome, Microsoft Edge) before Chromium, which they all
 * are, and never the made-up one every list carries ("Not?A_Brand", spelled differently each release).
 */
const browser = (list: Brand[]): Brand | undefined => {
  const real = list.filter((b) => b.brand.replace(/[^a-z]/gi, '').toLowerCase() !== 'notabrand');
  return real.find((b) => b.brand !== 'Chromium') ?? real[0];
};

/** The system by name and version. Windows counts its own way in the hints: 13 and up is Windows 11, under it 10. */
const system = (platform: string, version = ''): string => {
  if (platform !== 'Windows') return [platform, version].filter(Boolean).join(' ');
  const major = Number.parseInt(version, 10);
  return major >= 13 ? 'Windows 11' : major >= 1 ? 'Windows 10' : 'Windows';
};

/** What a report says it was sent from. `hints`: what the browser said when asked, if it could be. */
export function device(userAgent: string, hints?: Hints): string {
  const b = browser(hints?.fullVersionList ?? []);
  if (!hints?.platform || !b) return userAgent.replace(FROZEN_MAC, '');
  const chip = [hints.architecture, hints.bitness && `${hints.bitness}-bit`].filter(Boolean).join(' ');
  return [`${b.brand} ${b.version}`, system(hints.platform, hints.platformVersion), chip, hints.model].filter(Boolean).join(', ');
}

/** The same of this browser, asked first. */
export async function thisDevice(): Promise<string> {
  const data = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(hints: string[]): Promise<Hints> } }).userAgentData;
  const asked = data?.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'model', 'fullVersionList']).catch(() => undefined);
  const late = new Promise<undefined>((r) => setTimeout(() => r(undefined), ASK_MS));
  return device(navigator.userAgent, await Promise.race([asked, late]));
}
