# Nertz

Real-time multiplayer [Nertz](https://en.wikipedia.org/wiki/Nertz) for 2 to 6 friends in the browser. Everybody plays their own
solitaire at the same time and races to play onto shared piles in the middle. One person starts a table, sends the link, and
everyone else joins from it. No accounts, no database: one small Node process holds every table in memory.

Status: runs locally. **Nothing has been deployed and no cloud resources exist.** The `Dockerfile` and `fly.toml` in this repo
are a proposal (see [Hosting plan](#hosting-plan)) and have never been run against a real service.

## Run the two-window demo

Needs Node 22 or newer (developed on Node 24).

```sh
npm install
npm run dev
```

Then open **http://localhost:5173** in two browser windows (two tabs of the same browser are fine):

1. Window 1: type a name, press **Start a new table**. The server picks the table code; you land in the lobby with an
   invite link like `http://localhost:5173/?room=ABCD`.
2. Window 2: paste the invite link (or open the home page and type the code), type a different name, press **Join table**.
   A code that no table has is refused with a message; it never opens a new table.
3. Window 1: press **Deal the first round**.

`npm run dev` runs the game server on port 8787 and Vite on 5173 (Vite proxies `/ws` to the server). Each window is its own
player because identity lives in `sessionStorage`. Reloading a window keeps its seat and hand. Use a new window or tab for a
second player, not "Duplicate tab": a duplicate copies the identity, takes over the seat, and the original tab is told so.

Controls:

| Do this | To |
| --- | --- |
| Drag a card (or a run from a work pile) onto the exact pile it fits | move it there. Anywhere else, it goes back |
| Drag an Ace onto an empty slot in the middle | start a centre pile in that slot |
| Drag a finished pile (one you put the King on) to the tray | clear it and free its slot |
| Click the stock, or press Space | flip three cards |
| **I'm stuck** | vote to reshuffle (see rules) |
| **NERTZ!** (appears in your nertz pile's place once it is empty) | end the round |

There is no click-to-play and no "throw it at the middle": a card lands only where it is released, and only if it fits there.
While you hold a card, exactly the piles that would take it are outlined, and the one you are over lights up. What counts is
where the pointer is when you let go; only if the pointer is over no pile at all does the centre of the card you grabbed
decide. Each pile's drop area is the pile plus a small margin (a whole column, for a work pile), neighbouring areas never
touch, and a card let go between two piles goes back where it came from.

What you see around a round:

- **The deal.** Every round opens with each player's deck, in their own back colour, lying where their stock goes. The
  nertz pile and then the four work piles are dealt off it one card after another, everyone's at the same time, yours
  large and the others' small. It takes about two and a half seconds and nothing can be touched meanwhile. Then the
  face-up cards (each nertz top and the four work tops) turn over at the same moment on every screen: that is the start.
  With "reduce motion" switched on the cards simply fade in where they belong; the wait and the turn are the same.
- **Face-down work cards** lie under each work pile, yours and everyone's, and turn over when the cards above them leave.
- **A long work pile** of yours starts higher up, into the free felt above its column, rather than being squeezed. When
  there is no felt left, the oldest cards of the pile narrow to slivers and the newest keep their rank readable.
- **A pile you finished** (you placed its King) glows and says "Drag to tray"; other people's finished piles are dimmed and
  ticked. The **tray** stands to the right of the middle, with every King peeking out from under the next.
- **NERTZ!** in big letters lies across the hand of whoever called it, on every board.
- **The grace window**: a small countdown ring in the top right, for everyone, while cards that were in hand at the call may
  still land, with "Put it down!" or the name of whoever is being waited for. If an opponent sits in that corner it moves
  down the right edge to the first spot clear of every opponent. If you are holding a card you simply keep dragging; if the
  server takes it out of your hand it slides home.
- **The end of the round** is played on the table before the scores: the centre piles turn face-down where they lie, the tray
  piles turn over and come out, everything is washed around the middle, and the cards sort themselves by back colour into
  one pile per player with the count and the nertz penalty underneath. Then the score sheet. It takes about five seconds; a
  click skips it, and with "reduce motion" switched on it is skipped altogether. The totals beside the names do not change
  until the sheet is up.

Other scripts:

```sh
npm test          # vitest: rules engine, protocol, room, real-socket server tests, client prediction
npm run typecheck # tsc --noEmit, strict
npm run build     # builds the client into dist/
npm start         # production mode: one process serves dist/ and the websocket on PORT (default 8787)
```

To try the production shape locally: `npm run build && npm start`, then open http://localhost:8787.

## Rules as implemented

- 2 to 6 players. Each has their own 52-card deck with its own back colour.
- Deal, per player: a 13-card **nertz pile** (only the top card face up), 4 **work piles** with 0, 1, 2 and 3 face-down
  cards under one face-up card (10 cards), the other 29 cards face down as the **stock**, and an empty **waste**.
  While the cards are being dealt (3 seconds) nobody can play, flip, vote or call, and nobody is shown a face.
- **Work piles** build down in alternating colours. Any run from a face-up card to the top of its pile can move to another
  of your work piles. When the face-up cards leave a pile, the next face-down card turns over. A pile with nothing left takes
  any card or run.
- **The middle** is a grid of fixed **slots**, 4 per player in the round, shared by everyone. An Ace starts a pile in the
  specific empty slot it is dropped on; every other card goes on the specific pile it extends, up by suit to the King, one
  card at a time.
- **Precise placement.** A card lands only when released on the one pile where it legally fits. If someone got there first
  (the pile moved on, or the empty slot was taken), the card returns to where it came from. Nothing is ever rerouted.
- **Completed piles.** A pile with its King takes nothing more and stays in its slot until the player who placed the King
  drags it to the **tray** at the side. The slot is then free for a new Ace. Tray piles still count for scoring.
- You can play: the top of your nertz pile or of your waste to a work pile or the middle; the top of a work pile to the
  middle; a run from one work pile to another.
- **Stock**: flip up to three cards onto the waste. When the stock is empty, flipping turns the waste back over into the stock.
- **Stuck**: each player can toggle "I'm stuck". When every connected player is stuck, each player's waste goes back onto
  their stock, the top stock card moves to the bottom (so the threes come out differently), and all flags clear. Making any
  move clears your own flag.
- **Ending a round**: once your nertz pile is empty you may press **NERTZ!**. It is a deliberate action, so you can keep
  playing cards to the middle first if you think it pays. Everyone is frozen at once, with one exception:
- **Held-card grace.** A player who was in the middle of dragging a card at the moment of the call, and whose card has at
  least one legal place to go, gets up to 4 seconds to release it on a legal spot: exactly one move, with that card only.
  If the card has nowhere to go, or loses its last spot to another player's grace move, the drag is cancelled. Letting go
  anywhere is that one move: if the spot was taken a moment earlier, the card goes back and that player is done. The round
  is over as soon as every such player has let go, or after 4 seconds. Grace moves count.
- **Scoring**, strictly: +1 for each of your cards in the middle (slots and tray), −2 for each card left in your nertz pile.
  No bonus for going out. Scores add up over rounds.
- **Table management**: the person who opened the table deals. If they are not connected, the first connected player may deal
  instead; the role returns when they are back. A round is dealt only to players who are connected at that moment. Someone
  who was away keeps their seat and score, watches if they return mid-round, and is dealt in next round. New players cannot
  join during a round; they can between rounds. Someone who presses Leave on the score sheet stays on that sheet, but no
  longer counts towards the six seats: a newcomer can take the place.

## How concurrency works

The whole design is: **the server decides, in arrival order, and clients predict with the same code.**

**One authoritative order.** The server is a single Node process. Each websocket message is handled synchronously, start to
finish, on Node's one thread. The order in which messages arrive is therefore the order of play. There are no locks, no
timestamps and no client authority. A move either applies to the current state or is rejected. (`server/room.ts`, about 300
lines, is all of it.)

**Intents name cards, not positions.** A client sends `{ k: 'move', cardId, count, to }`, not "move the third card of pile
two". If the table changed while the message was in flight, the server looks up where that card is *now* and judges the move
against the current state. `count` is how many cards the sender lifted (the card and the run on top of it). If that is not
what lies on the card now, the move is refused: when a drop to the middle is refused and the player has already dragged
the card underneath somewhere else, the refused card is not carried along. A stale message can be rejected, but it can
never move a card that was not picked up.

**Opaque ids and redacted views.** Card ids are random strings generated per round and say nothing about suit or rank. Each
player is sent a full snapshot in which face-down cards (all stocks, everything under the top of each nertz pile, and the
face-down cards at the bottom of each work pile, the owner's included) are reduced to `{ id, owner, hidden: true }`. The id stays the same when a card is revealed, so a card animates continuously from
back to face, and nobody can read hidden cards off the wire.

**Snapshots, seq and ack.** Every client message that plays a card carries a sequence number. Every server message is a
complete snapshot `{ rev, ack, room }`: `rev` increases with every change, and `ack` is the highest sequence number from *you*
that the server has processed, whether it accepted it or not. The state is tiny, so there are no diffs to get wrong. The
server coalesces: however many messages it handles in one turn of the event loop, each player gets one snapshot.

**Prediction is replay.** The rules engine (`shared/engine.ts`) is a pure function, `applyIntent(state, seat, intent)`, shared
by server and client, and it works on redacted views too. The client keeps the last snapshot and the list of intents it has
sent that are not yet acknowledged. What you see is those pending intents replayed over the latest snapshot, skipping any
that no longer apply. So your card moves the instant you let go, and if you lost a race the next snapshot simply no longer
supports your move: the card animates back. There is no rollback code. (`client/net.ts`: `onSnapshot`, `onSend`, `predict`.)

**No fallback.** A move names its destination exactly: `{ k: 'work', i }` (one of your own piles) or `{ k: 'slot', i }` (one
slot of the middle). The engine judges that pile and nothing else. Two players dropping on the same pile, or two Aces on the
same empty slot, are simply two messages: the first to arrive lands, the second is rejected and its sender's next snapshot
no longer supports the predicted move, so the card animates home.

**Holds and the grace window.** The server has to know who is mid-drag when Nertz is called, so drags are intents too:
`{ k: 'hold', cardId }` when a drag starts (accepted only for a card that seat could pick up), `{ k: 'release' }` when it
ends without a move. A move ends the hold by itself whether it is accepted or refused (`refused` in the engine: a drop that
lost a race still emptied the hand, and the client that sent it does not know yet that it lost), and so does losing the
connection. So the server never believes in a held card that went home. `PlayerState.holding` is part of every view, and
the client's replay applies the same rule. All the rules of grace live in the pure engine:

- `nertz` sets `nertzCalledBy` and fills `GameState.grace` with the seats that are holding a card with at least one legal
  destination. Everyone else's hold is dropped and all their intents are rejected from then on.
- A seat in `grace` may send exactly one more intent: a `move` of its held card, or a `release`. Either removes it from
  `grace`, the move even when it is refused; any other seat whose held card now has nowhere to go is removed with it.
- `isOver(state)` is "Nertz was called and `grace` is empty". `expireGrace(state)` empties it.

The server owns only the clock: when a call leaves someone in grace it starts one 4-second timer, and on expiry applies
`expireGrace`. The room stays in phase `playing` until `isOver`, then scores and moves to `results`. Snapshots carry
`graceMs`, the milliseconds left when the snapshot was sent (a duration to count down locally, not a timestamp), or `null`.

**The deal is a phase, and it is the same for everyone.** A fresh round from `deal` has `GameState.dealing` set. While it
is, `applyIntent` refuses every intent from every seat (the sender's `ack` still advances), and `viewFor` redacts every
card, the face-up ones included, so no layout can be read early, not even off the network tab. Ids are unchanged, so the
cards on screen are the ones that turn over later. The server owns only the clock, exactly as for grace: one `DEAL_MS`
(3 s) timer per round, and when it fires `finishDeal(state)` clears the flag and every player's ordinary view goes out in
the same flush. Snapshots carry `dealMs`, the milliseconds of the deal left when the snapshot was sent, or `null`. The
client animates from it and never decides anything: its input is off because the shared reducer says no, and a window that
arrives late (a reload or reconnect mid-deal) puts the cards already dealt in place and deals the rest on schedule
(`dealWait` in `client/layout.ts`). A card is dealt only when its element first appears during a deal, and only once, so
later snapshots, reconnects, the end of the round and coming back from the score sheet never replay it. Disconnecting during the deal changes nothing: the round opens on time. The timer is stopped when
the room is forgotten.

**The final table.** During `results` the snapshot still holds the finished round (`game`: slots, tray, hands) next to
`lastRound` (who called, and per player the name, the cards played, the nertz cards left and the running total), so the
client can play the end-of-round sequence and draw the score sheet from it, even if a player has left since.

**Tables.** `{ t: 'create', name, token }` opens a table and the server picks the code, which comes back in the first
snapshot. `{ t: 'join', room, name, token }` sits down at an existing table; a code that does not exist is answered with an
error and creates nothing. A connection that goes to another table from a lobby gives up its lobby seat, so one connection
never holds more than one table that has not started.

**Reconnects.** Identity is a random token in `sessionStorage`, sent only to the server. A new socket with a known token gets
its seat back and a fresh snapshot; sequence numbers and pending intents belong to a connection and start over. Until that
first snapshot arrives the client sends and predicts nothing: the table stays on screen as it was, and input is ignored.

**Hardening.** Every inbound message is parsed into a clean copy or dropped. Frames are capped at 2 KB, names at 20
characters, connections at 40 messages a second sustained. A slow client that falls 1 MB behind is disconnected. A table
with nobody connected is deleted after 10 minutes, or after 1 minute if it never dealt a round; a lobby everyone has left
is deleted at once. There is a cap of 2000 tables and no limit per address: someone opening sockets in bulk could still
fill it for about a minute at a time.

## Project layout

```
shared/   rules engine and wire protocol. Pure TypeScript, no IO, RNG injected. Used by server and client.
  types.ts      Card, GameState, Intent, RoomView
  engine.ts     deal, finishDeal, applyIntent, refused, legalDrops, expireGrace, isOver, resolveStuck, viewFor, scoreRound, checkInvariants
  protocol.ts   message types, limits, parsing and validation
server/   Node http + ws
  room.ts       one table: seats, host, rounds, intent handling, the deal and grace timers, snapshots. No IO.
  index.ts      http server, websocket upgrade on /ws, room registry, static files from dist/, /healthz
client/   Vite + React
  net.ts        websocket store and prediction
  layout.ts     pure geometry: where every card, slot, tray pile, drop area and the countdown goes for a given window size; the deal's schedule
  Table.tsx     the table: the deal, drag and drop, the Nertz call, the grace countdown, the steps of the end-of-round sequence
  Finale.tsx    the wash and the sorted piles at the end of a round, drawn on a canvas
  App.tsx       home, lobby and score sheet
  cards/        card faces drawn as SVG in code (original art, see cards/CREDITS.md)
```

Dependencies at runtime: `ws`, `react`, `react-dom`, `motion` (card animation) and `tsx` (runs the TypeScript server
directly, so there is no server build step).

## Hosting plan

Nothing here has been deployed. This is the plan I would follow.

**What the game needs.** One long-lived process that holds websockets open and keeps every table in memory. All players of a
table must reach the *same* process, because that process's event loop is what orders their moves. Load is tiny: a snapshot
is a few kilobytes and a busy table is a few messages a second.

### Recommended start: one Fly.io machine

- One always-on `shared-cpu-1x` machine in one region near the players, serving the built client and the websocket from the
  same origin. Expect a few dollars a month; check Fly's current pricing.
- Auto-stop off and exactly one machine. `fly launch` likes to create two machines for availability; that would split tables
  across processes, so scale to one (`fly scale count 1`). Auto-stop must stay off because a stopped machine forgets every
  table.
- The included `Dockerfile` and `fly.toml` match this: port 8080, health check on `/healthz`, connection-based concurrency,
  no auto-stop.
- **What a deploy or restart does to live games:** the process is replaced, so every table and score is gone. Clients notice
  the dropped socket, reconnect with backoff and try to rejoin their table code, which no longer exists, so they are told
  there is no such table and someone has to start a new one. For a game among friends, deploying when nobody is playing is enough. If that ever stops being
  acceptable, the fix is to write each room's state to a volume or Redis on change and reload it on boot; `GameState` is
  plain JSON, so that is a small change.
- Outgrowing one machine (unlikely) means routing by table code, for example with Fly's `fly-replay` header, so that a table
  always lands on the machine that owns it.

First deploy would look like this (not run):

```sh
fly launch --no-deploy     # pick a unique app name and region; keep the fly.toml in this repo
fly deploy
fly scale count 1
```

### Railway or Render

Both run the same `Dockerfile` (or `npm run build` + `npm start`) as an always-on container with websocket support, and both
are simpler to click through than Fly. Either is a fine alternative.

- Use exactly one instance, for the same reason as above.
- Avoid tiers that sleep when idle (Render's free web services do): sleeping loses every table and makes the first visitor
  wait for a cold start.
- Compared with Fly: less control over region and restarts, usually a little more per month for an always-on instance, less
  to configure.

### Cloudflare Durable Objects (or PartyKit)

A Durable Object is a small single-threaded server with a name. One object per table code gives exactly the model this game
already uses: all of a table's messages arrive at one place and are handled one at a time. PartyKit, now part of Cloudflare,
is a thin layer over the same thing.

- **Why the port is straightforward:** `shared/` is pure and has no Node APIs, and `server/room.ts` does no IO; it talks to
  connections through a two-method interface (`send`, `close`). The port replaces `server/index.ts` (about 200 lines of
  http/ws glue) with a Worker that routes `/ws?room=CODE` to the object for that code, and wraps Cloudflare's WebSocket in
  that interface. The client stays the same apart from the URL.
- **What you gain:** no server to keep running, tables near the players, scale to zero, and no single machine whose restart
  ends every game at once.
- **What it costs:** a different runtime (no `ws`, no `node:http`), a second deploy story for local development, and care
  around hibernation: an idle object is evicted from memory, so a table's state has to be written to the object's storage or
  the table kept awake while a round is on.

This is where I would go if the game became public. For a handful of friends it is more machinery than one small machine.

### Why not Vercel-style serverless

Serverless functions run per request and are then frozen or discarded. They cannot keep a websocket server listening, and
two requests are not guaranteed to reach the same instance, so there is no process in which a table could live or in which
two players' moves could be put in order. Making it work means adding a hosted realtime service for the sockets and a
database for the state, and then recreating "one move at a time per table" with transactions. That is more code, more
latency and more moving parts than the single process it replaces. Vercel could host the static client, but the game server
would still need one of the options above, and serving both from one origin is simpler.

## Known limits

- **Someone who never comes back** keeps their seat until they press Leave or the table expires. They are not dealt cards
  while away, but they count towards the six seats. There is no kick.
- **An abandoned lobby lasts a minute.** If you open a table and everyone's connection drops for more than a minute before
  the first deal, the table is gone and the invite link reports no such table.
- **No Leave button during a round**, only in the lobby and on the results sheet. Closing the tab holds the seat.
- **Fonts come from Google Fonts** at runtime. Offline they fall back to system fonts; everything still works.
- **Small screens.** Laid out for laptop and desktop windows. Phone landscape works but is tight, and touch input has not
  been tested on a real device.
- **Very long work piles in a low window.** At 1280 x 720 a pile of two face-down and ten face-up cards shows its newest
  six cards with the whole rank and the top of the suit, the next with most of its rank, and the oldest three as slivers
  about 11 px tall, which are hard to read and to grab. A taller window, or fewer players, leaves felt for the pile to rise into. With six players in a small window (about 1024 x 700)
  the 24 centre slots are only about 35 px wide; they still take a drop, but it is fiddly.
- **The wash is a canvas.** At the end of a round up to ~300 card backs move at once, so they are drawn on one canvas
  rather than as elements. Measured in Chromium with 6 players and 222 cards in the middle: a steady 60 frames a second at
  1x and 2x pixel density with a GPU, and at 1x without one. Without a GPU at 2x it misses frames, notices (five late
  frames), and draws the moving cards at 1x until they come to rest.
- **The deal** is drawn from where each stock lies, and only the cards that leave it move (23 per player); the 29 that
  stay are the stock. Resizing the window during the deal moves each deck, and the cards already out, to the new layout
  and the deal carries on. In a background tab the browser slows timers, so cards can leave the deck late there. The
  turn-over arrives with the snapshot that ends the deal, so on a slow connection it is late by that connection's
  latency.
- **The grace countdown** avoids every opponent's hand, but with four or five opponents in one row it sits just below
  them and can lie over the top edge of the tray for the (at most four) seconds it is up.
- **A round nobody ends.** If every card is played and nobody presses NERTZ!, the round just sits there. The call is
  deliberate by design.
- **After a server restart** a reconnecting window is told its table no longer exists and is put back on the home page with
  the code filled in; somebody has to start a new table.
- **Bundle size** is about 400 kB (130 kB gzipped), a third of it the animation library.
- **No spectators, no chat, no persistence.** Restarting the server ends every game.
