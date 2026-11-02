import { kmerHashes } from "./hash.js";
import { selectMinimizers } from "./minimizer.js";
import { radixOrder } from "./radix.js";

/**
 * A seed index: the reference sequence's minimisers, sorted by hash so that a
 * query minimiser can be looked up with one binary search.
 *
 * `strand[i]` records which strand produced the canonical hash. Two positions
 * holding the same canonical hash means their k-mers are reverse complements of
 * each other; XOR-ing the two strand bits recovers the relative orientation of
 * the hit, which is how inversions are detected later.
 */
export interface SeedIndex {
  hashes: Uint32Array;
  poss: Int32Array;
  strands: Uint8Array;
  n: number;
  k: number;
  w: number;
}

export function buildIndex(seq: string, k: number, w: number): SeedIndex {
  const { canon, strand, m } = kmerHashes(seq, k);
  const sel = selectMinimizers(canon, m, w);
  const n = sel.length;

  const hashes = new Uint32Array(n);
  const poss = new Int32Array(n);
  const strands = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = sel[i];
    hashes[i] = canon[p];
    poss[i] = p;
    strands[i] = strand[p];
  }

  const order = radixOrder(hashes, n);
  const sh = new Uint32Array(n);
  const sp = new Int32Array(n);
  const sd = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = order[i];
    sh[i] = hashes[o];
    sp[i] = poss[o];
    sd[i] = strands[o];
  }
  return { hashes: sh, poss: sp, strands: sd, n, k, w };
}

/** Index of the first element >= v. */
export function lowerBound(arr: Uint32Array, v: number, n: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
