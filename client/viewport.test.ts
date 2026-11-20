import { describe, expect, it } from 'vitest';
import { putBack, type Page } from './viewport';

/** A table: the page reaches nowhere (everything is drawn fixed to the window), and is where it belongs. */
const TABLE: Page = { x: 0, y: 0, maxX: 0, maxY: 0, offX: 0, offY: 0, zoomed: false, typing: false };

describe('putBack', () => {
  it('leaves a page that is where it belongs', () => {
    expect(putBack(TABLE)).toBeNull();
    expect(putBack({ ...TABLE, y: 0.6, offY: 0.4 })).toBeNull(); // (a phone's part of a pixel)
  });

  it('puts a table back at the top once the keyboard has gone, or the phone has been turned, and left it moved', () => {
    expect(putBack({ ...TABLE, y: 214 })).toEqual([0, 0]);
    expect(putBack({ ...TABLE, x: 59, y: 120 })).toEqual([0, 0]);
  });

  it('puts the window back over the page where what is shown was left off it', () => {
    expect(putBack({ ...TABLE, offY: 24 })).toEqual([0, 0]);
  });

  it('lets the page be moved while a field is typed into: the keyboard is up, and the field must show', () => {
    expect(putBack({ ...TABLE, y: 214, offY: 214, typing: true })).toBeNull();
  });

  it('leaves a page zoomed by hand where it is looked at', () => {
    expect(putBack({ ...TABLE, x: 80, y: 140, offX: 80, offY: 140, zoomed: true })).toBeNull();
  });

  it('leaves a page that scrolls (the home page, the lobby) wherever it is scrolled to, short of its end', () => {
    const lobby: Page = { ...TABLE, maxY: 420 };
    expect(putBack({ ...lobby, y: 300 })).toBeNull();
    expect(putBack({ ...lobby, y: 420 })).toBeNull();
    expect(putBack({ ...lobby, y: 640 })).toEqual([0, 420]);
  });
});
