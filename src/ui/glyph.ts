/**
 * The glyph beside the hero heading.
 *
 * It is a 1.2 second rehearsal of what the tool does: seeds arrive scattered,
 * collapse onto the main diagonal, and then one inverted block appears on the
 * anti-diagonal. Then it stops.
 *
 * Two decisions worth recording:
 *
 * Once, not looped. A looping animation beside a heading competes with reading
 * for as long as the visitor stays on the page; a single performance is over
 * before it becomes furniture.
 *
 * Deterministic. The scatter comes from a fixed-seed PRNG, not Math.random, so
 * every visitor sees the same glyph. A layout that differs on each load reads as
 * decoration that is still settling, and it makes any screenshot comparison of
 * the page useless.
 *
 * The colours are the plot's own tier colours, read through the palette, because
 * a glyph that teaches a different legend than the figure below it teaches the
 * wrong legend.
 */

import { readPalette } from "./palette.js";

/** Same generator as the demo builder, copied rather than imported so the demo
 *  data code is not pulled into the first chunk for sixteen lines of PRNG. */
function xorshift32(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

const DOTS = 230;
const INVERTED = 16;
const DURATION_MS = 1200;

/** 0 before the turn, 1 after; smoothstep so the collapse does not start abruptly. */
function ease(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

interface Dot {
  /** Where the seed lands while the picture is still forming. */
  sx: number;
  sy: number;
  /** Where it belongs on the diagonal. */
  tx: number;
  ty: number;
  r: number;
}

function buildDots(rand: () => number): { collinear: Dot[]; inverted: Dot[] } {
  const collinear: Dot[] = [];
  for (let i = 0; i < DOTS; i += 1) {
    // Parameter along the main diagonal. A little jitter keeps the line from
    // reading as a hairline rule; the plot itself has the same grain.
    const t = (i + rand() * 0.9) / DOTS;
    const jitter = (rand() - 0.5) * 0.014;
    collinear.push({
      sx: rand(),
      sy: rand(),
      tx: 0.08 + t * 0.84,
      ty: 0.92 - t * 0.84 + jitter,
      r: 0.9 + rand() * 0.5,
    });
  }
  const inverted: Dot[] = [];
  for (let i = 0; i < INVERTED; i += 1) {
    const t = (i + rand() * 0.8) / INVERTED;
    inverted.push({
      sx: 0.2 + rand() * 0.6,
      sy: 0.2 + rand() * 0.6,
      // Anti-diagonal block: grows down and to the right, the signature of a
      // block that was reversed rather than moved.
      tx: 0.3 + t * 0.2,
      ty: 0.3 + t * 0.2,
      r: 1.1 + rand() * 0.5,
    });
  }
  return { collinear, inverted };
}

function paint(canvas: HTMLCanvasElement, progress: number): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const palette = readPalette();
  const size = canvas.width;
  ctx.clearRect(0, 0, size, size);

  const rand = xorshift32(0x5f3a91);
  const { collinear, inverted } = buildDots(rand);

  // Collapse runs from 22% to 78% of the timeline, so the eye sees the scatter
  // resolve rather than watching a fade.
  const converge = ease((progress - 0.22) / 0.56);
  // The inverted block only appears once the backbone is legible; otherwise it
  // reads as one more cloud of dust.
  const inversion = ease((progress - 0.74) / 0.26);

  ctx.globalCompositeOperation = "lighter";

  ctx.fillStyle = palette.tierCss[0];
  for (const d of collinear) {
    const x = lerp(d.sx, d.tx, converge) * size;
    const y = lerp(d.sy, d.ty, converge) * size;
    // Fade in with the collapse so the first frame is empty rather than a burst.
    ctx.globalAlpha = 0.35 + 0.65 * converge;
    ctx.beginPath();
    ctx.arc(x, y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }

  if (inversion > 0) {
    ctx.fillStyle = palette.tierCss[1];
    ctx.globalAlpha = inversion;
    for (const d of inverted) {
      const x = lerp(d.sx, d.tx, inversion) * size;
      const y = lerp(d.sy, d.ty, inversion) * size;
      ctx.beginPath();
      ctx.arc(x, y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function sizeCanvas(canvas: HTMLCanvasElement, cssSize: number): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.round(cssSize * dpr);
  if (canvas.width !== px) {
    canvas.width = px;
    canvas.height = px;
  }
}

/**
 * Paint the glyph. With `instant`, draw the finished picture and return — the
 * path used for reduced-motion users and for repainting after a theme change,
 * where replaying a 1.2 second animation would be a nuisance rather than a
 * flourish.
 */
export function startGlyph(canvas: HTMLCanvasElement, instant = false): void {
  const cssSize = canvas.clientWidth;
  // A hidden glyph has no box to measure; the media query hides it below 920px.
  if (cssSize < 8) return;
  sizeCanvas(canvas, cssSize);

  if (instant) {
    paint(canvas, 1);
    return;
  }

  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  if (reduce?.matches === true) {
    paint(canvas, 1);
    return;
  }

  const start = performance.now();
  const step = (now: number): void => {
    const t = Math.min(1, (now - start) / DURATION_MS);
    paint(canvas, t);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}