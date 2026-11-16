import type { ReactNode } from 'react';

/**
 * A name, as a span with `className`; if `host`, the dealer button by it (whoever hosts the table deals every round).
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

/** The dealer button: a white puck with a D, its edge showing under it. */
function HostMark() {
  return (
    <svg className="host" viewBox="0 0 16 17" role="img" aria-label="Host">
      <title>Host</title>
      <circle className="edge" cx="8" cy="9.4" r="7" />
      <circle cx="8" cy="8" r="7" />
      <text x="8" y="11.5" textAnchor="middle">
        D
      </text>
    </svg>
  );
}
