/**
 * Single source of truth for everything the dot plot paints.
 *
 * Why this module exists: the canvas used to carry its own hex table, separate
 * from the stylesheet's custom properties. Two colour definitions that must
 * agree will eventually disagree, and the failure mode is silent — a theme
 * switch repaints the page but leaves the figure in the old palette, or in a
 * light theme the collinear dots end up paper-white on paper-white and the
 * whole point of the tool disappears.
 *
 * So the stylesheet owns the colours and this module reads them back. Reading
 * costs a style resolution per colour, which is why the result is cached: the
 * wheel handler redraws on every event, and a redraw has no business touching
 * getComputedStyle.
 *
 * Themes are therefore edited in one place (app.css), and a pixel test can
 * assert that what the canvas paints matches what the legend claims.
 */

export interface Palette {
  /** Plot background — one step darker than the page so the frame reads as a figure. */
  bg: string;
  /** Reference diagonal behind the dots. */
  diagonal: string;
  grid: string;
  border: string;
  tick: string;
  tickText: string;
  /** Pixel colour per tier, as [r, g, b] — the blit needs numbers, not strings. */
  tierRgb: readonly (readonly [number, number, number])[];
  /** Same colours as CSS strings, for strokes that cannot use the numeric form. */
  tierCss: readonly string[];
}

/**
 * Per-tier opacity ceiling. Structural tiers may reach near-full opacity; noise
 * must stay visibly weaker so it cannot compete with a reported block.
 */
export const TIER_PEAK: readonly number[] = [0.95, 0.95, 0.92, 0.55];

/** Grid, border and tick marks are the paper colour at three weights. */
const GRID_ALPHA = 0.04;
const BORDER_ALPHA = 0.14;
const TICK_ALPHA = 0.22;
const DIAGONAL_ALPHA = 0.1;

/** Sentinel used to prove the probe resolved a colour instead of echoing its input. */
const UNRESOLVED = "";

let cached: Palette | null = null;
let probe: HTMLElement | null = null;

/**
 * Resolve one CSS custom property to concrete channel values.
 *
 * A probe element is used rather than parsing the property text: the property
 * returns whatever the author typed (`#ece7dc`, `rgb(...)`, a named colour),
 * whereas the computed style always comes back as `rgb()` / `rgba()` with the
 * cascade already applied. Parsing the raw text would silently break the first
 * time a theme used a format the parser did not anticipate.
 */
function resolve(cssVar: string): [number, number, number] {
  const root = document.documentElement;
  if (probe === null) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    // Rendered but out of the way: getComputedStyle returns nothing useful for
    // a detached node.
    probe.style.cssText = "position:fixed;top:0;left:-9999px;width:1px;height:1px;pointer-events:none";
    root.appendChild(probe);
  }
  probe.style.backgroundColor = `var(${cssVar})`;
  const text = getComputedStyle(probe).backgroundColor;
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(text);
  if (m === null) {
    // A missing variable leaves the probe transparent; reporting black would
    // hide the mistake, so make it loud in development.
    if (typeof console !== "undefined") console.warn(`palette: cannot resolve ${cssVar} (got "${text}")`);
    return [255, 0, 255];
  }
  return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
}

const css = ([r, g, b]: readonly [number, number, number]): string => `rgb(${r},${g},${b})`;

export function readPalette(): Palette {
  if (cached !== null) return cached;
  // Checked before the first resolve so a stripped-down DOM (unit tests) fails
  // with one clear message instead of a cascade of warnings.
  if (typeof document === "undefined") throw new Error("readPalette needs a DOM");
  if (getComputedStyle(document.documentElement).getPropertyValue("--paper").trim() === UNRESOLVED) {
    throw new Error("palette: stylesheet is not loaded (--paper is empty)");
  }

  const paper = resolve("--paper");
  const amber = resolve("--amber");
  const accentSoft = resolve("--accent-soft");
  const noise = resolve("--dot-noise");
  const paperCss = css(paper);

  cached = {
    bg: css(resolve("--ink3")),
    diagonal: `rgba(${paper[0]},${paper[1]},${paper[2]},${DIAGONAL_ALPHA})`,
    grid: `rgba(${paper[0]},${paper[1]},${paper[2]},${GRID_ALPHA})`,
    border: `rgba(${paper[0]},${paper[1]},${paper[2]},${BORDER_ALPHA})`,
    tick: `rgba(${paper[0]},${paper[1]},${paper[2]},${TICK_ALPHA})`,
    tickText: css(resolve("--faint")),
    tierRgb: [paper, amber, accentSoft, noise],
    tierCss: [paperCss, css(amber), css(accentSoft), css(noise)],
  };
  return cached;
}

/**
 * Drop the cache. Call this after the theme changes and before the next redraw;
 * the caller owns the redraw because only it knows what else on screen depends
 * on the palette.
 */
export function invalidatePalette(): void {
  cached = null;
}