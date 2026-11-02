import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 把页面上看得见的文字全部导出成一个 JSON。
 *
 * 用途：改 i18n 之前存一份，改完再存一份，逐字比对——
 * 中文模式必须和改动之前完全一致。这类重构最容易在顺手改文案时
 * 悄悄动到别的地方，肉眼看不出来。
 *
 * 用法：node tools/text-snapshot.mjs <输出文件>
 */

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.SYNTENY_URL || "http://127.0.0.1:5174/";
const out = process.argv[2] || "snapshot.json";
const port = 9600 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(join(tmpdir(), "snap-"));
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: BASE });
await sleep(1200);

// 空状态一份，跑完示例数据再一份：动态文案（提示语、表头、图注）只在有结果时出现。
const grab = `(() => ({
  title: document.title,
  lang: document.documentElement.lang,
  dataLang: document.documentElement.getAttribute('data-lang'),
  desc: document.querySelector('meta[name="description"]')?.content,
  aria: Array.from(document.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label')),
  th: Array.from(document.querySelectorAll('th')).map((e) => e.textContent.trim()),
  // 与排版无关的纯文字：空白一律压成一个空格，跨语言比对只信这个。
  norm: document.body.textContent.replace(/\\s+/g, ' ').trim(),
  text: document.body.innerText.replace(/\\n{3,}/g, '\\n\\n').trim(),
}))()`;

const empty = await evalIn(grab);
await evalIn(`document.getElementById('btnDemo').click(), true`);
for (let i = 0; i < 100; i += 1) {
  if (await evalIn(`!!document.getElementById('figDot')?.classList.contains('ready')`)) break;
  await sleep(200);
}
await sleep(400);
const filled = await evalIn(grab);

writeFileSync(out, `${JSON.stringify({ empty, filled }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  out,
  emptyChars: empty.text.length,
  filledChars: filled.text.length,
  th: filled.th,
  title: filled.title,
}));
chrome.kill();
process.exit(0);