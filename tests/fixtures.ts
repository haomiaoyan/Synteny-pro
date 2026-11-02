/**
 * Shared fixtures for the test suite.
 *
 * These live outside the `*.test.ts` files on purpose. Importing a helper from
 * a spec file also re-registers that spec's own `describe`/`it` blocks, so the
 * tests silently run twice and failures are reported under the wrong file —
 * a confusing enough trap to be worth a dedicated module.
 */

/**
 * Deterministic pseudo-random DNA.
 *
 * xorshift32 rather than Math.random: a ground-truth test that changes its
 * fixture between runs cannot distinguish a real regression from noise.
 */
export function dna(n: number, seed: number): string {
  let s = seed >>> 0 || 1;
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    buf[i] = s & 3;
  }
  const A = "ACGT";
  let out = "";
  for (let i = 0; i < n; i += 4096) {
    out += Array.from(buf.subarray(i, Math.min(n, i + 4096)), (v) => A[v]).join("");
  }
  return out;
}

/** Substitution mutations at the given per-base rate. */
export function mutate(seq: string, rate: number, seed: number): string {
  let s = seed >>> 0 || 1;
  let out = "";
  for (let i = 0; i < seq.length; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    if (s / 4294967296 < rate) {
      const alt = "ACGT".replace(seq[i], "");
      out += alt[(s >>> 8) % 3];
    } else {
      out += seq[i];
    }
  }
  return out;
}

/** Reverse complement over the engine's alphabet. */
export function revcomp(s: string): string {
  const map: Record<string, string> = { A: "T", C: "G", G: "C", T: "A", N: "N" };
  let out = "";
  for (let i = s.length - 1; i >= 0; i--) out += map[s[i]] ?? "N";
  return out;
}
