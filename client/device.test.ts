import { describe, expect, it } from 'vitest';
import { device, type Hints } from './device';

/** Chrome's user agent on any Mac at all. */
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

const chrome = (more: Hints): Hints => ({
  fullVersionList: [
    { brand: 'Not?A_Brand', version: '8.0.0.0' },
    { brand: 'Chromium', version: '157.0.7432.12' },
    { brand: 'Google Chrome', version: '157.0.7432.12' },
  ],
  ...more,
});

describe('what a report was sent from', () => {
  it('is what the browser says when asked, not what its user agent claims', () => {
    const from = device(CHROME_MAC, chrome({ platform: 'macOS', platformVersion: '26.1.0', architecture: 'arm', bitness: '64', model: '' }));
    expect(from).toBe('Google Chrome 157.0.7432.12, macOS 26.1.0, arm 64-bit');
    expect(from).not.toMatch(/Intel|10_15/);
  });

  it('names the browser itself: Chromium only where that is all it is, and never the made-up brand', () => {
    const mac: Hints = { platform: 'macOS', platformVersion: '26.1.0', architecture: 'x86', bitness: '64' };
    const edge = [
      { brand: 'Chromium', version: '157.0.7432.12' },
      { brand: 'Not/A)Brand', version: '24.0.0.0' },
      { brand: 'Microsoft Edge', version: '157.0.3800.5' },
    ];
    expect(device(CHROME_MAC, { ...mac, fullVersionList: edge })).toBe('Microsoft Edge 157.0.3800.5, macOS 26.1.0, x86 64-bit');
    expect(device(CHROME_MAC, { ...mac, fullVersionList: edge.slice(0, 2) })).toBe('Chromium 157.0.7432.12, macOS 26.1.0, x86 64-bit');
  });

  it('calls Windows by its name, which is not the number the browser gives', () => {
    const on = (platformVersion: string) => device('', chrome({ platform: 'Windows', platformVersion, architecture: 'x86', bitness: '64' }));
    expect(on('19.0.0')).toBe('Google Chrome 157.0.7432.12, Windows 11, x86 64-bit');
    expect(on('13.0.0')).toBe('Google Chrome 157.0.7432.12, Windows 11, x86 64-bit');
    expect(on('10.0.0')).toBe('Google Chrome 157.0.7432.12, Windows 10, x86 64-bit');
    expect(on('0.3.0')).toBe('Google Chrome 157.0.7432.12, Windows, x86 64-bit');
  });

  it('names a phone, and leaves out whatever the browser left empty', () => {
    expect(device('', chrome({ platform: 'Android', platformVersion: '16.0.0', architecture: '', bitness: '', model: 'Pixel 9' }))).toBe('Google Chrome 157.0.7432.12, Android 16.0.0, Pixel 9');
    expect(device('', chrome({ platform: 'Linux', platformVersion: '', architecture: 'x86', bitness: '64', model: '' }))).toBe('Google Chrome 157.0.7432.12, Linux, x86 64-bit');
  });

  it('is the user agent where the browser is not to be asked, less the Mac that every one of them claims', () => {
    expect(device(CHROME_MAC)).toBe('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36');
    expect(device('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15')).toBe('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15');
    expect(device('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0')).toBe('Mozilla/5.0 (Macintosh; rv:145.0) Gecko/20100101 Firefox/145.0');
  });

  it('is the user agent as it stands where it claims no such Mac', () => {
    const phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
    const old = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.2 Safari/605.1.15';
    expect(device(phone)).toBe(phone);
    expect(device(old)).toBe(old);
  });

  it('is the user agent too where the browser answered with nothing to go on', () => {
    expect(device(CHROME_MAC, {})).toBe(device(CHROME_MAC));
    expect(device(CHROME_MAC, { platform: 'macOS', fullVersionList: [{ brand: 'Not;A=Brand', version: '99.0.0.0' }] })).toBe(device(CHROME_MAC));
  });
});
