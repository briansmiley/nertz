// Small sums used on both sides: one definition each.

/** `v`, kept between `lo` and `hi` (`lo` where `hi` is below it). */
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** `v` to three places, as a position on the felt or a point of a flight goes over the wire (never -0). */
export const round3 = (v: number): number => Math.round(v * 1000) / 1000 || 0;
