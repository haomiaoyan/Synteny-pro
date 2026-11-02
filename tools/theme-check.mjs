import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 四套配色的实测脚本。
 *
 * 光看「点了有反应」不算数，这里量三样东西：
 *   1. 页面底色是否真的变成该主题的 --ink；
 *   2. 画布是否也跟着换 —— 画布颜色是从 CSS 变量算出来并缓存过的，
 *      最容易出现「页面换了、图没换」；
 *   3. 刷新之后是否记住。
 *
 * 画布采样用「与底色差得最远的那个像素」，共线区的点应该正好落在 --paper 上。
 */

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.SYNTENY_URL || "http://127.0.0.1:5174/";
const port = 9700 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(join(tmpdir(), "thm-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--lang=zh-CN", "--disable-gpu", "--no-first-run",
  "--no-default-browser-check", "--hide-scrollbars", "--force-color-profile=srgb",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--window-size=1440,1100", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 150; i += 1) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = tabs.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error("chrome 没有起来");
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });

let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const p = m.id && pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
});
const send = (method, params = {}) => {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 120000);
  });
};
const evalIn = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: BASE });

// 等示例数据跑完：那里才有区段可画。
for (let i = 0; i < 100; i += 1) {
  const ready = await evalIn(`!!document.getElementById('figDot')?.classList.contains('ready')`);
  if (ready) break;
  await evalIn(`document.getElementById('btnDemo')?.click(), true`);
  await sleep(300);
}

const PROBE = `(() => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const v = (n) => cs.getPropertyValue(n).trim();
  const parse = (s) => { const m = /rgba?\\(([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)/.exec(s); return m ? [+m[1], +m[2], +m[3]] : null; };
  const hex = (h) => { const m = /^#([\\da-f]{2})([\\da-f]{2})([\\da-f]{2})$/i.exec(h); return m ? [parseInt(m[1],16),parseInt(m[2],16),parseInt(m[3],16)] : null; };
  const c = document.getElementById('plot');
  let mostDistinct = null, delta = -1, canvasBg = null;
  if (c && c.width > 10) {
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const bg = [d[0], d[1], d[2]];
    canvasBg = bg;
    for (let i = 0; i < d.length; i += 4) {
      const dd = Math.abs(d[i]-bg[0]) + Math.abs(d[i+1]-bg[1]) + Math.abs(d[i+2]-bg[2]);
      if (dd > delta) { delta = dd; mostDistinct = [d[i], d[i+1], d[i+2]]; }
    }
  }
  return {
    attr: root.getAttribute('data-theme'),
    bodyBg: parse(getComputedStyle(document.body).backgroundColor),
    ink: hex(v('--ink')), paper: hex(v('--paper')), ink3: hex(v('--ink3')),
    meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    pressed: Array.from(document.querySelectorAll('.sw-b')).map((b) => b.getAttribute('data-pressed') || b.getAttribute('aria-pressed')),
    canvasBg, mostDistinct, delta,
    colorScheme: getComputedStyle(root).colorScheme,
  };
})()`;

const results = [];
for (const name of ["ink", "paper", "indigo", "moss"]) {
  await evalIn(`document.querySelector('.sw-b[data-sw="${name}"]').click(), true`);
  await sleep(250);
  results.push({ clicked: name, ...(await evalIn(PROBE)) });
}

// 记不记得住：刷新后应该还在苔色（最后一个点的）。
await send("Page.navigate", { url: BASE });
await sleep(1200);
const after = await evalIn(`(() => ({
  stored: localStorage.getItem('synteny.theme'),
  attr: document.documentElement.getAttribute('data-theme'),
  themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
  inlineScriptSet: localStorage.getItem('synteny.theme') === (document.documentElement.getAttribute('data-theme') || 'ink'),
}))()`);

console.log(JSON.stringify({ results, afterReload: after }, null, 2));
chrome.kill();
process.exit(0);