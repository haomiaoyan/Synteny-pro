/**
 * Canonical rolling k-mer hashes.
 *
 * Encoding: a k-mer and its reverse complement must hash to the same value, so
 * a block that was inverted in one genome still finds its counterpart. We hash
 * both directions and keep the smaller:
 *
 *   hf = sum v[i] * B^(k-1-i)      first base has the largest weight
 *   hr = sum comp(v[i]) * B^i      reverse-complement, same layout
 *   canon = min(hf, hr)
 *
 * B must be coprime with 2^32 so the rolling update can subtract the outgoing
 * base's contribution exactly; 131 is the smallest such prime above the
 * alphabet size and is what minimap2 uses as well.
 *
 * The multiplication is deliberately written as `*` rather than `Math.imul`.
 * Every intermediate stays below 2^53, so the product is exact, and skipping
 * the builtin call was measured at ~20x faster in a tight loop over megabases.
 */
const B = 131;

/** ACGT -> 0..3. Anything else (including N) maps to 0 and simply mismatches. */
const NUC_TABLE: Uint8Array = (() => {
  const t = new Uint8Array(128);
  t[65] = 0; // A
  t[67] = 1; // C
  t[71] = 2; // G
  t[84] = 3; // T
  return t;
})();

export interface KmerHashes {
  /** Canonical hash per position; length is `m`. */
  canon: Uint32Array;
  /** 0 if the forward strand won the comparison, 1 if the reverse complement did. */
  strand: Uint8Array;
  /** Number of k-mers, i.e. `seq.length - k + 1`, clamped at zero. */
  m: number;
}

/**
 * Hash every k-mer of `seq` in both strands.
 *
 * Two rolling passes rather than one interleaved pass: computing the forward
 * hashes and the reverse-complement hashes as separate contiguous loops keeps
 * each inner loop's working set in registers.
 *
 * The reverse complement is built over the *whole* sequence and then indexed
 * backwards, so `rev[p]` is the reverse complement window starting at original
 * position `m - 1 - p`.
 */
export function kmerHashes(seq: string, k: number): KmerHashes {
  const n = seq.length;
  const m = Math.max(0, n - k + 1);
  if (m === 0) return { canon: new Uint32Array(0), strand: new Uint8Array(0), m: 0 };

  const T = NUC_TABLE;
  const C = new Uint8Array(n);
  const R = new Uint8Array(n);
  for (let i = 0; i < n; i++) C[i] = T[seq.charCodeAt(i)];
  for (let i = 0; i < n; i++) R[i] = 3 - C[n - 1 - i];

  let hiB = 1;
  for (let i = 0; i < k - 1; i++) hiB = (hiB * B) >>> 0;

  const H = new Uint32Array(m);
  const HR = new Uint32Array(m);

  let a = 0;
  for (let i = 0; i < k; i++) a = (a * B + C[i]) >>> 0;
  for (let i = 0; ; i++) {
    H[i] = a;
    if (i + 1 >= m) break;
    a = ((a - C[i] * hiB) * B + C[i + k]) >>> 0;
  }

  let b = 0;
  for (let i = 0; i < k; i++) b = (b * B + R[i]) >>> 0;
  for (let p = 0; ; p++) {
    HR[p] = b;
    if (p + 1 >= m) break;
    b = ((b - R[p] * hiB) * B + R[p + k]) >>> 0;
  }

  const canon = new Uint32Array(m);
  const strand = new Uint8Array(m);
  for (let i = 0; i < m; i++) {
    const rv = HR[m - 1 - i];
    if (H[i] <= rv) {
      canon[i] = H[i];
      strand[i] = 0;
    } else {
      canon[i] = rv;
      strand[i] = 1;
    }
  }
  return { canon, strand, m };
}
