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

/** Carrying on from a pause. */
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

/** How far each card of a fanned hand is turned, front first: about the front card's bottom left corner. */
const FAN = [0, -13, -26, -39];

/**
 * Dealing again: a hand fanned out. Each card behind shows only its edge, the cards before it masked out of it (with a
 * little room round them), so the lines never cross.
 */
export function Redeal() {
  const card = (turn: number) => ({ x: 10, y: 5, width: 10, height: 14, rx: 1.8, transform: `rotate(${turn} 10 19)` });
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        {FAN.slice(1).map((_, i) => (
          <mask key={i} id={`fan-${i + 1}`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
            <rect width="24" height="24" fill="white" stroke="none" />
            {FAN.slice(0, i + 1).map((turn) => (
              <rect key={turn} {...card(turn)} fill="black" stroke="black" strokeWidth="1.6" />
            ))}
          </mask>
        ))}
      </defs>
      {[...FAN.keys()].reverse().map((i) => (
        <rect key={i} {...card(FAN[i]!)} mask={i ? `url(#fan-${i})` : undefined} />
      ))}
    </svg>
  );
}
