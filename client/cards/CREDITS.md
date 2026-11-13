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

Typefaces are loaded from Google Fonts and are licensed under the SIL Open
Font License 1.1:

- Barlow and Barlow Condensed, by Jeremy Tribby (card indices and interface text)
- Bowlby One, by Vernon Adams (display lettering and court-card letters)
