import { describe, expect, it } from "vitest";
import { runPair } from "../src/core/compare.js";
import { dna, mutate, revcomp } from "./fixtures.js";

/**
 * Block fixtures, described the way a biologist would describe them.
 *
 * `move` blocks are placed in the middle of the reference and rotated to the
 * end of the query, which is what breaks collinearity. A block that is last on
 * both sides stays collinear no matter where it is moved to.
 */
interface Layout {
  blocks: Array<{ len: number; kind: "same" | "invert" | "move" }>;
  gap: number;
}

/**
 * Build a reference and a query from a block layout.
 *
 * Every gap gets its *own* random filler. Reusing one filler string would make
 * it a genuine repeat present in both genomes, and the engine would (correctly)
 * report those copies as conserved blocks — a fixture artefact, not a result.
 *
 * Inverted blocks are reverse-complemented in place.
 */
function build(layout: Layout, seed: number) {
  const parts: string[] = [];
  let r = 0;
  let gapSeq = 0;
  const placed: Array<{ seq: string; r0: number; kind: string }> = [];
  const freshGap = (): string => dna(layout.gap, seed * 1000 + gapSeq++);

  for (const b of layout.blocks) {
    const f = freshGap();
    parts.push(f);
    r += f.length;
    const seq = dna(b.len, seed + r);
    placed.push({ seq, r0: r, kind: b.kind });
    parts.push(seq);
    r += b.len;
  }
  parts.push(freshGap());
  const ref = parts.join("");

  const stays = placed.filter((p) => p.kind !== "move");
  const moves = placed.filter((p) => p.kind === "move");
  const qParts: string[] = [freshGap()];
  for (const p of [...stays, ...moves]) {
    qParts.push(p.kind === "invert" ? revcomp(p.seq) : p.seq);
    qParts.push(freshGap());
  }
  const qry = qParts.join("");
  return { ref, qry, placed };
}

const OPTS = { k: 13, w: 12 };

describe("runPair on synthetic genomes", () => {
  it("reports nothing when the two genomes are unrelated", () => {
    const ref = dna(120_000, 1);
    const qry = dna(120_000, 2);
    const res = runPair(ref, qry, OPTS);
    expect(res.segs.length).toBe(0);
  });

  it("finds one collinear block for identical input", () => {
    const seq = dna(120_000, 3);
    const res = runPair(seq, seq, OPTS);
    expect(res.segs.length).toBe(1);
    expect(res.segs[0].type).toBe("col");
    expect(res.segs[0].identity).toBeGreaterThan(0.97);
    expect(res.stats.coverage).toBeGreaterThan(0.9);
  });

  it("marks a reverse-complemented input as an inversion", () => {
    const seq = dna(120_000, 4);
    const res = runPair(seq, revcomp(seq), OPTS);
    expect(res.segs.length).toBe(1);
    expect(res.segs[0].type).toBe("inv");
    expect(res.segs[0].dir).toBe(1);
    // The drawn diagonal must descend: q0 > q1 for an inverted block.
    expect(res.segs[0].q0).toBeGreaterThan(res.segs[0].q1);
  });

  it("separates a collinear backbone from a translocated block", () => {
    const { ref, qry } = build(
      {
        gap: 6000,
        blocks: [
          { len: 40_000, kind: "same" },
          { len: 25_000, kind: "move" },
          { len: 40_000, kind: "same" },
        ],
      },
      11,
    );
    const res = runPair(ref, qry, OPTS);
    const cols = res.segs.filter((s) => s.type === "col");
    const trns = res.segs.filter((s) => s.type === "trn");
    expect(cols.length).toBeGreaterThanOrEqual(2);
    expect(trns.length).toBe(1);
    // The moved block is about 25 kb; the tolerance covers the filler margins.
    expect(trns[0].len).toBeGreaterThan(18_000);
    expect(trns[0].len).toBeLessThan(32_000);
  });

  it("handles a mixed layout: two collinear, one inverted, one moved", () => {
    const { ref, qry } = build(
      {
        gap: 5000,
        blocks: [
          { len: 30_000, kind: "same" },
          { len: 20_000, kind: "move" },
          { len: 20_000, kind: "invert" },
          { len: 30_000, kind: "same" },
        ],
      },
      21,
    );
    const res = runPair(ref, qry, OPTS);
    const count = (t: string): number => res.segs.filter((s) => s.type === t).length;
    expect(count("col")).toBeGreaterThanOrEqual(2);
    expect(count("inv")).toBeGreaterThanOrEqual(1);
    expect(count("trn")).toBeGreaterThanOrEqual(1);
    // The two collinear blocks account for about 60 kb of a 100 kb reference,
    // so a wrong call of "everything is conserved" would show up here.
    expect(res.stats.coverage).toBeLessThan(0.95);
  });

  it("still finds a block after a short indel shifts everything downstream", () => {
    const { ref, qry } = build(
      {
        gap: 5000,
        blocks: [
          { len: 30_000, kind: "same" },
          { len: 30_000, kind: "same" },
        ],
      },
      31,
    );
    // Delete 101 bases in the middle of the query. A phase-locked sampler would
    // lose every seed past this point; a content-defined one should not.
    const cut = Math.floor(qry.length / 2);
    const gapped = qry.slice(0, cut) + qry.slice(cut + 101);
    const res = runPair(ref, gapped, OPTS);
    expect(res.segs.length).toBeGreaterThanOrEqual(1);
    expect(res.stats.coverage).toBeGreaterThan(0.4);
  });

  it("reports lower identity for a mutated block", () => {
    const seq = dna(120_000, 41);
    const mut = mutate(seq, 0.05, 777);
    const res = runPair(seq, mut, OPTS);
    expect(res.segs.length).toBeGreaterThanOrEqual(1);
    const top = res.segs[0];
    // 5% substitution. The seed-density estimate is biased low by design, so
    // the assertion is a window, not an equality.
    expect(top.identity).toBeGreaterThan(0.8);
    expect(top.identity).toBeLessThan(0.98);
  });

  it("returns seed points that fall inside a reported block", () => {
    const { ref, qry } = build(
      { gap: 5000, blocks: [{ len: 40_000, kind: "same" }] },
      51,
    );
    const res = runPair(ref, qry, OPTS);
    expect(res.pts.r.length).toBe(res.stats.seeds);
    let inBlock = 0;
    for (let i = 0; i < res.pts.r.length; i++) {
      if (res.pts.cls[i] !== 3) inBlock++;
    }
    // Most seeds must be claimed by the block; the rest are chance hits in filler.
    expect(inBlock / res.pts.r.length).toBeGreaterThan(0.6);
  });

  it("caps the work for a repeat-heavy input instead of hanging", () => {
    // A low-complexity genome is the pathological case for a seeding index.
    const ref = "ACGT".repeat(30_000);
    const qry = "ACGT".repeat(30_000);
    const t0 = Date.now();
    const res = runPair(ref, qry, OPTS);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(Number.isFinite(res.stats.seeds)).toBe(true);
  });

  it("does not report coverage above 100% for a duplicated block", () => {
    // The same block twice in the query: a summing implementation would report
    // ~200% coverage of the reference.
    const block = dna(40_000, 61);
    const ref = dna(6000, 62) + block + dna(6000, 63);
    const qry = dna(6000, 64) + block + dna(6000, 65) + block + dna(6000, 66);
    const res = runPair(ref, qry, OPTS);
    expect(res.stats.coverage).toBeLessThanOrEqual(1);
    expect(res.stats.coverage).toBeGreaterThan(0.5);
  });
});
