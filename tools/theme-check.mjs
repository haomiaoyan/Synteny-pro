import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 四套配色 × 两种语言的实测脚本。
 *
 * 光看「点了有反应」不算数，这里量的是「颜色到底有没有跟着主题走」：
 *   1. 页面底色是否真的变成该主题的 --ink；
 *   2. 工具区的 #plot 是否也跟着换（画布颜色从 CSS 变量算出来并缓存过，
 *      最容易出现「页面换了、图没换」）；
 *   3. **首屏的 #heroPlot**、**粒子层 #headParticles**、**图例圆点 .lg-dot**
 *      是否同样跟随 —— 这三处是动效层新增的着色面，批次五把它们交给了
 *      repaintAll() 去补帧，而「补帧漏了一处」在肉眼看来只是「颜色有点旧」，
 *      不盯着看根本发现不了。
 *
 * 为什么断言写成「采到的颜色 == 该主题对应的 CSS 变量」而不是「四个主题
 * 互不相同」：--amber 与 --accent-soft 在 ink/indigo/moss 三套里是同一个值
 * （站点身份色不随主题变），只有 paper 那套是另一组。硬要求四套全不同会
 * 把一个正确的设计判成错的。变量这条判据既能抓住「图没换色」，也不会误伤。
 *
 * 语言不该影响配色，所以同一主题下 zh 与 en 的采样必须逐字节相等 ——
 * 这条是回归保护：i18n 重渲染如果哪天把画布重建了，颜色会暂时回到默认值。
 *
 * 用法：
 *   node tools/theme-check.mjs
 *   SYNTENY_URL=http://localhost:4173/ node tools/theme-check.mjs
 *
 * 零依赖：Node 内置模块 + 本机 Chrome 的 CDP。任何一条断言不成立都 exit 1。
 */

const CHROME = process.env.SYNTENY_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
/** 默认打本地预览；vite preview 只绑 IPv6 localhost，所以 4173 也进候选。 */
const DEFAULT_URL = "http://127.0.0.1:5174/";
const WANTED = process.env.SYNTENY_URL || DEFAULT_URL;
const port = 9700 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(join(tmpdir(), "thm-"));
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

const failures = [];
const check = (id, ok, detail) => {
  if (!ok) failures.push({ id, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? "  " + detail : ""}`);
};

/**
 * 一次采样。
 *
 * 画布不能用「第一个像素」当底色：边上可能就是边框线或刻度。所以取**出现
 * 次数最多的颜色**（众数）当底色，再取**与底色差得最远的像素**当「画上去
 * 的东西」。两个量都只依赖画面内容，与采样顺序无关，同一画面永远同一结果。
 */
// 探针写成真正的函数再 toString 进页面：正则与模板串在这里按正常语法写，
// 不必为「经过一层字符串字面量」再手工加一层转义（第一版就是那样写错的）。
function probe() {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const v = (n) => cs.getPropertyValue(n).trim();
  const parse = (s) => {
    if (!s) return null;
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(s);
    if (m) return [+m[1], +m[2], +m[3]];
    const h = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(s);
    return h ? [parseInt(h[1], 16), parseInt(h[2], 16), parseInt(h[3], 16)] : null;
  };
  // 众数底色 + 最远像素，任何一块 2D 画布都能用。
  const sample = (c, stride) => {
    if (!c || c.width < 10 || c.height < 10) return null;
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const hist = new Map();
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * stride) {
      const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      hist.set(k, (hist.get(k) || 0) + 1);
      n += 1;
    }
    let best = 0, bestN = -1;
    for (const [k, v2] of hist) if (v2 > bestN) { bestN = v2; best = k; }
    const bg = [(best >> 16) & 255, (best >> 8) & 255, best & 255];
    let far = null, delta = -1;
    for (const k of hist.keys()) {
      const r = (k >> 16) & 255, gg = (k >> 8) & 255, b = k & 255;
      const dd = Math.abs(r - bg[0]) + Math.abs(gg - bg[1]) + Math.abs(b - bg[2]);
      if (dd > delta) { delta = dd; far = [r, gg, b]; }
    }
    return { bg, far, delta, share: bestN / n, w: c.width, h: c.height };
  };
  const particle = (c) => {
    if (!c || c.width < 10 || c.height < 10) return null;
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let maxA = 0, peak = null, painted = 0;
    // getImageData 给的是**非预乘**值。低 alpha 下（0.055–0.12）8 位量化能把
    // 单个像素偏 30 个通道值，深色主题最惨 —— 早先拿「最实像素」当答案是错的。
    // 一层里所有粒子/连线用的都是同一个 RGB，只有 alpha 不同，所以对全部
    // 上过色的像素取算术平均，量化噪声在上万个样本上自行抵消，误差 < 1。
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a === 0) continue;
      painted += 1;
      sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
      if (a > maxA) { maxA = a; peak = [d[i], d[i + 1], d[i + 2]]; }
    }
    const avg = painted === 0 ? null : [Math.round(sr / painted), Math.round(sg / painted), Math.round(sb / painted)];
    return { avg, peak, maxA, painted, w: c.width, h: c.height };
  };
  const dot = (sel) => {
    const el = document.querySelector(sel);
    return el ? parse(getComputedStyle(el).backgroundColor) : null;
  };
  return {
    attr: root.getAttribute('data-theme'),
    docLang: root.lang,
    bodyBg: parse(getComputedStyle(document.body).backgroundColor),
    ink: parse(v('--ink')), ink3: parse(v('--ink3')), paper: parse(v('--paper')),
    amber: parse(v('--amber')), accentSoft: parse(v('--accent-soft')),
    meta: document.querySelector('meta[name=\"theme-color\"]')?.getAttribute('content'),
    pressed: Array.from(document.querySelectorAll('.sw-b')).map((b) => b.getAttribute('aria-pressed')),
    plot: sample(document.getElementById('plot'), 4),
    hero: sample(document.getElementById('heroPlot'), 4),
    particles: particle(document.getElementById('headParticles')),
    dots: { col: dot('.lg-col'), inv: dot('.lg-inv'), trn: dot('.lg-trn') },
    colorScheme: getComputedStyle(root).colorScheme,
  };
}
const samplePage = () => evalIn(`(${probe.toString()})()`);

const dist = (a, b) => (a && b ? Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) : Number.NaN);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (c) => (c ? `rgb(${c.join(",")})` : "null");

const url = await pickUrl();
console.log(JSON.stringify({ url, chrome: CHROME }));

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });

// 等示例数据跑完：工具区那里才有区段可画；首屏图也要等 worker 回来。
for (let i = 0; i < 110; i += 1) {
  const ready = await evalIn(`!!document.getElementById('figDot')?.classList.contains('ready') && !!document.getElementById('heroPlot')?.classList.contains('ready')`);
  if (ready) break;
  await evalIn(`document.getElementById('btnDemo')?.click(), true`);
  await sleep(300);
}

const THEMES = ["ink", "paper", "indigo", "moss"];
const results = [];
for (const lang of ["zh", "en"]) {
  // 语言是持久化的：只在当前语言不符时才点一次，避免盲点导致来回翻。
  const wantsEn = lang === "en";
  if ((await evalIn(`document.documentElement.lang.startsWith('en')`)) !== wantsEn) {
    await evalIn(`document.getElementById('btnLang').click(), true`);
    await sleep(300);
  }
  for (const name of THEMES) {
    await evalIn(`document.querySelector('.sw-b[data-sw="${name}"]').click(), true`);
    // 主题变化 → repaintAll()；等两帧左右让画布重画完。
    await sleep(320);
    results.push({ lang, theme: name, ...(await samplePage()) });
  }
}

// ---- 逐条断言：每个 (语言, 主题) 组合 ----
for (const r of results) {
  const tag = `${r.lang}/${r.theme}`;
  check(`theme 属性 ${tag}`, (r.attr || "ink") === r.theme, `data-theme=${r.attr}`);
  check(`语言 ${tag}`, r.docLang.startsWith(r.lang === "zh" ? "zh" : "en"), `请求 ${r.lang}，页面 lang=${r.docLang}`);
  check(`页面底色 = --ink ${tag}`, same(r.bodyBg, r.ink), `body=${show(r.bodyBg)} --ink=${show(r.ink)}`);
  check(
    `#plot 底色 = --ink3 ${tag}`,
    r.plot && same(r.plot.bg, r.ink3),
    r.plot ? `众数底色=${show(r.plot.bg)}（${(r.plot.share * 100).toFixed(0)}% 采样）--ink3=${show(r.ink3)}` : "画布没画",
  );
  check(
    `#heroPlot 底色 = --ink3 ${tag}`,
    r.hero && same(r.hero.bg, r.ink3) && r.hero.share > 0.5,
    r.hero ? `众数底色=${show(r.hero.bg)}（${(r.hero.share * 100).toFixed(0)}%）--ink3=${show(r.ink3)}` : "画布没画",
  );
  // 共线层的点画在 0.95 不透明度上，与 --paper 只差一次与底色的混合，容差放到 40。
  check(
    `#heroPlot 有点（≠底色） ${tag}`,
    r.hero && r.hero.delta > 60 && dist(r.hero.far, r.paper) < 40,
    r.hero ? `最远像素=${show(r.hero.far)}（差 ${r.hero.delta}）--paper=${show(r.paper)}` : "—",
  );
  // 粒子层：tierRgb[0] 就是 --paper，画的时候只乘 alpha，RGB 不变。
  //
  // 容差 60（0–765 量纲）是实测出来的，不是拍的：这一层只画 alpha 0.055–0.12
  // 的半透明点与连线，getImageData 反预乘回 8 位时，深色主题下大量低 alpha
  // 像素的存储色会量化成 0，均值被往下拖 —— 实测最深那套偏 45，浅色三套偏 4–5。
  // 60 仍然远小于「配色没跟着换」时的偏差（浅↔深相差 650+），所以真回归抓得住；
  // 而 ink 与 indigo 的 --paper 本来就只差 8（设计如此），跨主题那组因此
  // 只断言浅↔深翻转，不强求四套互不相同。
  check(
    `#headParticles 颜色 = --paper ${tag}`,
    r.particles && r.particles.painted > 200 && dist(r.particles.avg, r.paper) <= 60,
    r.particles ? `上色像素均值=${show(r.particles.avg)}（${r.particles.painted} 像素，差 ${dist(r.particles.avg, r.paper)}）--paper=${show(r.paper)}` : "画布没画",
  );
  check(
    `.lg-dot 三色 = --paper/--amber/--accent-soft ${tag}`,
    same(r.dots.col, r.paper) && same(r.dots.inv, r.amber) && same(r.dots.trn, r.accentSoft),
    `共线=${show(r.dots.col)} 倒位=${show(r.dots.inv)} 易位=${show(r.dots.trn)}`,
  );
}

// ---- 跨主题：颜色必须真的换过 ----
const uniq = (arr) => new Set(arr.map((x) => JSON.stringify(x))).size;
const heroBgs = results.filter((r) => r.lang === "zh" && r.hero).map((r) => r.hero.bg);
const dotCols = results.filter((r) => r.lang === "zh").map((r) => r.dots.col);
check("跨主题/#heroPlot 底色四套各不相同", uniq(heroBgs) === 4, `${uniq(heroBgs)} 种：${heroBgs.map(show).join(" ")}`);
// 粒子层只断言「浅色那套与深色那套相差极大」：ink 与 indigo 的 --paper 只差 8，
// 而反预乘的量化误差本身就有 5–8，硬求四套互不相同只会测出舍入噪声。
const partByTheme = (t) => results.find((r) => r.lang === "zh" && r.theme === t)?.particles?.avg;
const inkP = partByTheme("ink");
const paperP = partByTheme("paper");
check(
  "跨主题/粒子颜色随主题切换（浅↔深）",
  dist(inkP, paperP) > 300,
  `ink=${show(inkP)} paper=${show(paperP)} 差=${dist(inkP, paperP)}`,
);
check("跨主题/图例圆点四套各不相同", uniq(dotCols) === 4, `${uniq(dotCols)} 种：${dotCols.map(show).join(" ")}`);

// ---- 语言不该影响配色：同一主题下 zh 与 en 的采样必须完全一致 ----
for (const name of THEMES) {
  const zh = results.find((r) => r.lang === "zh" && r.theme === name);
  const en = results.find((r) => r.lang === "en" && r.theme === name);
  const sig = (r) => JSON.stringify([r.bodyBg, r.hero?.bg, r.particles?.avg, r.dots]);
  check(`语言无关配色 ${name}`, zh && en && sig(zh) === sig(en), zh && en ? `zh=${sig(zh)}` : "缺采样");
}

// ---- 记不记得住：刷新后应该还在苔色（最后一个点的） ----
await send("Page.navigate", { url });
await sleep(1400);
const after = await evalIn(`(() => ({
  stored: localStorage.getItem('synteny.theme'),
  attr: document.documentElement.getAttribute('data-theme'),
  themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
  paper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
}))()`);
check(
  "持久化/刷新后仍是苔色",
  after.stored === "moss" && after.attr === "moss",
  `localStorage=${after.stored} data-theme=${after.attr} theme-color=${after.themeColor}`,
);

const out = {
  url,
  // 完整采样留档：颜色类回归只能靠对比原始值来定位，而不是靠一句 PASS/FAIL。
  results: results.map((r) => ({
    lang: r.lang, theme: r.theme, attr: r.attr, bodyBg: r.bodyBg, ink: r.ink, ink3: r.ink3,
    paper: r.paper, amber: r.amber, accentSoft: r.accentSoft, hero: r.hero, particles: r.particles, dots: r.dots,
  })),
  afterReload: after,
  failures,
};
console.log("\n" + JSON.stringify(out, null, 2));
ws.close();
chrome.kill();
process.exit(failures.length === 0 ? 0 : 1);