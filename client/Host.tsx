import type { ReactNode } from 'react';

/**
 * How whoever hosts the table (and so deals every round) is told apart wherever names are listed: the lobby's seats,
 * the score sheet, the names over the hands. One place, so the look is changed here and nowhere else.
 *  - button: by the name, the dealer button, a white puck with a D;
 *  - deck: by the name, the deck they deal from, three cards squared up;
 *  - ink: the name itself underlined in marigold.
 */
type HostLook = 'button' | 'deck' | 'ink';
const LOOK: HostLook = 'button';

/** A name, as a span with `className`; if `host`, marked as the host's. */
export function Name({ host, className, children }: { host: boolean | undefined; className?: string; children: ReactNode }) {
  const ink = host && LOOK === 'ink';
  return (
    <>
      <span className={[className, ink && 'host-ink'].filter(Boolean).join(' ') || undefined} title={ink ? 'Host' : undefined}>
        {children}
      </span>
      {host && !ink && <HostMark look={LOOK} />}
    </>
  );
}

function HostMark({ look }: { look: HostLook }) {
  return (
    <svg className={`host ${look}`} viewBox={look === 'deck' ? '0 0 15 17' : '0 0 16 17'} role="img" aria-label="Host">
      <title>Host</title>
      {look === 'deck' ? (
        <>
          <rect x="4.5" y="1" width="9.5" height="12.5" rx="1.6" />
          <rect x="2.75" y="2.25" width="9.5" height="12.5" rx="1.6" />
          <rect x="1" y="3.5" width="9.5" height="12.5" rx="1.6" />
        </>
      ) : (
        <>
          {/* The puck's edge, then its face, then the D. */}
          <circle className="edge" cx="8" cy="9.4" r="7" />
          <circle cx="8" cy="8" r="7" />
          <text x="8" y="11.5" textAnchor="middle">
            D
          </text>
        </>
      )}
    </svg>
  );
}
