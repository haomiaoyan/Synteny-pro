import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * Edge-case matrix for the upload path.
 *
 * Each case is a thing a visitor might actually do, and each has a *specific*
 * correct answer that is different from the other cases. A test that only
 * checks "it didn't crash" would pass while the app silently reported garbage.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const outDir = resolve(here, "shots");
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "synteny-edge-"));

const port = 9500 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), "synteny-edge-prof-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new", "--lang=zh-CN",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,1100",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 150; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const tabs = await res.json();
      const p = tabs.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("no page target");
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Runtime.consoleAPICalled") {
        this.logs.push(
          `[${m.params.type}] ` +
            (m.params.args || [])
              .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
              .join(" "),
        );
      }
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        this.logs.push(`[exception] ${d.text} ${d.exception?.description ?? ""}`);
      }
      if (m.id && this.pending.has(m.id)) {
        const { resolve: res, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error("timeout " + method));
        }
      }, 180000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails, null, 2));
    return r.result.value;
  }
}

function rng(seed) {
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
const NT = "ACGT";
function dna(n, r) {
  const parts = [];
  const chunk = [];
  for (let i = 0; i < n; i++) {
    chunk.push(NT[(r() * 4) | 0]);
    if (chunk.length === 8192) {
      parts.push(chunk.join(""));
      chunk.length = 0;
    }
  }
  if (chunk.length) parts.push(chunk.join(""));
  return parts.join("");
}
function fasta(name, seq) {
  const lines = [`>${name}`];
  for (let i = 0; i < seq.length; i += 60) lines.push(seq.slice(i, i + 60));
  return lines.join("\n") + "\n";
}

/* ---- fixtures ----------------------------------------------------------- */

const G = () => dna(4_000, rng(Math.floor(Math.random() * 1e9)));
const blocks = Array.from({ length: 6 }, (_, i) => dna(120_000, rng(7000 + i)));
let shared = "";
for (const b of blocks) shared += G() + b;
shared += G();

// 1. identical genome vs itself
const cases = [
  {
    name: "identical",
    ref: fasta("same_ref", shared),
    qry: fasta("same_qry", shared),
    expect: { inv: 0, trn: 0, note: "one collinear span covering everything" },
  },
  // 2. completely unrelated genomes of similar size
  {
    name: "unrelated",
    ref: fasta("rand_a", dna(700_000, rng(111))),
    qry: fasta("rand_b", dna(700_000, rng(222))),
    expect: { inv: 0, trn: 0, note: "no conserved blocks at all, or a trivial one" },
  },
  // 3. gzipped FASTA — what people actually download from NCBI
  {
    name: "gzip",
    ref: fasta("gz_ref", shared),
    qry: fasta("gz_qry", shared),
    gzip: ["qry"],
    expect: { inv: 0, trn: 0, note: "must be accepted; same content as case 1" },
  },
];

const paths = [];
for (const c of cases) {
  const rp = join(work, c.name + "_ref.fa");
  const qp = join(work, c.name + "_qry.fa" + (c.gzip ? ".gz" : ""));
  writeFileSync(rp, c.ref);
  if (c.gzip) writeFileSync(qp, gzipSync(Buffer.from(c.qry, "utf8")));
  else writeFileSync(qp, c.qry);
  paths.push({ name: c.name, ref: rp, qry: qp, expect: c.expect });
}

/* ---- run ---------------------------------------------------------------- */

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
const cdp = new Cdp(ws);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("DOM.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1100,
  deviceScaleFactor: 1,
  mobile: false,
});
await cdp.send("Page.navigate", { url: "http://127.0.0.1:5174/" });
await sleep(1200);

const results = [];

for (const p of paths) {
  // Reload every case: module state (S.ref, the worker, the canvas) is not
  // designed to be reset, and a reload is the honest way to test a fresh visit.
  await cdp.send("Page.navigate", { url: "http://127.0.0.1:5174/" });
  await sleep(1100);
  const doc = await cdp.send("DOM.getDocument");

  const setFile = async (id, path) => {
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: "#" + id,
    });
    await cdp.send("DOM.setFileInputFiles", { nodeId, files: [path] });
    await cdp.eval(`document.getElementById('${id}').dispatchEvent(new Event('change',{bubbles:true}))`);
  };

  await setFile("fileRef", p.ref);
  await sleep(800);
  await setFile("fileQry", p.qry);
  await sleep(1000);

  const hintAfterLoad = await cdp.eval(`document.getElementById('hint').textContent`);

  const canRun = await cdp.eval(`!document.getElementById('btnRun').disabled`);
  if (!canRun) {
    results.push({ name: p.name, stage: "load", hint: hintAfterLoad, ran: false });
    continue;
  }

  await cdp.eval(`document.getElementById('btnRun').click()`);

  let ready = false;
  for (let i = 0; i < 160; i += 1) {
    ready = await cdp.eval(`document.getElementById('figDot').classList.contains('ready')`);
    if (ready) break;
    await sleep(250);
  }

  const info = await cdp.eval(`(() => {
    const t = (id) => { const e = document.getElementById(id); return e ? e.textContent : null };
    return { hint: t('hint'), cols: t('nCol'), inv: t('nInv'), trn: t('nTrn'),
             noise: t('nNoise'), cov: t('nCov'), seeds: t('nSeeds'),
             caption: t('caption'), rows: document.querySelectorAll('#tbody tr').length };
  })()`);

  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, "edge-" + p.name + ".png"), Buffer.from(data, "base64"));

  results.push({ name: p.name, ran: true, ready, ...info, expect: p.expect });
}

console.log(JSON.stringify({ results, logs: cdp.logs.slice(0, 30) }, null, 2));
ws.close();
chrome.kill();
