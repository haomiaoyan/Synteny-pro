/**
 * Two-pass 16-bit radix sort over Uint32 keys.
 *
 * Returns an index permutation rather than reordering the keys themselves, so
 * the caller can pack several parallel arrays (position, strand) into one sort.
 * Comparison-based sorting of ~1e5 seeds was a visible chunk of the runtime;
 * this is stable, branch-predictable, and linear.
 */
export function radixOrder(keys: Uint32Array, n: number): Uint32Array {
  const out = new Uint32Array(n);
  const tmp = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;

  const cnt = new Uint32Array(65536);
  for (let pass = 0; pass < 2; pass++) {
    const shift = pass * 16;
    cnt.fill(0);
    for (let i = 0; i < n; i++) cnt[(keys[out[i]] >>> shift) & 0xffff]++;
    let sum = 0;
    for (let d = 0; d < 65536; d++) {
      const c = cnt[d];
      cnt[d] = sum;
      sum += c;
    }
    for (let i = 0; i < n; i++) {
      const o = out[i];
      tmp[cnt[(keys[o] >>> shift) & 0xffff]++] = o;
    }
    out.set(tmp);
  }
  return out;
}
