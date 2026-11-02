import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Interaction test: everything a visitor touches with a mouse or a keyboard.
 *
 * A screenshot can prove the page renders; it cannot prove that hovering names
 * a coordinate, that dragging zooms, or that a click selects the block under
 * the pointer. Each block below drives a real input event and then reads the
 * visible consequence out of the DOM.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const outDir = resolve(here, "shots");
mkdirSync(outDir, { recursive: true });

const port = 9800 + Math.floor(Math.random() * 150);
const profile = mkdtempSync(join(tmpdir(), "synteny-int-prof-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new", "--lang=zh-CN", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars", "--force-color-profile=srgb",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--window-size=1440,1100", "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wsUrl() {
  for (let i = 0; i < 150; i += 1) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = tabs.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("no target");
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Runtime.consoleAPICalled")
        this.logs.push(`[${m.params.type}] ${(m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ")}`);
      if (m.method === "Runtime.exceptionThrown")
        this.logs.push(`[exception] ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description ?? ""}`);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error("timeout " + method)); } }, 120000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      // 先给消息，再给被截断的原始结构：只留结构会正好把原因切掉。
      const d = r.exceptionDetails;
      const msg = d.exception?.description ?? d.text ?? "unknown";
      throw new Error(`${msg}\n--- raw: ${JSON.stringify(d).slice(0, 600)}`);
    }
    return r.result.value;
  }
  async shot(name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, name), Buffer.from(data, "base64"));
  }
  mouse(type, x, y, extra = {}) {
    return this.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
  }
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
const cdp = new Cdp(ws);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 2, mobile: false });
// 默认打本地预览；设 SYNTENY_URL 就能对已部署的站点跑同一套断言。
const target = process.env.SYNTENY_URL || "http://127.0.0.1:5174/";
await cdp.send("Page.navigate", { url: target });
await sleep(1500);

const out = {};
const txt = (id) => `(document.getElementById('${id}')||{}).textContent`;

// ---- 1. run the built-in demo -------------------------------------------
// 远端站点首次加载要先拉 chunk，点早了监听器还没绑上，会静默落空；
// 后面的断言就会对着空页面跑，报出来的错跟真正的原因毫无关系。
let demoReady = false;
for (let attempt = 0; attempt < 3 && !demoReady; attempt += 1) {
  await cdp.eval(`document.getElementById('btnDemo').click()`);
  for (let i = 0; i < 160; i += 1) {
    if (await cdp.eval(`!!document.getElementById('figDot')?.classList.contains('ready')`)) { demoReady = true; break; }
    await sleep(250);
  }
}
if (!demoReady) throw new Error("demo never became ready after 3 attempts: 页面可能根本没启动");
out.demo = {
  cols: await cdp.eval(txt("nCol")),
  inv: await cdp.eval(txt("nInv")),
  trn: await cdp.eval(txt("nTrn")),
  cov: await cdp.eval(txt("nCov")),
  seeds: await cdp.eval(txt("nSeeds")),
  rows: await cdp.eval(`document.querySelectorAll('#tbody tr').length`),
  // 表格是 DOM 逐行建出来的，抓统计时可能还差最后一行；这里等它稳定。
  rowsSettled: await (async () => {
    let last = -1;
    for (let i = 0; i < 40; i += 1) {
      const n = await cdp.eval(`document.querySelectorAll('#tbody tr').length`);
      if (n === last && n > 0) return n;
      last = n;
      await sleep(100);
    }
    return last;
  })(),
  hint: await cdp.eval(txt("hint")),
  xaxis: await cdp.eval(txt("xaxis")),
  ylab: await cdp.eval(txt("ylab")),
  zoomHidden: await cdp.eval(`document.getElementById('figZoom').hidden`),
};
await cdp.shot("i-01-demo.png");

// The page is a long editorial layout, so the figure sits below the fold at a
// typical viewport height. Centre it before measuring: coordinates outside the
// viewport are silently dropped by the input pipeline, which would look exactly
// like a broken handler.
await cdp.eval(`document.getElementById('plot').scrollIntoView({ block: 'center' })`);
await sleep(500);
const box = await cdp.eval(`(() => { const r = document.getElementById('plot').getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; })()`);
out.box = box;
out.plotFullyVisible = box.y >= 0 && box.y + box.h <= (await cdp.eval(`innerHeight`));
await cdp.shot("i-01b-centred.png");

// ---- 2. hover readout ----------------------------------------------------
const hx = Math.round(box.x + box.w * 0.42);
const hy = Math.round(box.y + box.h * 0.55);
await cdp.mouse("mouseMoved", hx, hy, { buttons: 0 });
await sleep(400);
out.hover = {
  hidden: await cdp.eval(`document.getElementById('readout').hidden`),
  text: (await cdp.eval(txt("readout")) || "").replace(/\s+/g, " ").trim(),
};
await cdp.shot("i-02-hover.png");

// ---- 3. click on a known block selects it -------------------------------
// Aim at the first reported block rather than the middle of the canvas: the
// demo genome has non-homologous spacers, so the exact centre of the figure
// can legitimately be empty and a click there proves nothing.
const clicked = await cdp.eval(`(() => {
  const row = document.querySelector('#tbody tr');
  if (!row) return null;
  const cells = row.querySelectorAll('td');
  const parse = (s) => { const m = /([\\d.]+)–([\\d.]+)/.exec(s); return m ? [(+m[1] + +m[2]) / 2, +m[1], +m[2]] : null; };
  const r = parse(cells[2].textContent);
  const q = parse(cells[3].textContent);
  return { id: row.dataset.id, rMid: r ? r[0] : null, qMid: q ? q[0] : null };
})()`);
out.clickTarget = clicked;
const nRefBp = await cdp.eval(`(() => { const t = document.getElementById('figSize').textContent; return parseFloat(t) * 1e6; })()`);
const padPx = Math.round(Math.min(box.w, box.h) * 0.072);
const innerPx = Math.min(box.w, box.h) - padPx * 2;
const fx = (clicked.rMid * 1e6) / nRefBp;
const fy = (clicked.qMid * 1e6) / nRefBp;
const cx = Math.round(box.x + padPx + fx * innerPx);
const cy = Math.round(box.y + padPx + innerPx - fy * innerPx);
await cdp.mouse("mouseMoved", cx, cy, { buttons: 0 });
await cdp.mouse("mousePressed", cx, cy, { button: "left", buttons: 1, clickCount: 1 });
await cdp.mouse("mouseReleased", cx, cy, { button: "left", buttons: 0, clickCount: 1 });
await sleep(350);
out.clickSelect = {
  selectedRows: await cdp.eval(`document.querySelectorAll('#tbody tr.sel').length`),
  selectedId: await cdp.eval(`document.querySelector('#tbody tr.sel')?.dataset.id ?? null`),
  point: { cx, cy, fx: +fx.toFixed(4), fy: +fy.toFixed(4) },
};
await cdp.shot("i-03-selected.png");

// ---- 4. drag a rectangle to zoom ---------------------------------------
const ax = Math.round(box.x + box.w * 0.30);
const ay = Math.round(box.y + box.h * 0.62);
const bx = Math.round(box.x + box.w * 0.55);
const by = Math.round(box.y + box.h * 0.40);
await cdp.mouse("mouseMoved", ax, ay, { buttons: 0 });
await cdp.mouse("mousePressed", ax, ay, { button: "left", buttons: 1, clickCount: 1 });
await cdp.mouse("mouseMoved", Math.round((ax + bx) / 2), Math.round((ay + by) / 2), { button: "left", buttons: 1 });
out.dragRectVisible = await cdp.eval(`!document.getElementById('dragRect').hidden`);
await cdp.mouse("mouseMoved", bx, by, { button: "left", buttons: 1 });
await cdp.mouse("mouseReleased", bx, by, { button: "left", buttons: 0, clickCount: 1 });
await sleep(500);
out.afterDragZoom = {
  zoom: await cdp.eval(txt("figZoom")),
  zoomHidden: await cdp.eval(`document.getElementById('figZoom').hidden`),
  xaxis: await cdp.eval(txt("xaxis")),
  ylab: await cdp.eval(txt("ylab")),
  dragRectHidden: await cdp.eval(`document.getElementById('dragRect').hidden`),
};
await cdp.shot("i-04-zoomed.png");

// ---- 5. wheel zoom back out --------------------------------------------
for (let i = 0; i < 6; i += 1) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: hx, y: hy, deltaX: 0, deltaY: 260 });
  await sleep(120);
}
out.afterWheelOut = {
  zoom: await cdp.eval(txt("figZoom")),
  zoomHidden: await cdp.eval(`document.getElementById('figZoom').hidden`),
};

// ---- 6. the zoom chip restores the full view ---------------------------
await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: hx, y: hy, deltaX: 0, deltaY: -400 });
await sleep(300);
const zoomBeforeReset = await cdp.eval(txt("figZoom"));
await cdp.eval(`document.getElementById('figZoom').click()`);
await sleep(350);
out.zoomReset = {
  before: zoomBeforeReset,
  afterHidden: await cdp.eval(`document.getElementById('figZoom').hidden`),
  xaxis: await cdp.eval(txt("xaxis")),
};

// ---- 7. double-click also resets --------------------------------------
await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: hx, y: hy, deltaX: 0, deltaY: -300 });
await sleep(300);
const zoomBeforeDbl = await cdp.eval(txt("figZoom"));
await cdp.mouse("mousePressed", hx, hy, { button: "left", buttons: 1, clickCount: 1 });
await cdp.mouse("mouseReleased", hx, hy, { button: "left", buttons: 0, clickCount: 1 });
await cdp.mouse("mousePressed", hx, hy, { button: "left", buttons: 1, clickCount: 2 });
await cdp.mouse("mouseReleased", hx, hy, { button: "left", buttons: 0, clickCount: 2 });
await sleep(400);
out.dblclickReset = {
  before: zoomBeforeDbl,
  zoomHidden: await cdp.eval(`document.getElementById('figZoom').hidden`),
};

// ---- 8. Escape clears the selection -----------------------------------
await cdp.eval(`(() => { const r = document.querySelector('#tbody tr'); r && r.click(); })()`);
await sleep(250);
const selBefore = await cdp.eval(`document.querySelectorAll('#tbody tr.sel').length`);
await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(300);
out.escape = { before: selBefore, after: await cdp.eval(`document.querySelectorAll('#tbody tr.sel').length`) };

// ---- 9. CSV export ------------------------------------------------------
out.csv = await cdp.eval(`(() => new Promise((res) => {
  const btn = document.getElementById('btnCsv');
  if (btn.disabled) return res({ disabled: true });
  const real = URL.createObjectURL;
  let blob = null;
  URL.createObjectURL = (b) => { blob = b; return 'blob:x'; };
  btn.click();
  URL.createObjectURL = real;
  if (!blob) return res({ blob: false });
  blob.text().then((t) => {
    const lines = t.split('\\n');
    res({ bytes: blob.size, header: lines[0], first: lines[1], lineCount: lines.length });
  });
}))()`);

// ---- 10. manual k override ---------------------------------------------
await cdp.eval(`(() => { const t = document.getElementById('advToggle');
  if (!t.checked) { t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
await sleep(250);
out.adv = { visible: await cdp.eval(`!document.getElementById('advBody').hidden`), k: await cdp.eval(`document.getElementById('inK').value`) };
await cdp.eval(`(() => { const k = document.getElementById('inK'); k.value = '19'; k.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await cdp.eval(`document.getElementById('btnRun').click()`);
for (let i = 0; i < 120; i += 1) {
  await sleep(250);
  if (await cdp.eval(`document.getElementById('figK').textContent === '19'`)) break;
}
out.afterK19 = { figK: await cdp.eval(txt("figK")), cols: await cdp.eval(txt("nCol")), cov: await cdp.eval(txt("nCov")), hint: await cdp.eval(txt("hint")) };
await cdp.shot("i-05-k19.png");

console.log(JSON.stringify({ out, logs: cdp.logs.slice(0, 12) }, null, 2));
ws.close();
chrome.kill();