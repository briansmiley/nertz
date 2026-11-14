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

1. Window 1: type a name, press **New Table**. The server picks the table code; you land in the lobby with an
   invite link like `http://localhost:5173/?room=ABCD`.
2. Window 2: paste the invite link (or open the home page and type the code), type a different name, press **Join table**.
   A code that no table has is refused with a message; it never opens a new table.
3. Window 1: press **Deal the first round**. The cards are dealt and the table waits.
4. Window 1: press **Start** (or Space). "1, 2, 3, NERTZ!" and everyone plays. Cards come off the stock one at a
   time: drag the top one onto the waste, three times for a group of three (or click, if the host set the table so).

On your own? In the lobby press **Add bot** and deal: one person and one bot make a round (see [Bots](#bots)).

`npm run dev` runs the game server on port 8787 and Vite on 5173 (Vite proxies `/ws` to the server). Each window is its own
player because identity lives in `sessionStorage`. Reloading a window keeps its seat and hand. Use a new window or tab for a
second player, not "Duplicate tab": a duplicate copies the identity, takes over the seat, and the original tab is told so.

Controls:

| Do this | To |
| --- | --- |
| Drag a card (or a run from a work pile) onto the exact pile it fits | move it there. Anywhere else, it goes back |
| Let an Ace go anywhere on the felt in the middle where there is room for the card | start a centre pile right there |
| ...or, at a table with "Crystallized Nertz", drag an Ace onto an empty marked place | start a centre pile on that place |
| Drag a finished pile (one you put the King on) to the tray, bottom right | clear it and free its place. Until you have, you can do nothing else |
| **Start**, or Space or Enter (the dealer, once the cards are dealt) | count "1, 2, 3, NERTZ!" and open play |
| Click the empty stock | turn the waste back over into the stock |
| Click the stock, or press Space | deal a group of three: they come off one at a time, a quarter of a second apart, and turn up together |
| **I'm stuck** | vote to reshuffle (see rules) |
| **NERTZ!** (appears in your nertz pile's place once it is empty) | end the round |
| Press M, or the speaker button bottom left | mute or unmute |
| The gear beside it | your own settings: volume, other players' volume, reduce motion |
| The bug beside that | report a bug or ask for a feature: a few words and, if you like, a screenshot |

There is no click-to-play and no "throw it at the middle": a card lands only where it is released, and only if it fits there.
Nothing shows where a card in hand may go: no pile is outlined for it. (On a touch screen a tap takes a card up and the
next tap puts it down, and a finger that lets go a little off a pile still lands on it.) What counts is
where the pointer is when you let go; only if the pointer is over no pile at all does the centre of the card you grabbed
decide. Each pile's drop area is the pile plus a small margin (a whole column, for a work pile), neighbouring areas never
touch, and a card let go between two piles goes back where it came from.

What you see around a round:

- **One felt in the middle, the same for everybody.** The middle is a wide felt with rounded ends. Every pile lies at
  the same place of it on every screen: the pile in its top left corner is in the top left corner for all of you.
  Only the seating round it is yours: you along the bottom, large; the others as small hands in seat order from your
  left, across the top for whoever sits opposite and at the left and right edges for your neighbours. See
  [The table](#the-table).
- **Other people's cards move while they are still in their hands.** When someone picks a card up you see it leave
  their pile, in their hand as your window seats them, and travel to the pile it is going to as they carry it there
  (an Ace, which may be going anywhere, lifts out of the hand and comes over when they slow down over the felt),
  about 18 times a second and smoothed in between. A card in someone else's hand is see-through and never in your pointer's way, so it cannot hide a pile;
  your own card turns partly see-through while it is over the middle, for the same reason. A bot does not drag, so
  its card simply crosses the table at a pace you can follow.

- **The deal.** Every round opens with each player's deck, in their own back colour, lying where their stock goes. The
  four work piles and then the nertz pile are dealt off it one card after another, everyone's at the same time, yours
  large and the others' small (a hand across the table is dealt the other way round, like the hand itself). It takes
  about three seconds and nothing can be touched meanwhile. Then the four work tops of every hand turn over at the same
  moment on every screen, so that everyone can look at their layout. The nertz piles stay face-down. With "reduce
  motion" switched on the cards simply fade in where they belong; the wait and the turn are the same.
- **The start.** The table now waits, for as long as it takes, for the dealer. The dealer has a big **Start** button in
  the middle of the felt (Space or Enter does the same); everyone else has a **Ready?** button there, and under it the names of those waiting, lit as each says ready. Being ready starts nothing: the dealer still says when. Pressing
  it counts "1", "2", "3" in the middle of every screen, about 0.7 seconds each, and on "NERTZ!" every nertz pile's top
  card turns over and play is open. Nothing can be touched before the word: no card, no stock, no patch of felt, and
  nobody's card is shown moving. With "reduce motion" the numbers do not bounce.
- **The stock and the waste.** The stock shows one edge for every three cards left, so you can see it getting thin. The
  waste is one squared-up pile: you see its top card and nothing of what is under it, in your own hand and in everyone
  else's (mirrored with the rest of the hand for the players across the table). While a group is being dealt its cards
  lie squarely on it face-down, and all turn over when the third lands.
- **Face-down work cards** lie under each work pile, yours and everyone's, and turn over when the cards above them leave.
- **A long work pile** of yours may start a little higher up, into what room there is between your hand and the felt.
  Past that the oldest cards of the pile narrow to slivers and the newest keep their rank readable.
- **A pile you finished** (you placed its King) glows and says "Drag to tray"; other people's finished piles are dimmed and
  ticked. Carrying it to the tray is the next thing you have to do: if you press a card, the stock, Space, "I'm stuck" or
  NERTZ! first, or try to deal from the stock or to start a pile on the felt, nothing moves, the pile shakes, the tray
  flashes, there is a soft tap and a small notice right by the pile, wherever on the table it lies, says "Move your
  finished pile to the tray first" for a couple of seconds. Your cards do not look grabbable meanwhile.
  The **tray** runs off the right edge of the window beside your hand: finished piles are pushed half
  off-screen there, the near side of every King peeking out from under the next. While you carry a finished pile it
  lights up and comes a little way in; let go anywhere from just short of it to the edge of the screen.
- **NERTZ!** in big letters lies across the hand of whoever called it, on every board.
- **The grace window**: a small countdown ring in the top right, for everyone, while cards that were in hand at the call may
  still land, with "Put it down!" or the name of whoever is being waited for. Nobody is ever seated in that corner. If
  you are holding a card you simply keep dragging; if the server takes it out of your hand it slides home.
- **The end of the round** is played on the table before the scores. The centre piles turn face-down where they lie, the
  tray piles turn over and come out, and everything is washed on the felt, backs up. Then the wash is drawn in to a heap
  in the middle of the felt and sorted by back colour, one player at a time, the round's lowest score first: each
  player's cards go out to a pile **in front of that player's seat**, at the edge of the felt towards their chair as
  your window seats them (yours at the bottom, the player opposite at the top). Beside each pile, on
  whichever side is clear, are its player's colour and name, "+N played" and "−N nertz left" in the same size, and
  largest the net score for the round; when the last pile is in, the round's best is picked out in gold ("★ ... wins the
  round") and the others dim. The labels are placed so that they cover no hand, no name, not the tray, not the NERTZ!
  stamp and not each other. Then the score sheet. The sequence takes about four seconds, a second and a half per
  player, and a pause of six and a half seconds to read it; a click skips it, and with "reduce motion" switched on it
  is skipped altogether. The totals beside the names do not change until the sheet is up.

Other scripts:

```sh
npm test          # vitest: rules engine, protocol, room, real-socket server tests (a hostile hand-written client among them), client prediction
npm run typecheck # tsc --noEmit, strict
npm run build     # builds the client into dist/
npm start         # production mode: one process serves dist/ and the websocket on PORT (default 8787)
```

To try the production shape locally: `npm run build && npm start`, then open http://localhost:8787.

## Rules as implemented

- 2 to 6 players. Each has their own 52-card deck with its own back colour.
- Deal, per player: a 13-card **nertz pile** (only the top card face up), 4 **work piles** with 0, 1, 2 and 3 face-down
  cards under one face-up card (10 cards), the other 29 cards face down as the **stock**, and an empty **waste**.
  While the cards are being dealt (3 seconds) nobody can play, deal from the stock, vote or call, and nobody is shown a face.
- **The start.** When the cards are down the work piles' top cards are turned over; the nertz piles stay face-down and
  still nobody can do anything. The round begins when the dealer says so: "1, 2, 3, Nertz!" (about two seconds), and on
  the word every nertz top is turned over and play is open for everyone at once. There is no time limit on the dealer.
- **Small tables** bury fewer cards: with two players in the round no work pile has a face-down card (4 cards in the
  work piles, 35 in the stock); with three they have 0, 0, 1 and 2 (7 and 32); from four up the standard 0, 1, 2 and 3.
  The nertz pile is 13 either way. This is the rule, not an option (`faceDown` in `shared/settings.ts`).
- **Work piles** build down in alternating colours. Any run from a face-up card to the top of its pile can move to another
  of your work piles. When the face-up cards leave a pile, the next face-down card turns over. A pile with nothing left takes
  any card or run.
- **The middle** holds up to 4 piles per player in the round, shared by everyone. Every card but an Ace goes on the
  specific pile it extends, up by suit to the King, one card at a time. Where an Ace goes is the host's choice (a table
  rule, see [The table](#the-table)):
  - **Anywhere** (the default): an Ace starts a pile at the very point of the felt where it is let go. The whole card
    must lie on the felt, and clear of every other pile by a small gap (0.14 of a card's width): exactly what you
    see, and the same on everyone's screen. While you carry the Ace over the felt it is the size of a pile in the
    middle, with an outline on it that says whether there is room (a gold ring and a tick) or not (a broken red ring,
    struck through, and a cross), and every pile shows the room it keeps round itself. Let go where there is no room
    and the Ace goes back. Two Aces for the same patch of felt: the first lands, the second goes back. The table
    still holds at most 4 piles per player.
  - **Crystallized Nertz**: the middle has a marked place for every pile, laid out as a loose cluster. An Ace starts
    a pile on the specific empty place it is dropped on.
- **Precise placement.** A card lands only when released on the one pile where it legally fits. If someone got there first
  (the pile moved on, or the empty place was taken), the card returns to where it came from. Nothing is ever rerouted.
- **Completed piles.** A pile with its King takes nothing more and stays where it is until the player who placed the King
  drags it to the **tray** at the side. Its place is then free for a new Ace. Tray piles still count for scoring.
- **Clear first.** Clearing the pile away is the very next thing the player who placed the King must do: until it is in
  the tray they cannot move a card, deal from the stock, say they are stuck or call Nertz. (At a real table you have to
  get the pile out of the way too; nothing is automated here.) Nobody else is held up, and the place stays taken
  meanwhile. If somebody else calls Nertz before the pile is cleared, the round ends as usual and the pile scores where
  it lies. It cannot meet the held-card grace window: placing the King emptied that player's hand and they could not
  pick anything up since.
- You can play: the top of your nertz pile or of your waste to a work pile or the middle; the top of a work pile to the
  middle; a run from one work pile to another.
- **Stock**: one click on the stock (or Space) deals a group of three, and dealing takes time, as it does with real
  cards: they come off one at a time, a quarter of a second apart (`STOCK_CARD_MS`), face-down onto the waste, and the
  group turns face-up when the third lands (or the stock runs out first). The next group cannot be started sooner than
  that after the last card, so going round the stock costs about three quarters of a second a group however fast you
  click. While a group is coming off the waste is out of play (its top is face-down, and nobody is shown those cards,
  their owner included); the nertz pile and the work piles play on. When the stock is empty, a click turns the whole
  waste back over into the stock.
- **The pace is the server's.** A group is three one-card intents sent by the client on that schedule; the server takes
  one card per intent and refuses a card that arrives too soon after the same player's last one, so a doctored client
  gains nothing. (The old "drag each card" rule still exists as the table setting `stockDeal: 'drag'`, but is no longer
  offered in the table rules.)
- **Stuck**: each player can toggle "I'm stuck". When every connected player is stuck, the server (which knows every
  card) checks whether anybody can still make a move that gets anywhere (`canProgress`): a card to the middle, a stock,
  waste or nertz card onto a work pile (any card of the stock counts: shifting it brings any card up), or a work-pile
  run that turns up a face-down card or empties a pile. If nobody can, **the table is jammed** and the round ends there,
  scored as it stands. Otherwise each player's waste (a half-dealt group included) goes back onto their stock, the top
  stock card moves to the bottom (so the threes come out differently: three votes in a row show every card), and all
  flags clear. Making any move clears your own flag.
- **Voting to end a round**: in the gear menu, while a round is on, anyone can vote to end it where it stands. When
  every connected person has voted (bots go along), it ends and is scored as usual. A vote can be taken back.
- **Ending a round**: once your nertz pile is empty you may press **NERTZ!**. It is a deliberate action, so you can keep
  playing cards to the middle first if you think it pays. Everyone is frozen at once, with one exception:
- **Held-card grace.** A player who was in the middle of dragging a card at the moment of the call, and whose card has at
  least one legal place to go, gets up to 4 seconds to release it on a legal spot: exactly one move, with that card only.
  If the card has nowhere to go, or loses its last spot to another player's grace move, the drag is cancelled. Letting go
  anywhere is that one move: if the spot was taken a moment earlier, the card goes back and that player is done. The round
  is over as soon as every such player has let go, or after 4 seconds. Grace moves count. A stock card on its way to
  the waste is not such a card: it goes back, and a group left half-dealt at the call stays as it lies, face-down.
- **Scoring**, strictly: +1 for each of your cards in the middle (piles and tray), −2 for each card left in your nertz pile.
  No bonus for going out. Scores add up over rounds.
- **Table management**: the person who opened the table deals. If they are not connected, the first connected player may deal
  instead; the role returns when they are back. A round is dealt only to players who are connected at that moment. Someone
  who was away keeps their seat and score, watches if they return mid-round, and is dealt in next round. A new player may
  join at any time: in the middle of a round they sit down and watch it, and are dealt in at the next. (Until the dealer has said Start nothing has been played: whoever sits down or comes back by then is dealt in, the round being dealt over.) The score sheet says of how many rounds a total is the sum, where that is fewer than the table has played. Someone who presses Leave on the score sheet stays on that sheet, but no
  longer counts towards the six seats: a newcomer can take the place.

## The table

**Table space.** The middle of the table is defined once, in `shared/table.ts`, for everybody: one felt, a wide
rectangle with rounded corners, 2 units high and 5.6 wide with up to three players, 4.4 wide from four on (`feltHw`:
there are hands at its sides then, and a squarer felt can be taller on the screen), corner radius 0.62, centre (0, 0), y down the screen, one
unit the same distance both ways. A centre pile is a point of it (the middle of its cards), kept in the game state
(`GameState.places`, one per slot, in every snapshot). Nothing in the state says where anything is on a screen.

**The same way up for everyone.** The felt is not turned for anybody. A client only chooses where on its screen the
centre of the felt goes and how many pixels a unit is: a point (x, y) of the table is drawn at
`(cx + x * u, cy + y * u)` (`toScreen` in `client/layout.ts`), and `toTable` is the exact inverse. So a pile is at
the same place of the felt in every window, and a card covers the same rectangle of it for everyone
(`cardSize(players)`: upright, 1.4 times as high as wide). The client makes the felt as large as fits between the
hands and gives a card `w * u` pixels.

**So the rules for putting a pile down are what you see.** Two piles clash if their cards would overlap or leave
less than a gap of 0.14 of a card's width (`clash`: two rectangles); a pile is on the table if all four corners of
its card are on the felt (`onTable`). Nothing else. The engine uses exactly these to accept or refuse an Ace, and
the client draws exactly these while an Ace is in hand: the outline of the card, the same card grown by the gap
round every pile, and the edge of the felt. Wherever there is visibly room for a card, a pile may go: every point of
the felt can be covered by some pile, one pile shuts off four cards' worth of places and no more (9% of them with six
players, 16% with two), and the next pile can lie 6 px beside it.

**The size of a card** is chosen so that all four piles per player (every Ace in the round) together cover 30% of
the felt, and never more than 0.4 units wide however few the players, so that a careless row of piles along the
middle still leaves room for a pile above and below every one of them. Put down anywhere at random that happens to
be free, all four piles per player fit at least 99 times in 100 (`shared/table.test.ts`).

**Crystallized Nertz.** Four marked places per player, the same for everyone: two rows for up to three players, three
for more, each row set half a place to one side of the next like bricks, each place nudged a little off its mark and
given up to two and a half degrees of tilt, always the same way. Same card size as without.

**Hands.** Your own hand is laid out as it always was. Everyone else's is a compact row where they sit as you see
it, in seat order clockwise from your left: along the top edge for seats across from you, at the left or right edge (turned to face the felt)
for your neighbours (turned a quarter turn to face the felt, running down the edge), lower down the nearer they sit to you. A hand across the table is drawn the other way round
(its owner's left is your right, as at a real table), a neighbour's the same way round as yours. The top corners are
kept free for the chat button and the grace countdown, the bottom corners for the settings and the tray.

**Card sizes** (width in pixels of a centre card, and of an opponent's card; the same with and without the grid):

| Window | 2 players | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- |
| 1280 x 720 | 65, 45 | 67, 40 | 59, 33 | 55, 29 | 51, 25 |
| 1440 x 900 | 85, 56 | 88, 50 | 78, 41 | 72, 36 | 67, 32 |
| 1920 x 1080 | 105, 67 | 108, 60 | 96, 50 | 88, 43 | 83, 38 |
| 2560 x 1440 | 148, 89 | 153, 81 | 135, 66 | 124, 58 | 116, 50 |

Your own cards are 0.108 of the window's height wide (with room for 0.85 of a card below the row: a work pile of more
than about eight cards squeezes its older cards to slivers), up to 150 px; an opponent's up to 96 px; a centre card up to 1.2
times your own. `npx tsx scripts/sizes.ts` prints this table.

(While the felt was a round table turned to each chair these were, at 1280 x 720, 65/52/45/29/38 with marked places
and 49/37/36/25/28 without. Two players with the grid is the one case that got smaller.)

### Seeing cards move

While you drag a card your client reports where it is, `{ t: 'drag', id, w, h, p }`, at most 18 times a second (and
always the last position). The server stamps your seat on it and forwards it to the other players at the table.
That is all it does: the report is not stored, not checked against the rules, not in any snapshot and not predicted.
The card still moves only when you let go, by the ordinary `move` intent. The server forwards a report only while
the game says that player is holding that very card (the `hold` intent came down the same socket just before), so
nobody can make a card fly that is not in their hand, and it lets through at most 30 a second per player.

A report says where the card is in two frames at once, because there is no single mapping from one player's screen to
another's: the felt is the same on every screen, the hands are not. Its owner carries a card up from the bottom of
their screen; in your window it has to come from wherever they sit.

- `p`: the card's centre in table space: the same point of the felt on every screen.
- `h`: how far the card is from its pile, in widths of its owner's cards: along the row, and towards the middle.
  Right near the hand, wherever and however large a window draws that hand.
- `w`: how far the card has come of the way to a pile in the middle that would take it, from 0 when it has just left
  its own pile (or has no such pile to go to: an Ace) to 1 when it is over that pile.

A receiving window (`aloftAt` in `client/layout.ts`) starts the card at `h` in its own picture of that hand: so a
card going from pile to pile within a hand is seen doing just that. A card that leaves the hand for the felt is
lifted a little way out of the hand towards the middle. From there a card with a pile to go to is drawn `w` of the
way along the straight line to that pile, so it arrives as its owner does; and a card with none (an Ace on its way
to bare felt) comes over to where it really is, `p`, when it has lingered over the felt for a quarter of a second
or so (or, if it is put down without lingering, flies there from the hand when it lands). It grows from hand size to
pile size on the way. So from every seat a card is seen to travel a nearly straight line from its owner's hand to
its place (checked for every seat of 2 to 6 players: at most 1.3 times the straight line, never doubling back), and
a card that is held still over the felt is drawn exactly where it is. Between reports the card closes on its place
smoothly (about two thirds of the way every 70 ms), so 18 reports a second, or fewer if some are late or lost, look
like one movement. When the snapshot says the hold is over, the card is released from wherever it has got to and
the ordinary animation takes it to its pile, or home if the move was refused. A player who disconnects mid-drag
loses the hold on the server, so the card goes home on everyone's screen. A run moves as one. Carrying a finished
pile to the tray is not reported: the pile is seen to go when it gets there.

Cards that move without having been seen on their way (a bot's, or after lost reports) cross the table in 0.2 to
0.45 seconds depending on the distance, see-through while in the air. With "reduce motion" on, other players' held
cards jump from report to report instead of gliding.

## Bots

Whoever deals can seat bots, so that one person has something to play against. In the lobby, and on the score sheet between
rounds, pick **slow**, **medium** or **fast** and press **Add bot**; **Remove Bot Ada** sends one away. A bot takes a seat
with its own back colour and a name ("Bot Ada", "Bot Bix", ...), is marked "bot" in the lobby list and beside its name on
the table, and counts as a connected player everywhere: for the two-player minimum, for the six seats, for the "everyone is
stuck" vote and for scoring. A bot never deals, cannot be added or removed during a round, and does not keep a table alive:
a lobby with only bots left is forgotten at once, and a table nobody is connected to expires as usual, bots or not.

**It plays fair.** The bot lives on the server but is a player like any other. All it ever sees is `viewFor(state, itsSeat)`,
the same redacted snapshot a person in that seat is sent, and all it can do is submit ordinary intents through the same
`Room` code path as a person's, in the same single order, with the same refusals. If a move is refused (somebody got there
first, or the table is not open for play) it forgets it and looks again later. There are no rules for bots in the engine.
The decision is one pure function, `chooseIntent(view, seat, memory, rng, observance)` in `server/bot.ts`; the room only
owns the timers, which stop when the round ends, when the bot is removed and when the table is deleted.

**One action per look, a look late.** At each look the bot first does what it noticed at its previous look, then
looks again: nothing it does is a reaction quicker than one pause, as with a person who has to see a card and then
move it. If the table moved on meanwhile and the move is refused, it simply looks again. What it notices at a look is
the first of these that applies:

1. Carry a centre pile it finished (it placed the King) to the tray: before everything, as the rules demand.
2. Its nertz pile is empty: call Nertz.
3. Nertz top to the middle (anything but an Ace to the exact pile). An Ace starts its pile anywhere there is room: of
   a handful of places it glances at all over the felt, the clear one nearest the middle, and if none of them is
   clear, wherever the engine says there is room. (At a table with the grid: any empty marked place.)
4. Nertz top to a work pile: one it builds down on, or an empty one if there is none.
5. Waste top, or the top of a work pile, to the middle.
6. A work pile's whole face-up run onto another pile, but only if that turns over a face-down card or empties the pile.
   It never moves a run that gains nothing, and never undoes its own last run move.
7. Waste top onto a work pile it builds down on (empty piles are kept for the nertz card).
8. Otherwise deal one card off the stock (or turn the waste over). Three looks make a group, and at each of them it may
   find something better to do with its other piles; the waste is out of play until the group is up, as for anyone. Once
   it has dealt all the way round to where it started without making a single move, it says "I'm stuck" (and keeps
   dealing, in case the middle changes). Any move starts the count again.

Note 3 before 4: given the choice, it puts its nertz card on a work pile rather than in the middle.

**Two numbers per level.**

| Level | Mean pause between looks | Observance |
| --- | --- | --- |
| slow | 3.2 s | 0.6 |
| medium | 2.2 s | 0.75 |
| fast | 1.4 s | 0.9 |

The pause is jittered between half and one and a half times the mean. After a card it dealt off the stock the next look
comes after half the usual pause (`DEAL_PACE`), so a group of three costs one and a half looks where a flip of three used
to cost one: 0.8 s, 0.5 s and 0.3 s a card on average at the three levels, about what dragging them takes. *Observance* is how human it is: on each look, every
move it could make is noticed, independently, with that probability, and it takes the first one in the list above that it
noticed. A move it missed gets a fresh chance at the next look, so it finds things late rather than never. Moves with its own
nertz card are noticed more reliably (probability `observance ^ 0.5`, which about halves the misses) and plays to the middle
from the waste or a work pile a little less (`observance ^ 1.25`). Clearing its finished pile, calling Nertz and dealing
from the stock are never missed. A bot never deals and never presses Start: it wakes when play opens, on the word, like everyone.

A bot does not drag: its card is placed in the instant it decides. So it never sends `hold`, and can never be in the
held-card grace window after a call. On screen its card is not teleported: every client glides it from its pile to
where it went (see [Seeing cards move](#seeing-cards-move)).

**It is a basic bot.** It does not plan, and it jams. In simulation, bots playing only each other finish nearly every deal
at four to a table, but three get stuck for good in about one deal in three and two in about two deals in three: each sits
on cards the others need, and reshuffling the stocks does not help. A person who plays well opens the middle for it.
If you and the bot are both truly stuck, see "A round nobody ends" under [Known limits](#known-limits).

## Sound and settings

**Sound.** Every card makes a noise: a flick as each card of the deal lands (for exactly the cards that leave your
deck: 7 or 10 to the work piles, then the 13 of the nertz pile), a faint slide on pick-up, a thunk on a work pile, one
soft flick for each card dealt off the stock (the group turning up makes no sound of its own), the same firm card sound
for every card played to the middle whatever its rank, a two-note chime for a King, a slide for a pile going to the
tray, a dull tap when a card goes back (put down nowhere, or beaten to its pile, or tried while a finished pile of
yours is waiting for the tray), a knock for each of "1, 2, 3" and a bright light hit on the opening "NERTZ!", one loud
hit when Nertz is called at the end, a tick each second of the grace window for whoever still holds a card, and a
riffle, flicks and a small flourish through the end-of-round sequence. Your own cards sound at full level, everyone
else's much quieter (a quarter, until you move the slider).

- The card noises are recordings from Kenney's CC0 "Casino Audio" pack, cut down to 13 short MP3s (66 kB in all); the
  tones are synthesised. Sources and licence: [`client/sounds/CREDITS.md`](client/sounds/CREDITS.md).
- `client/sound.ts` has one function per cue (Web Audio: each sound a one-shot with its own short envelope, into a master
  gain and a limiter, at most 18 at once). The audio context is made on the first click or key press, as browsers require.
- Which cue fires is decided by `client/soundEvents.ts`, a pure function that compares two successive *rendered* states by
  card id. So a move sounds once, when it is predicted, and not again when the server confirms it; a predicted move that is
  refused sounds as the card going home; and nothing is compared across a reconnect or reload, so nothing is replayed.

**Your settings** (the gear, bottom left on every screen): sound on or off, volume, other players' volume, reduce motion.
Reduce motion follows the system setting until you touch it, then overrules it either way. Kept in `localStorage`; without
storage they last until the page closes.

**Table rules** (lobby and score sheet): set by the host, read-only for everyone else, stored in the room and sent in every
snapshot (`RoomView.settings`). They change with `{ t: 'settings', patch }`, which the server takes only from whoever may
deal and only between rounds. `shared/settings.ts` holds the one object and its validation. Two options today, listed
together under "Table rules": "Crystallized Nertz" (`centre`: unticked is
`'free'`, the default, an Ace starts its pile wherever it is put down; ticked is `'spots'`, the marked places); and how
cards are dealt off the stock (`stockDeal`: `'drag'`, the default, or `'click'`; see the rules). The last is only a choice of gesture for the client. The next deal reads them,
and a round keeps what it was dealt under, because settings cannot change during a round.

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
player is sent a full snapshot in which face-down cards (all stocks, everything under the top of each nertz pile, the
face-down cards at the bottom of each work pile and the cards of a group half-dealt onto a waste, the owner's included) are reduced to `{ id, owner, hidden: true }`. The id stays the same when a card is revealed, so a card animates continuously from
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

**No fallback.** A move names its destination exactly: `{ k: 'work', i }` (one of your own piles), `{ k: 'slot', i }` (one
pile or marked place of the middle) or, for an Ace at a table without the grid, `{ k: 'felt', x, y }` (a point of the
table, to a thousandth of a unit). The engine judges that pile, or that point, and nothing else. Two players dropping on
the same pile, two Aces on the same empty place, or two Aces on overlapping patches of felt are simply two messages: the
first to arrive lands, the second is rejected and its sender's next snapshot no longer supports the predicted move, so
the card animates home. A pile started on the felt takes the first slot nobody is using; if another Ace got in first
the server may file it under a different slot than the client predicted, at the same place, which nobody can see.

**Holds and the grace window.** The server has to know who is mid-drag when Nertz is called, so drags are intents too:
`{ k: 'hold', cardId }` when a drag starts (accepted only for a card that seat could pick up), `{ k: 'release' }` when it
ends without a move. A move ends the hold by itself whether it is accepted or refused (`refused` in the engine: a drop that
lost a race still emptied the hand, and the client that sent it does not know yet that it lost), and so does losing the
connection. So the server never believes in a held card that went home. (A stock card being dragged to the waste is
not a hold: it is face-down and cannot be played, so nothing is sent until it lands, and then only `{ k: 'flip' }`.) `PlayerState.holding` is part of every view, and
the client's replay applies the same rule. All the rules of grace live in the pure engine:

- `nertz` sets `nertzCalledBy` and fills `GameState.grace` with the seats that are holding a card with at least one legal
  destination. Everyone else's hold is dropped and all their intents are rejected from then on.
- A seat in `grace` may send exactly one more intent: a `move` of its held card, or a `release`. Either removes it from
  `grace`, the move even when it is refused; any other seat whose held card now has nowhere to go is removed with it.
- `isOver(state)` is "Nertz was called and `grace` is empty". `expireGrace(state)` empties it.

The server owns only the clock: when a call leaves someone in grace it starts one 4-second timer, and on expiry applies
`expireGrace`. The room stays in phase `playing` until `isOver`, then scores and moves to `results`. Snapshots carry
`graceMs`, the milliseconds left when the snapshot was sent (a duration to count down locally, not a timestamp), or `null`.

**The opening is a small state machine, and it is the same for everyone.** `GameState.stage` goes `dealing` → `ready` →
`countdown` → `play`, one pure function per step (`finishDeal`, `startCountdown`, `openPlay`; each returns the same object
when it is not its turn). Only `play` accepts intents: before it `applyIntent` refuses every intent from every seat (the
sender's `ack` still advances), so a client predicts nothing either. `viewFor` redacts by stage: while `dealing` every
card, the face-up ones included, so no layout can be read early, not even off the network tab; in `ready` and `countdown`
the work tops are shown and every nertz top is still hidden, the owner's included. Ids never change, so the cards on
screen are the ones that turn over later. The server owns the two clocks and the button, exactly as for grace:

- one `DEAL_MS` (3 s) timer per round; when it fires, `finishDeal` and one flush. Snapshots carry `dealMs`.
- `ready` has no timer at all. `{ t: 'go' }` from whoever may deal (the host, or the acting dealer while the host is away,
  even if they are sitting the round out) applies `startCountdown`; from anyone else, or in any other stage, it is ignored.
- one `START_MS` timer (3 beats of `START_BEAT_MS`, 2.1 s); when it fires, `openPlay`, the bots are woken, and every
  player's view with the nertz tops goes out in the same flush. Snapshots carry `startMs`, a duration like `dealMs`, so a
  window that reloads mid-count shows the right number and nothing is replayed.

A table left in `ready` with nobody connected runs no timer and expires like any abandoned table. Both timers are stopped
when the room is forgotten. The
client animates from it and never decides anything: its input is off because the shared reducer says no, and a window that
arrives late (a reload or reconnect mid-deal) puts the cards already dealt in place and deals the rest on schedule
(`dealWait` in `client/layout.ts`). A card is dealt only when its element first appears during a deal, and only once, so
later snapshots, reconnects, the end of the round and coming back from the score sheet never replay it. Disconnecting during the deal changes nothing: the deal ends on time.

**Clear-first is a rule of the reducer.** `mustClear(state, seat)` is "some centre pile was completed by this seat and
Nertz has not been called". While it holds, `applyIntent` refuses every intent from that seat except `clear` (carrying a
pile to the tray is a single intent; it never used `hold`). The client's replay applies the same rule, so after a
predicted King nothing else is even sent; `client/clearFirst.tsx` only turns such a refusal into the nudge and the notice.

**The final table.** During `results` the snapshot still holds the finished round (`game`: piles and their places, tray, hands) next to
`lastRound` (who called, and per player the name, the cards played, the nertz cards left and the running total), so the
client can play the end-of-round sequence and draw the score sheet from it, even if a player has left since.

**One card per `flip`.** `{ k: 'flip' }` moves the top stock card onto the waste and counts it in `PlayerState.dealt`
(0 to 2: how many cards of an unfinished group lie face-down on top of the waste). The third card, or the last of the
stock, sets it back to 0: the group is up. `viewFor` redacts the top `dealt` waste cards for everyone, and `grab` refuses
the waste while it is above 0. On a client's redacted view the same reducer predicts each card; the faces arrive with
the snapshot that confirms the third, and the three cards (same ids) turn over where they lie. On an empty stock the same
intent turns the waste over, which can only happen with `dealt` at 0. Dragging and clicking send the same message.

**Tables.** `{ t: 'create', name, token }` opens a table and the server picks the code, which comes back in the first
snapshot. `{ t: 'join', room, name, token }` sits down at an existing table; a code that does not exist is answered with an
error and creates nothing. A connection that goes to another table from a lobby gives up its lobby seat, so one connection
never holds more than one table that has not started.

**Reconnects.** Identity is a random token in `sessionStorage`, sent only to the server. A new socket with a known token gets
its seat back and a fresh snapshot; sequence numbers and pending intents belong to a connection and start over. Until that
first snapshot arrives the client sends and predicts nothing: the table stays on screen as it was, and input is ignored.

**Hardening.** Every inbound message is parsed into a clean copy or dropped. Frames are capped at 2 KB, names at 20
characters, connections at 40 messages a second sustained with a burst of 120 (dealing a
card is one message; a whole lap of the stock in one instant is 33). A slow client that falls 1 MB behind is disconnected. A table
with nobody connected is deleted after 10 minutes, or after 1 minute if it never dealt a round; a lobby everyone has left
is deleted at once. There is a cap of 2000 tables and no limit per address: someone opening sockets in bulk could still
fill it for about a minute at a time.

## Chat and voice

A small **Chat** button sits in the top-left corner of the lobby, the table and the score sheet. It opens a panel with
text chat, voice controls and the host's two switches; **Hide** folds it back to the button, which shows a dot when there is
something unread. During a round the open panel is only as wide as the room beside your hand and the felt, and while you
hold a card it fades and lets the pointer through. Keys typed in the panel are never game hotkeys.

- **Text chat.** Enter sends. Plain text, at most 300 characters, shown with the sender's name in their seat colour. The
  server stamps the sender and an id, keeps the last 200 lines per table in memory and allows each player 5 messages per
  5 seconds (the excess is dropped). Chat is not part of the game snapshot: lines arrive as their own message
  (`{ t: 'chat' }`), and the kept history is sent once to every connection that sits down, reconnects included.
- **Voice chat.** Opt-in: the microphone is asked for only when you press **Join voice**. Then: **Mute**, **Leave voice**,
  a list of who is in voice and who is muted, and a ring around whoever is making sound. It is a WebRTC mesh, audio only:
  every pair of players in voice has one direct peer connection (15 for a full table of 6). Offers, answers and ICE
  candidates go through the game's websocket (`{ t: 'signal', to: seat }`); the server forwards them only between two
  players of the same table who have both joined voice, stamps the sender's seat, and never looks inside. The player in
  the lower seat makes the offer. Leaving voice, leaving the table, losing the connection or the host switching voice off
  closes the connections and releases the microphone; after a dropped websocket the client rejoins by itself, after a
  page reload you press Join again.
- **No relay (STUN only).** Peers find each other with a public STUN server (`stun:stun.l.google.com:19302`). That works
  when at least one of the two can be reached directly, as on most home networks. Two players who are both behind strict
  NATs or firewalls (some company, campus and mobile networks) will not hear each other: that needs a TURN relay, which
  costs bandwidth and is not set up. The place for it is the one `ICE_SERVERS` constant in `client/voice.ts`.
- **Host switches.** "Text chat" and "Voice chat", both on by default, are in the chat panel on every screen. Only the
  host (whoever may deal) can flip them, at any time; everyone else sees them greyed out. Text off: the server refuses new
  messages and the input is disabled, but the history stays readable and is still there when it is switched back on.
  Voice off: everyone is disconnected from voice at once and the Join button is hidden; switching it back on lets people
  join again, nobody is put back automatically.

Voice has been checked in headless Chromium with fake microphones only (connection state and audio packet counters, not
by ear), and not in Safari or Firefox or across real networks.

## Project layout

```
shared/   rules engine and wire protocol. Pure TypeScript, no IO, RNG injected. Used by server and client.
  types.ts      Card, GameState, Intent, RoomView
  table.ts      the felt everyone shares: its shape, the size of a card, which piles clash and which lie on it, the marked places
  engine.ts     deal, finishDeal, startCountdown, openPlay, applyIntent, mustClear, refused, legalDrops, feltFree, expireGrace, isOver, resolveStuck, viewFor, scoreRound, checkInvariants
  protocol.ts   message types (the `drag` report among them), limits, parsing and validation
  settings.ts   table settings (house rules): the object, its defaults, validation
  chat.ts       chat and voice messages, their limits and validation
server/   Node http + ws
  room.ts       one table: seats, host, rounds, intent handling, the deal, start and grace timers, bot timers, the relay of card positions, snapshots. No IO.
  bot.ts        the bot's whole brain: chooseIntent, a pure function from its redacted view to one intent
  chat.ts       one table's chat history, rate limit, host switches, voice presence and signalling relay. No IO.
  index.ts      http server, websocket upgrade on /ws, room registry, static files from dist/, /healthz
client/   Vite + React
  net.ts        websocket store and prediction
  layout.ts     pure geometry: where the felt, every hand, card, pile, tray pile, drop area and the countdown goes for a given window size; where another player's held card is drawn; the deal's schedule
  Table.tsx     the table: the deal, drag and drop, other players' cards in the air, the Nertz call, the grace countdown, the steps of the end-of-round sequence
  Opening.tsx   the dealer's Start button, "Waiting for ...", and "1, 2, 3, NERTZ!" in the middle of the table
  clearFirst.tsx  the nudge and the notice when you try something else while your finished pile waits for the tray
  Finale.tsx    the end of a round: the wash on the felt and each player's pile gathered in front of their seat (a canvas), and where the labels go
  App.tsx       home, lobby and score sheet
  Settings.tsx  the mute button and gear (your settings), and the table rules on the lobby and score sheets
  prefs.ts      your settings: sound levels, reduced motion; localStorage
  sound.ts      Web Audio: one function per cue, and the hook that plays them
  soundEvents.ts  pure: which cues a change of the rendered table calls for
  sounds/       13 short card recordings (CC0, see sounds/CREDITS.md)
  Chat.tsx      the chat panel: text, voice controls, host switches
  social.ts     chat lines, switches and voice presence as the server reports them
  voice.ts      microphone, WebRTC mesh, speaking meter
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
- **Only the dealer can start.** Once the cards are dealt the table waits for the dealer's Start with no time limit. If
  the dealer is connected but not looking, everyone waits; the role passes on only when their connection drops.
- **No Leave button during a round**, only in the lobby and on the results sheet. Closing the tab holds the seat.
- **Fonts come from Google Fonts** at runtime. Offline they fall back to system fonts; everything still works.
- **Small screens.** Laid out for desktop windows from 1280 x 720 up, and checked for 2 to 6 players at 1280 x 720,
  1440 x 900 and 1920 x 1080. Narrower than that your hand reaches the settings corner. There is no phone layout yet,
  and touch input has not been tested on a real device.
- **The middle is not turned to your chair.** Every pile is at the same place of the felt for everyone, so a pile
  that is right in front of you is at the far side from the player drawn opposite you, although on their own screen
  it is right in front of them too. It is what makes "is there room here" the same question on every screen.
- **Another player's Ace is not drawn where it is until it lingers.** A card with a pile to go to is seen travelling
  there. An Ace may be going anywhere on the felt, and where it is on its owner's screen on the way (coming up from
  the bottom of theirs) says little about that; so it is drawn lifted out of their hand, and comes over to its true
  place when they hold it still over the felt for a moment, or flies there when it lands. A card moved quickly is
  mostly seen as that last flight.
- **The felt has one shape per table size** (2.8 times as wide as high up to three players, 2.2 times from four
  on), the same for every window: a window much taller or wider than 16:9 leaves some of its room unused, and a
  window narrower than 1280 px leaves the felt little between the side hands.
- **Two players with the grid have smaller cards than on the old round table** (57 px at 1280 x 720, from 65): both kinds of table
  now share one card size, chosen so that eight piles put down anywhere still fit.
- **A table can fill up before every Ace is out** if piles are put down wastefully enough: at random they all fit
  at least 99 times in 100, but it is not impossible to shut the last Ace out. It then waits until a pile is
  finished and cleared.
- **Very long work piles.** There is little room between your hand and the felt, so a long pile is squeezed
  rather than rising: at 1280 x 720 a pile of two face-down and ten face-up cards shows its newest five or six cards
  with the whole rank, and the oldest as slivers about 11 px tall, which are hard to read and to grab.
- **The open chat panel** lies over a neighbour seated at the left edge. Hide it to see them.
- **The labels at the end of the round are tight with five or six players at 1280 x 720.** Six piles and six labels
  (176 px wide each) share the felt with the wash, so one or two labels sit above or below their pile, or half a
  label higher or lower beside it, instead of level with it; each has its player's colour chip. Label placement is
  checked for 2 to 6 players at 1280 x 720 and 1440 x 900; in a smaller window labels may overlap something. The
  NERTZ! stamp across your own hand is large and stays up through the sequence.
- **Face-down cards of a half-dealt group** at the call stay face-down on the waste through the end of the round.
- **In drag mode nothing on the table says the stock must be dragged**: a click on a stock that still has cards does
  nothing. The rule is in the table rules and in this file.
- **The wash is a canvas.** At the end of a round up to ~300 card backs move at once, so they are drawn on one canvas
  rather than as elements. Measured in Chromium with 6 players and 222 cards in the middle: a steady 60 frames a second at
  1x and 2x pixel density with a GPU, and at 1x without one. Without a GPU at 2x it misses frames, notices (five late
  frames), and draws the moving cards at 1x until they come to rest.
- **The deal** is drawn from where each stock lies, and only the cards that leave it move (23 per player, 20 under the
  small-table rule); the rest stay: they are the stock. Resizing the window during the deal moves each deck, and the cards already out, to the new layout
  and the deal carries on. In a background tab the browser slows timers, so cards can leave the deck late there. The
  turn-over arrives with the snapshot that ends the deal, so on a slow connection it is late by that connection's
  latency.
- **A round nobody ends.** If every card is played and nobody presses NERTZ!, the round just sits there. The call is
  deliberate by design. (A table that is jammed for good ends by itself once everyone says they are stuck.)
- **After a server restart** a reconnecting window is told its table no longer exists and is put back on the home page with
  the code filled in; somebody has to start a new table.
- **Bundle size** is about 460 kB (160 kB gzipped), a third of it the animation library, plus 39 kB of sound files
  (the smallest recordings are inlined in the script).
- **Sound needs a first click or key press**, like all audio in a browser, and the recordings load at that moment. If the
  very first thing you do is something audible, it may be silent.
- **In a very small window** (roughly under 700 px wide or 520 px high) the mute button and gear, bottom left, can sit
  over the line of text under your nertz pile.
- **Chat in a small window.** With the panel open during a round in a window under about 1250 px wide, it lies over the
  captions under your nertz pile and, narrower still, over the pile's edge. Hide it to play.
- **No spectators, no persistence.** Restarting the server ends every game and forgets the chat.

## Feedback

The bug button posts to `/feedback` (server/feedback.ts). A report goes wherever the server was told, to both if both are set:

- `FEEDBACK_WEBHOOK`: a Discord webhook URL (channel settings, Integrations, Webhooks: no bot needed). The report is
  posted there with the screenshot attached. On Fly: `fly secrets set FEEDBACK_WEBHOOK=...`.
- `FEEDBACK_DIR`: a directory. Each report is a line in `feedback.jsonl` there, the screenshot a file beside it. Outside
  production it defaults to `./feedback` (git-ignored); in production it is off unless set, since a machine's own disk
  does not survive a deploy: point it at a mounted volume if a copy is wanted.

- `LINEAR_API_KEY` and `LINEAR_TEAM`: a Linear personal API key and the key of a team (the letters before an issue's
  number, like `NRZ`). An issue is filed there, titled `[FEEDBACK] ...` and labelled Bug or Feature (the label is made
  if the team has none of that name), with the screenshot in its description.
  Optional: `LINEAR_PRIORITY`, `LINEAR_ASSIGNEE`, `LINEAR_STATE` and `LINEAR_PROJECT` say how the issue is filed.

Nothing names a particular server or workspace in the code: `.env.example` lists every name, with what to put there.

Five reports per address per ten minutes; a screenshot is scaled down in the browser first.
