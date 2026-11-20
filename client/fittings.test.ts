import { describe, expect, it } from 'vitest';
import { inPlay, lcg, roomOf, seats } from '../shared/testkit';
import { fittingsOf } from './fittings';
import { nameWidth } from './layout';

const social = { text: true, voice: false, watchText: true, watchVoice: false, inVoice: [] };

describe('your own line', () => {
  it('is measured by what the table writes in it: your name and total; at the end of a round, the wider of the total before the round and after it', () => {
    const room = roomOf(inPlay(seats(3), lcg(3)), 0);
    const playing = { ...room, players: room.players.map((p) => (p.seat === 0 ? { ...p, score: -13 } : p)) };
    expect(fittingsOf(playing, social, false).name).toBe(nameWidth('p0', '-13'));

    // -104 before the round, 7 after it: the line says the one, then the other.
    const line = { seat: 0, id: 0, name: 'p0', played: 15, nertzLeft: 0, delta: 111, total: 7, rounds: 3, calls: 1 };
    const results = { ...room, phase: 'results' as const, players: room.players.map((p) => (p.seat === 0 ? { ...p, score: 7 } : p)), lastRound: { end: { by: 'vote' as const }, scores: [line] } };
    expect(fittingsOf(results, social, false).name).toBe(nameWidth('p0', '-104'));
  });
});
