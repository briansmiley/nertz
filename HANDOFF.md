# Handoff notes (11 Nov 2026)

State: `main` is deployed to https://nertz.fly.dev (Fly app `nertz`, org `personal`, region `sjc`, one machine,
suspends when idle). Deploy with `fly deploy --app nertz --ha=false` when nobody is connected
(`curl https://nertz.fly.dev/healthz` shows connections); a deploy drops live games. Staging: branch `staging` goes to
https://nertz-staging.fly.dev (Fly app `nertz-staging`, same `fly.toml`, one machine, suspends when idle): deploy it with
`fly deploy --app nertz-staging --ha=false` from that branch. A push deploys by itself
(`.github/workflows/deploy.yml`): checks first, then `staging` at once, and `main` only once nobody is connected (it asks
`/healthz` every 30 s for up to 90 minutes, then gives up: re-run the job). Fly deploy tokens are the GitHub secrets
`FLY_API_TOKEN_PROD` and `FLY_API_TOKEN_STAGING` (they expire in November 2027). `npm run dev` for local work
(server 8787, Vite 5173); `npm run typecheck`, `npm test`, `npm run build` must stay green. README.md describes the game
as built.

The owner reviews by playing and gives feedback in plain words; small tweaks are made directly, and he prefers quick
turnarounds over long verification loops for small visual changes.

## Done on 13 Nov 2026

- Score sheet: table rules behind a gear, a robot button opens "Add a bot", a faint × after each bot's name removes it,
  a door icon leaves; columns read "Played" and "6 × −2 = −12". The grid rule is now called "Crystallized Nertz".
- Bots: level only sets thinking time; once a bot starts a group off its stock, the rest come 250 ms apart
  (`DEAL_STEP_MS` in server/bot.ts), the same at every level.
- Pause: a pause button by mute/gear (or P) while a round is played, before a call. The server drops held cards,
  stops bots and refuses moves (except the end vote); the table blurs with a "Paused" card. Whoever paused, the
  dealer, or anyone once the pauser is away can carry on. With three corner buttons the gear can touch your
  "Round N at table" line on small windows (part of the mobile item).
- End of round: unfinished centre piles turn over as loose stacks showing their size (`slotStack`), and the wash starts
  from there. Not yet seen in a browser.
- The "lost" sound also plays while you hold a card and someone else plays on a started centre pile it could have gone
  on (however long you held it), as well as when a drop you made loses the race at the server.

## Done on 11-12 Nov 2026 (all deployed)

- Bigger centre cards (`def509f`); side neighbours' hands turned to run down the edges and less room kept under your
  hand (`5fc4b02`): piles past about eight cards squeeze; hover (380 ms) or tap a work pile to fan it out (`9d853ea`).
- End-of-round: a solid block behind each player's pile and label (`b64614d`).
- Table-rule explanations behind (i) icons (`5fc4b02`).
- Half-dealt waste cards always drawn face-down (they flashed face-up after a recycle on a laggy link); a lost race
  plays its own sound (`6dceeaf`). Note: the owner does NOT want stock cards revealed to the client to cut the
  round-trip lag on the group turning up; ask before changing what the server reveals.
- Countdown digits and NERTZ! word sized to the screen width (`e957da8`).
- Stuck: a table where nothing can move ends at the first all-stuck vote (`canProgress`, `ended: 'jam'`); anyone can
  vote to end a round from the gear menu (`ended: 'vote'`, everyone connected; bots go along) (`ed2701d`).
- `npx tsx scripts/sizes.ts` prints card sizes per window and player count. The long random-play tests time out on the
  1-vCPU droplet: run `npx vitest run --testTimeout=180000` there.

## Done on 13 Nov 2026 (NOT deployed)

- Dealing off the stock: cards are counted off one at a time, 170 ms apart (`STOCK_CARD_MS`), each slipping in under
  a nearly square face-down stack held over the stock; the whole group is held a 160 ms beat (`STOCK_TURN_MS`, drawn
  by the client only: the server has already turned it up), then turns over onto the waste. Half a second in all.
- The stock's flick is much quieter, thinned and eased in (`stockCard` in `client/sound.ts`).
- The dotted outline under the stock sits under its bottom card (`stockPad`), so it does not show as the stack thins.
- The Start button's small print is just "Space".

## Where the session of 13 Nov 2026 stopped (read this first)

- Everything below is committed on local `main` only. `origin/main`, `origin/staging` and both Fly apps are behind:
  the owner said to work locally and NOT push to `staging` or `main` until he says so.
- Dev server: `npx concurrently -k "tsx watch server/index.ts" "vite --host"` from the repo (5173, on the network).
- The owner is choosing among the card backs and decks at `/?decks`; nothing has been cut for good except what he
  named (Poker, Night as a deck, four-colour, Aces, Votes for Women, Gem). Expect "keep these, drop those" next,
  and perhaps grouping (drawn patterns / fractals / tiles / old prints).
- Not cleared to deploy: the `ornate` back (unknown source), `bicycle` (Rider Back trademark), `lightcone` (their
  logo). See `client/cards/CREDITS.md`.
- TEMPORARY, to delete when he says: `/?decks-legacy`, `client/GalleryLegacy.tsx` and its rules at the end of
  `client/styles.css`.
- Open, by his own words: the Pixel deck's court cards are not good enough yet (he wants them to evoke Balatro's;
  no copying its files); the Mosaic back reads as pixels; the fan-hover sound and the end-of-round backs are unheard
  / unseen by anyone; mobile landscape and the home-screen launch were never checked on his phone after the rework.
- He reviews by looking: take a screenshot of every visual change, in every state it has (expanded, hovered, small),
  before saying it is done.

## Decks, lobby, bots and Aces (13 Nov 2026, local only: NOT pushed or deployed)

- Decks (`DECKS` in `shared/protocol.ts`, drawn in `client/cards/Face.tsx`): Nertz, Big print,
  Night and Cute (all drawn in code), and Classic (picture files in `public/cards/classic`, public domain, see
  `client/cards/CREDITS.md`). Card backs can be chosen too (`CARD_BACKS`, drawn by `backOf` in `Face.tsx`): sixteen candidates the
  owner is choosing among, one-colour patterns printed in the player's colour and pictures framed in it. Sources and
  licences are in CREDITS.md; `ornate` (unknown source) and `bicycle` (trademark) are NOT cleared to deploy. Every deck keeps red and black: no four-colour decks. Each has its own
  large-print rendition for small cards. A player's choice (your settings, "Card faces") is told to the table
  (`{ t: 'deck' }`, `PlayerView.deck`) and their cards are drawn with it for everyone. Bots have the plain deck.
  `/?decks` shows every deck, full faces and small cards (`client/Gallery.tsx`); linked from your settings.
- Backs: sixteen-odd candidates (`CARD_BACKS`), seven drawn in code (`client/cards/backArt.ts`: worked out once per
  browser, the same for everyone), the rest pictures. Every back has a simpler small-card version (a simpler drawing,
  or the picture's middle). The end-of-round canvas draws each player's back (`backSprite` in `Finale.tsx`; not yet
  seen with a non-plain back). `/?decks` is redesigned (backs dealt on the cloth, decks as fanned hands);
  `/?decks-legacy` and `client/GalleryLegacy.tsx` are TEMPORARY (the old layout, for a before-and-after picture).
- Dark cards are a switch on every deck (`night` in your settings and the gallery; a dark deck is named `<deck>:night`
  where it is drawn), not a deck of their own; Classic's dark pictures are the light ones inverted in CSS.
- In the lobby (before the first deal) a player takes any free colour: it moves them to that seat (`{ t: 'seat' }`).
  Not guarded against someone doing it while in voice chat, which goes by seat.
- Three more drawn backs: binary tree, dragon curve, Koch snowflake. Per-back small-card treatment is `SMALL` in
  `Face.tsx` (how far a picture is zoomed; 1 = whole).
- Lobby: add-a-bot and leave are in the sheet's top corner; from 640 px wide the players are in two columns.
- Face-down cards in the work piles are a fixed rule by how many are dealt in (`faceDown` in `shared/settings.ts`):
  none with two players, 0/0/1/2 with three, 0/1/2/3 from four. The "fewer face-down cards" option is gone.
- End of round: a card going out to its owner's pile keeps its place in the heap (slides out from under what lay on
  it) and no longer jumps to the top (`paint` in `client/Finale.tsx`).
- A bot never overlooks an Ace it could play to the middle (`ace` in `server/bot.ts`); other moves are still missed
  by chance, by level.

## Bots carry their cards (merged to main 13 Nov 2026, NOT deployed)

A bot's move used to be applied in one step when its think timer fired, so nobody could beat it to a pile. Now it
picks the card up (a real hold), the server sends made-up drag reports for the carry (`shared/flight.ts`: 650 ms to
the middle, 300 ms along its own row, taken out of its thinking pause), and only then sends the move; if the spot
was taken meanwhile the drop is refused like anyone's. The flight time does not go by distance, and a bot does not
change course in the air.

## Mobile (merged to main 13 Nov 2026 as a first pass the owner calls bad, to be fixed later; NOT deployed)

A phone held upright (narrower than 640 px and at least 1.2 times as tall: `isTall`, `TALL` in `client/layout.ts`) gets
its own table: a bar across the top for the buttons (chat left; sound, pause, gear right), everyone else in rows under
it (one to three hands to a row, whichever leaves their cards largest), the felt the width of the screen, and your hand
in two rows: four work piles with the tray beside them, and under them the nertz pile (left), your name and the stuck
button (middle), the stock and waste (right). `placeHand` takes `rows` for that. Everything else follows the `Seat`
rects, so drags, live card movement and the deal needed no change.

- Touch: a dragged card rises until its lower edge is just above the fingertip, and is aimed by its own middle, not
  by the finger (`Drag.touch`, `pointOf` in `Table.tsx`).
- The end of a round can be skipped with a button (it was Escape only); labels of the sorted piles are kept on screen.
- Score sheet, lobby, home, settings slip and chat panel fit a 360 px screen; inputs are 16 px on touch (no iOS zoom).
- A phone on its side keeps the desktop arrangement with a shorter label under the hand (`.table.short`).
- A phone on its side (`LOW`, `isLow` in `client/layout.ts`: not upright and lower than 500 px): everyone else is a
  small upright hand in a column at each side of the felt (clockwise, up the left column and down the right), so the
  felt has the whole height above your hand. The stuck button is a pill beside your hand; the clock stands beside Chat.
- The stuck button reads x/n (how many are stuck, of how many playing) everywhere; upright it is a pill in the top bar.
- The page runs to the screen's edges (`viewport-fit=cover`); `insets()` in `client/viewport.ts` reads the notch and
  bottom-bar insets and `computeLayout` keeps hands and your own row out of them (`keep`). Untested on a real notch.
- Home screen: `public/manifest.json`, icons and the Apple tags make the game open with no browser bars once added to
  a phone's home screen. Your settings has a "Whole screen" section on touch devices: a full-screen button where the
  browser allows it (Android), the home-screen steps where it does not (iPhone).
- `useViewport` (`client/viewport.ts`) reads the window's size again after a phone is turned.
- Checked only in headless Chromium at phone sizes (360x640 to 390x844, 2 to 6 players, touch events through CDP):
  NOT on a real phone, not in Safari. Scripts for that are not in the repo.
- Known limits: cards on the felt are about 23 to 29 px wide on a phone (the felt is a fixed wide shape shared by every
  screen, so its size goes by the screen's width); at 360x640 with three or more opponents their cards are about 13 px.
  The end-of-round pile labels can lie over a hand. `VITE_PORT` / `PORT` let a second checkout run its own dev servers.

## To do, in the owner's priority order

1. ~~**Centre cards are too small.**~~ Done in `def509f` (not yet seen in a browser): caps raised, felt 2.2:1 from four
   players, own hand 0.108 of the window's height. Six players now 46 / 53 / 75 / 103 px at 720p / 900p / 1080p / 1440p.
   `npx tsx scripts/sizes.ts` prints the full table. Note: the long random-play tests time out on the 1-vCPU droplet
   (they do on the old code too); run `npm test` on a faster machine before deploying.
2. **Mobile.** A first pass is in (see "Mobile" above); the owner finds it bad and wants it redone. Before it: not designed for yet (deferred until he has Fable usage: it is a design job). From a phone screenshot
   (portrait, 2 bots): opponents squeezed into a strip at the top, the felt a short wide band mid-screen, half the
   screen empty between them and the hand; your hand's name/"nertz pile" line under the corner buttons and cut off at
   the bottom; the tray off the right edge. Since then: the felt is 2.2:1 from four players, side neighbours' hands
   are turned to run down the edges (`turnHand`), and a work pile can be fanned out by hovering or tapping (`peek`). He reports the end-of-round score card is bigger than the screen and there is a lot
   of empty space. A phone needs its own layout. Open question he raised: whether live card movement can survive a
   different phone layout. It should: positions on the felt are in shared table coordinates and positions near a hand
   are hand-relative (`aloftAt`), so a phone can lay the table out differently and still map both.
3. **End-of-round readability.** He wants something solid behind each player's whole block (gathered pile plus name,
   "+N played", "-N nertz left", net score) so it reads as one unit. The net score is already the largest thing, on a
   solid pill.
4. **Verify free placement at 3 and 4 players in a real browser.** His original bug: "I sometimes can't place my Ace
   in the middle; it thinks a bunch of spots are taken" (caused by the old rotated table; the centre is now one
   unrotated felt). The independent check of the fix was cut off before it tried this.
5. **Other players' Aces in free mode** are not drawn at their true place while moving quickly: only the last flight is
   seen. Other cards glide properly.

## Smaller things noted, not asked for

- The big NERTZ! stamp covers the caller's hand through the whole end sequence.
- The open chat panel covers an opponent seated at the left edge.
- Carrying a finished pile to the tray is not shown live to other players.
- Drag-to-deal code (`stockDeal: 'drag'`) is unreachable from the UI and can be deleted once he is sure about the
  timed deal (`STOCK_CARD_MS`). README still calls 'drag' the default in one place.
- Nobody has listened to the sounds or tried voice chat end to end; untested on touch, Safari and Firefox.
- Bots jam fairly often at small tables; he has not asked for changes since they were slowed (3.2 / 2.2 / 1.4 s).

## His standing preferences

- Exact placement only: a card lands where it is released or goes home; no auto-play, no snapping.
- Scoring is cards played out minus twice the nertz cards left; nothing else.
- The end of a round plays out; only Escape skips it.
- Other players' sounds much quieter than your own; no rising tones.
- Ask before anything outward-facing other than Fly redeploys of this app, which he has authorised.
