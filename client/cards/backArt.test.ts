import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BACK_GROUPS, CARD_BACKS } from '../../shared/protocol';
import { BACK_ART } from './backArt';

// That every back has its art at all is the type's business (`BACK_ART`). What no type sees is here.
describe('the backs', () => {
  it('every picture back has its file, and there is no file that is nobody\'s back', () => {
    const files = readdirSync('public/cards/backs').map((f) => f.replace(/\.png$/, '')).sort();
    const pictures = Object.entries(BACK_ART).flatMap(([back, art]) => (art.k === 'file' ? [back] : [])).sort();
    expect(pictures).toEqual(files);
  });

  it('every back is shown under one kind, once', () => {
    expect(BACK_GROUPS.flatMap((g) => g.backs).sort()).toEqual(Object.keys(CARD_BACKS).sort());
  });
});
