import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useDismiss } from './dismiss';

/**
 * One of a few choices. The one chosen; pressed, all of them on a slip over what is under it (above it where there is
 * no room below), put away by choosing, by Esc, or by a press anywhere else. `label` names what is being chosen, `said`
 * an option in words, `show` how it is drawn (its words, unless told otherwise); `lead` goes before the one chosen.
 */
export function Dropdown<T extends string>({
  value,
  options,
  choose,
  label,
  said = (v) => v,
  show = said,
  lead,
  className,
}: {
  value: T;
  options: readonly T[];
  choose: (v: T) => void;
  label: string;
  said?: (v: T) => string;
  show?: (v: T) => ReactNode;
  lead?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const here = useRef<HTMLDivElement>(null);
  const shown = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useDismiss(here, open, () => setOpen(false));
  useLayoutEffect(() => {
    if (!open) return;
    const { top, bottom } = shown.current!.getBoundingClientRect();
    const tall = list.current!.offsetHeight;
    setUp(innerHeight - bottom < tall && top >= tall);
    list.current!.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
  }, [open]);
  /** Put away, with the focus back on what opened it. */
  const shut = (): void => (setOpen(false), shown.current?.focus());
  const onKey = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') (e.preventDefault(), setOpen(true));
      return;
    }
    if (e.key === 'Tab') return shut(); // (and the Tab goes on from the button)
    const items = [...list.current!.querySelectorAll<HTMLElement>('[role="option"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const moves: Record<string, number | undefined> = { ArrowDown: Math.min(at + 1, items.length - 1), ArrowUp: Math.max(at - 1, 0), Home: 0, End: items.length - 1 };
    const to = moves[e.key];
    if (to === undefined && e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation(); // (Esc puts this away, and not the slip it may be on)
    if (to === undefined) shut();
    else items[to]!.focus();
  };
  return (
    <div ref={here} className={className ? `dropdown ${className}` : 'dropdown'} onKeyDown={onKey}>
      <button ref={shown} type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${said(value)}`} onClick={() => setOpen(!open)}>
        {lead}
        {show(value)}
        <svg className="caret" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div ref={list} className={up ? 'up' : undefined} role="listbox" aria-label={label}>
          {options.map((o) => (
            <button key={o} type="button" role="option" aria-selected={o === value} tabIndex={-1} onClick={() => (choose(o), shut())}>
              {show(o)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
