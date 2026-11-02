import type { Sequence } from "./types.js";

/**
 * Parse FASTA text into sequences.
 *
 * Tolerant by design: any byte that is not a recognised base is dropped, the
 * name is the first whitespace-delimited token of the header, and empty
 * records are discarded. Multi-record files are supported; callers decide
 * what to do when there is more than one.
 */
export function parseFasta(text: string): Sequence[] {
  const out: Sequence[] = [];
  let name = "unnamed";
  let buf: string[] = [];

  const flush = (): void => {
    if (buf.length > 0) {
      const seq = buf.join("");
      if (seq.length > 0) out.push({ name, seq });
    }
    buf = [];
  };

  for (const raw of text.split(/\r?\n/)) {
    if (raw.charCodeAt(0) === 62 /* '>' */) {
      flush();
      name = raw.slice(1).trim().split(/\s+/)[0] || "unnamed";
    } else if (raw.length > 0) {
      const cleaned = raw.trim().toUpperCase().replace(/[^ACGTN]/g, "");
      if (cleaned.length > 0) buf.push(cleaned);
    }
  }
  flush();
  return out;
}

/** Options resolved for a comparison, either chosen by the user or guessed. */
export interface Params {
  k: number;
  w: number;
}

/**
 * Pick k and the minimiser window from the sequence sizes.
 *
 * Two targets, in order of priority:
 *
 *  * **Seed count.** Chaining is superlinear in the number of seeds, so the
 *    window is chosen to keep roughly 1.2e5 minimisers. The expected density of
 *    a minimiser scheme is 2/(w+1), not 1/w — a base can be the minimum of its
 *    window while its neighbour is too, and both are emitted. Budgeting at 1/w
 *    would silently double the seed count.
 *  * **Specificity.** k must be large enough that a k-mer occurring at random
 *    is rare: 4^13 is 6.7e7, so a 15-mer in a 1e7-base genome has a negligible
 *    chance of a spurious match. k grows with the input for the same reason.
 *
 * These are heuristics tuned against the demo genomes, not a correctness
 * boundary; the UI exposes them so a user can override.
 */
export function autoParams(nRef: number, nQry: number): Params {
  const n = Math.max(nRef, nQry);
  const k = n > 8e6 ? 17 : n > 1e6 ? 15 : 13;
  // 2/(w+1) density, target ~1.2e5 seeds => w ~ 2n/1.2e5.
  const w = Math.min(256, Math.max(8, Math.round((2 * n) / 120_000)));
  return { k, w };
}
