import type { Segment, SeedPoints } from "../core/types.js";
import { readPalette, TIER_PEAK } from "./palette.js";

/** Structural tier of a reported segment; matches the seed classes above. */
const TYPE_TIER = { col: 0, inv: 1, trn: 2 } as const;

/**
 * Dot-plot renderer.
 *
 * Draws the actual seed hits the engine produced, not a fitted line. That
 * distinction matters: a line drawing hides whether the underlying evidence is
 * dense or sparse, and it cannot show repeats or noise at all — it can only
 * redraw the summary the chaining step already produced. Points show what the
 * chaining step saw.
 *
 * Rendering strategy: seeds are accumulated into a device-pixel buffer, one
 * count per cell, and the buffer is converted to pixels once. This is what
 * produces the look of a real dot plot — a crisply thin diagonal where evidence
 * is dense, single visible grains where it is not. Drawing one rectangle per
 * seed cannot do that: at 50k seeds the rectangles overlap ~40 deep on the
 * diagonal and fuse into a thick white bar, while isolated seeds stay invisible.
 *
 * Tiers come from the engine's seed classification:
 *
 *   0 collinear      paper white, the conserved backbone
 *   1 inverted       amber, drawn on the descending diagonal
 *   2 translocated   orange, off the main axis
 *   3 noise          dim grey, everything that belongs to no reported block
 *
 * A cell claimed by several tiers shows the most structurally specific one:
 * a seed inside a reported block is evidence of that block, whereas a noise
 * seed in the same place is only background.
 */

/**
 * Seed splat radius in device pixels.
 *
 * At native resolution a single seed is one pixel, and one-pixel features read
 * as vector hairlines rather than as grains of evidence — the plot looks drawn
 * instead of measured. Spreading each seed over a 2x2 footprint restores the
 * granular texture that makes a dot plot legible as data.
 */
const SPLAT = 1;

/**
 * Density response: opacity approaches the tier peak as exp(-1/tau) per hit.
 * A single seed still leaves a visible grain, which is the whole point of
 * plotting seeds rather than blocks.
 */
const TAU = 1.9;

/** The visible window, in bases. Always a sub-rectangle of both genomes. */
export interface View {
  r0: number;
  r1: number;
  q0: number;
  q1: number;
}

export interface PlotInput {
  pts: SeedPoints;
  nRef: number;
  nQry: number;
  /** Visible window; omit to show everything. */
  view?: View;
  /** Segment to outline, in the same coordinates as the data. */
  highlight?: Segment | null;
}

export interface PlotState {
  /** Plot-area rectangle in CSS pixels. */
  pad: number;
  inner: number;
  /** Pixel width, needed by the hover code to invert coordinates. */
  width: number;
  /** The window actually drawn, so pointer->genome mapping cannot drift. */
  view: View;
}

/** The full extent of both genomes, i.e. the un-zoomed view. */
export function fullView(nRef: number, nQry: number): View {
  return { r0: 0, r1: nRef, q0: 0, q1: nQry };
}

function isFullView(v: View, nRef: number, nQry: number): boolean {
  return v.r0 === 0 && v.q0 === 0 && v.r1 === nRef && v.q1 === nQry;
}

/** Reused across redraws; reallocating a 2.8 M-cell buffer on every resize is wasteful. */
let bufCanvas: HTMLCanvasElement | null = null;
let bufCtx: CanvasRenderingContext2D | null = null;
let counts: Uint16Array = new Uint16Array(0);
let tiers: Uint8Array = new Uint8Array(0);
let bufSize = 0;

function ensureBuffer(size: number): HTMLCanvasElement | null {
  if (bufCanvas !== null && bufSize === size) return bufCanvas;
  bufCanvas = document.createElement("canvas");
  bufCanvas.width = size;
  bufCanvas.height = size;
  bufCtx = bufCanvas.getContext("2d", { willReadFrequently: false });
  if (bufCtx === null) {
    bufCanvas = null;
    return null;
  }
  counts = new Uint16Array(size * size);
  tiers = new Uint8Array(size * size);
  // 0xff means "no tier yet". Zero would mean tier 0, which is a real claim.
  tiers.fill(0xff);
  bufSize = size;
  return bufCanvas;
}

/**
 * Explicit geometry for rendering to a canvas that is not in the document.
 *
 * The normal path measures the live element, which an offscreen canvas cannot
 * answer, and clamps dpr to the screen's. Export needs both forced.
 */
export interface PlotSize {
  /** CSS width to lay out against. */
  w: number;
  /** CSS height to lay out against. */
  h: number;
  /** Device pixels per CSS pixel. 2 means "twice as sharp as a 1x screen". */
  dpr: number;
}

/**
 * Render one plot into a canvas.
 *
 * Returns the geometry so the caller can map pointer positions back to genome
 * coordinates without re-deriving the layout.
 */
export function drawPlot(
  canvas: HTMLCanvasElement,
  input: PlotInput,
  size?: PlotSize,
): PlotState | null {
  const dpr = size !== undefined ? size.dpr : Math.min(window.devicePixelRatio || 1, 2);
  const rect =
    size !== undefined ? { width: size.w, height: size.h } : canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;

  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const g = canvas.getContext("2d");
  if (g === null) return null;

  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = rect.width;
  const h = rect.height;
  const pad = Math.round(Math.min(w, h) * 0.072);
  const inner = Math.min(w, h) - pad * 2;

  const view = input.view ?? fullView(input.nRef, input.nQry);

  const P = readPalette();
  g.fillStyle = P.bg;
  g.fillRect(0, 0, w, h);

  drawPoints(g, input, view, pad, inner, dpr);
  drawGrid(g, pad, inner);
  drawFrame(g, view, pad, inner, input);
  drawHighlight(g, input.highlight ?? null, view, pad, inner);
  drawTicks(g, view, pad, inner);

  return { pad, inner, width: w, view };
}

function drawPoints(
  g: CanvasRenderingContext2D,
  input: PlotInput,
  view: View,
  pad: number,
  inner: number,
  dpr: number,
): void {
  const { pts } = input;
  const count = pts.r.length;
  if (count === 0) return;

  // Work in device pixels: one seed per cell at native resolution is what
  // keeps a dense diagonal one pixel wide instead of a blurry band.
  const cells = Math.max(2, Math.round(inner * dpr));
  const buf = ensureBuffer(cells);
  if (buf === null || bufCtx === null) return;

  const spanR = Math.max(1, view.r1 - view.r0);
  const spanQ = Math.max(1, view.q1 - view.q0);
  const sx = (cells - 1) / spanR;
  const sy = (cells - 1) / spanQ;

  const occupied: number[] = [];

  for (let i = 0; i < count; i++) {
    const r = pts.r[i];
    const q = pts.q[i];
    // Seeds outside the window still exist, they are just not being looked at.
    if (r < view.r0 || r > view.r1 || q < view.q0 || q > view.q1) continue;
    const cx = Math.round((r - view.r0) * sx);
    // Query axis grows upward, so the buffer row is flipped. Getting this
    // wrong is not cosmetic: with rows growing down, an inverted block would
    // trace the same direction as a collinear one and the inversion vanishes.
    const cy = cells - 1 - Math.round((q - view.q0) * sy);
    if (cx < 0 || cx >= cells || cy < 0 || cy >= cells) continue;
    const k = cy * cells + cx;
    if (counts[k] === 0) occupied.push(k);
    if (counts[k] < 0xffff) counts[k] += 1;
    const t = pts.cls[i];
    // 255 means "no tier yet"; lower tier index wins otherwise.
    if (tiers[k] === 0xff || t < tiers[k]) tiers[k] = t;
  }

  if (occupied.length === 0) return;

  const img = bufCtx.createImageData(cells, cells);
  const px = img.data;

  // Splat: for each occupied cell, write the cell itself plus a soft 1px
  // halo, blending with max() rather than addition. Max keeps a dense diagonal
  // one pixel of bright core with a faint fringe instead of boiling into a fat
  // white bar, while an isolated seed still leaves a visible 3x3 grain.
  for (let oi = 0; oi < occupied.length; oi++) {
    const k = occupied[oi];
    const t = tiers[k];
    const tier = t < 4 ? t : 3;
    const [r, gg, b] = readPalette().tierRgb[tier];
    const sat = 1 - Math.exp(-counts[k] / TAU);
    const a = TIER_PEAK[tier] * sat;
    const core = Math.round(a * 255);

    const cx = k % cells;
    const cy = (k - cx) / cells;

    for (let dy = -SPLAT; dy <= SPLAT; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= cells) continue;
      for (let dx = -SPLAT; dx <= SPLAT; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= cells) continue;
        // Centre keeps full weight; the halo falls off with distance so the
        // grain has a soft edge rather than a hard 3x3 stamp.
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const w = d === 0 ? 1 : d === 1 ? 0.42 : 0.16;
        const val = Math.round(core * w);
        const p = (yy * cells + xx) * 4;
        const prev = px[p + 3];
        if (val <= prev) continue;
        px[p] = r;
        px[p + 1] = gg;
        px[p + 2] = b;
        px[p + 3] = val;
      }
    }

    // Reset for the next draw; the buffer is reused, not reallocated.
    counts[k] = 0;
    tiers[k] = 0xff;
  }

  bufCtx.putImageData(img, 0, 0);

  // Blit in device pixels. Identity transform here because putImageData already
  // wrote native-resolution pixels.
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  const padD = Math.round(pad * dpr);
  g.drawImage(buf, 0, 0, cells, cells, padD, padD, cells, cells);
  g.restore();
}

function drawGrid(g: CanvasRenderingContext2D, pad: number, inner: number): void {
  g.strokeStyle = readPalette().grid;
  g.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const p = Math.round(pad + (i / 8) * inner) + 0.5;
    g.beginPath();
    g.moveTo(p, pad);
    g.lineTo(p, pad + inner);
    g.stroke();
    g.beginPath();
    g.moveTo(pad, p);
    g.lineTo(pad + inner, p);
    g.stroke();
  }
}

function drawFrame(
  g: CanvasRenderingContext2D,
  view: View,
  pad: number,
  inner: number,
  input: PlotInput,
): void {
  g.strokeStyle = readPalette().border;
  g.lineWidth = 1;
  g.strokeRect(pad + 0.5, pad + 0.5, inner - 1, inner - 1);

  // A faint reference diagonal: without it, an empty plot gives no sense of
  // where a perfectly collinear genome *would* have landed. It only means
  // anything at full scale, where the two axes span the same pair of genomes
  // and a 45-degree line is genuinely the line of equal coordinates.
  if (input.pts.r.length === 0) return;
  if (!isFullView(view, input.nRef, input.nQry)) return;
  g.save();
  g.setLineDash([2, 4]);
  g.strokeStyle = readPalette().diagonal;
  g.beginPath();
  g.moveTo(pad, pad + inner);
  g.lineTo(pad + inner, pad);
  g.stroke();
  g.restore();
}

/**
 * Outline the selected block.
 *
 * Drawn as a plain hairline rectangle rather than a glow so it reads as an
 * annotation on the figure, not as a second kind of data. An inverted block is
 * a rectangle too: its two corners are (r0,q0) and (r1,q1) with q0 > q1, so the
 * box itself is the same shape and only the diagonal inside it differs.
 */
function drawHighlight(
  g: CanvasRenderingContext2D,
  seg: Segment | null,
  view: View,
  pad: number,
  inner: number,
): void {
  if (seg === null) return;
  const spanR = Math.max(1, view.r1 - view.r0);
  const spanQ = Math.max(1, view.q1 - view.q0);
  const x = (r: number): number => pad + ((r - view.r0) / spanR) * inner;
  const y = (q: number): number => pad + inner - ((q - view.q0) / spanQ) * inner;

  const x0 = x(Math.min(seg.r0, seg.r1));
  const x1 = x(Math.max(seg.r0, seg.r1));
  const y0 = y(Math.min(seg.q0, seg.q1));
  const y1 = y(Math.max(seg.q0, seg.q1));

  // A block smaller than a few pixels cannot be outlined meaningfully; mark
  // its centre instead so the selection never silently does nothing.
  const w = x1 - x0;
  const h = y1 - y0;
  g.save();
  g.strokeStyle = readPalette().tierCss[TYPE_TIER[seg.type]];
  g.lineWidth = 1;
  if (w < 6 || h < 6) {
    g.beginPath();
    g.arc((x0 + x1) / 2, (y0 + y1) / 2, 5.5, 0, Math.PI * 2);
    g.stroke();
  } else {
    g.setLineDash([3, 3]);
    g.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
    g.setLineDash([]);
    g.globalAlpha = 0.10;
    g.fillStyle = g.strokeStyle;
    g.fillRect(x0, y0, w, h);
  }
  g.restore();
}

/** Axis unit for a visible span: pick the one that keeps labels short. */
function unitFor(span: number): { name: string; scale: number; digits: number } {
  if (span >= 2_000_000) return { name: "Mbp", scale: 1e6, digits: 1 };
  if (span >= 2_000) return { name: "kbp", scale: 1e3, digits: 0 };
  return { name: "bp", scale: 1, digits: 0 };
}

function drawTicks(
  g: CanvasRenderingContext2D,
  view: View,
  pad: number,
  inner: number,
): void {
  const ux = unitFor(view.r1 - view.r0);
  const uy = unitFor(view.q1 - view.q0);

  g.strokeStyle = readPalette().tick;
  g.fillStyle = readPalette().tickText;
  g.font = "9.5px ui-monospace, Menlo, monospace";
  g.lineWidth = 1;

  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;

    // bottom: x axis (reference), growing right, labelled in the source's view
    const label = ((view.r0 + t * (view.r1 - view.r0)) / ux.scale).toFixed(ux.digits);
    const p = Math.round(pad + t * inner) + 0.5;
    g.beginPath();
    g.moveTo(p, pad + inner);
    g.lineTo(p, pad + inner + 4);
    g.stroke();
    g.textAlign = "center";
    g.fillText(label, p, pad + inner + 16);

    // left: y axis (query), growing up — so the top of the box is the far end
    const qLabel = ((view.q0 + t * (view.q1 - view.q0)) / uy.scale).toFixed(uy.digits);
    const py = Math.round(pad + inner - t * inner) + 0.5;
    g.beginPath();
    g.moveTo(pad, py);
    g.lineTo(pad - 4, py);
    g.stroke();
    g.textAlign = "right";
    g.fillText(qLabel, pad - 8, py + 3.5);
  }
  g.textAlign = "start";
}

/**
 * Map a pointer position to a fraction of the plot box, or null when it is
 * outside it. Drag-to-zoom needs the fraction rather than genome coordinates so
 * that it can build a window without knowing the current one.
 */
export function pointerFraction(
  state: PlotState,
  px: number,
  py: number,
): { fx: number; fy: number } | null {
  const { pad, inner } = state;
  if (px < pad || px > pad + inner || py < pad || py > pad + inner) return null;
  return { fx: (px - pad) / inner, fy: (pad + inner - py) / inner };
}

/** Map a pointer position to genome coordinates, or null when it is outside
 * the plot area. Used by the hover readout. */
export function invertPointer(
  state: PlotState,
  px: number,
  py: number,
): { r: number; q: number } | null {
  const f = pointerFraction(state, px, py);
  if (f === null) return null;
  const { view } = state;
  return {
    r: Math.round(view.r0 + f.fx * (view.r1 - view.r0)),
    q: Math.round(view.q0 + f.fy * (view.q1 - view.q0)),
  };
}

/**
 * Build the window a drag selected, clamped to the genomes and to a minimum
 * size. A drag under a few pixels is almost always an accidental twitch while
 * clicking, and zooming into it would look like the plot had jumped.
 */
export function viewFromDrag(
  state: PlotState,
  a: { px: number; py: number },
  b: { px: number; py: number },
  nRef: number,
  nQry: number,
): View | null {
  const fa = pointerFraction(state, a.px, a.py);
  const fb = pointerFraction(state, b.px, b.py);
  if (fa === null || fb === null) return null;

  const { view } = state;
  const toR = (f: number): number => view.r0 + f * (view.r1 - view.r0);
  const toQ = (f: number): number => view.q0 + f * (view.q1 - view.q0);

  const r0 = Math.min(toR(fa.fx), toR(fb.fx));
  const r1 = Math.max(toR(fa.fx), toR(fb.fx));
  const q0 = Math.min(toQ(fa.fy), toQ(fb.fy));
  const q1 = Math.max(toQ(fa.fy), toQ(fb.fy));

  // Refuse a window narrower than ~6 px of the current view: that is a click,
  // not a drag.
  const minR = (view.r1 - view.r0) * 0.004;
  const minQ = (view.q1 - view.q0) * 0.004;
  if (r1 - r0 < minR || q1 - q0 < minQ) return null;

  return clampView({ r0, r1, q0, q1 }, nRef, nQry);
}

/** Keep a window inside both genomes and above the smallest sensible span. */
export function clampView(v: View, nRef: number, nQry: number): View {
  const MIN_SPAN = 200;
  let r0 = Math.max(0, Math.min(v.r0, nRef - MIN_SPAN));
  let r1 = Math.min(nRef, Math.max(v.r1, r0 + MIN_SPAN));
  let q0 = Math.max(0, Math.min(v.q0, nQry - MIN_SPAN));
  let q1 = Math.min(nQry, Math.max(v.q1, q0 + MIN_SPAN));
  if (r1 - r0 < MIN_SPAN) r0 = Math.max(0, r1 - MIN_SPAN);
  if (q1 - q0 < MIN_SPAN) q0 = Math.max(0, q1 - MIN_SPAN);
  return { r0, r1, q0, q1 };
}

/** Zoom about a fixed fraction of the box, so the point under the cursor stays
 * under the cursor. factor < 1 zooms in. */
export function zoomView(
  v: View,
  fx: number,
  fy: number,
  factor: number,
  nRef: number,
  nQry: number,
): View {
  const spanR = v.r1 - v.r0;
  const spanQ = v.q1 - v.q0;
  const anchorR = v.r0 + fx * spanR;
  const anchorQ = v.q0 + fy * spanQ;
  const nr = spanR * factor;
  const nq = spanQ * factor;
  const next = clampView(
    { r0: anchorR - fx * nr, r1: anchorR + (1 - fx) * nr, q0: anchorQ - fy * nq, q1: anchorQ + (1 - fy) * nq },
    nRef,
    nQry,
  );
  // Zooming out past the full extent would otherwise leave a window a hair
  // inside the genome, which reads as "still zoomed" forever: the readout says
  // 1.0x but never offers a way back. Snap it.
  const coverR = (next.r1 - next.r0) / Math.max(1, nRef);
  const coverQ = (next.q1 - next.q0) / Math.max(1, nQry);
  if (coverR > 0.995 && coverQ > 0.995) return fullView(nRef, nQry);
  return next;
}

/** How far the window has been zoomed in, as a multiple of the full extent. */
export function zoomFactor(v: View, nRef: number, nQry: number): number {
  const f = Math.max((v.r1 - v.r0) / Math.max(1, nRef), (v.q1 - v.q0) / Math.max(1, nQry));
  return 1 / Math.max(1e-9, f);
}

/** True when the window shows essentially everything. */
export function isZoomed(v: View, nRef: number, nQry: number): boolean {
  return zoomFactor(v, nRef, nQry) > 1.02;
}
