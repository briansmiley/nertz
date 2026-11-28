import { describe, expect, it } from 'vitest';
import type { RoundLine } from '../shared/types';
import { sheetOrder } from './App';

/** A line of the sheet: whose, what they played and had left in the nertz pile, and what they have kept across rounds. */
const line = (name: string, played: number, nertzLeft: number, total: number, calls = 0): RoundLine => ({ seat: 0, id: 0, name, played, nertzLeft, delta: played - 2 * nertzLeft, total, rounds: 2, calls });
// Bo got Nertz and won the round (+14); Al and Di made the same of it (+3); Cy lost it (−2) and still leads the table.
const lines = [line('Di', 9, 3, 3), line('Cy', 6, 4, 40, 2), line('Al', 5, 1, 12), line('Bo', 14, 0, 20, 1)];
const names = (sorted: RoundLine[]) => sorted.map((l) => l.name).join(' ');

describe('the score sheet', () => {
  it("lists the round's best first, whoever leads the table: a tie on the round goes by the total", () => {
    expect(names(sheetOrder(lines, { by: 'round', reversed: false }))).toBe('Bo Al Di Cy');
  });

  it('sorts by any column, its best first: the most points or calls, the fewest cards left, the names from A', () => {
    expect(names(sheetOrder(lines, { by: 'total', reversed: false }))).toBe('Cy Bo Al Di');
    expect(names(sheetOrder(lines, { by: 'played', reversed: false }))).toBe('Bo Di Cy Al');
    expect(names(sheetOrder(lines, { by: 'nertz', reversed: false }))).toBe('Bo Al Di Cy');
    expect(names(sheetOrder(lines, { by: 'name', reversed: false }))).toBe('Al Bo Cy Di');
    // (Al and Di have called none, and made the same of the round: the total says which is first.)
    expect(names(sheetOrder(lines, { by: 'calls', reversed: false }))).toBe('Cy Bo Al Di');
  });

  it("sorts by the total's average per round, whoever has played the fewest rounds, and a line with none last", () => {
    const some = [{ ...line('Al', 5, 1, 12), rounds: 3 }, { ...line('Bo', 14, 0, 20), rounds: 2 }, line('Cy', 6, 4, 18), { ...line('Di', 9, 3, 0), rounds: 0 }];
    // Al 4, Bo 10, Cy 9, Di none.
    expect(names(sheetOrder(some, { by: 'average', reversed: false }))).toBe('Bo Cy Al Di');
  });

  it('turns over, ties and all, the other way round', () => {
    expect(names(sheetOrder(lines, { by: 'total', reversed: true }))).toBe('Di Al Bo Cy');
    expect(names(sheetOrder(lines, { by: 'calls', reversed: true }))).toBe('Di Al Bo Cy');
  });
});
