import { createServer } from "node:http";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

/**
 * Serve dist/ under a /synteny/ prefix, the way a GitHub Pages project site does,
 * and confirm the worker still loads and the plot still appears. A relative base
 * is supposed to make this work, but "supposed to" is not evidence.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "subpath-"));
cpSync(resolve(here, "../dist"), join(root, "synteny"), { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const rel = decodeURIComponent(url.pathname);
  const file = join(root, rel.endsWith("/") ? rel + "index.html" : rel);
  try {
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("no");
  }
});
await new Promise((r) => server.listen(5299, "127.0.0.1", r));

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const port = 9400 + Math.floor(Math.random() * 90);
const chrome = spawn(CHROME, ["--headless=new", "--lang=zh-CN", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
  `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "sp-"))}`, "about:blank"], { stdio: "ignore" });
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
await new Promise((r, j) => { sock.addEventListener("open", r); sock.addEventListener("error", j); });
let id = 0; const pend = new Map(); const errs = []; const failed = [];
sock.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") errs.push((m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text ?? "").slice(0, 200));
  if (m.method === "Network.loadingFailed") failed.push(m.params.errorText);
  if (m.method === "Network.responseReceived") { const r = m.params.response; if (r.status >= 400) failed.push(r.status + " " + r.url.slice(-60)); }
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pend.set(mid, { resolve: res, reject: rej });
  sock.send(JSON.stringify({ id: mid, method, params }));
  setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); rej(new Error("timeout " + method)); } }, 60000);
});
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { err: String(r.exceptionDetails.exception?.description ?? "").slice(0, 200) };
  return r.result.value;
};

await send("Page.enable"); await send("Network.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: "http://127.0.0.1:5299/synteny/" });
await sleep(1200);
const clicked = await ev(`(() => { const b = document.getElementById('btnDemo'); if (!b) return 'no button'; b.click(); return 'ok'; })()`);
for (let i = 0; i < 160; i += 1) {
  if (await ev(`document.getElementById('figDot')?.classList.contains('ready') === true`)) break;
  await sleep(250);
}
const out = await ev(`(() => ({
  segs: document.querySelectorAll('#tbody tr').length,
  ready: document.getElementById('figDot').classList.contains('ready'),
  seeds: (document.getElementById('nSeeds')?.textContent ?? '').trim(),
  workerScript: performance.getEntriesByType('resource').map(r => r.name.split('/synteny/')[1]).filter(n => n && n.includes('worker'))
}))()`);
console.log(JSON.stringify({ clicked, out, errs: errs.slice(0, 3), failed: failed.slice(0, 6) }, null, 2));
sock.close(); chrome.kill(); server.close(); rmSync(root, { recursive: true, force: true });
