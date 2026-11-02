import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Screenshot harness for the real app.
 *
 * Drives headless Chrome over CDP: load the page, click "打开示例数据", wait for
 * the worker to return, then capture. The waits are condition-based rather than
 * fixed sleeps — a fixed sleep that is too short silently produces a screenshot
 * of a half-drawn plot, which is worse than a failure because it looks fine at
 * a glance.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const width = Number(process.argv[2] || 1280);
const height = Number(process.argv[3] || 1000);
const tag = process.argv[4] || "app";
const url = process.argv[5] || "http://127.0.0.1:5174/";

const outDir = resolve(here, "shots");
mkdirSync(outDir, { recursive: true });

const port = 9500 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), "synteny-app-"));
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
    `--window-size=${width},${height}`,
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
      /* chrome not up yet */
    }
    await sleep(200);
  }
  throw new Error("chrome did not expose a page target");
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleLines = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Runtime.consoleAPICalled") {
        const text = (m.params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
          .join(" ");
        this.consoleLines.push(`[${m.params.type}] ${text}`);
      }
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        this.consoleLines.push(
          `[exception] ${d.text} ${d.exception && d.exception.description ? d.exception.description : ""}`,
        );
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
      }, 120000);
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
  async shot(file) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    const p = join(outDir, file);
    writeFileSync(p, Buffer.from(data, "base64"));
    return p;
  }
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
const cdp = new Cdp(ws);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 2,
  mobile: false,
});

await cdp.send("Page.navigate", { url });
await sleep(1200);

// Click the demo button, then wait for the worker result.
await cdp.eval(`document.getElementById('btnDemo').click()`);

let ready = false;
for (let i = 0; i < 160; i += 1) {
  ready = await cdp.eval(
    `(() => { const d = document.getElementById('figDot'); return d.classList.contains('ready'); })()`,
  );
  if (ready) break;
  await sleep(250);
}

// Give the canvas one animation frame to finish the last draw.
await sleep(500);

const info = await cdp.eval(`(() => {
  const txt = (id) => { const e = document.getElementById(id); return e ? e.textContent : null };
  const rows = Array.from(document.querySelectorAll('#tbody tr')).map((tr) =>
    Array.from(tr.children).map((td) => td.textContent));
  return {
    ready: ${ready},
    hint: txt('hint'),
    figTitle: txt('figTitle'),
    cols: txt('nCol'), inv: txt('nInv'), trn: txt('nTrn'),
    noise: txt('nNoise'), cov: txt('nCov'), seeds: txt('nSeeds'),
    k: txt('figK'), size: txt('figSize'), time: txt('figTime'),
    caption: txt('caption'),
    tableCap: txt('tableCap'),
    rows,
    bodyScrollW: document.body.scrollWidth,
    innerW: innerWidth,
    // x/y are page coordinates so a pixel diff can be restricted to the figure
    // instead of blaming font antialiasing for a canvas regression.
    plotRect: (() => {
      const r = document.getElementById('plot').getBoundingClientRect();
      return {
        x: Math.round(r.x + window.scrollX),
        y: Math.round(r.y + window.scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    })(),
  };
})()`);

await cdp.shot(tag + "-viewport.png");

// Full page too: the editorial layout only reveals itself in the whole scroll.
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width,
  height: 4200,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(700);
await cdp.shot(tag + "-full.png");

console.log(
  JSON.stringify({ info, console: cdp.consoleLines.slice(0, 40) }, null, 2),
);
ws.close();
chrome.kill();
