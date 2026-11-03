import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `still-page` 守门 + 帧时间 + 390px 移动端（SDS §2.3 / §6.1）。
 *
 * 检查器的 `still-page` 只在「宽 ≥1100px、加载并滚动过整页之后，真正动过的
 * 不同元素 ≥8 个」时才算 PASS。它数什么、不数什么，是这一层动效设计的全部
 * 约束来源（SDS §2.3）：
 *
 *   - 只监听 `animationstart` / `transitionrun` / 内联 style 的
 *     transform|translate|opacity|scale|rotate|clip-path 变更；
 *   - 整个脚本只合成滚轮，**不点击、不 hover**，所以 hover/click 触发的
 *     过渡一律不计数；
 *   - canvas 的 rAF 循环不计数。
 *
 * 于是「13 个逐子元素入场」是唯一能过线的做法，而它恰好最脆弱：选择器写错
 * 一个、nth-child 错位、或者有人在 reveal.ts 里改一行目标列表，检查器就会
 * 从 PASS 掉回 FAIL，而页面看起来没有任何变化。这个脚本把检查器的记录器
 * 原样搬过来跑一遍，并且**逐条点名**那 13 个目标 —— 掉一个就红，不用等
 * 人工去看检查器的报告。
 *
 * 顺带在同一趟里测量两件只有真浏览器能回答的事：
 *
 *   - **帧时间**：合成的滚轮滚过整页时，p95 帧间隔必须 < 20ms（SDS §6.1）。
 *     滚动是最重的一段：缩放层写 transform、首屏图重画、粒子层被唤醒。
 *   - **390px**：无横向溢出；粒子数由面积公式定死
 *     `clamp(round(area/9000), 18, 90)`（SDS §4.3 表格里的 90/63/24 是在
 *     约 985 CSS px 下量的，不是 1440；这里断言公式本身，而不是某个魔数）。
 *
 * 用法：
 *   node tools/motion-count.mjs
 *   SYNTENY_URL=http://localhost:4173/ node tools/motion-count.mjs
 *
 * 零依赖：Node 内置模块 + 本机 Chrome 的 CDP。任何一条不成立都 exit 1。
 */

const CHROME = process.env.SYNTENY_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const DEFAULT_URL = "http://127.0.0.1:5174/";
const WANTED = process.env.SYNTENY_URL || DEFAULT_URL;
const port = 9900 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(join(tmpdir(), "mcnt-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--lang=zh-CN", "--disable-gpu", "--no-first-run",
  "--no-default-browser-check", "--hide-scrollbars", "--force-color-profile=srgb",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--window-size=1440,1100", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickUrl() {
  const cands = [WANTED];
  if (WANTED === DEFAULT_URL) cands.push("http://localhost:4173/", "http://127.0.0.1:4173/");
  for (const url of cands) {
    try {
      const r = await fetch(url, { method: "GET" });
      if (r.ok) return url;
    } catch { /* 试下一个 */ }
  }
  return WANTED;
}

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
const consoleLines = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning", "assert"].includes(m.params.type)) {
    const text = (m.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type)).join(" ");
    consoleLines.push({ level: m.params.type, text: text.slice(0, 200) });
  }
  if (m.method === "Runtime.exceptionThrown") {
    consoleLines.push({ level: "exception", text: String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300) });
  }
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
const run = async (fn, arg) => {
  const expression = arg === undefined ? `(${fn.toString()})()` : `(${fn.toString()})(${JSON.stringify(arg)})`;
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
};

const failures = [];
const passed = [];
const check = (id, ok, detail) => {
  (ok ? passed : failures).push({ id, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? "  " + detail : ""}`);
};

/**
 * 检查器的记录器（inspect.mjs:78-88）的等价实现，外加两件它没有的能力：
 *
 *   - `__motionMatch(sels)`：按选择器把「被数到的元素」逐条对账，13 个目标
 *     掉一个就能指出是哪一个；
 *   - `window.__frames`：从文档创建起记录每一帧的 rAF 时间戳。p95 帧间隔
 *     只能这样量 —— CDP 的 Performance 域给的是计数器，不是每帧的时刻。
 *
 * 记录方式刻意与检查器逐字对应（同一个 WeakSet→Set 的替换只是为了能查询），
 * 因为这里要回答的是「检查器会不会给我们 PASS」，而不是「我们觉得动效够不够」。
 */
const RECORDER = `(() => {
  const seen = new Set();
  const c = { elements: 0, css: 0, transitions: 0, scripted: 0 };
  const note = (t, k) => { if (!(t instanceof Element) || seen.has(t)) return; seen.add(t); c.elements++; c[k]++; };
  addEventListener('animationstart', (e) => note(e.target, 'css'), true);
  addEventListener('transitionrun', (e) => note(e.target, 'transitions'), true);
  const watch = () => new MutationObserver((list) => {
    for (const m of list) {
      const s = (m.target.getAttribute && m.target.getAttribute('style')) || '';
      if (/transform|translate|opacity|scale|rotate|clip-path/.test(s)) note(m.target, 'scripted');
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'], subtree: true });
  if (document.documentElement) watch(); else addEventListener('DOMContentLoaded', watch);
  window.__motionSample = () => {
    for (const a of (document.getAnimations ? document.getAnimations() : [])) {
      const t = a.effect && a.effect.target;
      if (t) note(t, a.constructor && a.constructor.name === 'CSSTransition' ? 'transitions' : 'css');
    }
  };
  window.__motion = () => {
    window.__motionSample();
    const v = [...document.querySelectorAll('video')];
    return { ...c, videos: v.length, playingVideos: v.filter((x) => x.autoplay || !x.paused).length };
  };
  window.__motionMatch = (sels) => {
    window.__motionSample();
    const matched = {};
    for (const s of sels) {
      const all = document.querySelectorAll(s);
      let n = 0;
      for (const el of all) if (seen.has(el)) n++;
      matched[s] = { present: all.length, counted: n };
    }
    return { ...c, matched };
  };
  window.__frames = [];
  const tick = (t) => { window.__frames.push(t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})();`;

await send("Page.enable");
await send("Runtime.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER });

const url = await pickUrl();
console.log(JSON.stringify({ url, chrome: CHROME }));

/** 13 个入场目标，按 SDS §4.7 的表拆成「选择器 → 期望个数」。 */
const TARGETS = [
  [".mast-top", 1],
  [".subnav", 1],
  [".lg-item", 3],
  [".spec", 4],
  [".slot", 2],
  ["thead", 1],
  ["footer .right", 1],
];
const TARGET_TOTAL = TARGETS.reduce((n, [, k]) => n + k, 0);

/**
 * 用合成滚轮把整页滚一遍。
 *
 * 为什么必须是真的滚轮事件而不是 scrollTo：批次四的入场挂在
 * IntersectionObserver 上，两者都会触发；但这一趟同时要量帧时间，
 * 而滚动缩放层与粒子层都监听真实的滚动节奏。合成滚轮让这条路径与
 * 访客走的完全一致。
 */
async function wheelThroughPage(height, width) {
  const step = 240;
  const maxY = await run(() => Math.max(0, document.documentElement.scrollHeight - innerHeight));
  const clicks = Math.ceil(maxY / step) + 4;
  for (let i = 0; i < clicks; i += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.round(width / 2),
      y: Math.round(height / 2),
      deltaX: 0,
      deltaY: step,
      pointerType: "mouse",
    });
    await sleep(45);
  }
  await sleep(700);
}

// ---------------------------------------------------------------------------
// 1) 1440×900：动效计数 + 13 个目标逐条对账 + 帧时间
// ---------------------------------------------------------------------------
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
// 入场最长 .5s + 180ms 延迟；等它跑完再开始滚，免得首屏入场与滚动入场搅在一起。
await sleep(1500);

const before = await run(() => ({ y: Math.round(scrollY), frames: window.__frames.length }));
// 帧统计清零，只算滚动这一段：加载期的布局抖动不属于「滚动是否顺滑」。
await run(() => { window.__frames.length = 0; });

await wheelThroughPage(900, 1440);

const counted = await run((sels) => window.__motionMatch(sels), TARGETS.map(([s]) => s));
const frames = await run(() => {
  const f = window.__frames;
  const d = [];
  for (let i = 1; i < f.length; i += 1) d.push(f[i] - f[i - 1]);
  d.sort((a, b) => a - b);
  const at = (q) => (d.length === 0 ? null : d[Math.min(d.length - 1, Math.floor(d.length * q))]);
  return { n: d.length, p50: at(0.5), p95: at(0.95), max: d.length ? d[d.length - 1] : null };
});

const yEnd = await run(() => Math.round(scrollY));
console.log(`      滚到 y=${yEnd}（起点 y=${before.y}），记录 ${frames.n} 段帧间隔`);

// still-page 的门槛是 8；SDS 目标是 13。这里两条都断言，掉到 8-12 之间也要红：
// 8 只是检查器的及格线，不是这一层的验收目标。
check("motion/元素数 ≥ 检查器门槛 8", counted.elements >= 8, `elements=${counted.elements}（门槛 8）`);
check(
  "motion/13 个目标全部计数",
  counted.elements >= TARGET_TOTAL && TARGET_TOTAL === 13,
  `elements=${counted.elements}，目标共 ${TARGET_TOTAL} 个`,
);

const missing = [];
for (const [sel, want] of TARGETS) {
  const got = counted.matched[sel];
  if (!got || got.counted !== want) missing.push(`${sel} 计到 ${got ? got.counted : 0}/${want} 个（DOM 中 ${got ? got.present : 0} 个）`);
}
check("motion/逐条点名对账", missing.length === 0, missing.length === 0 ? TARGETS.map(([s, k]) => `${s}×${k}`).join(" ") : missing.join(" | "));
console.log(`      计数构成：css=${counted.css} transitions=${counted.transitions} scripted=${counted.scripted}（canvas 的 rAF 不计数，符合预期）`);

check(
  "perf/帧间隔 p95 < 20ms",
  frames.n >= 30 && frames.p95 !== null && frames.p95 < 20,
  `n=${frames.n} p50=${frames.p50?.toFixed(1)}ms p95=${frames.p95?.toFixed(1)}ms max=${frames.max?.toFixed(1)}ms`,
);

// ---------------------------------------------------------------------------
// 2) 390×844：无横向溢出 + 粒子数 = 面积公式 + canvas 与 .head 同尺寸
// ---------------------------------------------------------------------------
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await send("Page.navigate", { url });
await sleep(1600);

const mobile = await run(() => {
  const de = document.documentElement;
  const head = document.querySelector(".head");
  const c = document.getElementById("headParticles");
  const cr = c ? c.getBoundingClientRect() : null;
  const hr = head ? head.getBoundingClientRect() : null;
  return {
    innerWidth,
    overflowX: de.scrollWidth - de.clientWidth,
    count: c ? Number(c.dataset.particleCount) : null,
    expected: cr ? Math.max(18, Math.min(90, Math.round((cr.width * cr.height) / 9000))) : null,
    canvasW: cr ? Math.round(cr.width) : null,
    canvasH: cr ? Math.round(cr.height) : null,
    headW: hr ? Math.round(hr.width) : null,
    headH: hr ? Math.round(hr.height) : null,
    pageHeight: de.scrollHeight,
  };
});

check("mobile/宽度就是 390", mobile.innerWidth === 390, `innerWidth=${mobile.innerWidth}（Emulation.setDeviceMetricsOverride，headless 的 --window-size 下限约 500px）`);
check("mobile/无横向溢出", mobile.overflowX <= 0, `scrollWidth - clientWidth = ${mobile.overflowX}px`);
check(
  "mobile/粒子数符合面积公式",
  mobile.count === mobile.expected,
  `${mobile.canvasW}×${mobile.canvasH} → ${mobile.count}（clamp(round(area/9000),18,90) = ${mobile.expected}）`,
);
check(
  "mobile/粒子层尺寸 = .head",
  mobile.headW !== null && Math.abs(mobile.canvasW - mobile.headW) <= 2 && Math.abs(mobile.canvasH - mobile.headH) <= 2,
  `canvas ${mobile.canvasW}×${mobile.canvasH} / .head ${mobile.headW}×${mobile.headH}`,
);

// ---------------------------------------------------------------------------
// 3) 控制台：零错误、零警告
// ---------------------------------------------------------------------------
// 收集到的只有 error/warning/assert 与未捕获异常，全部算失败。
const bad = consoleLines;
check("console/零错误零警告", bad.length === 0, bad.length === 0 ? "两次加载（1440 / 390）均无 error/warning/exception" : bad.slice(0, 6).map((l) => `[${l.level}] ${l.text}`).join(" | "));

const result = { url, passed: passed.length, failed: failures.length, failures };
console.log("\n" + JSON.stringify(result, null, 2));
ws.close();
chrome.kill();
process.exit(failures.length === 0 ? 0 : 1);