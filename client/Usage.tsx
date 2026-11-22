// How much the game is played, for an admin (server/stats.ts `GET /usage`), from the corner's menu: all told; the
// last days, a bar of games each (what else was played that day its tooltip) over a notch and its date; and the latest
// sittings, who was at them. With the bots, or just the humans.
import { useState } from 'react';
import type { Played, Usage } from '../shared/types';
import { useUsage } from './account';
import { Back } from './Menu';

/** What a count is said as, after its figure. */
const COUNTS: { key: keyof Played; one: string; many: string }[] = [
  { key: 'games', one: 'game', many: 'games' },
  { key: 'rounds', one: 'round', many: 'rounds' },
  { key: 'players', one: 'player', many: 'players' },
  { key: 'guests', one: 'guest hand', many: 'guest hands' },
  { key: 'bots', one: 'bot hand', many: 'bot hands' },
];
const said = (n: number, { one, many }: { one: string; many: string }): string => `${n} ${n === 1 ? one : many}`;

/** A day (`2026-11-21`, a date here) as it is written: `Sat 21 Nov`. */
const dayWritten = (day: string): string => new Date(`${day}T12:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

export function UsageSlip({ back }: { back: () => void }) {
  const [humans, setHumans] = useState(false);
  const usage = useUsage(humans);
  return (
    <section className="slip usage" aria-label="Played">
      <header className="slip-head">
        <Back onClick={back} />
        <h3>Played</h3>
        <p className="humans" role="radiogroup" aria-label="Who">
          {[false, true].map((h) => (
            <button key={String(h)} type="button" role="radio" aria-checked={h === humans} onClick={() => setHumans(h)}>
              {h ? 'just humans' : 'bots and humans'}
            </button>
          ))}
        </p>
      </header>
      {usage === null ? <p className="none">—</p> : usage && <Figures usage={usage} humans={humans} />}
    </section>
  );
}

function Figures({ usage, humans }: { usage: Usage; humans: boolean }) {
  const most = Math.max(1, ...usage.days.map((d) => d.games));
  /** (Just the humans, there are no bot hands to count.) */
  const counts = humans ? COUNTS.filter((c) => c.key !== 'bots') : COUNTS;
  return (
    <>
      <dl className="totals">
        {counts.map((c) => (
          <div key={c.key}>
            <dd>{usage.total[c.key].toLocaleString()}</dd>
            <dt>{usage.total[c.key] === 1 ? c.one : c.many}</dt>
          </div>
        ))}
      </dl>
      <ol className="days" aria-label="Games a day">
        {usage.days.map((d) => (
          <li key={d.day} data-tip={`${dayWritten(d.day)}: ${counts.map((c) => said(d[c.key], c)).join(', ')}`}>
            <span style={{ height: `${(d.games / most) * 100}%` }}>{d.games > 0 && <b>{d.games}</b>}</span>
          </li>
        ))}
      </ol>
      {/* A notch for each day, its date under it, and the month under the first and under a 1st. */}
      <ol className="dates" aria-hidden="true">
        {usage.days.map((d, i) => {
          const date = new Date(`${d.day}T12:00`);
          return (
            <li key={d.day}>
              {date.getDate()}
              {(i === 0 || date.getDate() === 1) && <small>{date.toLocaleDateString(undefined, { month: 'short' })}</small>}
            </li>
          );
        })}
      </ol>
      <ul className="games" aria-label="Latest games">
        {usage.games.map((g) => (
          <li key={`${g.at}-${g.code}`}>
            <time dateTime={new Date(g.at).toISOString()}>{new Date(g.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
            <span className="code">{g.code}</span>
            <span className="long">
              {said(g.rounds, { one: 'round', many: 'rounds' })} · {Math.max(1, Math.round(g.ms / 60_000))}m
            </span>
            <span className="who">
              {g.players.map((p, i) => (
                <span key={i} className={p.as}>
                  {p.name}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
