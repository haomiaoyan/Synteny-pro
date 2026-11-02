/**
 * Content-defined sampling.
 *
 * Within every window of `w` bases, keep the position whose canonical hash is
 * smallest. Because the choice depends only on the content of the window, and
 * not on its phase in the string, two homologues sample the *same* k-mers even
 * after an insertion or a deletion shifts everything downstream.
 *
 * This is the property that makes the whole tool work. A fixed stride does not
 * have it: one indel anywhere upstream desynchronises the sampling and the two
 * sequences stop sharing positions entirely, so a dot plot degenerates into
 * noise past the first rearrangement.
 *
 * Implemented as the standard monotonic-deque sliding-window minimum, which is
 * O(m) and needs no allocation per window.
 */
export function selectMinimizers(canon: Uint32Array, m: number, w: number): number[] {
  const out: number[] = [];
  if (m === 0) return out;

  const win = Math.max(1, Math.min(w | 0, m));
  const dq = new Int32Array(m);
  let head = 0;
  let tail = 0;
  let last = -1;

  for (let i = 0; i < m; i++) {
    const ci = canon[i];
    while (tail > head && canon[dq[tail - 1]] >= ci) tail--;
    dq[tail++] = i;

    const lo = i - win + 1;
    while (dq[head] < lo) head++;

    if (i >= win - 1) {
      const p = dq[head];
      // A window can stay the minimum across many steps; emit it once.
      if (p !== last) {
        out.push(p);
        last = p;
      }
    }
  }
  return out;
}
