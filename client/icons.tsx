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

/** The connection lost: the robot cracked, a spade and an X for eyes, a zigzag mouth, snapped antenna, bulb red. */
export function RobotBroken() {
  return (
    <span className="robot-net">
      <img className="art" src={robotBroken} alt="" aria-hidden="true" />
    </span>
  );
}

/** The connection back: the robot mended and upright, a heart and a dot for eyes, the antenna straight, bulb green. */
export function RobotFixed() {
  return (
    <span className="robot-net">
      <img className="art" src={robotFixed} alt="" aria-hidden="true" />
    </span>
  );
}

/** The game updating: a hand of four cards, only their suits, fanned, the front one tucked to the back over and over. */
export function Riffle() {
  return (
    <span className="riffle" aria-hidden="true">
      <i>{'♠\uFE0E'}</i>
      <i className="red">{'♥\uFE0E'}</i>
      <i>{'♣\uFE0E'}</i>
      <i className="red">{'♦\uFE0E'}</i>
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

/** Away from the table (Lucide's unplug): a plug pulled out of its socket. */
export function Unplugged() {
  return (
    <svg className="unplugged" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m19 5 3-3M2 22l3-3" />
      <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" />
      <path d="M7.5 13.5 10 11M10.5 16.5 13 14" />
      <path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z" />
    </svg>
  );
}

/** Taking the table offline (Lucide's wifi-off): the waves of a line, struck through. */
export function NoLine() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20h.01M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.7M19 12.9a10 10 0 0 0-2.1-1.5M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8a15 15 0 0 0-11.3-3.8M2 2l20 20" />
    </svg>
  );
}

/** Resetting the table: the score pad inside an arrow that comes round. */
export function Again() {
  return <img className="art" src="/icons/reset.png" alt="" aria-hidden="true" />;
}
