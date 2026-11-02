"use strict";

/**
 * Comparison worker.
 *
 * Everything heavy runs here so the page keeps painting while a 50 Mbp
 * comparison is in flight. Messages in and out are plain objects, because the
 * structured clone between page and worker copies typed arrays rather than
 * moving them.
 */

import { runPair } from "../core/compare.js";

export interface RunRequest {
  id: number;
  ref: string;
  qry: string;
  k: number;
  w: number;
}

export interface RunSuccess {
  id: number;
  ok: true;
  segs: Array<{
    id: string;
    type: "col" | "inv" | "trn";
    r0: number;
    r1: number;
    q0: number;
    q1: number;
    len: number;
    seeds: number;
    identity: number;
    dir: 0 | 1;
  }>;
  pts: { r: Int32Array; q: Int32Array; cls: Uint8Array };
  stats: {
    k: number;
    w: number;
    seeds: number;
    chained: number;
    elapsed: number;
    coverage: number;
    nRef: number;
    nQry: number;
  };
}

export interface RunFailure {
  id: number;
  ok: false;
  error: string;
}

export type RunReply = RunSuccess | RunFailure;

self.onmessage = (ev: MessageEvent<RunRequest>): void => {
  const { id, ref, qry, k, w } = ev.data;
  try {
    const res = runPair(ref, qry, { k, w });
    const reply: RunSuccess = {
      id,
      ok: true,
      segs: res.segs,
      pts: res.pts,
      stats: res.stats,
    };
    self.postMessage(reply);
  } catch (err) {
    const reply: RunFailure = {
      id,
      ok: false,
      // Surfaced verbatim in the UI, so it must be a readable sentence.
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(reply);
  }
};
