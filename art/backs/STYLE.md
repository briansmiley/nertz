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

## Making a back from an image

Crop to 5:7, find the background's tone (the commonest dark value) and the white (the 99.5th percentile), stretch
them to transparent and opaque, and save 360×504 white on transparent. Whatever is left of the background should be
under 2% opaque: more means a gradient or glow got in, and the image should be redone.
