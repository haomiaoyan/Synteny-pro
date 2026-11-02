import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 中英切换验收。
 *
 * 三件事，任何一件不对都算失败：
 *   1. 中文模式下页面文字必须与改动前逐字一致（对比 tools/shots/zh-before.json）；
 *   2. 切到英文后，可见文字里不能再有中文字符（词典漏一条就会露出来）；
 *   3. 切回中文后要与中文模式完全一致，也就是来回切换不掉字。
 *
 * 第 2 条比“看起来翻译完了”可靠得多：它把漏译直接变成一个数字。
 */

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.SYNTENY_URL || "http://127.0.0.1:5174/";
const baseline = JSON.parse(readFileSync("tools/shots/zh-before.json", "utf8"));

const port = 9500 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(join(tmpdir(), "i18n-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--lang=zh-CN", "--disable-gpu", "--no-first-run",
  "--no-default-browser-check", "--hide-scrollbars",
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: BASE });
await sleep(1000);

const GRAB = `(() => {
  const txt = document.body.textContent.replace(/\\s+/g, ' ').trim();
  const cjk = txt.match(/[\\u4e00-\\u9fff]+/g) || [];
  return {
    lang: document.documentElement.lang,
    dataLang: document.documentElement.getAttribute('data-lang'),
    title: document.title,
    norm: txt,
    cjkCount: cjk.length,
    cjkWords: Array.from(new Set(cjk)).slice(0, 25),
    th: Array.from(document.querySelectorAll('th')).map((e) => e.textContent.trim()),
    btn: document.getElementById('btnLang')?.textContent?.trim(),
    hidden: document.getElementById('btnLang')?.hasAttribute('hidden'),
  };
})()`;

const empty = await evalIn(GRAB);

// 语言按钮必须在加载后自己出现。它是 hidden 起手的，若“显示”写在点击回调里，
// 用户永远点不到——脚本用 JS 点击会绕过 hidden，所以只有这里能查出问题。
// 但远端首次加载要拉 chunk，读太早会读到还没执行的标记，所以轮询到出现为止；
// 等到多少毫秒本身就是证据：久等不来才是真故障。
const probeBtn = `(() => {
  const b = document.getElementById('btnLang');
  if (!b) return { present: false };
  const cs = getComputedStyle(b);
  return { present: true, hidden: b.hasAttribute('hidden'), display: cs.display, visible: !b.hasAttribute('hidden') && cs.display !== 'none' };
})()`;
let langBtn = await evalIn(probeBtn);
let btnWaitMs = 0;
for (let i = 0; i < 100 && langBtn.visible !== true; i += 1) {
  await sleep(100);
  btnWaitMs += 100;
  langBtn = await evalIn(probeBtn);
}
langBtn.waitedMs = btnWaitMs;

// 跑一遍示例数据，让动态文案（提示、图注、表头、类型名）也出现在页面上。
// 远端站点首次加载要拉 chunk + worker，点早了监听器还没绑上，所以失败就再点一次。
for (let attempt = 0; attempt < 3; attempt += 1) {
  await evalIn(`document.getElementById('btnDemo').click(), true`);
  let ok = false;
  for (let i = 0; i < 100; i += 1) {
    if (await evalIn(`!!document.getElementById('figDot')?.classList.contains('ready')`)) { ok = true; break; }
    await sleep(200);
  }
  if (ok) break;
}
await sleep(400);
const zh = await evalIn(GRAB);

await evalIn(`document.getElementById('btnLang').click(), true`);
await sleep(400);
const en = await evalIn(GRAB);

await evalIn(`document.getElementById('btnLang').click(), true`);
await sleep(400);
const zhAgain = await evalIn(GRAB);

// 英文全文落盘，方便逐句读一遍；机器只能测出漏翻，读不通要人看。
writeFileSync('tools/shots/en-text.txt', `${en.norm}
`, 'utf8');
const same = (a, b) => a === b;
// 提示语里带着真实耗时（“15 个区段 · 0.18 s · 覆盖 95.0%”），每次都不同。
// 不抹掉它，这个断言测的就是机器快慢，不是文案有没有被改坏。
const stripTime = (s) => s.replace(/\d+(?:\.\d+)? s\b/g, "<t> s");
const zhNorm = stripTime(zh.norm);
const baseFilled = stripTime(baseline.filled.norm);
console.log(JSON.stringify({
  zhMatchesBaseline: same(zhNorm, baseFilled),
  emptyMatchesBaseline: same(empty.norm, baseline.empty.norm),
  zhChars: zh.norm.length,
  langBtnVisibleAtLoad: langBtn,
  enCjkLeft: en.cjkCount,
  enLeftover: en.cjkWords,
  enTitle: en.title,
  enLangAttr: `${en.lang} / ${en.dataLang}`,
  enTh: en.th,
  enBtn: en.btn,
  enHidden: en.hidden,
  zhAfterToggleBack: same(stripTime(zhAgain.norm), zhNorm),
  zhTitleBack: zhAgain.title,
  // 中文基线第一处不一致，方便定位是哪个词条写错了
  firstDiff: (() => {
    const a = baseFilled, b = zhNorm;
    if (a === b) return null;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return { at: i, was: a.slice(i, i + 40), now: b.slice(i, i + 40) };
    }
    return null;
  })(),
  emptyLen: { was: baseline.empty.norm.length, now: empty.norm.length },
  emptyFirstDiff: (() => {
    const a = baseline.empty.norm, b = empty.norm;
    if (a === b) return null;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return { at: i, was: a.slice(i, i + 40), now: b.slice(i, i + 40) };
    }
    return null;
  })(),
}, null, 2));
chrome.kill();
process.exit(0);