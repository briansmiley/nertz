# Handoff notes (11 Nov 2026)

State: `main` is deployed to https://nertz.fly.dev (Fly app `nertz`, org `personal`, region `sjc`, one machine,
suspends when idle). Deploy with `fly deploy --app nertz --ha=false` when nobody is connected
(`curl https://nertz.fly.dev/healthz` shows connections); a deploy drops live games. `npm run dev` for local work
(server 8787, Vite 5173); `npm run typecheck`, `npm test`, `npm run build` must stay green. README.md describes the game
as built.

The owner reviews by playing and gives feedback in plain words; small tweaks are made directly, and he prefers quick
turnarounds over long verification loops for small visual changes.

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

## To do, in the owner's priority order

1. ~~**Centre cards are too small.**~~ Done in `def509f` (not yet seen in a browser): caps raised, felt 2.2:1 from four
   players, own hand 0.108 of the window's height. Six players now 46 / 53 / 75 / 103 px at 720p / 900p / 1080p / 1440p.
   `npx tsx scripts/sizes.ts` prints the full table. Note: the long random-play tests time out on the 1-vCPU droplet
   (they do on the old code too); run `npm test` on a faster machine before deploying.
2. **Mobile.** Not designed for yet (deferred until he has Fable usage: it is a design job). From a phone screenshot
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
