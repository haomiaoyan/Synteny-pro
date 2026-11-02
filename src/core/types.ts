/** Shared domain types for the dot-plot engine. */

/** A sequence as the engine sees it: a plain ACGT string plus a display name. */
export interface Sequence {
  readonly name: string;
  /** Upper-case, DNA alphabet only, N allowed. */
  readonly seq: string;
}

/** How two homologous blocks sit relative to each other. */
export type SegmentType = "col" | "inv" | "trn";

/** One collinear run of seeds reported to the UI. */
export interface Segment {
  id: string;
  type: SegmentType;
  /** Reference start, always the smaller coordinate. */
  r0: number;
  /** Reference end, always the larger coordinate. */
  r1: number;
  /**
   * Query start. For an inverted segment this is the *larger* coordinate,
   * so that (r0,q0)->(r1,q1) draws the descending diagonal that an
   * inversion actually is.
   */
  q0: number;
  q1: number;
  /** Block length in bases (the longer of the two axes). */
  len: number;
  /** Number of seeds that produced this block. */
  seeds: number;
  /** Estimated base identity in [0,1]. */
  identity: number;
  /** 0 = same strand, 1 = opposite strand. */
  dir: 0 | 1;
}

/** Raw seed hits, kept so the plot can draw actual points rather than fitted lines. */
export interface SeedPoints {
  r: Int32Array;
  q: Int32Array;
  /**
   * Tier index per seed: 0 = collinear, 1 = inverted, 2 = translocated,
   * 3 = noise (a hit that belongs to no reported block).
   */
  cls: Uint8Array;
}

export interface RunStats {
  /** k-mer length used. */
  k: number;
  /** Minimiser window, in bases. */
  w: number;
  seeds: number;
  chained: number;
  /** Wall-clock milliseconds for the whole comparison. */
  elapsed: number;
  /** Fraction of the reference covered by reported blocks, in [0,1]. */
  coverage: number;
  nRef: number;
  nQry: number;
}

export interface RunResult {
  segs: Segment[];
  pts: SeedPoints;
  stats: RunStats;
}
