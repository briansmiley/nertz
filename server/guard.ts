// Every table lives in this one process: whatever one of them throws where nothing catches it (a timer, a socket's
// close, a snapshot sent on the next turn of the event loop) would end the process and take every other table with it.

/** Runs `fn` now. What it throws is logged under `what` and goes no further: the caller carries on. */
export function guard(what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`error in ${what}`, err);
  }
}
