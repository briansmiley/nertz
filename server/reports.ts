// The reports players send with the bug button, kept: each a row of `report` (server/db.ts) as it came, and once it
// has been passed on (server/feedback.ts), what became of it. A screenshot is a file in the reports directory beside
// the database, `<id>.jpg`, named by the report's id alone: nothing a sender says goes into a path, and nothing serves
// these files.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Db } from './db';
import type { Heading, Report } from './feedback';

/**
 * How much the screenshots kept may come to in all, bytes. Past it a report is kept without its picture (which is
 * still passed on): what anyone at all can send must not be able to fill the volume the accounts live on.
 */
export const MAX_KEPT_IMAGE_BYTES = 200 << 20;

/** A report's id, as the server makes it (and nothing else does): twelve hex digits. */
export const REPORT_ID = /^[0-9a-f]{12}$/;

/** A new report's id. (Made whether or not there is anywhere to keep it: the logs, Discord and Linear name it too.) */
export const newReportId = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

/** Writes a screenshot: false, said in the log and with nothing left behind, if it cannot be. */
function write(file: string, data: Buffer): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data, { flag: 'wx' });
    return true;
  } catch (err) {
    console.error('reports: a screenshot could not be kept', file, err);
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') rmSync(file, { force: true });
    return false;
  }
}

/** The screenshot of report `id` in `dir` (always a JPEG: feedback.ts accepts no other): its name is made here from the id, never taken from anyone. */
export function imageFile(dir: string, id: string): string {
  if (!REPORT_ID.test(id)) throw new Error(`no such report image: ${JSON.stringify(id)}`);
  return join(dir, `${id}.jpg`);
}

/**
 * Who sent a report, as the cap on what one sender hands to the auto-fanout counts them (server/feedback.ts): their
 * account if they were signed in (whatever name they gave), else the name they gave, trimmed and in lower case (one
 * name is one person), else nobody, all of whom are one sender.
 */
export const senderOf = (r: Pick<Report, 'name'>, account: string | null): string => (account ? `account:${account}` : r.name?.trim() ? `name:${r.name.trim().toLowerCase()}` : 'nobody');

/** What became of a report once it was passed on (server/feedback.ts). */
export interface Passed {
  /** What it was titled, and how much it was judged to matter (if it was judged). */
  heading: Heading;
  /** The address of the issue filed for it, if one was. */
  issue: string | null;
  /** The id of the Discord message it was posted as, if it was: where BinaryBot opens a thread once a PR for it is ready. */
  post: string | null;
  /** Whether that issue was handed to the auto-fanout: labelled `auto`. */
  auto: boolean;
}

export interface Reports {
  /** Keeps a report as it came, and who sent it if they were signed in. Throws if it cannot, and then keeps nothing. */
  add(id: string, at: number, report: Report, account: string | null): void;
  /**
   * Whether report `id`'s issue may be labelled `auto`: yes if its sender (`senderOf`) has had fewer than `max` so far,
   * and then it is counted as one of them at once, so that two reports at a time cannot both slip under the cap.
   * (`passedOn` says in the end whether it was: not, if no issue came of it.)
   */
  mayAuto(id: string, max: number): boolean;
  /** What became of it once it was passed on. */
  passedOn(id: string, passed: Passed): void;
  /** Keeps `account`'s reports, but as nobody's, with no name to them (and no sender: counted for nobody). */
  forget(account: string): void;
}

export interface ReportsOptions {
  /** Where screenshots are kept. Without it (a database in memory), a report is kept without its picture. */
  dir: string | null;
  maxImageBytes?: number;
}

export function openReports(db: Db, { dir, maxImageBytes = MAX_KEPT_IMAGE_BYTES }: ReportsOptions): Reports {
  const add = db.prepare('insert into report (id, created_at, kind, text, name, room, context, account, sender, image_bytes) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const pictures = db.prepare('select coalesce(sum(image_bytes), 0) as bytes from report');
  // (One statement: the count and the mark go together.)
  const mayAuto = db.prepare('update report set auto = 1 where id = ? and sender is not null and (select count(*) from report as had where had.sender = report.sender and had.auto = 1) < ?');
  const passedOn = db.prepare('update report set title = ?, priority = ?, issue = ?, post = ?, auto = ? where id = ?');
  const forget = db.prepare('update report set account = null, name = null, sender = null where account = ?');
  return {
    add(id, at, r, account) {
      const fits = dir && r.image && (pictures.get() as { bytes: number }).bytes + r.image.length <= maxImageBytes;
      // The picture first, then the row: a row never names a file that is not there. ('wx': never over a file already
      // there.) A picture that cannot be written is left out: the report is kept without it, as past the cap.
      const file = fits ? imageFile(dir!, id) : null;
      const image = file && write(file, r.image!) ? r.image! : null;
      try {
        add.run(id, at, r.kind, r.text, r.name ?? null, r.room ?? null, r.context ?? null, account, senderOf(r, account), image?.length ?? null);
      } catch (err) {
        if (image) rmSync(file!, { force: true });
        throw err;
      }
    },
    mayAuto: (id, max) => mayAuto.run(id, max).changes === 1,
    passedOn: (id, { heading, issue, post, auto }) => void passedOn.run(heading.title, heading.priority ?? null, issue, post, auto ? 1 : 0, id),
    forget: (account) => void forget.run(account),
  };
}
