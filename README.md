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

1. Window 1: type a name, press **Start a new table**. You land in the lobby with an invite link like
   `http://localhost:5173/?room=ABCD`.
2. Window 2: paste the invite link, type a different name, press **Join table**.
3. Window 1: press **Deal the first round**.

`npm run dev` runs the game server on port 8787 and Vite on 5173 (Vite proxies `/ws` to the server). Each window is its own
player because identity lives in `sessionStorage`. Reloading a window keeps its seat and hand. Use a new window or tab for a
second player, not "Duplicate tab": a duplicate copies the identity, takes over the seat, and the original tab is told so.

Controls:

| Do this | To |
| --- | --- |
| Drag a card (or a run from a work pile) | move it to a work pile or to the middle |
| Click a card | play it to the middle if any foundation takes it |
| Click the stock, or press Space | flip three cards |
| **I'm stuck** | vote to reshuffle (see rules) |
| **Nertz!** (appears when your nertz pile is empty) | end the round |

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
- Deal, per player: a 13-card **nertz pile** (only the top card face up), 4 **work piles** of one face-up card each, the other
  35 cards face down as the **stock**, and an empty **waste**.
- **Work piles** build down in alternating colours. Any run from a card to the top of its pile can move to another of your
  work piles. An empty work pile takes any card or run.
- **Foundations** are in the middle and shared by everyone. Any Ace starts a new one; they build up by suit to the King, one
  card at a time. A finished pile stays in place, dimmed, and still counts for scoring.
- You can play: the top of your nertz pile or of your waste to a work pile or a foundation; the top of a work pile to a
  foundation; a run from one work pile to another.
- **Stock**: flip up to three cards onto the waste. When the stock is empty, flipping turns the waste back over into the stock.
- **Stuck**: each player can toggle "I'm stuck". When every connected player is stuck, each player's waste goes back onto
  their stock, the top stock card moves to the bottom (so the threes come out differently), and all flags clear. Making any
  move clears your own flag.
- **Ending a round**: once your nertz pile is empty you may press **Nertz!**. The round ends immediately. It is a deliberate
  action, so you can keep playing cards to the middle first if you think it pays.
- **Scoring**: +1 for each of your cards in the middle, −2 for each card left in your nertz pile. Scores add up over rounds.
- **Table management**: the person who opened the table deals. If they are not connected, the first connected player may deal
  instead; the role returns when they are back. A round is dealt only to players who are connected at that moment. Someone
  who was away keeps their seat and score, watches if they return mid-round, and is dealt in next round. New players cannot
  join during a round; they can between rounds.

## How concurrency works

The whole design is: **the server decides, in arrival order, and clients predict with the same code.**

**One authoritative order.** The server is a single Node process. Each websocket message is handled synchronously, start to
finish, on Node's one thread. The order in which messages arrive is therefore the order of play. There are no locks, no
timestamps and no client authority. A move either applies to the current state or is rejected. (`server/room.ts`, about 200
lines, is all of it.)

**Intents name cards, not positions.** A client sends `{ k: 'move', cardId, to }`, not "move the third card of pile two". If
the table changed while the message was in flight, the server looks up where that card is *now* and judges the move against
the current state. A stale message can be rejected, but it can never move the wrong card.

**Opaque ids and redacted views.** Card ids are random strings generated per round and say nothing about suit or rank. Each
player is sent a full snapshot in which face-down cards (all stocks, and everything under the top of each nertz pile) are
reduced to `{ id, owner, hidden: true }`. The id stays the same when a card is revealed, so a card animates continuously from
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

**Foundation fallback.** Racing for the middle is the game, so a lost race should not waste the card if it still has a home.
When a move targets a foundation that can no longer take the card, the engine plays it on any other foundation that can (or
starts a new one for an Ace). Only when none accepts it is the move rejected.

Both outcomes were checked in two real browser windows with 250 ms of artificial latency each way: both players play a 2 on
the same Ace at the same moment, each window briefly shows its own card landing, then the loser's card either returns to its
pile (one Ace out) or slides over to the other Ace of that suit (two out), and both windows end identical.

**Reconnects.** Identity is a random token in `sessionStorage`, sent only to the server. A new socket with a known token gets
its seat back and a fresh snapshot; sequence numbers and pending intents belong to a connection and start over.

**Hardening.** Every inbound message is parsed into a clean copy or dropped. Frames are capped at 2 KB, names at 20
characters, connections at 40 messages a second sustained. A slow client that falls 1 MB behind is disconnected. Tables with
nobody connected are deleted after 10 minutes.

## Project layout

```
shared/   rules engine and wire protocol. Pure TypeScript, no IO, RNG injected. Used by server and client.
  types.ts      Card, GameState, Intent, RoomView
  engine.ts     deal, applyIntent, resolveStuck, viewFor, scoreRound, checkInvariants
  protocol.ts   message types, limits, parsing and validation
server/   Node http + ws
  room.ts       one table: seats, host, rounds, intent handling, snapshots. No IO.
  index.ts      http server, websocket upgrade on /ws, room registry, static files from dist/, /healthz
client/   Vite + React
  net.ts        websocket store and prediction
  layout.ts     pure geometry: where every card goes for a given window size
  Table.tsx     the table, drag and drop
  App.tsx       home, lobby and results screens
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
  the dropped socket, reconnect with backoff and rejoin the same table code, which puts everyone back together in a fresh
  lobby with scores at zero. For a game among friends, deploying when nobody is playing is enough. If that ever stops being
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

- **Table codes are chosen by the browser.** Joining a code that does not exist creates that table. So a mistyped code puts
  you alone in a new lobby instead of saying "no such table", and two groups could in principle pick the same four letters
  (about 1 in 330,000 per pair of tables). Fixing it properly needs a "create" message in the protocol.
- **Someone who never comes back** keeps their seat until they press Leave or the table expires. They are not dealt cards
  while away, but they count towards the six seats. There is no kick.
- **No Leave button during a round**, only in the lobby and on the results sheet. Closing the tab holds the seat.
- **Fonts come from Google Fonts** at runtime. Offline they fall back to system fonts; everything still works.
- **Small screens.** Laid out for laptop and desktop windows. Phone landscape works but is tight, long work piles compress
  their fan, and touch input has not been tested on a real device.
- **Bundle size** is about 400 kB (130 kB gzipped), a third of it the animation library.
- **No spectators, no chat, no persistence.** Restarting the server ends every game.
