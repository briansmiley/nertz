import { useState } from 'react';

/**
 * A picture that may not load: `src` while it has not failed to (and the `onError` that says it did), else null, for
 * whatever stands in its place. A new `src` is tried afresh.
 */
export function usePicture(src: string | null | undefined): { src: string | null; onError: () => void } {
  const [broken, setBroken] = useState<string | null>(null);
  const shown = src && broken !== src ? src : null;
  return { src: shown, onError: () => shown && setBroken(shown) };
}
