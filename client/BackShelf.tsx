// The backs to choose among, as they are shown wherever one is chosen (the gallery at /?decks, and the sheet opened
// from a card in a table's lobby): each kind a fan of its first few cards, the rest fading off behind them, and the kind that is picked up dealt out under the
// row, first a card with a question mark on it (any one of that kind, drawn by lot when a table's first round is dealt), then every
// back of the kind with its small rendition tucked against it.
import { useState, type CSSProperties } from 'react';
import { backGroups, CARD_BACKS, type Back } from '../shared/protocol';
import { backOf } from './cards/Face';
import { layOut } from './sound';

/** How each card of a spread lies: a few degrees off square. */
const LIE = [-3, 2, -1.5, 3, -2.5, 1, -1, 2.5];
/** How many cards a kind is shown by: the first three fanned out in full, two more fading away behind them (there are more where those came from). */
const FAN = 5;

/**
 * `back` is the one chosen (shown as chosen unless `random` is set); `random` the lot chosen in its place: 'all', or
 * the name of a kind. `colour` and `bare` are how the backs are drawn here.
 */
export function BackShelf({ colour, bare, back, random, onPick, onRandom }: { colour: string; bare: boolean; back: Back; random: string | null; onPick: (back: Back) => void; onRandom: (scope: string | null) => void }) {
  const groups = backGroups();
  /** The kind of back that is dealt out (one at a time; none, if its pile was put back): to begin with, the one the choice is in. */
  const [open, setOpen] = useState<string | null>(() => (groups.find((g) => (random && random !== 'all' ? g.name === random : g.backs.includes(back))) ?? groups[0]!).name);
  const shown = groups.find((g) => g.name === open);
  return (
    <>
      <div className="shelf" style={{ '--piles': groups.length } as CSSProperties}>
        {groups.map((group) => {
          const holds = random ? random === group.name : group.backs.includes(back);
          /** The few cards the pile is shown by, top card first: the chosen one, if it is in this pile. */
          const top = [...(holds && !random ? [back] : []), ...group.backs.filter((b) => random || b !== back)].slice(0, FAN);
          return (
            <button key={group.name} type="button" className={`pile${open === group.name ? ' open' : ''}${holds ? ' holds' : ''}`} aria-expanded={open === group.name} onClick={() => (open === group.name || layOut(), setOpen(open === group.name ? null : group.name))}>
              <span className="stack">
                {top
                  .map((b, i) => (
                    <span key={b} className="mini" style={{ '--k': i } as CSSProperties}>
                      <span {...backOf(colour, b, bare)} />
                    </span>
                  ))
                  .reverse()}
              </span>
              <b>{group.name}</b>
              <i>{group.backs.length}</i>
            </button>
          );
        })}
      </div>
      {shown && (
        <div key={shown.name} className="dealt" style={{ '--at': groups.indexOf(shown), '--piles': groups.length } as CSSProperties}>
          {/* First in every spread: any one of this kind, drawn by lot for a table, when its first round is dealt. */}
          <button type="button" className={`lay lot${random === shown.name ? ' on' : ''}`} style={{ '--lie': '-2deg', '--n': 0 } as CSSProperties} aria-pressed={random === shown.name} title={`One of ${shown.name}, drawn by lot when a table's first round is dealt, and kept for that table`} onClick={() => onRandom(random === shown.name ? null : shown.name)}>
            <span className="mini">
              <span {...backOf(colour, null, bare)} />
            </span>
            <em>Random</em>
          </button>
          {shown.backs.map((b, i) => (
            <button key={b} type="button" className={`lay${!random && back === b ? ' on' : ''}`} style={{ '--lie': `${LIE[i % LIE.length]}deg`, '--n': i + 1 } as CSSProperties} aria-pressed={!random && back === b} onClick={() => onPick(b)}>
              <span className="mini">
                <span {...backOf(colour, b, bare)} />
              </span>
              <span className="mini small">
                <span {...backOf(colour, b, bare, true)} />
              </span>
              <em>{CARD_BACKS[b]}</em>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
