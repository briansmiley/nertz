# Card art

The card faces and backs are original artwork for this project, drawn in code:

- `Face.tsx` draws every face as inline SVG (suit shapes, pip layouts, court
  cards, and a large-print "mini" rendition for small cards).
- The backs are plain CSS (`.back` in `../styles/cards.css`), one colour per seat.

That deck carries the same licence as the rest of the repository.

The "Classic" deck that can be chosen in the settings (`public/cards/classic/`) is by Adrian Kennard, generated with
https://www.me.uk/cards/makeadeck.cgi and released under the CC0 Public Domain licence; its court cards are based on
19th-century Goodall & Son designs. The files are changed here in one way: the corner index figure is drawn heavier
and a quarter larger (and the small suit mark under it moved down to make room), so it reads on a small card.

## Card backs (`public/cards/backs/`)

Candidates the owner is choosing among (13 Nov 2026): not all will stay. All but `ornate` are from Wikimedia Commons
(file page: `https://commons.wikimedia.org/wiki/File:<file>`), scaled down, and the one-colour ones turned into a
white-on-nothing pattern that is printed in each player's colour.

| back | Commons file | by | licence |
| --- | --- | --- | --- |
| `bicycle` | USPCC card backs (Bicycle Rider).png | Mabeenot | CC BY-SA 4.0 |
| `rosette` | Carta Francese retro Rosso.jpg | Trocche100 at Italian Wikipedia | Public domain |
| `cobble` | Niebieska Koszulka z Wzoru Berlińskiego.png | Joh. Müller (Schaffhausen) | Public domain |
| `stars` | Swiss card deck - 1850 - Back side.jpg | Unknown author | Public domain |
| `lion` | Koszulka z wzoru rzymskiego.png | Marteau i Georges | CC0 |
| `piatnik` | Kártya - Piatnik Nándor és fiai R.T. Budapest (14).jpg (its middle) | Derzsi Elekes Andor | CC BY-SA 3.0 (attribution and share-alike: say so before deploying) |
| `atlas` | Атласная колода экстра рубашка.jpg | Adolf Charlemagne, 1850 | Public domain |
| `check` | Back03.svg | Nicu Buculei | CC0 |
| `carpet-tint` (its coloured original is kept, unused, in `art/colour-backs`) | Russian style card back.jpg | Dondorf GmbH (Germany) | Public domain |

- `fleur` (drawn in `backArt.ts`) uses the outline of "Fleur de lis flat.svg" (Wikimedia Commons, BrazilianInBattleofVerdun, CC0), and
  `giglio` that of "Fleur de lis of Florence.svg" (Wikimedia Commons, F l a n k e r, public domain).
- `arbor` (drawn in `backArt.ts`) is the logo of Arbor, the owner's own organisation, redrawn from its file.
- `acanthus`, `daisy`, `tulip`, `fronds`, `oak`, `waterlily`, `lilypads`, `maple`, the `dandelion-` backs, `thistle`, `clover`, `clover-2`, `lily`, `rose`, `iris`, `sunflower`, `poppies`, `sequoia`, `birch`, `fern`, `ginkgo`, `ginkgo-ring`, `ginkgo-scatter`, `tarot-star` and `tarot-eye` (and the tarot pair's one-colour `-tint` prints) are pictures the owner made in Midjourney.
- The Animals backs (`fox`, `owl`, `loong`, `rabbit`, `crane`, `phoenix`, `deer`, `koi`, `falcon`, `swallowtail`,
  `butterflies`, `ants`, `aster`) were generated for the owner with OpenAI's image API (24 Nov 2026), whose terms
  give the output to the one who made it. `aster` is the owner's cat, from the owner's own photo. How they were made
  is in `art/backs/STYLE.md`.
- `damask` was generated for the owner with OpenAI's image API (26 Nov 2026) after a photo the owner took of a printed
  fabric: a new medallion in its spirit, not a copy of the print. How it was made is in `art/backs/STYLE.md`.
- `seraph` was generated for the owner with OpenAI's image API (27 Nov 2026) from a written description only (wings
  crossing round an eye in shadow), with `aster` as the reference for its texture. No outside image was given to the
  model. How it was made is in `art/backs/STYLE.md`.
- `lightcone` (drawn in `backArt.ts`) is the logo of Lightcone Infrastructure, taken from the owner's own copy of its
  file. It is their mark, not this project's: the owner's choice to include; check with them before it is deployed publicly.
- `enterprise` (drawn in `backArt.ts`) is the delta insignia of Star Trek's Starfleet, traced from a picture the owner
  gave. It is a trademark of CBS Studios (Paramount), not this project's: the owner's choice to include; decide
  knowingly whether to ship it.
- `hat` (the aperiodic "einstein" tiling, drawn in `backArt.ts`) is built by the method of Craig S. Kaplan's hatviz,
  https://github.com/isohedral/hatviz (BSD 3-Clause, Copyright (c) 2023 Craig S. Kaplan), rewritten here in TypeScript.
- `ornate` is made from a picture the owner found; WHERE IT IS FROM AND ITS LICENCE ARE NOT YET KNOWN (it looks like
  stock art): it must be cleared, or replaced, before it is deployed.
- `bicycle` is the Bicycle "Rider Back" of the United States Playing Card Company. The design is from 1887 and out of
  copyright, but Bicycle and the Rider Back are that company's trademarks: decide knowingly whether to ship it, and
  do not call it "Bicycle" in the game. The scan is CC BY-SA 4.0 (credit it, here).
- The CC BY-SA file (`bicycle`) needs this credit kept, and the changed picture stays under the same licence.

The "Cute" and "Pixel" decks (and every deck's dark version but Classic's) are drawn in code like the first, and are
original to this project. The Pixel deck is in the manner of old video-game cards; it uses no other game's artwork.

Typefaces are loaded from Google Fonts and are licensed under the SIL Open
Font License 1.1:

- Barlow and Barlow Condensed, by Jeremy Tribby (card indices and interface text)
- Bowlby One, by Vernon Adams (display lettering and court-card letters)
- Fredoka, by Milena Brandão and Hafontia (the Cute deck's lettering)
