# Nertz

Real-time multiplayer [Nertz](https://en.wikipedia.org/wiki/Nertz) for 2 to 6 friends in the browser. Everybody plays their own
solitaire at the same time and races to play onto shared piles in the middle. One person starts a table, sends the link, and
everyone else joins from it. No accounts, no database: one small Node process holds every table in memory.

Deployed to Fly.io from this repo on every push to `staging` and to `main`: see [Hosting](#hosting).

## Run the two-window demo

Needs Node 22 or newer (developed on Node 24).

```sh
npm install
npm run dev
```

Then open **http://localhost:5173** in two browser windows (two tabs of the same browser are fine):

1. Window 1: type a name, press **New Table**. The server picks the table code; you land in the lobby with an
   invite link like `http://localhost:5173/?room=ABCD`.
2. Window 2: paste the invite link (or open the home page and type the code, or pick the table under **Tables**), type a different name, press **Join table**.
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
| ...or tap or click it, then the pile (if the table moves without dragging) | the same, without carrying it |
| Let an Ace go anywhere on the felt in the middle where there is room for the card | start a centre pile right there |
| Drag a finished pile (one you put the King on) to the tray, bottom right (or tap or click it, then the tray, if the table moves without dragging) | clear it and free its place. Until you have, you can do nothing else |
| **Start**, or Space or Enter (the dealer, once the cards are dealt) | count "1, 2, 3, NERTZ!" and open play |
| Click the empty stock | turn the waste back over into the stock |
| Click the stock, or press Space | deal a group of three: they come off one at a time, a quarter of a second apart, and turn up together |
| **I'm stuck** | vote to reshuffle (see rules) |
| **NERTZ!** (appears in your nertz pile's place once it is empty) | end the round |
| The menu (☰) bottom left | **Mute**; during a round what can be done to the table: **Pause** (or P; then **Unpause**: anyone in the round, or whoever deals), **End round** (the vote, with its tally), **Stand up** (for now: see table management), **Restart round** (whoever deals: the round is dealt over from the start, nothing of it scored) and **Leave table**, the last two asking again before they do it; **Settings** (volume, and under it your cards, other players' cards and voice chat each on their own; reduce motion); and **Feedback** (a bug or an idea: a few words and, if you like, a screenshot) |
| Press M (or the key you set under Hotkeys in the settings) | mute or unmute. While the sound is off a small amber speaker sits at the end of the chat bar, top left: press it to turn the sound back on |

There is no auto-play and no "throw it at the middle": a card lands only where it is released, and only if it fits there.
Nothing shows where a card in hand may go: no pile is outlined for it. (A finger that lets go a little off a pile still
lands on it. Under a finger the card rises clear of the fingertip as it is carried off, and on a phone comes to one size
on the way, upright or on its side, whatever size the hand's cards are.) What counts is
where the pointer is when you let go; only if the pointer is over no pile at all does the centre of the card you grabbed
decide. Each pile's drop area is the pile plus a small margin (a whole column, for a work pile), neighbouring areas never
touch, and a card let go between two piles goes back where it came from.

At a table that moves without dragging (the table rule "Move without dragging", on by default) a tap or a click also
takes a card up without carrying it: it stands lifted where it was, and the next tap or click puts it down, on the pile
it points at (or, for an Ace, that spot of the felt). A pile you finished is taken up the same way, and the next tap or
click on the tray clears it. Anywhere else, or Escape, puts it back and does nothing more: a click on the stock with a
card taken up does not deal. A mouse does exactly what a finger does. A card moved so is never seen crossing the table. With the rule off, every card is dragged, on a touch
screen too.

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
- **A pile you finished** (you placed its King) glows and gives a small nod; other people's finished piles are dimmed and
  ticked. Carrying it to the tray is the next thing you have to do: if you press a card, the stock, Space, "I'm stuck" or
  NERTZ! first, or try to deal from the stock or to start a pile on the felt, nothing moves, the pile shakes, the tray
  flashes and there is a soft tap. From then on the pile says "Drag to tray"; left alone, it says so after four seconds.
  Your cards do not look grabbable meanwhile.
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
npm test          # vitest: rules engine, protocol, room, real-socket server tests (a hostile hand-written client among them), client prediction, the pointer (press, carry, tap)
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
  specific pile it extends, up by suit to the King, one card at a time. An Ace starts a pile at the very point of the
  felt where it is let go (see [The table](#the-table)). The whole card must lie on the felt, and clear of every other
  pile by a small gap (0.14 of a card's width): exactly what you see, and the same on everyone's screen. While you
  carry the Ace over the felt it is the size of a pile in the middle, with an outline on it that says whether there is
  room (a gold ring and a tick) or not (a broken red ring, struck through, and a cross), and every pile shows the room
  it keeps round itself. Let go where there is no room and the Ace goes back. Two Aces for the same patch of felt: the
  first lands, the second goes back. The table still holds at most 4 piles per player.
- **Precise placement.** A card lands only when released on the one pile where it legally fits. If someone got there first
  (the pile moved on, or the felt was taken), the card returns to where it came from. Nothing is ever rerouted.
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
  gains nothing.
- **Stuck**: each player can toggle "I'm stuck". When every connected player who plays the round is stuck (not anyone
  who has got up from their cards: see table management), the server (which knows every card) checks whether any hand
  still played, here or away, can ever get anywhere (`canProgress`): put a card in the middle, or take one off its nertz
  pile, now or however many moves on (stock cards onto work piles, runs between them, face-down cards turned up; any
  card of the stock counts: shifting it brings any card up). A move that leads to neither does not count. It errs one
  way only: a hand that can get somewhere is never taken for dead. If nobody can, **the table is jammed** and the round ends there,
  scored as it stands. Otherwise each player's waste (a half-dealt group included) goes back onto their stock, the top
  stock card moves to the bottom (so the threes come out differently: three votes in a row show every card), and all
  flags clear, and the round counts one more reshuffle. Making any move clears your own flag.
- **Voting to end a round**: in the menu (☰), while a round is on, anyone can vote to end it where it stands. When
  every connected person who plays the round has voted (bots go along), it ends and is scored as usual. A vote can be
  taken back. Once a round has been reshuffled three times, or once anyone has voted, the same vote stands on the
  table too: **End round**, beside "I'm stuck".
- **Ending a round**: once your nertz pile is empty you may press **NERTZ!**. It is a deliberate action, so you can keep
  playing cards to the middle first if you think it pays. Everyone is frozen at once, with one exception:
- **Held-card grace.** A player who was in the middle of dragging a card at the moment of the call, and whose card has at
  least one legal place to go, gets up to 4 seconds to release it on a legal spot: exactly one move, with that card only.
  If the card has nowhere to go, or loses its last spot to another player's grace move, the drag is cancelled. Letting go
  anywhere is that one move: if the spot was taken a moment earlier, the card goes back and that player is done. The round
  is over as soon as every such player has let go, or after 4 seconds. Grace moves count. A stock card on its way to
  the waste is not such a card: it goes back, and a group left half-dealt at the call stays as it lies, face-down.
  "The moment of the call" is when it reaches your screen, not the server: a card you take up while the call is on its
  way to you (or whose taking up is on its way to the server as the call is made) was in your hand at the call. So the
  round waits for each player's window to say it has the call, a round trip, at most 1 second (`HEAR_MS`); a window that
  has not said by then (asleep in the background, say) is taken to have.
- **Scoring**, strictly: +1 for each of your cards in the middle (piles and tray), −2 for each card left in your nertz pile.
  No bonus for going out. Scores add up over rounds.
- **Table management**: the person who opened the table deals. If they are not connected, the first connected player may deal
  instead; the role returns when they are back. A round is dealt only to players who are connected at that moment. Someone
  who was away keeps their seat and score, watches if they return mid-round, and is dealt in next round. Whoever comes to a table
  sits down at it if a seat is free and no round is being played, as whoever opens it does; otherwise they come in to
  watch, and have a seat by asking for one ("Take a seat"). A
  seat asked for is given at once if one is free and no round is being played, and otherwise by the queue, first asked
  first, when the round is over or a seat comes free; whoever asked can think again and just watch, and anyone at the
  table can stand up between rounds. In a round under way, **Stand up** in the menu stands you up for now: you are
  shown as away, your cards lie as they are, and the votes (stuck, end round) go on without you; you sit back down by
  pressing **Sit back down** (in the menu, or where "I'm stuck" was) or by playing a card, and if you have not by the
  time the round is over you are watching from then on. (Until the dealer has said Start nothing has been played: whoever sits down or
  comes back by then is dealt in, the round being dealt over.) The score sheet says of how many rounds a total is the
  sum, where that is fewer than the table has played. Someone who presses Leave is gone from the table, and their seat is
  free: at once, or if their cards are in a round, when it is over; their line of the last score sheet stays.
- **Standing someone up, sending someone away.** Whoever deals can do either to anyone else at any time, a round in
  play included: pressing a name at the table (or the eye and the × beside it on the lobby and the score sheet). Standing
  up gives the seat up to watch; sending away puts them out of the table altogether, and back by the same window they
  are someone new. Between rounds either happens at once. In a round, it is the same for its cards whichever it is (and
  the same as pressing Leave): their cards lie where they are, marked "left", and are scored as they lie; they play no
  more of it and no longer count in "I'm stuck", the vote to end the round, or whether the table is jammed, so those
  who remain can carry on, unstick or end it without them. The seat is held for those cards until the round is over.
  Then whoever was stood up is watching (and can take a seat again), and whoever was sent away is off the list and off
  the score sheet; whoever left is off the list, their line staying.
- **Who is who.** Everyone in a room has an `id`, which is theirs for as long as the table stands and never anyone
  else's: everything about a person goes by it (who you are, who said what, who is in voice, whose line of the score
  sheet). What is about cards goes by seat. Where someone is, is exactly one of three things: at the table (a seat), in
  the queue for one, or just watching; apart from that they are here or away. A window comes back as who it was by its
  token, kept for as long as the window lives; a name proves nothing, and nobody takes a seat by typing one.

## The table

**Table space.** The middle of the table is defined once, in `shared/table.ts`, for everybody: one felt, a wide
rectangle with rounded corners, 2 units high and 5.6 wide with up to three players, 4.4 wide from four on (`feltHw`:
there are hands at its sides then, and a squarer felt can be taller on the screen), corner radius 0.62, centre (0, 0), y down the screen, one
unit the same distance both ways. A centre pile is a point of it (the middle of its cards), kept in the game state
on the pile itself (each pile in `GameState.slots` is its `cards` and where it lies, `at`: in every snapshot). Nothing in the state says where anything is on a screen.

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

**Hands.** Your own hand is laid out as it always was. Everyone else's is a compact row where they sit as you see
it, in seat order clockwise from your left: along the top edge for seats across from you, at the left or right edge (turned to face the felt)
for your neighbours (turned a quarter turn to face the felt, running down the edge), lower down the nearer they sit to you. A hand across the table is drawn the other way round
(its owner's left is your right, as at a real table), a neighbour's the same way round as yours. The top corners are
kept free for the chat button and the grace countdown, the bottom corners for the settings and the tray.

**Card sizes** (width in pixels of a centre card, and of an opponent's card):

| Window | 2 players | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- |
| 1280 x 720 | 65, 45 | 67, 40 | 59, 33 | 55, 29 | 51, 25 |
| 1440 x 900 | 85, 56 | 88, 50 | 78, 41 | 72, 36 | 67, 32 |
| 1920 x 1080 | 105, 67 | 108, 60 | 96, 50 | 88, 43 | 83, 38 |
| 2560 x 1440 | 148, 89 | 153, 81 | 135, 66 | 124, 58 | 116, 50 |

Your own cards are 0.108 of the window's height wide (with room for 0.85 of a card below the row: a work pile of more
than about eight cards squeezes its older cards to slivers), up to 150 px; an opponent's up to 96 px; a centre card up to 1.2
times your own. `npx tsx scripts/sizes.ts` prints this table.

(While the felt was a round table turned to each chair these were, at 1280 x 720, 49/37/36/25/28.)

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

The lobby sheet is one size however many sit down: its list of names has a line for each of the ten seats a table can
have (`MAX_PLAYERS`), filled in order of arrival. A seat the table has but nobody has taken is the dashed outline of a
card; past the table's seats the lines are bare. Your card back and colour stand beside the table rules under the list.
So adding bot after bot, or changing the number of seats, moves nothing under the pointer.

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
   clear, wherever the engine says there is room.
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
else's quieter by default (Others at 40%, and under a lower ceiling than yours).

- The card noises are recordings from Kenney's CC0 "Casino Audio" pack, cut down to 13 short MP3s (66 kB in all); the
  tones are synthesised. Sources and licence: [`client/sounds/CREDITS.md`](client/sounds/CREDITS.md).
- `client/sound.ts` has one function per cue (Web Audio: each sound a one-shot with its own short envelope, into a gain for
  its channel, yours or other players' cards, and from both into one limiter, at most 18 at once). The audio context is
  made on the first click or key press, as browsers require.
- Which cue fires is decided by `client/soundEvents.ts`, a pure function that compares two successive *rendered* states by
  card id. So a move sounds once, when it is predicted, and not again when the server confirms it; a predicted move that is
  refused sounds as the card going home; and nothing is compared across a reconnect or reload, so nothing is replayed.

**Your settings** (from the menu, bottom left on every screen, and the gear on the score sheet, which opens the same
slip): sound on or off, the levels, reduce motion. Whoever hosts has the table's own settings at the bottom of theirs:
text and voice chat, and between rounds the table rules. Nobody else sees them there.
Volume is for everything; under it **Yours** (your cards and the table's own sounds: the count, the call of Nertz, a
bot's spoken "Nertz"), **Others** (other players' cards) and **Voice** (voice chat) each show their level, and a press
opens that one's slider. Mute is for the game's sounds: it leaves voice chat as it is.
Reduce motion follows the system setting until you touch it, then overrules it either way. Kept in `localStorage`; without
storage they last until the page closes.

**Table rules** (on the lobby sheet for everyone, read-only but for the host; and at the bottom of the host's settings between rounds): set by the host, stored in the room and sent in
every snapshot (`RoomView.settings`). They change with `{ t: 'settings', patch }`, which the server takes only from
whoever may deal and only between rounds, so a round keeps the rules it was dealt under. An option the server does not
know is dropped (an older client asking for one changes nothing). `shared/settings.ts` holds the one object and its
validation. One option today, only a choice of gesture for the client: "Move without dragging" (`tapToMove`, on by
default: a tap or a click takes a card up and the next puts it down, on every screen alike; off, every card is
dragged), listed under "Table rules". The server cannot hold anyone to `tapToMove`: a card taken up by a tap and one
picked up to be dragged are the same `hold` and `move`.

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
pile of the middle) or, for an Ace, `{ k: 'felt', x, y }` (a point of the table, to a thousandth of a unit). The engine
judges that pile, or that point, and nothing else. Two players dropping on the same pile, or two Aces on overlapping
patches of felt, are simply two messages: the
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

- `nertz` takes the round's status to `grace` (with who called, and `unheard`: below), and the hold of everyone whose
  card has no legal destination is dropped. Who is in grace is not kept anywhere: it is exactly the seats still holding
  a card (`inGrace`). All of everyone else's intents are rejected from then on.
- A seat in grace may send exactly one more intent: a `move` of its held card, or a `release`. Either empties its hand
  and so takes it out of grace, the move even when it is refused; any other seat whose held card now has nowhere to go
  is taken out with it.
- The call reaches each window a moment after it is made, and a hold may be on its way to the server meanwhile. So the
  status also lists the seats whose windows have not yet said they have the call (`unheard`, `yetToHear`): who they are
  is the room's to say (it writes them into every `nertz` it applies: everyone else playing the round from a window of
  their own, not a bot nor anyone away or standing). Until a seat sends `{ k: 'heard' }` it may still `hold`, as it
  could a moment before, and that card puts it in grace like any other. The window sends `heard` the moment a snapshot
  shows it the call (client/net.ts), on the same socket as its intents: so a hold sent before it had the call comes
  before, and one after, after. Without `unheard` (the engine's own tests, a client predicting its own call) everyone
  hears it at once.
- When nobody is left in grace and nobody is left to hear the call, the status is `over`, by that Nertz.
  `expireGrace(state)` takes it there at once.

The server owns only the clock. The room keeps one round timer for whichever timed status is current (`dealing`,
`countdown` or `grace`); grace is timed on the call itself, the change into `grace` in the room's `intent`, for 4 seconds,
and on expiry the room applies `expireGrace`. Within it the room waits at most `HEAR_MS` (1 second, `hearMs` of the
room; 0 in the room's own tests, where the call reaches everyone at once) for the windows to hear it, then applies
`heard` for each that has not; a window that goes away is not waited for. The room stays in phase `playing` until `isOver`, then scores and moves to
`results`. Snapshots carry one `timerMs`, the milliseconds left of the timed status when the snapshot was sent (a
duration to count down locally, not a timestamp), or `null`; `game.status` names the stage it belongs to.

**One status.** How far a round has got is one field, `GameState.status`: `dealing`, `ready`, `countdown`, `play`,
`grace` (who called) or `over` (how it ended: a Nertz by a seat, a jam, or a vote). The reducer switches on it once, and
every round ends through the same step, which empties every hand. What others ask of it has one name each in the
engine: `isLive` (the room, the bots, pause, the vote to end the round, the table), `hasOpened` (the nertz tops are
shown), `isOver`, `calledBy`, `inGrace`. The round's result (`RoundResult.end`) is the very value the status ended on.

**The opening is a small state machine, and it is the same for everyone.** `GameState.status` goes `dealing` → `ready` →
`countdown` → `play`, one pure function per step (`finishDeal`, `startCountdown`, `openPlay`; each returns the same object
when it is not its turn). Only `play` accepts intents: before it `applyIntent` refuses every intent from every seat (the
sender's `ack` still advances), so a client predicts nothing either. `viewFor` redacts by stage: while `dealing` every
card, the face-up ones included, so no layout can be read early, not even off the network tab; in `ready` and `countdown`
the work tops are shown and every nertz top is still hidden, the owner's included. Ids never change, so the cards on
screen are the ones that turn over later. The server owns the clock and the button, exactly as for grace, with the same one round timer:

- `dealing` is timed for `DEAL_MS` (3 s); when it runs out, `finishDeal` and one flush. Snapshots carry `timerMs`.
- `ready` has no timer at all. `{ t: 'go' }` from whoever may deal (the host, or the acting dealer while the host is away,
  even if they are sitting the round out) applies `startCountdown`; from anyone else, or in any other stage, it is ignored.
- `countdown` is timed for `START_MS` (3 beats of `START_BEAT_MS`, 2.1 s); when it runs out, `openPlay`, the bots are
  woken, and every player's view with the nertz tops goes out in the same flush. Snapshots carry the same `timerMs`, so a
  window that reloads mid-count shows the right number and nothing is replayed.

A table left in `ready` with nobody connected runs no timer and expires like any abandoned table. The round timer is
stopped when the room is forgotten. The
client animates from it and never decides anything: its input is off because the shared reducer says no, and a window that
arrives late (a reload or reconnect mid-deal) puts the cards already dealt in place and deals the rest on schedule
(`dealWait` in `client/layout.ts`). A card is dealt only when its element first appears during a deal, and only once, so
later snapshots, reconnects, the end of the round and coming back from the score sheet never replay it. Disconnecting during the deal changes nothing: the deal ends on time.

**Clear-first is a rule of the reducer.** `mustClear(state, seat)` is "some centre pile was completed by this seat and
the round is live". While it holds, `applyIntent` refuses every intent from that seat except `clear` (carrying a
pile to the tray is a single intent; it never used `hold`). The client's replay applies the same rule, so after a
predicted King nothing else is even sent; `client/clearFirst.tsx` only turns such a refusal into the shake and the words on the pile.

**The final table.** During `results` the snapshot still holds the finished round (`game`: piles and their places, tray, hands) next to
`lastRound` (how it ended, and per player the name, the cards played, the nertz cards left and the running total), so the
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
  table.ts      the felt everyone shares: its shape, the size of a card, which piles clash and which lie on it, where a new pile may go
  engine.ts     deal, finishDeal, startCountdown, openPlay, applyIntent, mustClear, refused, snipedBy, legalDrops, feltFree, expireGrace, isLive, hasOpened, isOver, calledBy, inGrace, yetToHear, resolveStuck, viewFor, scoreRound, checkInvariants
  protocol.ts   message types (the `drag` report among them), limits, parsing and validation
  settings.ts   table settings (house rules): the object, its defaults, validation
  chat.ts       chat and voice messages, their limits and validation
server/   Node http + ws
  room.ts       one table: seats, host, rounds, intent handling, the deal, start and grace timers, bot timers, the relay of card positions, snapshots. No IO.
  bot.ts        the bot's whole brain: chooseIntent, a pure function from its redacted view to one intent
  chat.ts       one table's chat history, rate limit, host switches, voice presence and signalling relay. No IO.
  index.ts      http server, websocket upgrade on /ws, room registry, static files from dist/, /healthz, /tables (the home page's list), /api/auth, /profile, /stats
  db.ts         what outlives the process: the one SQLite file, and the tables of ours in it
  accounts.ts   signing in with Google or a code by email (Better Auth): the only file that knows how
  profile.ts    /profile: one's own name to go by, and one's account deleted
  rounds.ts     every round played to its end, kept; and one person's record of them
  reports.ts    what players send with the bug button, kept
  guard.ts      what every message, timer, snapshot and socket close runs inside: a throw is logged, and every other table carries on
client/   Vite + React
  net.ts        websocket store and prediction
  layout.ts     pure geometry: where the felt, every hand, card, pile, tray pile, drop area and the countdown goes for a given window size; where another player's held card is drawn; the deal's schedule
  Table.tsx     the table: the deal, the card in your hand (it listens to the pointer and carries out what hand.ts decides), other players' cards in the air, the Nertz call, the grace countdown, the steps of the end-of-round sequence
  level.ts      pure: a card's stacking level, from the level the layout gives it and what it is doing (in its pile, travelling, turning over, in the deck, in a hand)
  hand.ts       pure: the card or finished pile in your hand (pressed, carried or tapped), and what a press, a move, a release or a tap does
  Opening.tsx   the dealer's Start button, "Waiting for ...", and "1, 2, 3, NERTZ!" in the middle of the table
  clearFirst.tsx  what your finished pile does while it waits for the tray: a nod, a shake when you try something else, and then its words
  Finale.tsx    the end of a round: the wash on the felt and each player's pile gathered in front of their seat (a canvas), and where the labels go
  App.tsx       home, lobby and score sheet
  Settings.tsx  the corner (the menu button, and your settings it leads to, the host's table settings at their foot), the table rules on the lobby sheet, and the small icon buttons the sheets share
  actions.ts    what can be done to the table during a round (pause, the vote to end it, deal again, leave): the one rule for each of whether it is open to you
  Menu.tsx      the menu: mute, those actions, and the way to settings and feedback
  prefs.ts      your settings: sound levels, reduced motion; localStorage
  tip.ts        the game's own tooltip, in place of the browser's `title`: one for the page, beside any element with a `data-tip`, on mouse hover or keyboard focus (never on touch), kept on screen and out of the way of clicks
  sound.ts      Web Audio: one function per cue, and the hook that plays them
  soundEvents.ts  pure: which cues a change of the rendered table calls for
  sounds/       13 short card recordings (CC0, see sounds/CREDITS.md)
  Chat.tsx      the chat panel: text, voice controls, host switches
  social.ts     chat lines, switches and voice presence as the server reports them
  voice.ts      microphone, WebRTC mesh, speaking meter
  cards/        card faces drawn as SVG in code (original art, see cards/CREDITS.md)
  styles/       the stylesheet, one file per screen or part (index.css imports them in cascade order)
```

Dependencies at runtime: `ws`, `react`, `react-dom`, `motion` (card animation) and `tsx` (runs the TypeScript server
directly, so there is no server build step).

## Hosting

**What the game needs.** One long-lived process that holds websockets open and keeps every table in memory. All players of a
table must reach the *same* process, because that process's event loop is what orders their moves. Load is tiny: a snapshot
is a few kilobytes and a busy table is a few messages a second.

### What runs: one Fly.io machine per app

- Two apps, each one `shared-cpu-1x` machine serving the built client and the websocket from the same origin: `nertz` and
  `nertz-staging`. The `Dockerfile` and `fly.toml` are their whole configuration: port 8080, health check on `/healthz`,
  connection-based concurrency.
- `.github/workflows/deploy.yml` deploys them: a push to `staging` runs the checks and deploys staging; a push to `main`
  runs the checks and then waits until `/healthz` says nobody is connected before it deploys. Exactly one machine each
  (`--ha=false`): two would split tables across processes.
- An idle machine is suspended, memory kept (`auto_stop_machines = "suspend"`), and resumed on the next request. Fly only
  suspends a machine with no open connections, and every player at a table holds a websocket, so a game in progress keeps
  it up.
- **What a deploy or restart does to live games:** the process is replaced, so every table and score is gone. Clients notice
  the dropped socket, reconnect with backoff and try to rejoin their table code, which no longer exists, so they are told
  there is no such table and someone has to start a new one. Hence `main` deploys only when nobody is connected. If that
  ever stops being enough, the fix is to write each room's state to a volume or Redis on change and reload it on boot;
  `GameState` is plain JSON, so that is a small change.
- Outgrowing one machine (unlikely) means routing by table code, for example with Fly's `fly-replay` header, so that a table
  always lands on the machine that owns it.

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

- **Someone who never comes back** keeps their seat until they press Leave, whoever deals stands them up or sends them
  away, or the table expires. They are not dealt cards while away, but they count towards the six seats. Only whoever
  deals can do that: if that is the one who is not looking (connected, but gone), nobody can.
- **Every table is on the home page.** **Tables** lists, to anyone, each table someone is at just now (the twenty where
  something happened last): its code, the names at it, and its round. There is no private table.
- **An abandoned lobby lasts a minute.** If you open a table and everyone's connection drops for more than a minute before
  the first deal, the table is gone and the invite link reports no such table.
- **Only the dealer can start.** Once the cards are dealt the table waits for the dealer's Start with no time limit. If
  the dealer is connected but not looking, everyone waits; the role passes on only when their connection drops.
- **Leaving during a round** is in the menu (☰), and asks twice: whoever leaves does not come back
  to their cards. Between rounds the lobby and the results sheet have their own Leave. Closing the tab holds the seat.
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
  nothing. The rule is only in this file.
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

## Accounts

Nobody has to sign in. At the top of the first page's pad, someone with no name yet chooses **Sign in** or **Guest**; a
guest writes a name (one the browser remembers goes straight to it), with a quiet Sign in beside it for later. Signing in
is with Google or with a code sent to their email, and they are then known across tables and visits. Signed in, their
picture (or initial) and name stand where the name was written, and pressing them turns the pad over to their page: the name they go by (theirs to change), their record over the rounds they played
signed in, deleting their account at the foot on the left and signing out on the right. The pad turns over like a card,
to their page or the way in and back again (with reduced motion, the other side simply comes up).

### What is kept

One SQLite file, `nertz.db` under `DATA_DIR` (`server/db.ts`), opened with Node's own `node:sqlite`: nothing to compile.
Without a `DATA_DIR` (in production; in dev it is `./data`) nothing outlives the process and nobody can sign in. If the
file cannot be opened the game runs without it, and the log says so (`nothing is kept: ...`). The boot line ends
`, keeping rounds` or `, keeping rounds and accounts`.

- **Rounds** (`server/rounds.ts`): every round played to its end, by anyone: when, at which table and in which sitting
  at it (`game`: from the table's opening, or its last start-over), how it ended, how long it took, each hand's score,
  who played it within the sitting, the name it was played under and whether they had left before the end, and each snipe (who sniped whom, with which card). A hand played signed in also
  carries the account's id. A round left unfinished (everyone gone, or the server restarted) is not kept. Tables of ours are made by the list of migrations in `server/db.ts`: to change one, add an entry.
- **Reports** (`server/reports.ts`): what players send with the bug button (see [Feedback](#feedback)).
- **Accounts**: Better Auth's own tables (user, session, account, verification), which it brings up to date on boot:
  who signed in, as Google or their email says. Nothing of ours writes to them.
- **Profiles** (`profile`): who someone is at the table, theirs to change: for now the name they go by (null until a
  new email account chooses one). Made with the account (from Google's first name), and gone with it.

Who someone at a table is signed in as is what their socket's cookie said as it opened, and is never sent to anyone
else. Only a socket opened from a page of ours (its `Origin` is `PUBLIC_URL`) is signed in as anyone: from any other
page it is a guest's. The same account in two windows is one seat at a table: the second window watches until the first stands up
(`Room.seatQueue`), so a round has at most one hand of an account, and the database holds it to that.

`GET /stats?among=all|people|no-bots` answers whoever asks, by their cookie, with their own record (`Stats`,
shared/types.ts) over every round, those with someone else there who is no bot, or those with no bot at all: rounds
played, rounds won (nobody in the round scored more, and somebody else played), rounds they called Nertz in, points and
cards played to the middle in all and the most of each in one round, nertz cards left in all, how far ahead they finish,
and snipes made and suffered. 401 for nobody signed in; 404 where there are no accounts. How far ahead is the share of
the others in a round who scored less, a tie counting half, averaged over the rounds with someone else in them: 1 for
first, 0 for last and ½ for the middle of a table of any size (an average place would mean something else at two than at
six). Your page shows it as a percentage, and the sums as so much a round.

`/profile` is one's own profile, by one's cookie (`server/profile.ts`): `GET` it (or a 401 naming the ways in, for
nobody signed in); `PUT {name}` a new name to go by; `DELETE` the account. Changes are taken only from `PUBLIC_URL`.
Deleting takes the profile, the user, its sessions and its link to Google in one transaction, and leaves their hands and
reports kept as nobody's, with no name to them; any table they are sitting at plays on with them as a guest. Someone who
asks with the bug button instead (`public/privacy.html` says they may) is deleted by hand: with the database open, run
the statements of the three `forget`s (`server/accounts.ts`, `rounds.ts`, `reports.ts`) for their id in one transaction.

### Signing in

`server/accounts.ts` is the only file that knows how: it hands the work to [Better Auth](https://better-auth.com), which
does the exchange with Google, sends and checks codes by email (its `emailOTP` plugin, sent through Resend), keeps the
session in a cookie, and keeps its tables in the database. Everything of Better Auth's is served under `/api/auth`. One
email address is one account whichever way someone comes in: Google's word for an address and a code sent to it are both
proof of it. A code is six digits, good for ten minutes and three tries, kept hashed, and asked for at most three times a
minute from one place; any one address is sent eight a day at most, whoever asks (`CODES_A_DAY`), which caps the guesses
at it from everywhere together. A code Resend will not take is said to be unsent (502), and does not count. An account
made by email takes no name or picture from the request that makes it: only Google's are kept.

Accounts are **off unless set up**. With any of the settings below missing, `/api/auth` answers 404, and the client
takes that to mean there is no signing in and shows nothing about it. The same with no database, or if accounts cannot
be opened: the game runs without them, and the log says why (`accounts are off: ...`).

Of someone signed in with Google, the name, email address and picture Google has are kept, taken afresh each time they
sign in; of someone signed in by email, the address. Nothing else: not the address or browser they signed in from, and not Google's tokens for their account
(`public/privacy.html` says so, to them).

To turn them on (names as in `.env.example`; on Fly, `fly secrets set NAME=value -a <app>`, once per app):

1. In the Google Cloud console make an OAuth client of type "Web application", with one authorised redirect URI per
   place the app runs: `https://nertz.binarysmile.com/api/auth/callback/google`,
   `https://nertz-staging.binarysmile.com/api/auth/callback/google`, `http://localhost:5173/api/auth/callback/google`.
   Publish the consent screen, or only the test users listed on it can sign in.
2. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from it, `AUTH_SECRET` to a long random string
   (`openssl rand -base64 32`), and `PUBLIC_URL` to where that app is reached (`https://nertz.binarysmile.com`).
   Signing in works only from that address: at the app's `fly.dev` one a guest can play, and nobody can sign in.
3. For codes by email, set `RESEND_API_KEY` (a Resend key for a domain verified there). They come from
   `Nertz <nertz@mail.binarysmile.com>` unless `EMAIL_FROM` says. Either way in will do alone: with only this, nobody
   is offered Google; with only Google, the line at the foot of the first page goes straight there.
4. On Fly the database lives on a volume mounted at `/data` (`fly.toml`, `[mounts]`). Each app needs one, made once,
   **before** the first deploy that mounts it: `fly volumes create nertz_data --size 1 -r sjc -a <app>`.

A volume belongs to one machine, which is what each app already runs. Fly keeps daily snapshots of it for five days.

## Feedback

The bug button posts to `/feedback` (server/feedback.ts).

A report is **kept** first, where there is a database (see [What is kept](#what-is-kept); `server/reports.ts`): a row of
the `report` table, written before the sender is answered, with the report as it came and the account of whoever sent
it if they were signed in. The screenshot is a file beside the database, `reports/<id>.jpg` under
`DATA_DIR`: its name is made by the server from the report's id, never from anything sent, and
nothing serves these files (read them with `fly ssh sftp get`). The screenshots kept may come to 200 MB in all: past
that a report is kept without its picture, which is still passed on (anyone at all can send one, and the accounts live
on the same volume). Once it has been passed on, the row also says what it was titled and the address of the issue
filed for it. So a report that reaches nowhere else is not lost. To read them:
`select id, datetime(created_at / 1000, 'unixepoch'), kind, title, text, image_bytes, issue from report order by created_at desc;`

From there it is passed on wherever the server was told, to both if both are set:

- `FEEDBACK_WEBHOOK`: a Discord webhook URL (channel settings, Integrations, Webhooks: no bot needed). The report is
  posted there with the screenshot attached. On Fly: `fly secrets set FEEDBACK_WEBHOOK=...`.

- `LINEAR_API_KEY` and `LINEAR_TEAM`: a Linear personal API key and the key of a team (the letters before an issue's
  number, like `NRZ`). An issue is filed there, titled `[FEEDBACK] ...` and labelled Bug or Feature (the label is made
  if the team has none of that name), with the screenshot in its description.
  Optional: `LINEAR_PRIORITY`, `LINEAR_ASSIGNEE`, `LINEAR_STATE` and `LINEAR_PROJECT` say how the issue is filed.
- `ANTHROPIC_API_KEY` (optional): Claude Haiku names each report, for the issue and the Discord message, and sets the
  issue's priority by how bad it sounds (High, Medium or Low, over `LINEAR_PRIORITY`; never Urgent, since a player could
  ask for it). Without it, or if Claude does not answer within ten seconds, a report is titled by its first line.

Nothing names a particular server or workspace in the code: `.env.example` lists every name, with what to put there.

Ten reports per address per minute; a screenshot is scaled down in the browser first.
