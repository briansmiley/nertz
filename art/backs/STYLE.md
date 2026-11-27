# Animal backs: how they were made

The animal backs in `public/cards/backs/` (fox, owl, loong, rabbit, crane, phoenix, deer, koi, falcon, swallowtail,
butterflies, ants, aster) were generated with OpenAI's image API (`gpt-image-2.5-sunburst`, low quality, 1024×1536)
on 24 Nov 2026, through `~/.claude/scripts/gen-image.py`. Their full-size originals, normalised to black and white,
are kept outside the repo in `~/nertz-art/backs/` (on the Mac and on hetz).

## The prompt

Every back is one prompt: the opening line, one or two sentences about the subject, then the style.

> A playing card back design, portrait orientation. *[subject]* Crisp papercut silhouette style: solid white shapes on
> a solid deep navy blue background. Strictly monochrome: only white and navy, no other colors anywhere. Details are
> thin clean cut-out lines, like a paper cutting. The overall shape is loose and natural, not symmetrical. No border,
> frame or margin: flat navy fills the card edge to edge, no vignette or darkening at the edges. No shading, gradients,
> texture, paper grain, shadows, text, or repeating pattern.

Subjects that worked:

- **fox**: lying down, curled into a ball with its nose tucked into its bushy tail; tall grass at the bottom edge.
- **owl**: perched on a branch, facing forward with large round eyes, wings folded; the branch runs off both sides.
- **loong**: a Chinese dragon as a bold solid silhouette, like a shadow puppet, then edited: "zoom in on the top half
  of this dragon… add a bit more detail carved into the silhouette".
- **crane**: wings spread wide in flight, wingtips off the side edges, long legs trailing, reeds at the bottom.
- **falcon**: a peregrine perched on a rocky ledge, in profile, wings folded.
- **swallowtail**: wings open, its long hindwing tails reaching toward the bottom edge so it fills the tall card.
- **butterflies**: seven or eight of different sizes fluttering upward at different angles, a few cropped by the edges.
- **ants**: ten large ants seen from above, scattered at all angles; no rows, no trail.

## What we learned

- **No colour words in the subject.** "Red-crowned crane" drew a red crown.
- **One image per idea.** Two from the same prompt come out nearly the same; try different prompts instead.
- **Detail comes from the prompt, not the model**: "almost no interior detail" gives a bold silhouette.
- **A real photo is a reference once, never again.** Mixed into later edits it brings a soft glow that no prompt
  removes. Aster was made from a photo, then refined with only her own drafts as references.
- **Small things must be large.** Ants in rows, or a busy owl, turn to texture at hand size.
- **Aster** is her faithful draft softened by hand, not by the model: blurred (Gaussian, σ 2.2 at 1024 px wide) and
  re-cut at six times the contrast around the midpoint.

## Smooth animals: giraffes, python, sphinx

`giraffes`, `python` and `sphinx` (26 Nov 2026) are animals with no fur or feathers to cut, or little. With the prompt
above alone they came out flat and too clean: smooth even outlines, large plain fills, nothing around them, like a
logo. What the first animals have, and these lacked, is ragged tapered edges and many small cuts inside that follow
the body. So one more sentence goes in before the style:

> Hand-cut look, like a traditional paper cutting or woodcut made with a knife: edges lively and slightly irregular,
> never smooth vector curves or even outlines. Form and roundness are suggested by many small tapered cuts and nicks of
> varying width that follow the body, denser on the side turned away from the light. Not a logo, not clip art.

and the subject names what there is to cut, and a little of where the animal is:

- **giraffes**: two adults seen close, from the tops of their legs up, cropped by the bottom edge (no feet, no ground,
  no grass): mostly necks and heads against open sky, one browsing the crown of a thorny acacia at the top, the other
  turned back toward us; short bristly manes, spots as uneven hand-cut patches, large and bold.
- **python**: a ball python in a loose pile of overlapping coils, slender rather than fat, neck rising in a gentle S,
  head in profile near the top; three or four fern fronds and a couple of fallen leaves, mostly open space; blotches as
  irregular patches with ragged edges, and rows of small crescent scale nicks along each coil, thicker underneath.
- **sphinx**: "a mythical sphinx from an ancient Greek vase", sitting upright in profile on a rocky outcrop: a lion's
  furry body and ruff, a calm human face with wind-blown hair and a headband, large feathered eagle wings raised high.
  It was drawn with thistles and grasses on the rock, then edited: "remove the thistles, grasses and all other plants".

Giraffes and python are cut closer than the others: a 5:7 window 72% of the picture's width, from its top edge, in
the middle from side to side, so the heads are large and the bodies run off the bottom and sides.

- **Too much setting is texture.** Whole giraffes in tall grass among three trees, each with small spots, were lost at
  hand size; a hairless cat on a rumpled blanket turned to stripes. A few large things around the animal are enough.
- **An edit keeps what is there; it does not reshape well.** Taking the plants off the sphinx was clean. Making a snake
  slimmer by an edit left gaps in its body: it was drawn again from a new prompt.
- **A woman's head and chest on an animal's body is refused** by the image API's filter. "A calm human face" on "a
  lion's furry body" is not.

## Damask

`damask` (in the Ornate group, 26 Nov 2026) is the one ornament made this way, after the owner's phone photo of a
blue damask-printed fabric. Its first draft was an edit of the photo, with the subject *after the damask medallion in
this fabric photo. One large symmetrical medallion fills the card: leafy scrolls, curling fronds and small buds
radiating from a small rayed sunburst rosette in the centre, mirrored left to right and top to bottom, with a ring of
curling scroll lobes around it; parts of the neighbouring medallions are cropped by the card edges at the corners*, and
the style with "loose and natural, not symmetrical" left out (an ornament should be symmetrical) and "fabric weave"
added to what to leave out. It came out soft and ragged in its small leaves, so it was redrawn from that draft alone:
"more cleanly… crisp, sharp, clean edges like cut paper: no blur, no soft or ragged fragments, no small specks… slightly
bolder and simpler so they read at a small size".

- **One medallion, neighbours cut by the edges**: the print's whole repeat would be texture at hand size.
- **Ask for crisp edges in a second pass.** A busy first draft keeps its fine leaves blurred; redrawing it from itself
  sharpens them.

## Seraph

`seraph` (in the Celestial group, 27 Nov 2026) was written from a description, with no outside image given to the
model: the style prompt, symmetrical, with the subject *a mythical winged guardian seen head-on and mirrored left to
right and top to bottom: two pairs of great feathered wings, one pair rising upward and one pair reaching downward,
their long arms crossing over and under each other like a woven knot around a single large open eye at the centre of
the card. A small full moon sits above the top wings*. That gave clean but flat drafts. Two edits followed:

1. Texture, with the draft and `aster.png` as references: "Give it the texture and level of detail of the second
   image (a cat): every feather built from many fine carved strokes, hatching and stippled flecks, like a woodcut or
   engraving… Take only the line texture from the cat, nothing of the cat itself."
2. Shadow, from that draft alone: "sink [the eye] deep into shadow… mostly swallowed by solid navy: no bright white
   eyeball. Only its outline, a few fine carved strokes on the lids, the rim of the iris and a small bright glint…"

3. Eye back up, from the shadowed draft alone: "Only make the eye itself read clearly at a small size: bold bright
   white upper and lower lids drawn with thick carved strokes, a clear bright ring round the iris… a larger bright
   glint… while the shadow around it stays." Sunk fully into shadow, the eye was lost at card size.

- **One of our own backs is a fine reference for texture.** Aster's woodcut strokes carried over without any of the cat.
- **Check the centre at card size.** A dark hollow reads in the full image and vanishes in a pile.
- About $0.17 in all (`--issue` was not given; see the usage log for 27 Nov).

## Making a back from an image

Crop to 5:7, find the background's tone (the commonest dark value) and the white (the 99.5th percentile), stretch
them to transparent and opaque, and save 360×504 white on transparent. Whatever is left of the background should be
under 2% opaque: more means a gradient or glow got in, and the image should be redone.
