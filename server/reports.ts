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

export interface Reports {
  /** Keeps a report as it came, and who sent it if they were signed in. Throws if it cannot, and then keeps nothing. */
  add(id: string, at: number, report: Report, account: string | null): void;
  /** What became of it once it was passed on: what it was titled, how much it was judged to matter (if it was judged), and the address of the issue filed for it (if one was). */
  passedOn(id: string, heading: Heading, issue: string | null): void;
  /** Keeps `account`'s reports, but as nobody's, with no name to them. */
  forget(account: string): void;
}

export interface ReportsOptions {
  /** Where screenshots are kept. Without it (a database in memory), a report is kept without its picture. */
  dir: string | null;
  maxImageBytes?: number;
}

export function openReports(db: Db, { dir, maxImageBytes = MAX_KEPT_IMAGE_BYTES }: ReportsOptions): Reports {
  const add = db.prepare('insert into report (id, created_at, kind, text, name, room, context, account, image_bytes) values (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const pictures = db.prepare('select coalesce(sum(image_bytes), 0) as bytes from report');
  const passedOn = db.prepare('update report set title = ?, priority = ?, issue = ? where id = ?');
  const forget = db.prepare('update report set account = null, name = null where account = ?');
  return {
    add(id, at, r, account) {
      const fits = dir && r.image && (pictures.get() as { bytes: number }).bytes + r.image.length <= maxImageBytes;
      // The picture first, then the row: a row never names a file that is not there. ('wx': never over a file already
      // there.) A picture that cannot be written is left out: the report is kept without it, as past the cap.
      const file = fits ? imageFile(dir!, id) : null;
      const image = file && write(file, r.image!) ? r.image! : null;
      try {
        add.run(id, at, r.kind, r.text, r.name ?? null, r.room ?? null, r.context ?? null, account, image?.length ?? null);
      } catch (err) {
        if (image) rmSync(file!, { force: true });
        throw err;
      }
    },
    passedOn: (id, heading, issue) => void passedOn.run(heading.title, heading.priority ?? null, issue, id),
    forget: (account) => void forget.run(account),
  };
}
