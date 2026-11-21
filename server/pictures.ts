// The pictures people put up of themselves (SMI-70): each a small square WebP in the pictures directory beside the
// database, `<id>.webp`, served at `/pictures/<id>.webp` for anyone at a table with them to see.
//
// Nothing that was sent is kept or served as it came. The client crops and shrinks a picture before sending it, but
// the server does not count on that: it decodes what came (a JPEG, PNG or WebP, and nothing else, of no more than so
// many pixels) and draws it afresh at PICTURE_SIDE, which leaves behind its metadata (where and on what it was taken)
// and anything else in the file that is not the picture. A picture's id is the server's, made new for each one put
// up (so the address of an old one is never another's, and a new one is never cached as the old), and is the only
// thing that goes into a path.
import { randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import sharp from 'sharp';

/** Where a picture is served from: `${PICTURES_PATH}/<id>.webp`. */
export const PICTURES_PATH = '/pictures';
/** The side of every picture kept, px: twice the largest it is shown, for screens that draw two pixels to one. */
export const PICTURE_SIDE = 128;
/** The most a picture sent may be: the client sends one about PICTURE_SIDE square, far under this. */
export const MAX_SENT_BYTES = 1 << 20;
/** The most pixels a picture sent may have before it is not even decoded. */
const MAX_SENT_PIXELS = 4096 * 4096;
/** The most a picture kept may be. One drawn at PICTURE_SIDE comes to a few KB; past this something is wrong with it. */
const MAX_KEPT_BYTES = 64 << 10;
const ACCEPTED = new Set(['jpeg', 'png', 'webp']);

/** A picture's id, as the server makes it (and nothing else does): sixteen hex digits. */
export const PICTURE_ID = /^[0-9a-f]{16}$/;

/** Where picture `id` is served from. */
export const pictureUrl = (id: string): string => `${PICTURES_PATH}/${id}.webp`;

export interface Pictures {
  /** Draws what was sent afresh and keeps it: its id, or null for what is not a picture we take. Throws if it cannot be written. */
  put(sent: Buffer): Promise<string | null>;
  /** Picture `id` gone (and none, for null). Never throws: a file that will not go is said in the log. */
  remove(id: string | null): void;
  /** Answers a GET for a path under PICTURES_PATH. */
  serve(path: string, req: IncomingMessage, res: ServerResponse): void;
}

/** What was sent, drawn afresh as a PICTURE_SIDE square WebP: null for anything that is not a JPEG, PNG or WebP picture of a sensible size. */
export async function redraw(sent: Buffer): Promise<Buffer | null> {
  try {
    const image = sharp(sent, { limitInputPixels: MAX_SENT_PIXELS, failOn: 'error', animated: false });
    const { format } = await image.metadata();
    if (!format || !ACCEPTED.has(format)) return null;
    // (Turned as its camera said it was held, then cropped to the middle square. No metadata goes with it: sharp keeps none unless asked.)
    const drawn = await image.rotate().resize(PICTURE_SIDE, PICTURE_SIDE, { fit: 'cover' }).flatten({ background: '#ffffff' }).webp({ quality: 80 }).toBuffer();
    return drawn.length <= MAX_KEPT_BYTES ? drawn : null;
  } catch {
    return null; // not a picture, or a broken one
  }
}

export function openPictures(dir: string): Pictures {
  const file = (id: string): string => {
    if (!PICTURE_ID.test(id)) throw new Error(`no such picture: ${JSON.stringify(id)}`);
    return join(dir, `${id}.webp`);
  };
  return {
    async put(sent) {
      const drawn = await redraw(sent);
      if (!drawn) return null;
      const id = randomBytes(8).toString('hex');
      mkdirSync(dir, { recursive: true });
      writeFileSync(file(id), drawn, { flag: 'wx' });
      return id;
    },
    remove(id) {
      if (!id) return;
      try {
        rmSync(file(id), { force: true });
      } catch (err) {
        console.error('pictures: a picture could not be removed', id, err);
      }
    },
    serve(path, req, res) {
      const id = /^\/pictures\/([0-9a-f]{16})\.webp$/.exec(path)?.[1];
      if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405, { allow: 'GET, HEAD' }).end();
      let size = 0;
      try {
        size = id ? statSync(file(id)).size : 0;
      } catch {
        // none such
      }
      if (!id || !size) return void res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Not found');
      res.writeHead(200, {
        'content-type': 'image/webp',
        'content-length': size,
        // A picture, and only ever a picture: never sniffed as anything else, never a page, never shown by another site.
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
        // (Its id is new for every picture: what is at an address never changes.)
        'cache-control': 'public, max-age=31536000, immutable',
      });
      if (req.method === 'HEAD') return void res.end();
      createReadStream(file(id))
        .on('error', () => res.destroy())
        .pipe(res);
    },
  };
}
