// Colour arithmetic in OKLab, where lightness is as the eye sees it: a colour can be made lighter there without
// changing its hue or how vivid it is.

type Lab = { l: number; a: number; b: number };

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function oklab(hex: string): Lab {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Linear sRGB, which may lie outside 0 to 1 when the colour cannot be shown. */
function linear({ l: L, a, b }: Lab): number[] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

const shown = (lab: Lab) => linear(lab).every((c) => c >= -1e-4 && c <= 1 + 1e-4);

function hexOf(lab: Lab): string {
  return (
    '#' +
    linear(lab)
      .map((c) =>
        Math.round(toGamma(Math.min(1, Math.max(0, c))) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

/** How light a colour looks, from 0 (black) to 1 (white). */
export const lightness = (hex: string): number => oklab(hex).l;

/**
 * The colour, unchanged if it is already as light as `l` (0 to 1); otherwise the same hue made that light, as vivid as
 * it was or, where a screen cannot show that, as vivid as it can.
 */
export function atLeastLight(hex: string, l: number): string {
  const lab = oklab(hex);
  if (lab.l >= l) return hex;
  let [lo, hi] = [0, 1];
  if (shown({ l, a: lab.a, b: lab.b })) lo = 1;
  else
    for (let i = 0; i < 20; i++) {
      const k = (lo + hi) / 2;
      if (shown({ l, a: lab.a * k, b: lab.b * k })) lo = k;
      else hi = k;
    }
  return hexOf({ l, a: lab.a * lo, b: lab.b * lo });
}
