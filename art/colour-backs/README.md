# Card backs with colours of their own (not in the game)

Three backs that are pictures in their own colours, taken out on 13 Nov 2026 when every back became one colour
(white on the player's colour). They are kept here, where the game does not serve them, in case that rule is dropped.

- `carpet.jpg`: "Russian style card back.jpg", Dondorf GmbH (Germany), public domain (Wikimedia Commons).
- `tarot-star.jpg`, `tarot-eye.jpg`: made by the owner in Midjourney.

To bring one back: move its file to `public/cards/backs/`, name it in `CARD_BACKS` and a group in
`shared/protocol.ts`, and restore the code that framed a coloured picture in the player's colour (`PICTURES` in
`client/cards/Face.tsx`, `.back.pic` in the stylesheet, `picture` in Finale.tsx's `backSprite`), taken out later:
`git log -S PICTURES` finds it. Their one-colour versions are in the game as `carpet-tint`, `tarot-star-tint` and
`tarot-eye-tint`.
