import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Layout check across viewport widths.
 *
 * No screenshot comparison: this asserts the properties that actually break
 * layouts — horizontal overflow, a canvas that stopped being square, a table
 * pushed out of its column, and controls that vanished below the fold.
 */

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const port = 9300 + Math.floor(Math.random() * 80);
const chrome = spawn(CHROME, [
  "--headless=new", "--lang=zh-CN", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "resp-"))}`, "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws = null;
for (let i = 0; i < 120 && ws === null; i += 1) {
  try {
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const p = tabs.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (p) ws = p.webSocketDebuggerUrl;
  } catch { /* wait */ }
  if (ws === null) await sleep(200);
}
const sock = new WebSocket(ws);
await new Promise((res, rej) => { sock.addEventListener("open", res); sock.addEventListener("error", rej); });
let id = 0; const pend = new Map(); const errs = [];
sock.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") errs.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pend.set(mid, { resolve: res, reject: rej });
  sock.send(JSON.stringify({ id: mid, method, params }));
  setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); rej(new Error("timeout " + method)); } }, 60000);
});
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { err: (r.exceptionDetails.exception?.description ?? "").slice(0, 160) };
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");

const widths = [1440, 1280, 1100, 900, 760, 620, 480];
const rows = [];
for (const w of widths) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 1000, deviceScaleFactor: 1, mobile: false });
  // 默认打本地预览；设 SYNTENY_URL 就能对已部署的站点跑同一套断言。
  await send("Page.navigate", { url: process.env.SYNTENY_URL || "http://127.0.0.1:5174/" });
  await sleep(1100);
  // SYNTENY_LANG=en 时先切英文量表；两套文案长度不同，排版风险也不同。
  // 语言是持久化的：上一次切到 en，这次加载就是 en，盲点一次又切回中文。
  if (process.env.SYNTENY_LANG === 'en') {
    if (await ev(`document.documentElement.lang.startsWith('zh')`)) {
      await ev(`document.getElementById('btnLang').click()`);
      await sleep(250);
    }
  }
  await ev(`document.getElementById('btnDemo').click()`);
  for (let i = 0; i < 120; i += 1) {
    if (await ev(`document.getElementById('figDot').classList.contains('ready')`)) break;
    await sleep(250);
  }
  rows.push(await ev(`(() => {
    const de = document.documentElement;
    const cv = document.getElementById('plot').getBoundingClientRect();
    const tb = document.getElementById('tbody');
    const tbl = tb.closest('table') || tb;
    const tr = tbl.getBoundingClientRect();
    const run = document.getElementById('btnRun').getBoundingClientRect();
    return {
      width: innerWidth,
      overflowX: de.scrollWidth - de.clientWidth,
      canvasSquare: Math.abs(cv.width - cv.height) <= 1 ? true : Math.round(Math.abs(cv.width - cv.height)),
      canvasW: Math.round(cv.width),
      tableRight: Math.round(tr.right),
      tableOverflows: tr.right - de.clientWidth,
      runVisible: run.width > 0 && run.height > 0,
      zoomChipHidden: document.getElementById('figZoom').hidden,
      segs: document.querySelectorAll('#tbody tr').length,
      lang: document.documentElement.lang,
      font: getComputedStyle(document.body).fontFamily.split(',')[0].replace(/"/g, ''),
      tblScroll: tbl.scrollWidth - tbl.clientWidth,
    };
  })()`));
}

console.log(JSON.stringify({ rows, errs: errs.slice(0, 4) }, null, 2));
sock.close();
chrome.kill();
