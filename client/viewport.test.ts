import { describe, expect, it } from 'vitest';
import { aboveKeyboard, KEYBOARD_MIN, type Seen } from './viewport';

/** What is seen of a window, unmoved and not pinched in, unless said otherwise. */
const seen = (width: number, height: number, more: Partial<Seen> = {}): Seen => ({ offsetLeft: 0, offsetTop: 0, width, height, scale: 1, ...more });

describe('aboveKeyboard', () => {
  it('is nothing while all of the window is seen', () => {
    expect(aboveKeyboard(793, seen(393, 793))).toBeNull();
  });

  it("is nothing while a browser's bars are drawn in or out: more is seen than the page, or a little less", () => {
    expect(aboveKeyboard(793, seen(393, 852))).toBeNull();
    expect(aboveKeyboard(793, seen(393, 793 - KEYBOARD_MIN + 1))).toBeNull();
  });

  it('is what is seen above a keyboard on a phone held upright', () => {
    expect(aboveKeyboard(793, seen(393, 420))).toEqual({ x: 0, y: 0, w: 393, h: 420 });
  });

  it('is where what is seen was moved to, on a phone on its side: the field being typed in was lower than the keyboard leaves', () => {
    expect(aboveKeyboard(393, seen(852, 170, { offsetTop: 96 }))).toEqual({ x: 0, y: 96, w: 852, h: 170 });
  });

  it('is nothing for a pinch, which shrinks all that is seen in proportion', () => {
    expect(aboveKeyboard(793, seen(393 / 2, 793 / 2, { scale: 2, offsetLeft: 80, offsetTop: 200 }))).toBeNull();
  });

  it('is what is seen above a keyboard while pinched in too', () => {
    expect(aboveKeyboard(793, seen(393 / 2, 210, { scale: 2, offsetTop: 300 }))).toEqual({ x: 0, y: 300, w: 393 / 2, h: 210 });
  });
});
