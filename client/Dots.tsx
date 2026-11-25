/** Three dots coming and going, in place of an ellipsis: something is under way. (Still with reduced motion.) */
export function Dots() {
  return (
    <span className="dots" aria-hidden="true">
      <i>.</i>
      <i>.</i>
      <i>.</i>
    </span>
  );
}
