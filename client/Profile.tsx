// You, signed in: the name you go by and where your page is (both yours to change), your record, whether your page is
// yours alone, and the ways out: signing out, and your account gone for good. Opened by pressing your name at the foot of the home page's pad. And someone else's page (`/u/<handle>`),
// opened by pressing their name at a table: their record, and yours against them.
import { useEffect, useRef, useState } from 'react';
import { cleanName, handleOf, MAX_HANDLE_LENGTH, MAX_NAME_LENGTH } from '../shared/protocol';
import { AMONG, type Account, type Among, type Stats, type Versus } from '../shared/types';
import { deleteAccount, rehandle, rename, repicture, setPrivate, signOut, usePage, useStats, type Crop } from './account';
import { PictureCrop } from './PictureCrop';

/** A figure as it is written: a true minus sign, and no "-0.0". */
const written = (n: number, places = 0): string => {
  const text = Math.abs(n).toFixed(places);
  return n < 0 && Number(text) !== 0 ? `−${text}` : text;
};

/** Which rounds are counted (every one, or one kind), drawn (people, bots, or both), and said in their tooltip. */
const AMONG_DRAWN: Record<Among, { title: string; draw: React.JSX.Element }> = {
  all: {
    title: 'All',
    draw: (
      <>
        <Person x={0.5} small />
        <Bot x={8.3} small />
        <Person x={16.5} small />
      </>
    ),
  },
  humans: {
    title: 'Humans',
    draw: (
      <>
        <Person x={2} />
        <Person x={13} />
      </>
    ),
  },
  mixed: {
    title: 'Humans and bots',
    draw: (
      <>
        <Person x={2} />
        <Bot x={12} />
      </>
    ),
  },
  bots: { title: 'Bots', draw: <Bot x={6} /> },
};

/** (`small`: three to a drawing, at three quarters of the size, standing on the same line.) */
const at = (x: number, small?: boolean): string => (small ? `translate(${x} 4.5) scale(0.75)` : `translate(${x} 0)`);

function Person({ x, small }: { x: number; small?: boolean }) {
  return (
    <g transform={at(x, small)}>
      <circle cx="4.5" cy="8" r="2.6" />
      <path d="M0 19.5c0-3.4 2-5.6 4.5-5.6s4.5 2.2 4.5 5.6" />
    </g>
  );
}

function Bot({ x, small }: { x: number; small?: boolean }) {
  return (
    <g transform={at(x, small)}>
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
    const was = localStorage.getItem(AMONG_KEY);
    return was === 'no-bots' ? 'humans' : (AMONG.find((a) => a === was) ?? 'all'); // (as 'no-bots' was once said; 'people' is now none)
  } catch {
    return 'all';
  }
};

/** Which rounds a record counts, as last chosen in this browser (one choice, for anyone's record). */
function useAmong(): [Among, (a: Among) => void] {
  const [among, setAmong] = useState(rememberedAmong);
  const choose = (a: Among): void => {
    setAmong(a);
    try {
      localStorage.setItem(AMONG_KEY, a);
    } catch {
      // storage unavailable: the choice lasts as long as the page
    }
  };
  return [among, choose];
}

/** The rounds to count, by who held hands in them: on a record, and on how much the game is played (Usage.tsx). */
export function Which({ among, choose }: { among: Among; choose: (a: Among) => void }) {
  return (
    <div className="among" role="radiogroup" aria-label="Which rounds">
      {AMONG.map((a) => (
        <button key={a} type="button" role="radio" aria-checked={a === among} aria-label={AMONG_DRAWN[a].title} data-tip={AMONG_DRAWN[a].title} onClick={() => choose(a)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {AMONG_DRAWN[a].draw}
          </svg>
        </button>
      ))}
    </div>
  );
}

/** A figure, what it counts, (where the word alone may not say) a little more about it, and a tint for one that is good or bad for whoever's it is. */
type Figure = [string, string, string?, ('good' | 'bad')?];

function Figures({ figures }: { figures: Figure[] }) {
  return (
    <dl className="record">
      {figures.map(([n, what, more, tint]) => (
        <div key={what} data-tip={more} className={[tint, more && 'explained'].filter(Boolean).join(' ') || undefined}>
          <dt>{what}</dt>
          <dd>{n}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Someone's record, as figures. */
function recordOf(stats: Stats): Figure[] {
  /** A sum over the rounds, as so much a round. */
  const per = (sum: number): string => (stats.rounds ? written(sum / stats.rounds, 1) : '–');
  return [
    [written(stats.rounds), stats.rounds === 1 ? 'round' : 'rounds'],
    [stats.rounds ? `${written(stats.won)}–${written(stats.rounds - stats.won)}` : '–', 'W–L'],
    [stats.odds === null ? '–' : `${written(stats.odds, 1)}×`, 'vs chance', 'Rounds won, against 1 in n at a table of n: 1× is chance'],
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
}

/** Yours against someone, as figures: the rounds you both played, how often each of you finished ahead, and each one's points over them. */
function versusOf(v: Versus): Figure[] {
  const level = v.rounds - v.ahead - v.behind;
  return [
    [written(v.rounds), v.rounds === 1 ? 'round' : 'rounds'],
    [written(v.ahead), 'ahead', level ? `${level} level` : undefined, 'good'],
    [written(v.behind), 'behind', undefined, 'bad'],
    [written(v.points), 'yours', 'Your points in them'],
    [written(v.theirs), 'theirs', 'Their points in them'],
  ];
}

/** Your record: the figures, and under each what it counts, over the rounds `among` says. */
function Record({ among }: { among: Among }) {
  const stats = useStats(among);
  return stats && <Figures figures={recordOf(stats)} />;
}

/**
 * Someone's page, for you signed in: the name they go by and their record, and under it yours against them (on your
 * own page, nobody to be against); both over the rounds you choose. A page that is nobody's (gone, or never was) says so.
 */
export function Theirs({ handle, head }: { handle: string; head?: React.ReactNode }) {
  const [among, choose] = useAmong();
  const page = usePage(handle, among);
  const known = typeof page === 'object' ? page : null;
  return (
    <div className="profile theirs">
      <div className="you">
        {head}
        {known && <TheirPicture picture={known.picture} name={known.name} />}
        <h2>{page === 'none' ? 'Not found' : (known?.name ?? '')}</h2>
        {page !== 'none' && <Which among={among} choose={choose} />}
      </div>
      {known && <Figures figures={recordOf(known.stats)} />}
      {known?.versus && (
        <div className="versus">
          <h3>You vs {known.name ?? 'them'}</h3>
          <Figures figures={versusOf(known.versus)} />
        </div>
      )}
    </div>
  );
}

/** Their picture: the one they put up, else their initial (never Google's: only they see that one). */
function TheirPicture({ picture, name }: { picture: string | null; name: string | null }) {
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <span className="theirpicture" aria-hidden="true">
      {picture && broken !== picture ? <img src={picture} alt="" onError={() => setBroken(picture)} /> : <i>{name ? [...name][0]!.toUpperCase() : ''}</i>}
    </span>
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

/** What a handle is being typed as: lowercase, and only what a handle can have in it. */
const typedHandle = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, MAX_HANDLE_LENGTH);

/** Where setting a handle has got to: nothing asked yet; asked; someone else's (or the site's); or no yes, for any other reason. */
type Claim = 'idle' | 'asking' | 'taken' | 'failed';

/** How long Failed is said before the button is Set again, to try again. */
const FAILED_MS = 2500;

/**
 * Where your page is, `/u/<handle>`, changed where it is written. Typing a different one brings up Set (or Enter), which
 * asks for it (faint while what is typed cannot be one): had, the button goes; someone else's, or the site's, it says
 * Taken until the handle is changed; no answer, or any other no, it says Failed for a moment, and is Set again. Leaving
 * the field puts yours back (unless it is being asked for), so what it shows is yours unless you are at it.
 */
function YourHandle({ account }: { account: Account }) {
  const [handle, setHandle] = useState(account.handle);
  const [claim, setClaim] = useState<Claim>('idle');
  /** Set is being pressed: the field losing the focus to it is not leaving. */
  const pressing = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => (setHandle(account.handle), setClaim('idle')), [account.handle]);
  useEffect(() => {
    if (claim !== 'failed') return;
    const t = setTimeout(() => setClaim((c) => (c === 'failed' ? 'idle' : c)), FAILED_MS);
    return () => clearTimeout(t);
  }, [claim]);
  const back = (): void => (setHandle(account.handle), setClaim('idle'));
  const asked = handleOf(handle.replace(/-+/g, '-').replace(/^-|-$/g, ''));
  const set = async (): Promise<void> => {
    if (asked === null || asked === account.handle || claim === 'taken' || claim === 'asking') return;
    setHandle(asked);
    setClaim('asking');
    const claimed = await rehandle(asked);
    setClaim(claimed === 'yours' ? 'idle' : claimed);
  };
  return (
    <span className={`yourhandle ${claim}`} onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && !pressing.current && claim !== 'asking' && back()}>
      <label>
        <span aria-hidden="true">/u/</span>
        <input
          ref={field}
          aria-label="Your page's address"
          aria-invalid={claim === 'taken' || undefined}
          value={handle}
          maxLength={MAX_HANDLE_LENGTH}
          size={Math.max(3, handle.length)} /* (where field-sizing is not had: about as wide as the handle) */
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => (setHandle(typedHandle(e.target.value)), setClaim('idle'))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void set();
            if (e.key === 'Escape') (back(), e.currentTarget.blur(), e.stopPropagation());
          }}
        />
      </label>
      {handle !== account.handle && (
        <button
          type="button"
          className="set"
          aria-live="polite"
          disabled={asked === null || asked === account.handle || claim === 'taken' || claim === 'asking'}
          // (The field keeps the focus where a press can be stopped from taking it, and where it cannot (a tap, on some
          // phones) losing it to Set is not leaving. Nothing is held back on the pointer's press: on iOS, a tap whose
          // pointerdown is held back may get no click.)
          onPointerDown={(e) => (pressing.current = !e.currentTarget.disabled)}
          onPointerCancel={() => (pressing.current = false)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => ((pressing.current = false), field.current?.focus(), void set())}
        >
          {claim === 'taken' ? 'Taken' : claim === 'failed' ? 'Failed' : 'Set'}
        </button>
      )}
    </span>
  );
}

/**
 * Your picture: the one you put up, else Google's, else your initial. Under the pointer, a pencil over it. Pressed, a
 * picture of your own to put up in its place: first moved and zoomed to fit the circle (PictureCrop). Yours, a cross
 * by it takes it down.
 */
function YourPicture({ account }: { account: Account }) {
  const [busy, setBusy] = useState(false);
  const [broken, setBroken] = useState<string | null>(null);
  /** A picture chosen, being fitted to the circle before it is put up. */
  const [fitting, setFitting] = useState<File | null>(null);
  const shown = account.picture ?? account.image;
  const put = async (file: Blob | null, crop?: Crop): Promise<void> => {
    setBusy(true);
    await repicture(file, crop);
    setBusy(false);
  };
  return (
    <span className={`yourpicture${busy ? ' busy' : ''}`}>
      <label data-tip={account.picture ? 'Change picture' : 'Put up a picture'}>
        <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} aria-label="Your picture" onChange={(e) => (setFitting(e.target.files?.[0] ?? null), (e.target.value = ''))} />
        {shown && broken !== shown ? <img src={shown} alt="" referrerPolicy="no-referrer" onError={() => setBroken(shown)} /> : <i aria-hidden="true">{account.name ? [...account.name][0]!.toUpperCase() : ''}</i>}
        <span className="edit" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M4 20h4L19 9l-4-4L4 16z" />
            <path d="M13.5 6.5l4 4" />
          </svg>
        </span>
      </label>
      {fitting && <PictureCrop file={fitting} onCancel={() => setFitting(null)} onSave={(crop) => (setFitting(null), void put(fitting, crop))} />}
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

/** Whether your page is yours alone: a switch, turned at once, and back if the server did not take it. */
function Private({ account }: { account: Account }) {
  const [asked, setAsked] = useState<boolean | null>(null);
  const on = asked ?? account.private;
  const turn = (): void => {
    setAsked(!on);
    void setPrivate(!on).then(() => setAsked(null));
  };
  return (
    <button type="button" role="switch" aria-checked={on} className="private" data-tip="Only you see your page" onClick={turn}>
      <span className="lever" aria-hidden="true" />
      Private
    </button>
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
  const [among, choose] = useAmong();
  return (
    <div className="profile">
      <div className="you">
        {head}
        <YourPicture account={account} />
        <div className="names">
          <YourName account={account} />
          <YourHandle account={account} />
        </div>
        <Private account={account} />
        <Which among={among} choose={choose} />
      </div>
      <Record among={among} />
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
