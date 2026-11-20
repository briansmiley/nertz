import { describe, expect, it } from 'vitest';
import { BACKS, nameColour } from './Face';
import { atLeastLight, lightness } from './ink';

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

describe('atLeastLight', () => {
  it('leaves a colour that is light enough as it is', () => {
    expect(atLeastLight('#e2a019', 0.74)).toBe('#e2a019');
  });

  it('makes a dark colour that light, keeping its hue', () => {
    const lifted = atLeastLight('#272b35', 0.74);
    expect(lightness(lifted)).toBeCloseTo(0.74, 2);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(lifted.slice(i, i + 2), 16)) as [number, number, number];
    expect(b).toBeGreaterThan(r); // still a cool slate, not a grey or a brown
    expect(b).toBeGreaterThan(g);
  });

  it('comes back to the same colour when barely lifted', () => {
    const back = channels(atLeastLight('#c9303f', lightness('#c9303f') + 1e-9));
    channels('#c9303f').forEach((c, i) => expect(Math.abs(c - back[i]!)).toBeLessThanOrEqual(1));
  });
});

describe('nameColour', () => {
  it('lifts only the near-black seat; every other seat keeps its own colour', () => {
    BACKS.forEach((_, seat) => expect(lightness(nameColour(seat))).toBeGreaterThan(0.49));
    expect(lightness(nameColour(BACKS.indexOf('#272b35')))).toBeCloseTo(0.5, 2);
    BACKS.forEach((back, seat) => {
      if (back === '#272b35') return;
      const [was, now] = [channels(back), channels(nameColour(seat))];
      was.forEach((c, i) => expect(Math.abs(c - now[i]!)).toBeLessThanOrEqual(2));
    });
  });
});
