import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Crop a single element out of the app and capture it at high scale.
 *
 * Reviewing a 4200px full-page shot means looking at the plot through a 3.5x
 * downscale, where every interesting detail is gone. This captures the plot
 * element itself.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const selector = process.argv[2] || "#plot";
const tag = process.argv[3] || "crop";
const scale = Number(process.argv[4] || 2);

const outDir = resolve(here, "shots");
mkdirSync(outDir, { recursive: true });

const port = 9500 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), "synteny-crop-"));
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
    "--window-size=1400,1100",
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
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
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
  width: 1400,
  height: 1100,
  deviceScaleFactor: scale,
  mobile: false,
});
await cdp.send("Page.navigate", { url: "http://127.0.0.1:5174/" });
await sleep(1200);
await cdp.eval(`document.getElementById('btnDemo').click()`);
for (let i = 0; i < 160; i += 1) {
  const ok = await cdp.eval(`document.getElementById('figDot').classList.contains('ready')`);
  if (ok) break;
  await sleep(250);
}
await sleep(600);

// Scroll the element into view before measuring, otherwise the rect is off
// screen and Page.captureScreenshot with a clip yields a blank image.
await cdp.eval(`document.querySelector('${selector}').scrollIntoView({block:'center'})`);
await sleep(400);

// Clip coordinates for captureBeyondViewport are document coordinates, while
// getBoundingClientRect is viewport-relative. Adding the scroll offset is what
// makes the crop land on the element instead of on the top of the page.
const rect = await cdp.eval(
  `(() => { const r = document.querySelector('${selector}').getBoundingClientRect();
     return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY),
              w: Math.round(r.width), h: Math.round(r.height) } })()`,
);

const { data } = await cdp.send("Page.captureScreenshot", {
  format: "png",
  clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 },
  captureBeyondViewport: true,
});
const p = join(outDir, tag + ".png");
writeFileSync(p, Buffer.from(data, "base64"));
console.log(JSON.stringify({ rect, file: p }));
ws.close();
chrome.kill();
