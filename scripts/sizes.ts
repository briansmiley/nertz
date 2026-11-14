// Prints how big cards come out in various windows: `npx tsx scripts/sizes.ts`
import { deal } from '../shared/engine';
import { cardSize } from '../shared/table';
import { computeLayout } from '../client/layout';

const rng = () => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); };
const WINDOWS: [number, number][] = [[1280, 720], [1440, 900], [1920, 1080], [2560, 1440], [3440, 1440], [3840, 2160]];
console.log('window       n  centre  opp  own   felt(w x h)   felt share of window');
for (const [W, H] of WINDOWS) {
  for (let n = 2; n <= 6; n++) {
    const g = deal(Array.from({ length: n }, (_, i) => i), rng());
    const L = computeLayout(W, H, g, 0);
    const c = cardSize(n).w * L.felt.u;
    console.log(`${`${W}x${H}`.padEnd(11)} ${n}  ${c.toFixed(0).padStart(5)}  ${(L.opponents[0]!.s * 90).toFixed(0).padStart(3)}  ${(L.me!.s * 90).toFixed(0).padStart(3)}   ${L.middle.w.toFixed(0)}x${L.middle.h.toFixed(0)}`.padEnd(48) + `${((L.middle.w / W) * 100).toFixed(0)}% x ${((L.middle.h / H) * 100).toFixed(0)}%`);
  }
}
