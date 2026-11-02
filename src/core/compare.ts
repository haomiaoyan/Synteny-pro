import type { RunResult, Segment, SegmentType, SeedPoints } from "./types.js";
import { kmerHashes } from "./hash.js";
import { selectMinimizers } from "./minimizer.js";
import { buildIndex, lowerBound } from "./index-ref.js";

/**
 * How many reference hits one query minimiser may contribute.
 *
 * A minimiser inside a repeat family can match thousands of places. Keeping all
 * of them makes the seed set explode and the chains meaningless, so each query
 * minimiser is capped; the effect is that repeats show up as a light fog of
 * noise points rather than a solid band.
 */
const MAX_HITS = 24;

/** Minimum seeds before a chain is allowed to become a reported block. */
const MIN_SEEDS = 5;

/** A diagonal is "the same diagonal" within this many bases. */
function diagonalTolerance(nRef: number, nQry: number): number {
  return Math.max(32, Math.round(Math.max(nRef, nQry) * 0.0008));
}

/** Largest query gap a chain may jump over without breaking. */
function maxChainGap(w: number): number {
  return Math.max(w * 40, 6000);
}

/** Blocks shorter than this are not reported. */
function minBlockLength(w: number): number {
  return Math.max(w * 60, 3000);
}

interface Blast {
  r: number;
  q: number;
  d: number;
}

interface Chain {
  dir: 0 | 1;
  q0: number;
  q1: number;
  r0: number;
  r1: number;
  /** Distinct query positions, not raw hit count. */
  n: number;
  dRef: number;
  lenQ: number;
  lenR: number;
}

export interface RunOptions {
  k: number;
  w: number;
}

/**
 * Compare two sequences and return the blocks they share.
 *
 * The pipeline is: seed -> chain -> classify -> report.
 *
 *  * **Seed.** Every query minimiser is looked up in the reference index; each
 *    hit becomes a point (reference position, query position, relative strand).
 *  * **Chain.** Hits of the same orientation are grouped by diagonal offset
 *    `d` (either `r - q` for same-strand or `r + q` for opposite-strand) and
 *    walked in query order, allowing a bounded gap.
 *  * **Classify.** Chains are typed by asking which of them can coexist on one
 *    monotone path through both genomes. That is a longest-increasing-
 *    subsequence problem, and it is what distinguishes "this block stayed where
 *    it was" from "this block moved somewhere else".
 *  * **Report.** Blocks are filtered by length and given identifiers.
 */
export function runPair(refSeq: string, qrySeq: string, opts: RunOptions): RunResult {
  const t0 = now();
  const { k, w } = opts;
  const nR = refSeq.length;
  const nQ = qrySeq.length;

  const idx = buildIndex(refSeq, k, w);
  const qh = kmerHashes(qrySeq, k);
  const qSel = selectMinimizers(qh.canon, qh.m, w);

  // ---- seed ----
  // Start at a generous size and only grow for repeat-heavy input, which keeps
  // the common case to a single allocation.
  let cap = Math.max(1024, qSel.length * 4);
  let hitR = new Int32Array(cap);
  let hitQ = new Int32Array(cap);
  let hitDir = new Uint8Array(cap);
  let hitCount = 0;

  const H = idx.hashes;
  const P = idx.poss;
  const S = idx.strands;
  const HN = idx.n;

  const grow = (): void => {
    cap *= 2;
    const nr = new Int32Array(cap);
    const nq = new Int32Array(cap);
    const nd = new Uint8Array(cap);
    nr.set(hitR.subarray(0, hitCount));
    nq.set(hitQ.subarray(0, hitCount));
    nd.set(hitDir.subarray(0, hitCount));
    hitR = nr;
    hitQ = nq;
    hitDir = nd;
  };

  for (let si = 0; si < qSel.length; si++) {
    const q = qSel[si];
    const h = qh.canon[q];
    const qs = qh.strand[q];
    let i = lowerBound(H, h, HN);
    let taken = 0;
    for (; i < HN && H[i] === h && taken < MAX_HITS; i++, taken++) {
      if (hitCount >= cap) grow();
      hitR[hitCount] = P[i];
      hitQ[hitCount] = q;
      // Same canonical hash with different strand bits means the hit is flipped.
      hitDir[hitCount] = (qs ^ S[i]) as 0 | 1;
      hitCount++;
    }
  }

  // ---- chain ----
  const chains = chainHits(hitR, hitQ, hitDir, hitCount, k, w, nR, nQ);

  // ---- classify ----
  const segs = classifyChains(chains, qSel, k, w);

  const kept = segs.filter((s) => s.len >= minBlockLength(w));
  kept.sort((a, b) => a.r0 - b.r0);
  kept.forEach((s, i) => {
    s.id = "s_" + String(i + 1).padStart(3, "0");
  });

  // ---- point tinting ----
  const pts = tintPoints(hitR, hitQ, hitCount, kept, k);

  const stats = {
    k,
    w,
    seeds: hitCount,
    chained: kept.reduce((sum, s) => sum + s.seeds, 0),
    elapsed: now() - t0,
    coverage: coveredFraction(kept, nR),
    nRef: nR,
    nQry: nQ,
  };

  return { segs: kept, pts, stats };
}

/**
 * Fraction of the reference covered by reported blocks.
 *
 * Computed as the length of the union of intervals, not the sum of block
 * lengths: a block that appears twice in the query maps twice onto the same
 * reference span, and summing would report coverage above 100%.
 */
function coveredFraction(segs: readonly Segment[], nR: number): number {
  if (segs.length === 0) return 0;
  const iv = segs.map((s) => [Math.max(0, s.r0), Math.min(nR, s.r1 + 1)] as const);
  iv.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curLo = iv[0][0];
  let curHi = iv[0][1];
  for (let i = 1; i < iv.length; i++) {
    const [lo, hi] = iv[i];
    if (lo > curHi) {
      total += curHi - curLo;
      curLo = lo;
      curHi = hi;
    } else if (hi > curHi) {
      curHi = hi;
    }
  }
  total += curHi - curLo;
  return Math.min(1, Math.max(0, total) / Math.max(1, nR));
}

function chainHits(
  hitR: Int32Array,
  hitQ: Int32Array,
  hitDir: Uint8Array,
  hitCount: number,
  k: number,
  w: number,
  nR: number,
  nQ: number,
): Chain[] {
  const tol = diagonalTolerance(nR, nQ);
  const maxGap = maxChainGap(w);
  const chains: Chain[] = [];

  for (let dir = 0 as 0 | 1; dir <= 1; dir = (dir + 1) as 0 | 1) {
    const list: Blast[] = [];
    for (let i = 0; i < hitCount; i++) {
      if (hitDir[i] !== dir) continue;
      const r = hitR[i];
      const q = hitQ[i];
      list.push({ r, q, d: dir === 0 ? r - q : r + q });
    }
    if (list.length === 0) continue;

    // Sort by diagonal, then by query position along that diagonal.
    list.sort((a, b) => a.d - b.d || a.q - b.q);

    let cur: {
      dRef: number;
      q0: number;
      qL: number;
      qLast: number;
      r0: number;
      rL: number;
      n: number;
    } | null = null;

    const flush = (): void => {
      if (cur !== null && cur.n >= MIN_SEEDS) {
        chains.push({
          dir,
          q0: cur.q0,
          q1: cur.qL,
          r0: cur.r0,
          r1: cur.rL,
          n: cur.n,
          dRef: cur.dRef,
          lenQ: cur.qL - cur.q0 + k,
          lenR: cur.rL - cur.r0 + k,
        });
      }
      cur = null;
    };

    for (const it of list) {
      const inChain =
        cur !== null &&
        Math.abs(it.d - cur.dRef) <= tol &&
        it.q - cur.qL <= maxGap &&
        it.q >= cur.qL - tol;

      if (inChain && cur !== null) {
        // Count distinct query positions: a repeat can produce several hits at
        // one query offset, and letting them all count would inflate identity.
        if (it.q !== cur.qLast) {
          cur.n++;
          cur.qLast = it.q;
        }
        cur.qL = it.q;
        cur.rL = it.r;
      } else {
        flush();
        cur = { dRef: it.d, q0: it.q, qL: it.q, qLast: it.q, r0: it.r, rL: it.r, n: 1 };
      }
    }
    flush();
  }
  return chains;
}

/**
 * Assign each chain a type.
 *
 * Same-strand chains are either part of the conserved backbone or moved away
 * from it. Deciding which is a weighted longest-increasing-subsequence over
 * (reference start, query start): the maximum-weight increasing set *is* the
 * backbone, and everything left over is a translocation.
 *
 * The earlier version of this file compared diagonal offsets instead. That is
 * wrong in a way that matters: real genomes accumulate small indels, so the
 * diagonal offset drifts across every block and almost nothing has a constant
 * one. Sorting by position and asking for a monotone path is insensitive to
 * that drift.
 */
function classifyChains(chains: Chain[], qSel: number[], k: number, _w: number): Segment[] {
  const fwd: Chain[] = [];
  const inv: Chain[] = [];
  for (const c of chains) {
    if (c.dir === 1) inv.push(c);
    else fwd.push(c);
  }
  fwd.sort((a, b) => a.r0 - b.r0);

  const m = fwd.length;
  const best = new Float64Array(m);
  const prev = new Int32Array(m).fill(-1);
  for (let i = 0; i < m; i++) {
    const wi = fwd[i].lenR;
    best[i] = wi;
    for (let j = 0; j < i; j++) {
      if (fwd[j].q0 < fwd[i].q0 && best[j] + wi > best[i]) {
        best[i] = best[j] + wi;
        prev[i] = j;
      }
    }
  }
  let bi = -1;
  for (let i = 0; i < m; i++) if (bi < 0 || best[i] > best[bi]) bi = i;
  const backbone = new Set<number>();
  for (let i = bi; i >= 0; i = prev[i]) backbone.add(i);

  const segs: Segment[] = [];
  fwd.forEach((c, i) => segs.push(makeSegment(c, backbone.has(i) ? "col" : "trn", qSel, k)));
  for (const c of inv) segs.push(makeSegment(c, "inv", qSel, k));
  return segs;
}

/**
 * Count of query minimisers in [lo, hi].
 *
 * `qSel` is ascending by construction, so two binary searches suffice.
 */
function countMinimizersIn(qSel: number[], lo: number, hi: number): number {
  const firstAtLeast = (v: number): number => {
    let a = 0;
    let b = qSel.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (qSel[mid] < v) a = mid + 1;
      else b = mid;
    }
    return a;
  };
  const firstAbove = (v: number): number => {
    let a = 0;
    let b = qSel.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (qSel[mid] <= v) a = mid + 1;
      else b = mid;
    }
    return a;
  };
  return Math.max(0, firstAbove(hi) - firstAtLeast(lo));
}

/**
 * Estimate base identity from seed density.
 *
 * If a base survives unchanged with probability p, a whole k-mer survives with
 * probability p^k. The observed fraction of query minimisers that found a
 * place in this block is therefore about p^k, and inverting that gives p.
 *
 * This is an estimate, not a measurement: it inherits the sampling bias of
 * minimisers (a mutation can lift a window's minimum away, losing a seed that
 * had no mismatching k-mer) and so reads slightly low. Reported to one decimal
 * and labelled as estimated in the UI.
 */
function estimateIdentity(seeds: number, spanLo: number, spanHi: number, qSel: number[], k: number): number {
  const total = Math.max(1, countMinimizersIn(qSel, spanLo, spanHi));
  const frac = Math.min(1, seeds / total);
  const p = Math.pow(Math.max(frac, 1e-9), 1 / k);
  return Math.max(0.5, Math.min(1, p));
}

function makeSegment(c: Chain, type: SegmentType, qSel: number[], k: number): Segment {
  const len = Math.max(c.lenR, c.lenQ);
  const qLo = Math.min(c.q0, c.q1);
  const qHi = Math.max(c.q0, c.q1);
  const identity = estimateIdentity(c.n, qLo, qHi, qSel, k);

  // Orientation must be preserved. Taking min/max on q for an inverted block
  // would draw it as an ascending diagonal, i.e. make the inversion invisible.
  const flip = c.dir === 1;
  return {
    id: "",
    type,
    r0: Math.min(c.r0, c.r1),
    r1: Math.max(c.r0, c.r1),
    q0: flip ? qHi : qLo,
    q1: flip ? qLo : qHi,
    len,
    seeds: c.n,
    identity,
    dir: c.dir,
  };
}

/**
 * Tag every seed with the type of block it supports, so the plot can draw the
 * actual hits instead of a fitted line. Seeds belonging to no block are noise.
 */
function tintPoints(
  hitR: Int32Array,
  hitQ: Int32Array,
  hitCount: number,
  segs: readonly Segment[],
  k: number,
): SeedPoints {
  const TIER: Record<SegmentType, number> = { col: 0, inv: 1, trn: 2 };
  const cls = new Uint8Array(hitCount).fill(3);
  for (let i = 0; i < hitCount; i++) {
    const r = hitR[i];
    const q = hitQ[i];
    let best = 3;
    for (const s of segs) {
      const rLo = Math.min(s.r0, s.r1) - k;
      const rHi = Math.max(s.r0, s.r1) + k;
      if (r < rLo || r > rHi) continue;
      const qLo = Math.min(s.q0, s.q1) - k;
      const qHi = Math.max(s.q0, s.q1) + k;
      if (q < qLo || q > qHi) continue;
      if (TIER[s.type] < best) best = TIER[s.type];
    }
    cls[i] = best;
  }
  return {
    r: hitR.subarray(0, hitCount),
    q: hitQ.subarray(0, hitCount),
    cls: cls.subarray(0, hitCount),
  };
}

/** Monotonic clock that works in both Node (tests) and the browser. */
function now(): number {
  if (typeof performance !== "undefined") return performance.now();
  return Date.now();
}
