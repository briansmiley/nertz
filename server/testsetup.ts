// Run before every test file (vite.config.ts, test.setupFiles). What the guard (server/guard.ts) catches is only
// logged, so a test whose timer or socket close throws would otherwise pass, or fail later for another reason. Here
// it fails the test it happened in. A test that means to make the guard catch something silences console.error
// itself (vi.spyOn(console, 'error').mockImplementation(...)), and what it silences never reaches this.
import { afterEach } from 'vitest';

const caught: unknown[][] = [];
const log = console.error.bind(console);
console.error = (...args: unknown[]): void => {
  if (typeof args[0] === 'string' && args[0].startsWith('error in ')) caught.push(args); // guard's own wording
  log(...args);
};

afterEach(() => {
  if (!caught.length) return;
  const [what, err] = caught[0]!;
  caught.length = 0;
  throw new Error(`the guard caught an error the test did not expect: ${String(what)}`, { cause: err });
});
