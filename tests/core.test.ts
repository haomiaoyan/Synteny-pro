import { describe, expect, it } from "vitest";
import { kmerHashes } from "../src/core/hash.js";
import { selectMinimizers } from "../src/core/minimizer.js";
import { radixOrder } from "../src/core/radix.js";
import { buildIndex, lowerBound } from "../src/core/index-ref.js";
import { parseFasta, autoParams } from "../src/core/fasta.js";
import { dna, revcomp } from "./fixtures.js";

describe("hash", () => {
  it("gives a k-mer and its reverse complement the same canonical hash", () => {
    const a = "ACGTACGTTGCA";
    const b = revcomp(a);
    const ha = kmerHashes(a, a.length);
    const hb = kmerHashes(b, b.length);
    expect(ha.canon[0]).toBe(hb.canon[0]);
    // The two strands must disagree, which is how orientation is recovered.
    expect(ha.strand[0]).not.toBe(hb.strand[0]);
  });

  it("gives different hashes to different sequence", () => {
    const ha = kmerHashes("ACGTACGTAC", 8);
    const hb = kmerHashes("ACGTTCGTAC", 8);
    expect(ha.canon[0]).not.toBe(hb.canon[0]);
  });

  it("returns nothing when the sequence is shorter than k", () => {
    expect(kmerHashes("ACG", 5).m).toBe(0);
  });

  it("treats N as a normal base that simply fails to match", () => {
    // N maps to 0, so a k-mer containing it hashes like one containing A.
    // That is acceptable: such k-mers are seeded but never conserved, so they
    // contribute noise rather than false homology.
    const withN = kmerHashes("NNNNN", 5);
    expect(withN.m).toBe(1);
    expect(Number.isFinite(withN.canon[0])).toBe(true);
  });
});

describe("minimizers", () => {
  it("survives a deletion upstream: the sampled k-mers are the same", () => {
    const seq = dna(4000, 1);
    const k = 15;
    const w = 10;
    const full = kmerHashes(seq, k);
    const cut = 1000;
    const trimmed = seq.slice(0, cut) + seq.slice(cut + 7);
    const part = kmerHashes(trimmed, k);

    const a = new Set(selectMinimizers(full.canon, full.m, w).map((p) => full.canon[p]));
    const b = new Set(selectMinimizers(part.canon, part.m, w).map((p) => part.canon[p]));

    let shared = 0;
    for (const v of a) if (b.has(v)) shared++;
    // After an indel a fixed stride would share essentially nothing.
    expect(shared / a.size).toBeGreaterThan(0.8);
  });

  it("samples at the expected 2/(w+1) density", () => {
    const seq = dna(20000, 2);
    const h = kmerHashes(seq, 15);
    const w = 20;
    const sel = selectMinimizers(h.canon, h.m, w);
    const ratio = sel.length / h.m;
    // The density of a (w,k) minimiser scheme is 2/(w+1); a random sequence at
    // this size lands well inside a factor of 1.5 of that.
    const expected = 2 / (w + 1);
    expect(ratio).toBeGreaterThan(expected * 0.66);
    expect(ratio).toBeLessThan(expected * 1.5);
  });

  it("is monotonic in position", () => {
    const h = kmerHashes(dna(3000, 3), 13);
    const sel = selectMinimizers(h.canon, h.m, 15);
    for (let i = 1; i < sel.length; i++) expect(sel[i]).toBeGreaterThan(sel[i - 1]);
  });

  it("degrades gracefully when the window exceeds the sequence", () => {
    const h = kmerHashes("ACGTACGTAC", 5);
    const sel = selectMinimizers(h.canon, h.m, 500);
    expect(sel.length).toBeGreaterThanOrEqual(1);
  });
});

describe("radix sort", () => {
  it("matches a comparison sort on duplicates", () => {
    const keys = new Uint32Array([5, 1, 5, 0, 4294967295, 7, 1, 0]);
    const order = radixOrder(keys, keys.length);
    const got = Array.from(order, (i) => keys[i]);
    expect(got).toEqual([0, 0, 1, 1, 5, 5, 7, 4294967295]);
  });

  it("is stable", () => {
    const keys = new Uint32Array([2, 1, 2, 1]);
    const order = radixOrder(keys, keys.length);
    // Equal keys keep their input order: indices 1,3 then 0,2.
    expect(Array.from(order)).toEqual([1, 3, 0, 2]);
  });

  it("handles an empty input", () => {
    expect(radixOrder(new Uint32Array(0), 0).length).toBe(0);
  });
});

describe("index", () => {
  it("finds the lower bound of present and absent keys", () => {
    const arr = new Uint32Array([1, 3, 3, 5]);
    expect(lowerBound(arr, 0, 4)).toBe(0);
    expect(lowerBound(arr, 3, 4)).toBe(1);
    expect(lowerBound(arr, 4, 4)).toBe(3);
    expect(lowerBound(arr, 9, 4)).toBe(4);
  });

  it("sorts an index by hash", () => {
    const idx = buildIndex(dna(5000, 4), 15, 12);
    for (let i = 1; i < idx.n; i++) {
      expect(idx.hashes[i]).toBeGreaterThanOrEqual(idx.hashes[i - 1]);
    }
  });
});

describe("parseFasta", () => {
  it("splits records and strips junk", () => {
    const seqs = parseFasta(">chr1 description here\nacgtacgt\nNNNN\n>chr2\nGGGG");
    expect(seqs.length).toBe(2);
    expect(seqs[0].name).toBe("chr1");
    expect(seqs[0].seq).toBe("ACGTACGTNNNN");
    expect(seqs[1].seq).toBe("GGGG");
  });

  it("ignores an empty record", () => {
    expect(parseFasta(">a\n\n>b\nACG").length).toBe(1);
  });

  it("handles CRLF line endings", () => {
    const seqs = parseFasta(">a\r\nACGT\r\n>b\r\nTTTT\r\n");
    expect(seqs.map((s) => s.seq)).toEqual(["ACGT", "TTTT"]);
  });

  it("falls back to a name when the header is bare", () => {
    expect(parseFasta(">\nACGT")[0].name).toBe("unnamed");
  });
});

describe("autoParams", () => {
  it("budgets seeds at the real 2/(w+1) density", () => {
    for (const n of [1_000_000, 4_000_000, 20_000_000]) {
      const { k, w } = autoParams(n, n);
      const seeds = n * (2 / (w + 1));
      expect(k).toBeGreaterThanOrEqual(13);
      expect(seeds).toBeLessThan(200_000);
      expect(seeds).toBeGreaterThan(40_000);
    }
  });

  it("never samples denser than w=8, even for a tiny genome", () => {
    const { w } = autoParams(50_000, 50_000);
    expect(w).toBeGreaterThanOrEqual(8);
    expect(w).toBeLessThanOrEqual(256);
  });
});
