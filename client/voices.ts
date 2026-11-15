// The cap on how many one-shots sound at once (sound.ts). A shot counts from
// when it starts to when it ends on the audio clock, not from when it was
// scheduled: a deal schedules all its flicks at once, but few of them sound
// together.

/** One shot on the audio clock, in seconds. `end` may be brought forward when the shot is cut short. */
export interface Voice {
  start: number;
  end: number;
}

export class Voices {
  private live: Voice[] = [];

  constructor(readonly max: number) {}

  /** How many shots are sounding at `t`. */
  sounding(t: number): number {
    let n = 0;
    for (const v of this.live) if (v.start <= t && t < v.end) n++;
    return n;
  }

  /**
   * Counts a shot that will sound from `start` to `end`, unless there would then be more than `max` sounding at some
   * moment of it (null: it stays silent). The count only rises where a shot starts, so those are the moments looked at:
   * its own start and the start of any shot already scheduled within it. Shots that have ended by `now` are forgotten.
   */
  take(now: number, start: number, end: number): Voice | null {
    this.live = this.live.filter((v) => v.end > now);
    for (const t of [start, ...this.live.map((v) => v.start).filter((s) => s > start && s < end)]) {
      if (this.sounding(t) >= this.max) return null;
    }
    const v = { start, end };
    this.live.push(v);
    return v;
  }

  /** How many shots are sounding or still to sound. */
  get size(): number {
    return this.live.length;
  }
}
