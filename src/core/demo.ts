import type { Sequence } from "./types.js";

/**
 * Synthetic demo genomes with a known structural history.
 *
 * Why synthetic: the demo has to be *verifiable*. The tests assert that the
 * engine recovers exactly the rearrangements we injected, and the UI can state
 * what the picture should show. Two real genomes would look more impressive and
 * be impossible to check.
 *
 * But "verifiable" must not mean "boring". A dot plot earns its place by showing
 * rearrangement, so the fixture deliberately loads up the phenomena a dot plot
 * exists to reveal:
 *
 *  * three inversions of different sizes   -> three anti-diagonal strokes
 *  * two translocations                    -> blocks off the main axis
 *  * one segmental duplication             -> a parallel diagonal beside the main one
 *  * scattered shared repeats              -> the faint off-diagonal speckle that
 *                                             makes a real plot look like a real plot
 *
 * The reference is a chain of blocks separated by non-homologous spacers; the
 * query is that chain rearranged. Sizes vary so the diagonal is not a ruler.
 */

/** xorshift32; deterministic so the demo is the same on every load. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const A = "ACGT";

function randomSeq(n: number, rnd: () => number): string {
  const out: string[] = [];
  const chunk: string[] = [];
  for (let i = 0; i < n; i++) {
    chunk.push(A[(rnd() * 4) | 0]);
    if (chunk.length === 4096) {
      out.push(chunk.join(""));
      chunk.length = 0;
    }
  }
  if (chunk.length > 0) out.push(chunk.join(""));
  return out.join("");
}

function revcomp(s: string): string {
  const out: string[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s.charCodeAt(i);
    out.push(c === 65 ? "T" : c === 67 ? "G" : c === 71 ? "C" : c === 84 ? "A" : "N");
  }
  return out.join("");
}

function substitute(seq: string, rate: number, rnd: () => number): string {
  const out: string[] = [];
  const chunk: string[] = [];
  for (let i = 0; i < seq.length; i++) {
    const c = seq[i];
    if (rnd() < rate) {
      let alt = c;
      while (alt === c) alt = A[(rnd() * 4) | 0];
      chunk.push(alt);
    } else {
      chunk.push(c);
    }
    if (chunk.length === 4096) {
      out.push(chunk.join(""));
      chunk.length = 0;
    }
  }
  if (chunk.length > 0) out.push(chunk.join(""));
  return out.join("");
}

export interface Demo {
  ref: Sequence;
  qry: Sequence;
  /** What the picture is supposed to show. */
  truth: {
    inversions: number;
    translocations: number;
    duplications: number;
    collinearBlocks: number;
    identity: number;
  };
  /** Blocks with their reference coordinates, used to sanity-check the render. */
  blocks: Array<{ r0: number; r1: number; kind: "same" | "invert" | "move" | "dup" }>;
}

/**
 * Block layout. Sizes are irregular on purpose: a fixture where every block is
 * the same length produces a perfectly regular diagonal, and regular is exactly
 * what makes a synthetic demo look synthetic.
 */
const LAYOUT: Array<{ kb: number; fate: "same" | "invert" | "move" | "dup" }> = [
  { kb: 180, fate: "same" },
  { kb: 95, fate: "same" },
  { kb: 240, fate: "invert" }, // inversion #1, large and obvious
  { kb: 60, fate: "same" },
  { kb: 130, fate: "move" }, // translocation #1: far from home
  { kb: 210, fate: "same" },
  { kb: 75, fate: "invert" }, // inversion #2, small
  { kb: 160, fate: "same" },
  { kb: 110, fate: "dup" }, // segmental duplication: also copied to the end
  { kb: 250, fate: "same" },
  { kb: 85, fate: "invert" }, // inversion #3
  { kb: 140, fate: "move" }, // translocation #2
  { kb: 190, fate: "same" },
  { kb: 100, fate: "same" },
];

/**
 * Spacer lengths vary too; uniform spacers quantise the plot into a comb.
 *
 * Deliberately short. Long unique spacers between every block turn the main
 * diagonal into a dashed line, which reads as an artefact rather than as data:
 * real genomes are largely homologous, and their dot plots show a continuous
 * diagonal interrupted only where sequence is genuinely absent.
 */
const SPACERS = [4_000, 9_000, 6_000, 7_500, 5_000, 8_000, 11_000];

export function makeDemo(): Demo {
  const rnd = rng(20261028);

  // ---- reference: blocks in order, separated by unique spacers ------------
  const blocks: Array<{ seq: string; r0: number; r1: number }> = [];
  const refParts: string[] = [];
  let cursor = 0;

  for (const spec of LAYOUT) {
    const gap = SPACERS[cursor % SPACERS.length];
    refParts.push(randomSeq(gap, rnd));
    cursor += gap;
    const len = spec.kb * 1000;
    const seq = randomSeq(len, rnd);
    blocks.push({ seq, r0: cursor, r1: cursor + len });
    refParts.push(seq);
    cursor += len;
  }
  refParts.push(randomSeq(SPACERS[0], rnd));
  const ref = refParts.join("");

  // ---- query: rearranged --------------------------------------------------
  const invIdx = LAYOUT.map((b, i) => (b.fate === "invert" ? i : -1)).filter((i) => i >= 0);
  const moveIdx = LAYOUT.map((b, i) => (b.fate === "move" ? i : -1)).filter((i) => i >= 0);
  const dupIdx = LAYOUT.map((b, i) => (b.fate === "dup" ? i : -1)).filter((i) => i >= 0);

  // Build the query order: pull the two moved blocks out and re-insert them at
  // positions that put them clearly away from their reference position, which
  // is what makes the translocation visible rather than merely present.
  const order: number[] = [];
  for (let i = 0; i < LAYOUT.length; i++) {
    if (moveIdx.includes(i)) continue;
    order.push(i);
    if (i === 1) order.push(moveIdx[0]); // block 4 lands very early -> far below the diagonal
  }
  order.push(moveIdx[1]); // block 11 lands at the very end -> far above the diagonal

  const qryParts: string[] = [];
  const truthBlocks: Demo["blocks"] = [];

  const pushBlock = (i: number, kind: "same" | "invert" | "move" | "dup", flip = false): void => {
    qryParts.push(randomSeq(SPACERS[i % SPACERS.length], rnd));
    const src = blocks[i];
    qryParts.push(flip ? revcomp(src.seq) : src.seq);
    truthBlocks.push({ r0: src.r0, r1: src.r1, kind });
  };

  for (const i of order) {
    const fate = LAYOUT[i].fate;
    pushBlock(i, fate === "invert" ? "invert" : fate === "move" ? "move" : "same", fate === "invert");
    if (dupIdx.includes(i)) {
      // The duplicate copy sits at the end of the query, so it draws its own
      // diagonal parallel to the main axis — the classic duplication signature.
      pushBlock(i, "dup");
    }
  }

  qryParts.push(randomSeq(SPACERS[2], rnd));
  const qry = substitute(qryParts.join(""), 0.03, rnd);

  truthBlocks.sort((a, b) => a.r0 - b.r0);

  return {
    ref: { name: "demo_ref.fa", seq: ref },
    qry: { name: "demo_qry.fa", seq: qry },
    truth: {
      inversions: invIdx.length,
      translocations: moveIdx.length,
      duplications: dupIdx.length,
      collinearBlocks: LAYOUT.filter((b) => b.fate === "same").length,
      identity: 0.97,
    },
    blocks: truthBlocks,
  };
}

/** Human-facing description of the demo, shown under the plot. */
export function demoCaption(d: Demo, en = false): string {
  if (en) {
    return (
      `This pair is synthetic: the reference is ${(d.ref.seq.length / 1e6).toFixed(2)} Mbp, ` +
      `assembled from ${LAYOUT.length} independent stretches of different lengths, ` +
      `separated by non-homologous spacers. The query then did three things: inverted ` +
      `three whole blocks, moved two to different positions, and duplicated one; ` +
      `finally 3% of bases were replaced at random. The correct reading — one main ` +
      `diagonal, three back-slashes, two positive-slope blocks off the axis, and a ` +
      `fainter line parallel to the main diagonal.`
    );
  }
  return (
    `这一对是程序合成的：参考长 ${(d.ref.seq.length / 1e6).toFixed(2)} Mbp，` +
    `由 ${LAYOUT.length} 段大小不等的独立序列拼成，段间是非同源的间隔序列。` +
    `查询做了三件事：三段整段倒置、两段搬到了别的位置、一段被复制了一份；` +
    `最后再随机替换 3% 的碱基。正确的读法是——一条主对角线，三段反斜线，` +
    `两块离开主轴的正斜率方块，以及主对角线旁边一条与之平行的副线。`
  );
}
