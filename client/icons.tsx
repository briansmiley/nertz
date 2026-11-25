// The line icons of the corner and its menu (Settings.tsx, Menu.tsx), and of the sheets that share them: 24 units
// square, drawn in the colour of the text around them.
// The connection banner's robots are built into the bundle, not public/icons: the broken one is wanted just when the
// line is down, too late to fetch it.
import robotBroken from './art/robot-broken.png?inline';
import robotFixed from './art/robot-fixed.png?inline';

/** Sound: the speaker, and struck through in red while it is off. */
export function Speaker({ off }: { off: boolean }) {
  return <img className="art" src={off ? '/icons/muted.png' : '/icons/volume.png'} alt="" aria-hidden="true" />;
}

/** The menu: three bars. */
export function MenuIcon() {
  return <img className="art" src="/icons/menu.png" alt="" aria-hidden="true" />;
}

/** Settings: a gear with a spade at its heart. Drawn art (public/icons), not a line icon. */
export function Gear() {
  return <img className="art" src="/icons/gear-bare.png" alt="" aria-hidden="true" />;
}

/** Leaving: out through a door. */
export function Door() {
  return <img className="art" src="/icons/leave.png" alt="" aria-hidden="true" />;
}

/** Signing in: in through the door, the arrow green. */
export function SignInDoor() {
  return <img className="art" src="/icons/signin.png" alt="" aria-hidden="true" />;
}

/** Taking a seat: the chair tucked in at the table (standing up's, the other way). */
export function Sit() {
  return <img className="art" src="/icons/sit.png" alt="" aria-hidden="true" />;
}

/** Standing up: the chair pushed back from the table. */
export function Chair() {
  return <img className="art" src="/icons/stand.png" alt="" aria-hidden="true" />;
}

/** The connection lost: the robot cracked, an X and an O for eyes, its bent antenna's bulb red and sparking. */
export function RobotBroken() {
  return (
    <span className="robot-net">
      <img className="art" src={robotBroken} alt="" aria-hidden="true" />
    </span>
  );
}

/** The connection back: the robot mended, hearts for eyes and a grin, the antenna straight and its bulb green, pulsing. */
export function RobotFixed() {
  return (
    <span className="robot-net fixed">
      <img className="art" src={robotFixed} alt="" aria-hidden="true" />
    </span>
  );
}

/** Feedback: a little beetle with a heart on its back. */
export function Bug() {
  return <img className="art" src="/icons/bug.png" alt="" aria-hidden="true" />;
}

/** How much the game is played (an admin's, Usage.tsx): bars on a line. */
export function Chart() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 19.5h17M7 16.5v-4M12 16.5V7M17 16.5v-6.5" />
    </svg>
  );
}

/** Pausing: two bars. */
export function PauseIcon() {
  return <img className="art" src="/icons/pause.png" alt="" aria-hidden="true" />;
}

/** Unpausing: play. */
export function Play() {
  return <img className="art" src="/icons/resume.png" alt="" aria-hidden="true" />;
}

/** Ending the round where it stands: the white flag, giving up on it. */
export function Flag() {
  return <img className="art" src="/icons/flag.png" alt="" aria-hidden="true" />;
}

/** Dealing again: two cards inside an arrow that comes round. */
export function Redeal() {
  return <img className="art" src="/icons/redeal.png" alt="" aria-hidden="true" />;
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

/** Resetting the table: the score pad inside an arrow that comes round. */
export function Again() {
  return <img className="art" src="/icons/reset.png" alt="" aria-hidden="true" />;
}
