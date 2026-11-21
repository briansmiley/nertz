// The line icons of the corner and its menu (Settings.tsx, Menu.tsx), and of the sheets that share them: 24 units
// square, drawn in the colour of the text around them.
import { Slash } from './hotkey';

/** Sound: crossed out while it is off (the line is drawn on as it goes). */
export function Speaker({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z" fill="currentColor" stroke="none" />
      <path d="M15.2 9.3a4 4 0 0 1 0 5.4M17.6 6.9a7.4 7.4 0 0 1 0 10.2" />
      <Slash on={off} />
    </svg>
  );
}

export function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />
    </svg>
  );
}

export function Gear() {
  const teeth = Array.from({ length: 8 }, (_, i) => <rect key={i} x="10.6" y="2.6" width="2.8" height="4.4" rx="0.9" transform={`rotate(${i * 45} 12 12)`} fill="currentColor" stroke="none" />);
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {teeth}
      <circle cx="12" cy="12" r="5.1" strokeWidth="3" />
    </svg>
  );
}

/** Leaving: out through a door. */
export function Door() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13 4.5h5.5v15H13" />
      <path d="M14.5 12H4.5M8 8.5 4.5 12 8 15.5" />
    </svg>
  );
}

export function Bug() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="14" rx="4.6" ry="5.8" />
      <path d="M9.2 8.6a2.9 2.9 0 0 1 5.6 0M9.5 5 8 3.3M14.5 5 16 3.3M12 9v10.6M7.4 12.5H3.8M7.4 16H4.3l-.9 2.6M16.6 12.5h3.6M16.6 16h3.1l.9 2.6M7.8 10.2 5 8.4M16.2 10.2 19 8.4" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Unpausing. */
export function Play() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.5 5.2v13.6L18.5 12z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Ending the round where it stands: the flag at the finish. */
export function Flag() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 20.5V4" />
      <path d="M6 4.5h11l-2.6 3.8L17 12H6" />
    </svg>
  );
}

/** How far each card of a fanned hand is turned, about the front card's bottom left corner: the back one first. */
const FAN = [-45, -30, -15, 0];

/** Dealing again: a hand fanned out. Laid back to front, each card filled with the paper it is drawn on, so it covers the ones behind. */
export function Redeal() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {FAN.map((turn) => (
        <rect key={turn} x="12" y="4" width="9.5" height="14.5" rx="1.8" transform={`rotate(${turn} 12 18.5)`} style={{ fill: 'var(--paper)' }} />
      ))}
    </svg>
  );
}

/** Watching: an eye. (Standing up from your cards: you watch the rest.) */
export function Eye() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  );
}

/** Copying (Lucide's copy): one sheet over another. */
/** A link: two rings of a chain. */
export function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  );
}

/** Done (Lucide's check). */
export function Check() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** A turning arrow: again from the start. */
export function Again() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5.5 12a6.5 6.5 0 1 0 2.2-4.9" />
      <path d="M5 4.5v3.4h3.4" />
    </svg>
  );
}
