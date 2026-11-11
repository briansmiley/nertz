# Card art

The card faces and backs are original artwork for this project, drawn in code:

- `Face.tsx` draws every face as inline SVG (suit shapes, pip layouts, court
  cards, and a large-print "mini" rendition for small cards).
- The backs are plain CSS (`.back` in `../styles.css`), one colour per seat.

No third-party card artwork is used, so the art carries the same licence as
the rest of the repository.

Typefaces are loaded from Google Fonts and are licensed under the SIL Open
Font License 1.1:

- Barlow and Barlow Condensed, by Jeremy Tribby (card indices and interface text)
- Bowlby One, by Vernon Adams (display lettering and court-card letters)
