# Sounds

Every recording here comes from **Casino Audio (1.1)** by Kenney Vleugels
(<https://kenney.nl/assets/casino-audio>), released under
[Creative Commons Zero (CC0 1.0)](http://creativecommons.org/publicdomain/zero/1.0/):
public domain, free for personal and commercial use, credit not required. The
pack's own `License.txt` says so:

> License (Creative Commons Zero, CC0)
> You may use these assets in personal and commercial projects.
> Credit (Kenney or www.kenney.nl) would be nice but is not mandatory.

The originals are stereo Ogg Vorbis. Each file here is a cut of one of them,
mixed to mono, faded at both ends, normalised to a peak of -3 dBFS and encoded
as MP3 (which every browser's Web Audio decoder reads, Safari included). About
66 kB in all.

| File | From | Cut (s) | Used for |
| --- | --- | --- | --- |
| `flick-1.mp3` | `card-slide-4.ogg` | 0.07 - 0.27 | deal, stock flip, sorting |
| `flick-2.mp3` | `card-slide-5.ogg` | 0.08 - 0.28 | deal, stock flip, sorting |
| `flick-3.mp3` | `card-slide-6.ogg` | 0.10 - 0.32 | deal, stock flip, sorting |
| `place-1.mp3` | `card-place-1.ogg` | 0.10 - 0.34 | drop on a pile, the Nertz hit |
| `place-2.mp3` | `card-place-4.ogg` | 0.21 - 0.50 | drop on a pile, the King, the Nertz hit |
| `place-3.mp3` | `card-place-2.ogg` | 0.12 - 0.32 | drop on a pile |
| `tap-1.mp3` | `card-slide-2.ogg` | 0.04 - 0.22 | a card going back |
| `tap-2.mp3` | `card-slide-1.ogg` | 0.12 - 0.30 | a card going back |
| `slide-1.mp3` | `card-shove-3.ogg` | 0.08 - 0.62 | a finished pile to the tray |
| `slide-2.mp3` | `card-shove-1.ogg` | 0.08 - 0.62 | the waste turned back over |
| `lift.mp3` | `card-slide-7.ogg` | 0.15 - 0.48 | picking a card up |
| `shuffle.mp3` | `card-shuffle.ogg` | 0.06 - 1.86 | the wash at the end of a round, the reshuffle of a table that was stuck |
| `fan.mp3` | `card-fan-1.ogg` | 0.00 - 0.72 | the score sheet appearing |

The tones (the ding for a card played to the middle, the King's chime, the
Nertz chord, the countdown tick) are not recordings: `../sound.ts` synthesises
them with the Web Audio API.
