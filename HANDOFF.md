# Handoff notes (11 Nov 2026)

State: `main` is deployed to https://nertz.fly.dev (Fly app `nertz`, org `personal`, region `sjc`, one machine,
suspends when idle). Deploy with `fly deploy --app nertz --ha=false` when nobody is connected
(`curl https://nertz.fly.dev/healthz` shows connections); a deploy drops live games. `npm run dev` for local work
(server 8787, Vite 5173); `npm run typecheck`, `npm test`, `npm run build` must stay green. README.md describes the game
as built.

The owner reviews by playing and gives feedback in plain words; small tweaks are made directly, and he prefers quick
turnarounds over long verification loops for small visual changes.

## To do, in the owner's priority order

1. **Centre cards are too small, and do not grow on a big screen.** Six players: 44 px wide at 1280x720, 47 at
   1440x900, 68 at 1920x1080; he finds them small on a 32-inch monitor. The felt has one fixed shape (2.8:1, see
   `shared/table.ts` and `computeLayout` in `client/layout.ts`), is hemmed in by the side hands and leaves vertical room
   unused; card size is capped. Two-player grid-mode cards also shrank (46 px at 1280x720, was 65).
2. **Mobile.** Not designed for yet. He reports the end-of-round score card is bigger than the screen and there is a lot
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
