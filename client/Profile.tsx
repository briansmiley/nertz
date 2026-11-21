// You, signed in: the name you go by (yours to change), your record, and the ways out: signing out, and your account
// gone for good. Opened by pressing your name at the foot of the home page's pad.
import { useEffect, useRef, useState } from 'react';
import { cleanName, MAX_NAME_LENGTH } from '../shared/protocol';
import { AMONG, type Account, type Among } from '../shared/types';
import { deleteAccount, rename, repicture, signOut, useStats } from './account';

/** A figure as it is written: a true minus sign, and no "-0.0". */
const written = (n: number, places = 0): string => {
  const text = Math.abs(n).toFixed(places);
  return n < 0 && Number(text) !== 0 ? `−${text}` : text;
};

/** Which rounds the record counts, drawn (a bot; a person with a bot; two people), and said in a word or two under them. */
const AMONG_DRAWN: Record<Among, { title: string; said: string; draw: React.JSX.Element }> = {
  all: { title: 'Every round', said: 'All', draw: <Bot x={6} /> },
  people: {
    title: 'Rounds with someone else, bots or not',
    said: 'With people',
    draw: (
      <>
        <Person x={2} />
        <Bot x={12} />
      </>
    ),
  },
  'no-bots': {
    title: 'Rounds with no bots',
    said: 'No bots',
    draw: (
      <>
        <Person x={2} />
        <Person x={13} />
      </>
    ),
  },
};

function Person({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 0)`}>
      <circle cx="4.5" cy="8" r="2.6" />
      <path d="M0 19.5c0-3.4 2-5.6 4.5-5.6s4.5 2.2 4.5 5.6" />
    </g>
  );
}

function Bot({ x }: { x: number }) {
  return (
    <g transform={`translate(${x} 0)`}>
      <rect x="0" y="9" width="10" height="9" rx="2.2" />
      <path d="M5 9V6.3" />
      <circle cx="5" cy="5.4" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.2" cy="13.3" r="1" fill="currentColor" stroke="none" />
      <circle cx="6.8" cy="13.3" r="1" fill="currentColor" stroke="none" />
    </g>
  );
}

const AMONG_KEY = 'nertz.among';
const rememberedAmong = (): Among => {
  try {
    return AMONG.find((a) => a === localStorage.getItem(AMONG_KEY)) ?? 'all';
  } catch {
    return 'all';
  }
};

/** Your record: the figures, and under each what it counts; over the rounds you choose, by who else was at them. (The choice stays up while the figures are being asked for, or could not be had.) */
export function Record() {
  const [among, setAmong] = useState(rememberedAmong);
  const stats = useStats(among);
  /** A sum over the rounds, as so much a round. */
  const per = (sum: number): string => (stats?.rounds ? written(sum / stats.rounds, 1) : '–');
  const choose = (a: Among): void => {
    setAmong(a);
    try {
      localStorage.setItem(AMONG_KEY, a);
    } catch {
      // storage unavailable: the choice lasts as long as the page
    }
  };
  /** Each figure, what it counts, (where the word alone may not say) a little more about it, and a tint for one that is good or bad for you. */
  const figures: [string, string, string?, ('good' | 'bad')?][] = !stats
    ? []
    : [
        [written(stats.rounds), stats.rounds === 1 ? 'round' : 'rounds'],
        [written(stats.won), 'won'],
        [written(stats.nertz), 'Nertz'],
        [stats.ahead === null ? '–' : `${written(stats.ahead * 100)}%`, 'ahead', 'Average ending rank: 1st = 100%, last = 0%'],
        [per(stats.points), 'avg score'],
        [stats.bestPoints === null ? '–' : written(stats.bestPoints), 'best score'],
        [per(stats.cards), 'avg cards'],
        [stats.bestCards === null ? '–' : written(stats.bestCards), 'best cards'],
        [per(stats.nertzLeft), 'avg nertz left'],
        [written(stats.snipes), stats.snipes === 1 ? 'snipe' : 'snipes', undefined, 'good'],
        [written(stats.sniped), 'sniped', undefined, 'bad'],
      ];
  return (
    <div className="yours-record">
      <div className="among">
        <div role="radiogroup" aria-label="Which rounds">
          {AMONG.map((a) => (
            <button key={a} type="button" role="radio" aria-checked={a === among} aria-label={AMONG_DRAWN[a].title} data-tip={AMONG_DRAWN[a].title} onClick={() => choose(a)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                {AMONG_DRAWN[a].draw}
              </svg>
            </button>
          ))}
        </div>
        <small aria-hidden="true">{AMONG_DRAWN[among].said}</small>
      </div>
      {stats && (
        <dl className="record">
          {figures.map(([n, what, more, tint]) => (
            <div key={what} data-tip={more} className={[tint, more && 'explained'].filter(Boolean).join(' ') || undefined}>
              <dt>{what}</dt>
              <dd>{n}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** The name you go by, changed where it is written: kept on Enter or on leaving it, put back if left empty. */
function YourName({ account }: { account: Account }) {
  const [name, setName] = useState(account.name ?? '');
  useEffect(() => setName(account.name ?? ''), [account.name]);
  const keep = async (): Promise<void> => {
    const clean = cleanName(name);
    if (!clean || clean === account.name) return setName(account.name ?? '');
    if (!(await rename(clean))) setName(account.name ?? '');
  };
  return (
    <input
      className="yourname"
      autoFocus={!account.name} /* (new, and no name yet: the first thing to do) */
      aria-label="Your name"
      placeholder="Name"
      value={name}
      maxLength={MAX_NAME_LENGTH}
      size={Math.max(4, name.length)} /* (where field-sizing is not had: about as wide as the name) */
      autoComplete="nickname"
      spellCheck={false}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => void keep()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') (setName(account.name ?? ''), e.stopPropagation());
      }}
    />
  );
}

/**
 * Your picture: the one you put up, else Google's, else your initial. Pressed, a picture of your own to put up in its
 * place; yours, a cross by it takes it down.
 */
function YourPicture({ account }: { account: Account }) {
  const [busy, setBusy] = useState(false);
  const [broken, setBroken] = useState<string | null>(null);
  const shown = account.picture ?? account.image;
  const put = async (file: Blob | null): Promise<void> => {
    setBusy(true);
    await repicture(file);
    setBusy(false);
  };
  return (
    <span className={`yourpicture${busy ? ' busy' : ''}`}>
      <label data-tip={account.picture ? 'Change picture' : 'Put up a picture'}>
        <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} aria-label="Your picture" onChange={(e) => (void put(e.target.files?.[0] ?? null), (e.target.value = ''))} />
        {shown && broken !== shown ? <img src={shown} alt="" referrerPolicy="no-referrer" onError={() => setBroken(shown)} /> : <i aria-hidden="true">{account.name ? [...account.name][0]!.toUpperCase() : ''}</i>}
      </label>
      {account.picture && (
        <button type="button" className="unpicture" aria-label="Remove picture" data-tip="Remove picture" disabled={busy} onClick={() => void put(null)}>
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 2l6 6M8 2l-6 6" />
          </svg>
        </button>
      )}
    </span>
  );
}

/** Asked once more, over everything: Esc or a press beside it is no. */
function SureDelete({ onNo }: { onNo: () => void }) {
  const [going, setGoing] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onNo();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNo]);
  return (
    <div className="asked" onPointerDown={(e) => e.target === e.currentTarget && onNo()}>
      <div className="paper-card" role="alertdialog" aria-label="Delete account: are you sure?">
        <h2>Are you sure?</h2>
        <button type="button" className="go danger" disabled={going} onClick={() => (setGoing(true), void deleteAccount().then((gone) => gone || (setGoing(false), onNo())))}>
          Delete account
        </button>
        <button type="button" className="quiet" autoFocus onClick={onNo}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Everything about you, laid out the same wherever it is shown. */
export function Profile({ account, head }: { account: Account; head?: React.ReactNode }) {
  const [deleting, setDeleting] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  return (
    <div className="profile" ref={root}>
      <div className="you">
        {head}
        <YourPicture account={account} />
        <YourName account={account} />
      </div>
      <Record />
      <div className="outs">
        <button type="button" className="gone" onClick={() => setDeleting(true)}>
          Delete account
        </button>
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
      {deleting && <SureDelete onNo={() => setDeleting(false)} />}
    </div>
  );
}
