import type { ReactNode } from 'react';
import { useReach } from './net';

/**
 * A name, as a span with `className`; if `host`, the host's mark by it.
 * Used wherever names are listed: the lobby's seats, the score sheet, the names over the hands.
 */
export function Name({ host, className, children }: { host: boolean | undefined; className?: string; children: ReactNode }) {
  return (
    <>
      <span className={className}>{children}</span>
      {host && <HostMark />}
    </>
  );
}

/** The host's mark: a white puck with an H, its edge showing under it. Not where nobody else can come: you are the only one who could host, and it says nothing. */
function HostMark() {
  if (!useReach().others) return null;
  return (
    <svg className="host" viewBox="0 0 16 17" role="img" aria-label="Host">
      <title>Host</title>
      <circle className="edge" cx="8" cy="9.4" r="7" />
      <circle cx="8" cy="8" r="7" />
      <text x="8" y="11.5" textAnchor="middle">
        H
      </text>
    </svg>
  );
}
