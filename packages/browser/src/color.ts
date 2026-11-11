/**
 * Colour math for the contrast measurement: parsing computed colours,
 * compositing alpha and the WCAG 2.x contrast ratio. Pure functions, no DOM, so
 * they run (and are tested) in Node. Colours never leave the page: the snapshot
 * walk keeps only the ratio this computes.
 */

/** sRGB channels 0–255 and alpha 0–1. */
export type Rgba = readonly [r: number, g: number, b: number, a: number];
/** An opaque colour: sRGB channels 0–255. */
export type Rgb = readonly [r: number, g: number, b: number];

export const WHITE: Rgb = [255, 255, 255];
export const BLACK: Rgb = [0, 0, 0];

const TRANSPARENT = "rgba(0, 0, 0, 0)";
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/;
const SRGB = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/;

const clamp = (value: number, max: number): number => (value < 0 ? 0 : value > max ? max : value);
const alpha = (value: string | undefined, percent: string | undefined): number =>
  value === undefined ? 1 : clamp(percent ? Number(value) / 100 : Number(value), 1);

/**
 * A computed colour as getComputedStyle serializes it: `rgb()`, `rgba()` or
 * `color(srgb …)`. Anything else (other colour spaces, keywords) is null:
 * unknown rather than guessed.
 */
export function parseColor(value: string | null | undefined): Rgba | null {
  if (!value) return null;
  const cached = parsed.get(value);
  if (cached !== undefined) return cached;
  const result = parse(value);
  // Pages use few distinct colours; the bound only guards against pathological ones.
  if (parsed.size < 4096) parsed.set(value, result);
  return result;
}

const parsed = new Map<string, Rgba | null>();

function parse(value: string): Rgba | null {
  if (value === TRANSPARENT || value === "transparent") return [0, 0, 0, 0];
  let match = RGB.exec(value);
  if (match)
    return [clamp(Number(match[1]), 255), clamp(Number(match[2]), 255), clamp(Number(match[3]), 255), alpha(match[4], match[5])];
  match = SRGB.exec(value);
  if (match)
    return [
      clamp(Number(match[1]) * 255, 255),
      clamp(Number(match[2]) * 255, 255),
      clamp(Number(match[3]) * 255, 255),
      alpha(match[4], match[5]),
    ];
  return null;
}

/** `top` painted over an opaque `bottom` (source-over). */
export function composite(top: Rgba, bottom: Rgb): Rgb {
  const a = top[3];
  if (a >= 1) return [top[0], top[1], top[2]];
  if (a <= 0) return bottom;
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a)];
}

const linear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2.x relative luminance, 0 (black) to 1 (white). */
export function luminance(color: Rgb | Rgba): number {
  return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
}

const luminances = new Map<string, number>();

/** Luminance of an opaque colour from parseColor, cached by its computed string. */
export function luminanceOf(value: string, color: Rgb | Rgba): number {
  let found = luminances.get(value);
  if (found === undefined) {
    found = luminance(color);
    if (luminances.size < 4096) luminances.set(value, found);
  }
  return found;
}

/** WCAG 2.x contrast ratio between two relative luminances. */
export const ratioOf = (la: number, lb: number): number => (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);

/** WCAG 2.x contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Rounded down to 2 decimal places, so a ratio just under a threshold (4.499)
 * is never reported as meeting it (4.5).
 */
export const floorRatio = (ratio: number): number => Math.floor(ratio * 100 + 1e-9) / 100;

/** WCAG 1.4.3: large text (≥ 24px, or ≥ 18.66px and bold) needs 3:1, other text 4.5:1. */
export function requiredRatio(fontPx: number, bold: boolean): number {
  return fontPx >= 24 || (bold && fontPx >= 18.66) ? 3 : 4.5;
}
