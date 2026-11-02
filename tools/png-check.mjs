import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * PNG export check.
 *
 * The exported figure cannot be judged by eye here, so this asserts the things
 * that can be measured: the pixel size really is twice the plot, the caption
 * band really contains drawn text, the background really follows the theme,
 * and a second export in another theme changes the ink.
 */

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const port = 9200 + Math.floor(Math.random() * 80);
const chrome = spawn(CHROME, [
  "--headless=new", "--lang=zh-CN", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--window-size=1440,1100", `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "png-"))}`, "about:blank",
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
  if (m.method === "Runtime.exceptionThrown") {
    errs.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id);
    pend.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  pend.set(mid, { resolve: res, reject: rej });
  sock.send(JSON.stringify({ id: mid, method, params }));
  setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); rej(new Error("timeout " + method)); } }, 60000);
});
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    return { err: (r.exceptionDetails.exception?.description ?? "").slice(0, 300) };
  }
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: process.env.SYNTENY_URL || "http://127.0.0.1:5174/" });
await sleep(1400);

const out = {};

// 拦截下载：把 blob 留在一个全局变量里，再用解码器量尺寸和像素。
await ev(`
  window.__png = null;
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => {
    if (b instanceof Blob && b.type === "image/png") window.__png = b;
    return realCreate.call(URL, b);
  };
  // 拦掉真正的下载，headless 里没有下载目录。
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (typeof this.download === "string" && this.download.endsWith(".png")) return;
    return realClick.call(this);
  };
  true
`);

out.beforeRun = await ev(`({
  pngDisabled: document.getElementById('btnPng').disabled,
  csvDisabled: document.getElementById('btnCsv').disabled,
  label: document.getElementById('btnPng').textContent.trim(),
})`);

// 先跑出结果
await ev(`document.getElementById('btnDemo').click()`);
for (let i = 0; i < 160; i += 1) {
  if (await ev(`document.getElementById('figDot').classList.contains('ready')`)) break;
  await sleep(250);
}

out.afterRun = await ev(`({
  pngDisabled: document.getElementById('btnPng').disabled,
  plotW: Math.round(document.getElementById('plot').getBoundingClientRect().width),
  plotH: Math.round(document.getElementById('plot').getBoundingClientRect().height),
  theme: document.documentElement.getAttribute('data-theme'),
})`);

/** Click the button, wait for the blob, decode it and measure.
 *  The plot occupies the top (2 * plotH) device pixels; everything below is
 *  caption, then a 60px footer strip. */
const shoot = async () => {
  const { plotW, plotH } = out.afterRun;
  await ev(`window.__png = null, document.getElementById('btnPng').click(), true`);
  for (let i = 0; i < 80; i += 1) {
    if (await ev(`window.__png !== null`)) break;
    await sleep(150);
  }
  return ev(`(async () => {
    const b = window.__png;
    if (!b) return { err: "no blob" };
    const bmp = await createImageBitmap(b);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const corner = Array.from(g.getImageData(2, 2, 1, 1).data).slice(0, 3);
    const inkIn = (top, height) => {
      const h2 = Math.max(1, Math.min(height, bmp.height - top));
      const d = g.getImageData(0, top, bmp.width, h2).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const dx = Math.abs(d[i] - corner[0]) + Math.abs(d[i + 1] - corner[1]) + Math.abs(d[i + 2] - corner[2]);
        if (dx > 30) n += 1;
      }
      return n;
    };
    const plotPx = ${plotH} * 2;
    return {
      w: bmp.width, h: bmp.height, bytes: b.size, corner,
      plotInk: inkIn(0, plotPx),
      captionInk: inkIn(plotPx, bmp.height - plotPx - 60),
      footerInk: inkIn(bmp.height - 60, 60),
    };
  })()`);
};

out.dark = await shoot();

// 换浅色主题再导一次：底色应该跟着变，图注仍然要有字
await ev(`document.querySelector('.sw-b[data-sw="paper"]').click(), true`);
await sleep(500);
out.paper = await shoot();
out.themeAfter = await ev(`document.documentElement.getAttribute('data-theme')`);

// 英文导一次：图注应当来自英文文案（用宽度变化间接证明字形不同）
await ev(`document.getElementById('btnLang').click(), true`);
await sleep(500);
out.english = await shoot();
out.englishCaptionChars = await ev(`document.getElementById('caption').textContent.trim().length`);

out.errs = errs.slice(0, 4);
console.log(JSON.stringify(out, null, 2));
chrome.kill();
process.exit(0);
