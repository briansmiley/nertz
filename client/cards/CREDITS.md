# Card art

The card faces and backs are original artwork for this project, drawn in code:

- `Face.tsx` draws every face as inline SVG (suit shapes, pip layouts, court
  cards, and a large-print "mini" rendition for small cards).
- The backs are plain CSS (`.back` in `../styles.css`), one colour per seat.

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
| `chain` | Piedmontese tarot deck - Solesio - 1865 - Back side.jpg | F. F. Solesio (editor) | Public domain |
| `check` | Back03.svg | Nicu Buculei | CC0 |
| `suits` | Back09.svg | Nicu Buculei | CC0 |
| `carpet` | Russian style card back.jpg | Dondorf GmbH (Germany) | Public domain |
| `plaid-blue` | Atlas deck card back blue and brown.svg | Дмитрий Фомин (Dmitry Fomin) | CC0 |
| `plaid-green` | Atlas deck card back green and dark red.svg | Дмитрий Фомин (Dmitry Fomin) | CC0 |
| `gem` | Quaternius - 3D Card Kit - Fantasy - 0 Card Back.png | Quaternius | CC0 |

- `ornate` is made from a picture the owner found; WHERE IT IS FROM AND ITS LICENCE ARE NOT YET KNOWN (it looks like
  stock art): it must be cleared, or replaced, before it is deployed.
- `bicycle` is the Bicycle "Rider Back" of the United States Playing Card Company. The design is from 1887 and out of
  copyright, but Bicycle and the Rider Back are that company's trademarks: decide knowingly whether to ship it, and
  do not call it "Bicycle" in the game. The scan is CC BY-SA 4.0 (credit it, here).
- The CC BY-SA file (`bicycle`) needs this credit kept, and the changed picture stays under the same licence.

The "Night" and "Cute" decks are drawn in `Face.tsx` like the first, and are original to this project.

Typefaces are loaded from Google Fonts and are licensed under the SIL Open
Font License 1.1:

- Barlow and Barlow Condensed, by Jeremy Tribby (card indices and interface text)
- Bowlby One, by Vernon Adams (display lettering and court-card letters)
- Fredoka, by Milena Brandão and Hafontia (the Cute deck's lettering)
