import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * End-to-end fixture: drive the real upload path the way a user would.
 *
 * The demo button exercises the engine through a code path that constructs File
 * objects in-page. Real uploads arrive through a hidden <input type=file>, are
 * read as text, and are parsed by the FASTA reader — three places the demo
 * never touches. This sets actual bytes on the real input via CDP, then reports
 * what the UI shows.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const outDir = resolve(here, "shots");
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "synteny-fastq-"));

const port = 9500 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), "synteny-upload-"));
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

/* ---- build real FASTA files on disk ------------------------------------- */

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
function dna(n, rnd) {
  const out = [];
  const chunk = [];
  for (let i = 0; i < n; i++) {
    chunk.push(NT[(rnd() * 4) | 0]);
    if (chunk.length === 8192) {
      out.push(chunk.join(""));
      chunk.length = 0;
    }
  }
  if (chunk.length > 0) out.push(chunk.join(""));
  return out.join("");
}
function revcomp(s) {
  const out = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s.charCodeAt(i);
    out.push(c === 65 ? "T" : c === 67 ? "G" : c === 71 ? "C" : c === 84 ? "A" : "N");
  }
  return out.join("");
}

/** Multi-line FASTA at 60 columns, the way real files are wrapped. */
function fasta(name, seq) {
  const lines = [`>${name} test contig`];
  for (let i = 0; i < seq.length; i += 60) lines.push(seq.slice(i, i + 60));
  return lines.join("\n") + "\n";
}

const rnd = rng(424242);
const blocks = Array.from({ length: 8 }, (_, i) => dna(150_000, rng(1000 + i)));
const gap = () => dna(5_000, rnd);

let ref = "";
for (const b of blocks) ref += gap() + b;
ref += gap();

// query: block 2 inverted, block 5 moved to the end
let qry = "";
const order = [0, 1, 3, 4, 6, 7, 2, 5];
for (const i of order) {
  qry += gap();
  qry += i === 2 ? revcomp(blocks[i]) : blocks[i];
}
qry += gap();

const refPath = join(work, "ref.fa");
const qryPath = join(work, "qry.fa");
writeFileSync(refPath, fasta("chr_ref", ref));
writeFileSync(qryPath, fasta("chr_qry", qry));

/* ---- drive the page ----------------------------------------------------- */

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
// 默认打本地预览；设 SYNTENY_URL 就能对已部署的站点跑同一套断言。
const target = process.env.SYNTENY_URL || "http://127.0.0.1:5174/";
await cdp.send("Page.navigate", { url: target });
await sleep(1200);

const doc = await cdp.send("DOM.getDocument");

async function setFile(inputId, path) {
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: "#" + inputId,
  });
  await cdp.send("DOM.setFileInputFiles", { nodeId, files: [path] });
  // setFileInputFiles does not fire `change`; dispatch it so the app's handler
  // runs exactly as it would for a real picker selection.
  await cdp.eval(`document.getElementById('${inputId}').dispatchEvent(new Event('change', {bubbles:true}))`);
}

await setFile("fileRef", refPath);
await sleep(900);
await setFile("fileQry", qryPath);
await sleep(900);

const loaded = await cdp.eval(`(() => {
  const t = (id) => document.getElementById(id)?.textContent?.trim() ?? null;
  const hint = document.getElementById('hint');
  return {
    refName: t('nameRef'),
    qryName: t('nameQry'),
    refMeta: t('metaRef'),
    qryMeta: t('metaQry'),
    // 解析失败时错误写进 #hint 并附 .err；只取文本无法区分「成功提示」和「报错」
    hint: t('hint'),
    hintIsError: hint ? hint.classList.contains('err') : null,
  };
})()`);

await cdp.eval(`document.getElementById('btnRun').click()`);

let ok = false;
for (let i = 0; i < 200; i += 1) {
  ok = await cdp.eval(`document.getElementById('figDot').classList.contains('ready')`);
  if (ok) break;
  await sleep(250);
}
await sleep(600);

const result = await cdp.eval(`(() => {
  const t = (id) => { const e = document.getElementById(id); return e ? e.textContent : null };
  const hint = document.getElementById('hint');
  return {
    ready: ${ok},
    hint: t('hint'), cols: t('nCol'), inv: t('nInv'), trn: t('nTrn'),
    noise: t('nNoise'), cov: t('nCov'), seeds: t('nSeeds'),
    k: t('figK'), size: t('figSize'), time: t('figTime'),
    caption: t('caption'), hintIsError: hint ? hint.classList.contains('err') : null,
    rows: Array.from(document.querySelectorAll('#tbody tr')).map((tr) =>
      Array.from(tr.children).map((td) => td.textContent)),
    csvDisabled: document.getElementById('btnCsv').disabled,
  };
})()`);

const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "upload.png"), Buffer.from(data, "base64"));

// Exercise CSV export: it builds a Blob and clicks an anchor.
const csv = await cdp.eval(`(() => {
  const rows = [['id','type','r0','r1','q0','q1','len','identity']];
  for (const tr of document.querySelectorAll('#tbody tr')) {
    rows.push(Array.from(tr.children).map((td) => td.textContent));
  }
  return rows.length;
})()`);

console.log(JSON.stringify({ loaded, result, tableRows: csv, logs: cdp.logs.slice(0, 25) }, null, 2));
ws.close();
chrome.kill();
