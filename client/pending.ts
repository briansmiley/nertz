// The one-shots (sound.ts) still to sound, waiting on the page's clock. Every
// picture on the table runs on the page's clock (performance.now), and its
// sound must keep to it; but the audio has a clock of its own, which the
// browser stops whenever it stops the audio (a phone, while you are in another
// app) as the page's goes on. A shot put on the audio clock seconds ahead (the
// wash's whisper for each card, the deal's flicks) would then sound late by
// however long the page was away, out of step with the cards it is the sound
// of. So a shot waits here and is handed to the audio clock only just before
// its moment; one whose moment is gone is never heard.

/** A shot is handed to the audio clock this long before its moment (ms): a timer that fires a little late is still in time. */
export const AHEAD_MS = 200;
/** A shot that could only be handed over this long after its moment (ms) is not heard at all: what it was the sound of has been and gone. */
export const LATE_MS = 100;

export type Stop = () => void;
/** Puts a shot on the audio clock to sound `delay` seconds from now; returns how to cut it short. */
export type Start = (delay: number) => Stop;

interface Shot {
  /** Its moment, ms on the page's clock. */
  due: number;
  start: Start;
  /** Once handed over: how to cut it short. */
  cut: Stop | null;
}

export class Pending {
  /** Earliest first. */
  private shots: Shot[] = [];

  /**
   * A shot whose moment is `due` (ms on the page's clock; it is `now`). One that near is handed over at once. Returns
   * how to stop it: still waiting, it is never heard; handed over, it is cut short.
   */
  add(now: number, due: number, start: Start): Stop {
    if (due - now <= AHEAD_MS) return start(Math.max(0, due - now) / 1000);
    const shot: Shot = { due, start, cut: null };
    let i = this.shots.length;
    while (i > 0 && this.shots[i - 1]!.due > due) i--;
    this.shots.splice(i, 0, shot);
    return () => {
      if (shot.cut) return shot.cut();
      const k = this.shots.indexOf(shot);
      if (k >= 0) this.shots.splice(k, 1);
    };
  }

  /** At `now`: hands over every shot whose moment is near, and drops every one whose moment is gone. */
  run(now: number): void {
    while (this.shots.length && this.shots[0]!.due - now <= AHEAD_MS) {
      const shot = this.shots.shift()!;
      if (now - shot.due > LATE_MS) continue;
      shot.cut = shot.start(Math.max(0, shot.due - now) / 1000);
    }
  }

  /** When to `run` next (ms on the page's clock): when the earliest shot is to be handed over. Null: nothing waits. */
  get next(): number | null {
    const first = this.shots[0];
    return first ? first.due - AHEAD_MS : null;
  }
}
