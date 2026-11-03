import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * D2 不变量 + 减弱动效的内容可见性（SDS §4.7 / §6.1）。
 *
 * 为什么要有这个脚本：`.body-grid` 是这一页唯一的双列正文区，`#method` 与
 * `#limits` 就住在里面。SDS v1.0 曾打算让整块 `.body-grid` 淡入，那样两个
 * 正文容器会跟着一起 transform —— 直接违背 D2（正文必须是一块静止的纸）。
 * 批次四改用「逐个子元素入场」绕开了这件事，但绕开是**靠人记住**的：
 * 以后任何人给 `.body-grid`、`.prose` 或 `.note` 加一条入场，页面看起来
 * 依然漂亮，只有这条约束被悄悄破坏。所以这里把它钉成可执行的断言。
 *
 * 三件事分开断言，因为它们的失效方式不同：
 *
 * 1. **计算样式**：只看最终态是不够的。入场过渡只有半秒，跑完之后
 *    transform 回到 none、opacity 回到 1，违规会自我擦除。所以加载后的
 *    前 1 秒里有密集采样，滚动过程中每个位置再采一次。只要有任何一帧
 *    `#method`/`#limits` 子树里出现 transition/transform/opacity 变化就算失败。
 * 2. **规则扫描**：计算样式看不见「此刻没匹配、但确实指向它们」的规则
 *    （例如带 `#method` 前缀、或只在某种状态下的选择器）。所以再把
 *    document.styleSheets 里所有声明了这些属性的规则拿出来，逐条判断
 *    它能否匹配到两棵子树内部。跑的是构建产物里的那份 CSS —— preview
 *    服务的就是 dist，扫到的就是发布出去的那一份。
 * 3. **减弱动效**：隐藏态只写在 `@media (prefers-reduced-motion: no-preference)`
 *    里面，所以减弱动效下这些选择器根本不存在。检查器的 `reduced-hidden`
 *    规则会在 1440px 首屏数「看不见的文字块」，两个以上就 FAIL。这里用
 *    同一套判据自己数一遍，要求 **0 个**（比检查器的 ≥2 更严：这一页没有
 *    任何理由让首屏文字在减弱动效下不可见）。
 *
 * 范围只限两棵子树：`thead` 在 `.data` 里，是 `#method` 的**兄弟分支**，
 * 给它加入场是合规的。把断言写成「整个 .body-grid 都不许动」会误杀正确代码，
 * 所以脚本末尾专门断言 `thead` 不在两棵子树内 —— 免得将来有人为了「修」
 * 这条测试而误删批次四的入场。
 *
 * 用法：
 *   node tools/motion-check.mjs
 *   SYNTENY_URL=http://localhost:4173/ node tools/motion-check.mjs
 *
 * 零依赖：只用 Node 内置模块 + 本机 Chrome 的 CDP，与 tools/ 下其它脚本一致。
 * 任何一条断言不成立都 exit 1，并打印具体是哪个元素、哪条规则、哪一项属性。
 */

const CHROME = process.env.SYNTENY_CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
/** 默认打本地预览；preview 只绑 IPv6 localhost，所以 4173 也进候选。 */
const DEFAULT_URL = "http://127.0.0.1:5174/";
const WANTED = process.env.SYNTENY_URL || DEFAULT_URL;
const port = 9800 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(join(tmpdir(), "mchk-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--lang=zh-CN", "--disable-gpu", "--no-first-run",
  "--no-default-browser-check", "--hide-scrollbars", "--force-color-profile=srgb",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--window-size=1440,1100", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 决定打哪个地址。
 *
 * 没设 SYNTENY_URL 时先试 127.0.0.1:5174（dev/preview 的默认约定），
 * 再退到 4173（vite preview 的默认端口）。Windows 上 preview 只监听
 * IPv6 localhost，127.0.0.1 会连不上，所以两个名字都要试。
 */
async function pickUrl() {
  const cands = [WANTED];
  if (WANTED === DEFAULT_URL) cands.push("http://localhost:4173/", "http://127.0.0.1:4173/");
  for (const url of cands) {
    try {
      const r = await fetch(url, { method: "GET" });
      if (r.ok) return url;
    } catch { /* 这个端口没起，试下一个 */ }
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

/**
 * 往页面里注入一个函数并立刻跑。
 *
 * 直接把 Node 侧的函数体 toString 进去，而不是手写转义字符串：探针里有正则、
 * 有模板串，手写转义过一次就已经很难读了，再改一次必然出错。
 * 代价是被注入的函数不能引用任何 Node 作用域的变量。
 */
const run = async (fn, arg) => {
  const expression = arg === undefined
    ? `(${fn.toString()})()`
    : `(${fn.toString()})(${JSON.stringify(arg)})`;
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

// ---------------------------------------------------------------------------
// 页面内探针
// ---------------------------------------------------------------------------

/**
 * 数一遍 `#method` / `#limits` 子树里「在动」的元素。
 *
 * 除了逐元素的四项属性，还要看 `getAnimations()`：过渡跑到一半时计算样式
 * 可能已经回到终值（或者反过来），而正在跑的动画/过渡是「此刻确实在动」的
 * 直接证据。两者交叉，漏报的机会才小。
 *
 * 还要查**祖先链**。这一条是补上的漏洞：只要在 `.body-grid` 上加一次
 * transform，两段正文就跟着整块平移，而子树内部的元素自己没变——
 * 只查子树会判「干净」。祖先是空的话，CSS 里写多少都没关系；
 * 祖先一旦有 transform/opacity，正文就已经不在原位了。
 */
function d2Collect() {
  const roots = [document.getElementById("method"), document.getElementById("limits")];
  const missing = roots.map((r, i) => (r ? null : i === 0 ? "#method" : "#limits")).filter(Boolean);
  if (missing.length > 0) return { error: "找不到 " + missing.join(" / ") };

  // 两棵子树有重叠：#limits 是 #method 的后代。去重，否则每个元素查两遍。
  const seen = new Set();
  const els = [];
  for (const root of roots) {
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (seen.has(el)) continue;
      seen.add(el);
      els.push(el);
    }
  }

  const toMs = (list) => list.split(",").map((raw) => {
    const n = parseFloat(raw) || 0;
    return raw.trim().endsWith("ms") ? n : n * 1000;
  });
  const name = (el) => {
    const cls = typeof el.className === "string" ? el.className.trim() : "";
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (cls ? "." + cls.split(/\s+/).join(".") : "");
  };

  const bad = [];
  for (const el of els) {
    const cs = getComputedStyle(el);
    const why = [];
    for (const d of toMs(cs.transitionDuration)) if (d > 0.0001) why.push("transition-duration=" + d + "ms");
    if (cs.transform !== "none") why.push("transform=" + cs.transform);
    if (cs.translate && cs.translate !== "none") why.push("translate=" + cs.translate);
    if (cs.scale && cs.scale !== "none") why.push("scale=" + cs.scale);
    if (cs.rotate && cs.rotate !== "none") why.push("rotate=" + cs.rotate);
    const op = parseFloat(cs.opacity);
    if (!(op >= 0.999)) why.push("opacity=" + cs.opacity);
    if (cs.animationName !== "none") why.push("animation-name=" + cs.animationName);
    if (why.length > 0) bad.push(name(el) + " → " + why.join(", "));
  }

  const running = [];
  for (const root of roots) {
    for (const a of root.getAnimations({ subtree: true })) {
      const t = a.effect && a.effect.target;
      if (t && root.contains(t)) running.push(name(t) + " " + a.constructor.name + (a.transitionProperty ? "(" + a.transitionProperty + ")" : ""));
    }
  }

  // 祖先链：从 #method 一路走到 <body>。任何一层挂着 transform / opacity /
  // translate / scale / rotate，正文就已经被搬离原位了，哪怕它自己的
  // computed style 是干净的。这条检查防的正是「在父容器上做动效」这种
  // 绕过 D2 的写法。
  const ancestorBad = [];
  for (let n = roots[0].parentElement; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const why = [];
    for (const d of toMs(cs.transitionDuration)) if (d > 0.0001 && why.length === 0) why.push("transition-duration=" + d + "ms");
    if (cs.transform !== "none") why.push("transform=" + cs.transform);
    if (cs.translate && cs.translate !== "none") why.push("translate=" + cs.translate);
    if (cs.scale && cs.scale !== "none") why.push("scale=" + cs.scale);
    if (cs.rotate && cs.rotate !== "none") why.push("rotate=" + cs.rotate);
    const op = parseFloat(cs.opacity);
    if (!(op >= 0.999)) why.push("opacity=" + cs.opacity);
    if (why.length > 0) ancestorBad.push(name(n) + " → " + why.join(", "));
  }

  return {
    count: els.length,
    bad,
    ancestorBad,
    running,
    // reveal.ts 是本轮唯一会加隐藏态的模块。两棵子树里出现 .reveal 就等于
    // 有人把入场目标扩到了正文上，无论当前透明度是多少都该拦下。
    reveal: els.filter((el) => el.classList.contains("reveal")).length,
    limitsInsideMethod: !!roots[0].contains(roots[1]),
    theadInside: els.some((el) => el.tagName === "THEAD"),
  };
}

/**
 * 扫一遍当前文档加载的样式规则，找出「能匹配到两棵子树、又声明了动效属性」的那些。
 *
 * 关键细节：`@media` 里的规则要先看媒体查询此刻是否成立。app.css 末尾那条
 * `@media (prefers-reduced-motion: reduce) { * { transition-duration:.001ms } }`
 * 在默认状态下不生效，如果按「选择器能匹配就算」来处理，`*` 会匹配到正文里
 * 每一个元素，整条测试立刻变成噪音。媒体查询不成立的规则直接整棵跳过。
 *
 * 除了「现在就能匹配」的规则，选择器里直接点名 `#method` / `#limits` 的也一律
 * 算命中——那种规则哪怕此刻没生效（比如挂在 :hover 下），意图已经很明确了。
 */
function cssRuleScan() {
  const roots = [document.getElementById("method"), document.getElementById("limits")].filter(Boolean);
  const PROP = /^(transition|transform|translate|scale|rotate|opacity|animation)$|^transition-[a-z-]+$|^animation-[a-z-]+$/;
  const offenders = [];
  const sheets = [];
  let styleRules = 0;

  // 逗号分隔的选择器列表要按顶层逗号切：`:not(a, b)` 里的逗号不是分隔符。
  const split = (text) => {
    const out = [];
    let depth = 0;
    let cur = "";
    for (const ch of text) {
      if (ch === "(" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "]") depth -= 1;
      if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
  };

  const walk = (rules, where) => {
    for (const r of rules) {
      // 分组规则（@media / @supports / @layer）没有 selectorText，往下走；
      // @media 先判真假，不成立的整棵跳过。
      if (r.cssRules && !r.selectorText) {
        if (r.media && typeof r.media.mediaText === "string") {
          let applies = true;
          try { applies = matchMedia(r.media.mediaText).matches; } catch { applies = true; }
          if (!applies) continue;
          walk(r.cssRules, where + " @" + r.media.mediaText);
        } else {
          walk(r.cssRules, where + " " + (r.conditionText || r.name || ""));
        }
        continue;
      }
      if (!r.selectorText) continue;
      styleRules += 1;
      const decls = [];
      for (const p of r.style) if (PROP.test(p)) decls.push(p + ": " + r.style.getPropertyValue(p).trim());
      if (decls.length === 0) continue;
      for (const sel of split(r.selectorText)) {
        const namedById = /#(method|limits)\b/.test(sel);
        let matched = false;
        for (const root of roots) {
          try {
            if (root.matches(sel) || root.querySelectorAll(sel).length > 0) { matched = true; break; }
          } catch { /* 浏览器解析不了的选择器不可能生效，跳过 */ }
        }
        if (namedById || matched) offenders.push({ sel, decls, where, namedById, matched });
      }
    }
  };

  for (const sheet of Array.from(document.styleSheets)) {
    sheets.push(sheet.href || "inline");
    let rules = null;
    try { rules = sheet.cssRules; } catch { sheets.push("unreadable"); continue; }
    if (rules) walk(rules, sheet.href ? "sheet" : "inline");
  }

  return { sheets, styleRules, offenders };
}

/** 复刻检查器 reduced-hidden 的判据，数首屏有多少文字块是看不见的。 */
function reducedProbe() {
  const hidden = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const rg = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.nodeValue.trim();
    const el = n.parentElement;
    if (t.length < 3 || !el || el.closest('script, style, noscript, [aria-hidden="true"]')) continue;
    rg.selectNodeContents(n);
    const r = rg.getBoundingClientRect();
    if (r.width < 2 || r.top > innerHeight || r.bottom < 0) continue;
    let o = 1;
    let gone = false;
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.visibility === "hidden") { gone = true; break; }
      o *= +cs.opacity;
    }
    if (gone || o < 0.1) hidden.push(t.slice(0, 40));
  }
  const fig = document.querySelector(".hero-fig");
  return {
    hidden,
    reduce: matchMedia("(prefers-reduced-motion: reduce)").matches,
    reveal: document.querySelectorAll(".reveal").length,
    anyAnimations: document.getAnimations ? document.getAnimations().length : 0,
    figInline: fig ? (fig.getAttribute("style") || "") : "(no .hero-fig)",
    figTransform: fig ? getComputedStyle(fig).transform : "(no .hero-fig)",
    scrollY: Math.round(scrollY),
  };
}

/** 粒子层：数量、画没画、以及一个用来判「两次采样是否逐像素一致」的指纹。 */
function particleProbe() {
  const c = document.getElementById("headParticles");
  const head = document.querySelector(".head");
  if (!c || !head) return { error: "找不到 #headParticles 或 .head" };
  const g = c.getContext("2d");
  let painted = 0;
  let maxA = 0;
  let rgb = [0, 0, 0];
  let fp = 7;
  if (c.width > 0 && c.height > 0) {
    const d = g.getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a > 0) painted += 1;
      if (a > maxA) { maxA = a; rgb = [d[i], d[i + 1], d[i + 2]]; }
      // 只抽样，但步长与权重都固定，同样的画面永远得到同样的数。
      if (i % 164 === 0) fp = (fp * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7 + a) % 2147483647;
    }
  }
  const cr = c.getBoundingClientRect();
  const hr = head.getBoundingClientRect();
  const area = cr.width * cr.height;
  return {
    count: Number(c.dataset.particleCount),
    expected: Math.max(18, Math.min(90, Math.round(area / 9000))),
    area: Math.round(area),
    painted,
    maxA,
    rgb,
    fingerprint: fp,
    canvasW: Math.round(cr.width),
    canvasH: Math.round(cr.height),
    headW: Math.round(hr.width),
    headH: Math.round(hr.height),
  };
}

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------

const url = await pickUrl();
console.log(JSON.stringify({ url, chrome: CHROME }));

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(250);

// —— 1. 计算样式：加载后的前 1 秒密集采样 ——
// 入场过渡只有 .5s。只在稳定后采一次，等于只在「已经擦干净」的时候看。
const samples = [];
for (let i = 0; i < 11; i += 1) {
  samples.push(await run(d2Collect));
  await sleep(90);
}

// —— 2. 计算样式：滚动过程中采样 ——
// #method 与 #limits 都在首屏以下，它们的入场（如果哪天被误加）只会在滚动到
// 那个位置时才开始。滚动用 scrollTo 而不是合成滚轮：这里要的是「触发观察器」，
// 不需要真实输入的时序。
for (const y of [0, 420, 900, 1500, 2200, 3000, 99999]) {
  await run((top) => { scrollTo(0, top); }, y);
  await sleep(260);
  samples.push(await run(d2Collect));
}
await sleep(900);
samples.push(await run(d2Collect));

const err = samples.find((s) => s.error);
check("D2/子树存在", !err, err ? err.error : `采样 ${samples.length} 次`);
if (!err) {
  const first = samples[0];
  // 门槛只用来证明「检查的范围不是空的」。#method 下面就是 2 段正文 + h3#limits
  // + 2 段正文，加上内联的 span/b/code，实测 12 个元素；正文本身就这么点东西，
  // 写死一个更大的数只会让断言变成关于排版的断言。
  check("D2/检查规模非空", first.count >= 8, `#method+#limits 子树共 ${first.count} 个元素`);
  check("D2/#limits 在 #method 内（前提）", first.limitsInsideMethod === true, "#limits 是 #method 的后代，断言范围重叠属预期");
  check("D2/thead 不在两棵子树内", first.theadInside === false, "thead 在 .body-grid > .data，是兄弟分支；给它加入场是合规的");
  check("D2/子树内无 .reveal", samples.every((s) => s.reveal === 0), "reveal.ts 从不把正文当入场目标");

  const styleViolations = [];
  for (const s of samples) {
    for (const b of s.bad) styleViolations.push(b);
    for (const r of s.running) styleViolations.push(r + "（运行中的过渡/动画）");
  }
  check(
    "D2/计算样式无 transition/transform/opacity",
    styleViolations.length === 0,
    styleViolations.length === 0
      ? `${samples.length} 次采样 × ${first.count} 个元素，全部静止`
      : styleViolations.slice(0, 8).join(" | "),
  );

  // 祖先链。这条补的是一个真实的漏检：把 transform 加在 .body-grid 上时，
  // 两段正文会整块平移，而子树内部逐元素的检查全是干净的。
  const ancestorViolations = [];
  for (const s of samples) {
    for (const a of s.ancestorBad || []) ancestorViolations.push(a);
  }
  check(
    "D2/祖先链无 transform/opacity",
    ancestorViolations.length === 0,
    ancestorViolations.length === 0
      ? "从 #method 到 body 的每一层都不动——正文没被父容器搬走"
      : [...new Set(ancestorViolations)].slice(0, 6).join(" | "),
  );
}

// —— 3. 规则扫描：发布产物里的 CSS 有没有指向它们 ——
const scan = await run(cssRuleScan);
const bundleCss = scan.sheets.filter((s) => s.includes("/assets/") && s.endsWith(".css"));
check("CSS/扫到了构建产物", scan.sheets.length > 0, `样式表：${scan.sheets.join(", ") || "(无)"}`);
console.log(`      ${bundleCss.length > 0 ? "构建产物 CSS" : "非构建产物 CSS"}；规则总数 ${scan.styleRules}`);
check("CSS/规则数非空", scan.styleRules > 80, `共扫描 ${scan.styleRules} 条样式规则`);
check(
  "CSS/无规则对子树声明动效属性",
  scan.offenders.length === 0,
  scan.offenders.length === 0
    ? "0 条规则命中 #method/#limits 子树"
    : scan.offenders.slice(0, 6).map((o) => `${o.sel} { ${o.decls.join("; ")} }${o.namedById ? "（选择器直接点名）" : ""}`).join(" | "),
);

// —— 4. 减弱动效：内容必须全部可见 ——
// 用 CDP 模拟系统偏好。必须在导航**之前**设好：隐藏态是否存在取决于首帧。
await send("Emulation.setEmulatedMedia", {
  media: "",
  features: [{ name: "prefers-reduced-motion", value: "reduce" }],
});
await send("Page.navigate", { url });
await sleep(1600);

const red = await run(reducedProbe);
check("reduced/媒体查询生效", red.reduce === true, "matchMedia('(prefers-reduced-motion: reduce)')");
check("reduced/没有隐藏态类", red.reveal === 0, `页面上的 .reveal = ${red.reveal}（reveal.ts 在减弱动效下一个类都不加）`);
check(
  "reduced/首屏文字全部可见",
  red.hidden.length === 0,
  red.hidden.length === 0
    ? "按检查器 reduced-hidden 的判据，0 个不可见文字块"
    : `${red.hidden.length} 个文字块不可见：${red.hidden.slice(0, 5).map((t) => JSON.stringify(t)).join(", ")}`,
);

// 缩放也要不生效：批二的滚动缩放会在 .hero-fig 上写内联 transform。
await run(() => { scrollTo(0, 620); });
await sleep(500);
const redScrolled = await run(reducedProbe);
check(
  "reduced/滚动缩放不生效",
  redScrolled.figTransform === "none" && !/transform/.test(redScrolled.figInline),
  `.hero-fig 内联样式=${JSON.stringify(redScrolled.figInline)} 计算 transform=${redScrolled.figTransform}`,
);

// 粒子层：减弱动效下只画一帧静态画面，指针推不动它。
const pA = await run(particleProbe);
if (pA.error) {
  check("reduced/粒子层存在", false, pA.error);
} else {
  check("reduced/粒子数符合面积公式", pA.count === pA.expected, `${pA.canvasW}×${pA.canvasH} → ${pA.count}（公式 ${pA.expected}）`);
  check("reduced/粒子层已画出静态帧", pA.painted > 200, `${pA.painted} 个非透明像素，最大 alpha ${pA.maxA}`);
  check(
    "reduced/粒子层尺寸 = .head",
    Math.abs(pA.canvasH - pA.headH) <= 2 && Math.abs(pA.canvasW - pA.headW) <= 2,
    `canvas ${pA.canvasW}×${pA.canvasH} / .head ${pA.headW}×${pA.headH}`,
  );
  // 朝画布中间连发几次指针移动：正常模式下这会推开粒子、改变像素。
  const cx = Math.round(pA.canvasW / 2);
  const cy = Math.round(pA.canvasH / 2);
  for (let i = 0; i < 4; i += 1) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx + i * 6, y: cy + i * 3, buttons: 0, pointerType: "mouse" });
    await sleep(60);
  }
  await sleep(350);
  const pB = await run(particleProbe);
  check(
    "reduced/指针推不动粒子（未启动 rAF）",
    pB.fingerprint === pA.fingerprint,
    pB.fingerprint === pA.fingerprint ? "指针移动 4 次后逐像素一致" : `指纹 ${pA.fingerprint} → ${pB.fingerprint}`,
  );
}

// 收尾：把模拟关掉，免得留下会影响后续脚本的浏览器状态（每个脚本都是新进程，这里只是对称）。
await send("Emulation.setEmulatedMedia", { media: "", features: [] });

const result = { url, passed: passed.length, failed: failures.length, failures };
console.log("\n" + JSON.stringify(result, null, 2));
ws.close();
chrome.kill();
process.exit(failures.length === 0 ? 0 : 1);