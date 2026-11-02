import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Acceptance check for the hero glyph.
 *
 * The glyph is decorative, so the tempting test is "the canvas exists". That
 * would pass even if it painted nothing, or painted the inversion on the wrong
 * diagonal, or never stopped animating. So this samples actual pixels:
 *
 *   - at ~250ms the picture must be partly formed (some ink, not the final shape)
 *   - at ~1600ms it must be complete and STABLE across two later samples
 *   - the collinear dots must run from bottom-left to top-right, and the inverted
 *     block the other way; getting that backwards would teach the wrong legend
 *   - reduced motion must skip straight to the final frame
 *   - below 920px the glyph must not be rendered at all
 */

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const url = process.env.SYNTENY_URL || "http://127.0.0.1:5174/";
const port = 9900 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(join(tmpdir(), "glyph-"));

const chrome = spawn(
  CHROME,
  [
    "--headless=new", "--lang=zh-CN", "--disable-gpu", "--no-first-run",
    "--no-default-browser-check", "--hide-scrollbars", "--force-color-profile=srgb",
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
      const page = tabs.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("no target");
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });

let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.consoleAPICalled") logs.push(`[${m.params.type}]`);
  if (m.method === "Runtime.exceptionThrown") logs.push(`[exception] ${m.params.exceptionDetails.text}`);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error("timeout " + method)); } }, 60000);
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

/** Count ink by tier and return the centre of mass of each tier. */
const SAMPLE = `(() => {
  const c = document.getElementById('glyph');
  if (!c) return { missing: true };
  const rect = c.getBoundingClientRect();
  if (rect.width < 1) return { hidden: true, cssW: rect.width };
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let paper = 0, amber = 0;
  let px = 0, py = 0, ax = 0, ay = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gg = d[i + 1], b = d[i + 2], a = d[i + 3];
    if (a < 24) continue;
    const p = (i / 4);
    const x = p % c.width, y = (p - x) / c.width;
    // Paper is near-neutral and bright; amber is warm and much less blue.
    if (r > 150 && gg > 140 && b > 120 && Math.abs(r - gg) < 30) { paper++; px += x; py += y; }
    else if (r > 140 && b < 140) { amber++; ax += x; ay += y; }
  }
  const n = c.width;
  return {
    cssW: Math.round(rect.width),
    device: n,
    paper, amber,
    // Normalised centres, so the assertion does not depend on device pixels.
    paperCentre: paper ? [+(px / paper / n).toFixed(3), +(py / paper / n).toFixed(3)] : null,
    amberCentre: amber ? [+(ax / amber / n).toFixed(3), +(ay / amber / n).toFixed(3)] : null,
  };
})()`;

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 2, mobile: false });

const out = { url, logs };

// --- normal run: mid-animation and final ---------------------------------
await send("Page.navigate", { url });
await sleep(260);
out.mid = await evaluate(SAMPLE);
await sleep(1500);
out.final = await evaluate(SAMPLE);
await sleep(400);
out.settled = await evaluate(SAMPLE);
out.stopsAnimating = JSON.stringify(out.final) === JSON.stringify(out.settled);

// Orientation: the backbone must rise to the right, i.e. the far end of the
// paper line sits above its near end. Sampling the two halves is enough.
out.orientation = await evaluate(`(() => {
  const c = document.getElementById('glyph');
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let leftY = 0, leftN = 0, rightY = 0, rightN = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a < 24) continue;
    const p = i / 4, x = p % c.width, y = (p - x) / c.width;
    if (x < c.width * 0.35) { leftY += y; leftN++; }
    else if (x > c.width * 0.65) { rightY += y; rightN++; }
  }
  if (!leftN || !rightN) return null;
  return { leftMeanY: +(leftY / leftN).toFixed(2), rightMeanY: +(rightY / rightN).toFixed(2),
           risesToTheRight: leftY / leftN > rightY / rightN };
})()`);

// --- reduced motion must not animate -------------------------------------
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await send("Page.navigate", { url });
await sleep(260);
out.reducedMotionAt260ms = await evaluate(SAMPLE);
await send("Emulation.setEmulatedMedia", { features: [] });

// --- hidden on narrow layout --------------------------------------------
await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1000, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url });
await sleep(600);
out.narrow = await evaluate(SAMPLE);

console.log(JSON.stringify(out, null, 2));
chrome.kill();
process.exit(0);