import { drawPlot, type PlotInput } from "./plot.js";
import { readPalette } from "./palette.js";

/**
 * Export the current figure as a PNG at 2x, with the caption burned in.
 *
 * Why composite instead of screenshotting the canvas: the canvas holds only the
 * dots — captions, axes and the legend live in the DOM. A PNG of just the dots
 * is useless as a figure; what makes it citable is the sentence underneath it.
 */

/** CSS pixels per CSS pixel. 2 makes the file crisp on a retina screen. */
const SCALE = 2;

/** Space reserved under the plot for the caption, in CSS pixels. */
const CAPTION_GAP = 18;

export interface ExportOptions {
  /** CSS width of the plot square. */
  w: number;
  /** CSS height of the plot square. */
  h: number;
  input: PlotInput;
  /** Caption paragraph, already localised. Empty string means "no caption". */
  caption: string;
  /** One-line label drawn at the bottom edge, e.g. the site name. */
  footer: string;
}

/** The page's own serif stack — reading it keeps the caption in the same face
 *  the reader sees, including the Latin-first stack that English switches to. */
function bodyFont(): string {
  return getComputedStyle(document.body).fontFamily || "Georgia, serif";
}

const MONO_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** Break a paragraph into lines that fit `maxWidth` at the current font. */
function wrap(g: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/(\s+)/)) {
    const next = line + word;
    if (line !== "" && g.measureText(next).width > maxWidth) {
      lines.push(line.trimEnd());
      line = word.trimStart();
    } else {
      line = next;
    }
  }
  if (line.trim() !== "") lines.push(line.trimEnd());
  return lines;
}

/**
 * Draw plot + caption onto a fresh canvas and return it.
 *
 * Split from the download step so a test can inspect the pixels without
 * touching the filesystem.
 */
export function renderPng(opts: ExportOptions): HTMLCanvasElement | null {
  const P = readPalette();

  // The plot is rendered on its own canvas first: drawPlot sizes the canvas it
  // is given, so handing it the composite canvas would let it erase the caption.
  const plot = document.createElement("canvas");
  const state = drawPlot(plot, opts.input, { w: opts.w, h: opts.h, dpr: SCALE });
  if (state === null) return null;

  // Lay the caption out at 1x first to learn its height, then build the page.
  const probe = document.createElement("canvas").getContext("2d");
  if (probe === null) return null;
  // 画在设备像素上（没有 setTransform 缩放），所以字号也要乘 SCALE。
  const captionFont = `400 ${13 * SCALE}px ${bodyFont()}`;
  probe.font = captionFont;
  const captionW = opts.w * SCALE - 2 * CAPTION_GAP * SCALE;
  const lines = opts.caption === "" ? [] : wrap(probe, opts.caption, captionW);
  const lineH = 13 * 1.65 * SCALE;

  const footerH = opts.footer === "" ? 0 : 30 * SCALE;
  const captionH = lines.length === 0 ? 0 : lines.length * lineH + CAPTION_GAP * SCALE;

  const out = document.createElement("canvas");
  out.width = Math.round(opts.w * SCALE);
  out.height = Math.round(opts.h * SCALE + captionH + footerH);
  const g = out.getContext("2d");
  if (g === null) return null;

  g.fillStyle = P.bg;
  g.fillRect(0, 0, out.width, out.height);

  // drawPlot already painted a background across its own canvas; that is the
  // same colour, so the join is invisible.
  g.drawImage(plot, 0, 0);

  if (lines.length > 0) {
    g.font = captionFont;
    g.textBaseline = "top";
    g.fillStyle = P.tickText;
    let y = opts.h * SCALE + CAPTION_GAP * SCALE;
    for (const line of lines) {
      g.fillText(line, CAPTION_GAP * SCALE, y);
      y += lineH;
    }
  }

  if (opts.footer !== "") {
    const y = out.height - footerH;
    g.strokeStyle = P.border;
    g.lineWidth = SCALE;
    g.beginPath();
    g.moveTo(CAPTION_GAP * SCALE, y + 8 * SCALE);
    g.lineTo(out.width - CAPTION_GAP * SCALE, y + 8 * SCALE);
    g.stroke();
    g.font = `400 ${11 * SCALE}px ${MONO_FONT}`;
    g.textBaseline = "top";
    g.fillStyle = P.tickText;
    g.fillText(opts.footer, CAPTION_GAP * SCALE, y + 15 * SCALE);
  }

  return out;
}

/** Render, encode and hand the file to the browser. Resolves to the dimensions. */
export async function downloadPng(opts: ExportOptions, filename: string): Promise<{ w: number; h: number } | null> {
  const canvas = renderPng(opts);
  if (canvas === null) return null;
  const blob = await new Promise<Blob | null>((res) => {
    canvas.toBlob(res, "image/png");
  });
  if (blob === null) return null;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return { w: canvas.width, h: canvas.height };
}
