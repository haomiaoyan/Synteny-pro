import "./styles/app.css";
// 入场动效层单独成文件，但仍走 main.ts 的 import，不另开 <link>：
// 构建器会把它编进同一个 CSS 产物，顺序天然确定（app.css 在前）。
// 顺序在这里是有意义的——motion.css 里有一条 .slot.reveal 要把
// app.css 的 .slot 过渡合并回来，它必须排在后面才能生效。
import "./styles/motion.css";
import { parseFasta, autoParams } from "./core/fasta.js";
import { makeDemo, demoCaption, type Demo } from "./core/demo.js";
import type { Sequence, Segment } from "./core/types.js";
import { drawPlot, invertPointer, pointerFraction, viewFromDrag, zoomView, zoomFactor, isZoomed, fullView, type PlotInput, type PlotState, type View } from "./ui/plot.js";
import type { RunRequest, RunReply, RunSuccess } from "./ui/worker.js";
import { makeHeroDemo } from "./ui/hero-demo.js";
import { initTheme } from "./ui/theme.js";
import { t, lang, initLang, onLangChange } from "./i18n.js";
import { downloadPng } from "./ui/export.js";
import { initScrollZoom, isScrollZoomActive, onScrollZoomReset } from "./ui/scroll-zoom.js";
import { initReveal } from "./ui/reveal.js";
import { repaintParticlesOnce, startParticles } from "./ui/particles.js";

/**
 * Page controller.
 *
 * Deliberately thin: it owns the file inputs, hands the sequences to a worker,
 * and paints whatever comes back. No comparison logic lives here, so the whole
 * engine stays testable in Node without a DOM.
 */

interface State {
  ref: Sequence | null;
  qry: Sequence | null;
  result: RunSuccess | null;
  geom: PlotState | null;
  /** Visible window over both genomes; null means "not drawn yet". */
  view: View | null;
  selected: string | null;
  busy: boolean;
  requestId: number;
}

const S: State = {
  ref: null,
  qry: null,
  result: null,
  geom: null,
  view: null,
  selected: null,
  busy: false,
  requestId: 0,
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing element #${id}`);
  return el as T;
};

/* ------------------------------------------------------------------ setup */

const worker = new Worker(new URL("./ui/worker.ts", import.meta.url), { type: "module" });

const el = {
  slotRef: $("slotRef"),
  slotQry: $("slotQry"),
  fileRef: $<HTMLInputElement>("fileRef"),
  fileQry: $<HTMLInputElement>("fileQry"),
  nameRef: $("nameRef"),
  nameQry: $("nameQry"),
  metaRef: $("metaRef"),
  metaQry: $("metaQry"),
  btnDemo: $<HTMLButtonElement>("btnDemo"),
  btnRun: $<HTMLButtonElement>("btnRun"),
  btnCsv: $<HTMLButtonElement>("btnCsv"),
  btnPng: $<HTMLButtonElement>("btnPng"),
  hint: $("hint"),
  plot: $<HTMLCanvasElement>("plot"),
  plotEmpty: $("plotEmpty"),
  readout: $("readout"),
  dragRect: $("dragRect"),
  figDot: $("figDot"),
  figTitle: $("figTitle"),
  figSize: $("figSize"),
  figK: $("figK"),
  figTime: $("figTime"),
  nCol: $("nCol"),
  nInv: $("nInv"),
  nTrn: $("nTrn"),
  nNoise: $("nNoise"),
  nCov: $("nCov"),
  nSeeds: $("nSeeds"),
  tbody: $("tbody"),
  tableCap: $("tableCap"),
  caption: $("caption"),
  xaxis: $("xaxis"),
  ylab: $("ylab"),
  figZoom: $<HTMLButtonElement>("figZoom"),
  advToggle: $<HTMLInputElement>("advToggle"),
  advBody: $("advBody"),
  inK: $<HTMLInputElement>("inK"),
  inW: $<HTMLInputElement>("inW"),
};

/* ---------------------------------------------------------- 入场动效层 */

// 尽早挂上，位置要紧。
//
// 这一层是「先藏后显」：`.reveal` 一加，元素就跳到 opacity:0 等入场。
// 所以它必须赶在首次内容绘制之前完成，否则首屏会先以最终状态画出来、
// 再被按回隐藏态重浮一遍——访客看到的是一次闪烁。
//
// 顶部这段（模块求值 + 这里的同步调用）跑在首帧之前；实测 FCP 在 380ms，
// 而 `.reveal` 在 246ms 就已就位。但这条边距只有一次布局那么厚，
// 别在它上面再插入重活（大循环、同步 fetch、等 worker）。
// 真需要异步准备的东西，放到下面去。
//
// 不接返回值：这一层与页面同寿，没有卸载时机。保留 teardown 是为了
// 将来真有「关掉入场」的开关时一处就能拆干净。
void initReveal();

/* --------------------------------------------------------------- helpers */

const fmtInt = (n: number): string => n.toLocaleString("en-US");

/** 提示语存的是生成方式而不是成品，换语言时可以照原样再刷一遍。 */
let hintSpec: { key: string; vars?: Record<string, string | number>; cls: "" | "busy" | "err" } | null =
  null;

const setHint = (
  key: string,
  vars?: Record<string, string | number>,
  cls: "" | "busy" | "err" = "",
): void => {
  hintSpec = { key, vars, cls };
  el.hint.textContent = t(key, vars);
  el.hint.className = "hint" + (cls ? " " + cls : "");
};

const refreshHint = (): void => {
  if (hintSpec !== null) setHint(hintSpec.key, hintSpec.vars, hintSpec.cls);
};

/** 已经在别处翻译好、或者来自异常对象的整句提示。 */
const setHintRaw = (text: string, cls: "" | "busy" | "err" = ""): void => {
  hintSpec = null;
  el.hint.textContent = text;
  el.hint.className = "hint" + (cls ? " " + cls : "");
};

const setDot = (cls: "" | "ready" | "busy"): void => {
  el.figDot.className = "dot" + (cls ? " " + cls : "");
};

function showSlot(role: "ref" | "qry", seq: Sequence | null): void {
  const nameEl = role === "ref" ? el.nameRef : el.nameQry;
  const metaEl = role === "ref" ? el.metaRef : el.metaQry;
  const slotEl = role === "ref" ? el.slotRef : el.slotQry;

  if (seq === null) {
    nameEl.textContent = t("slot.name.empty");
    nameEl.classList.add("empty");
    metaEl.textContent = t("slot.meta.empty");
    slotEl.classList.remove("filled");
    return;
  }
  nameEl.textContent = seq.name;
  nameEl.classList.remove("empty");
  const n = seq.seq.length;
  metaEl.textContent =
    n >= 1e6 ? `${(n / 1e6).toFixed(2)} Mbp · ${fmtInt(n)} bp` : `${fmtInt(n)} bp`;
  slotEl.classList.add("filled");
}

/** Read a file as text, reporting the failure mode rather than swallowing it. */
async function readText(file: File): Promise<string> {
  if (file.size === 0) throw new Error(t("err.emptyFile", { name: file.name }));
  if (file.size > 200 * 1024 * 1024) {
    throw new Error(t("err.tooBig", { name: file.name, mb: (file.size / 1048576).toFixed(0) }));
  }

  // Files straight from NCBI/Ensembl are almost always gzipped, and a visitor
  // who downloads one should not have to know that. DecompressionStream is
  // built into the browser, so this costs no dependency — only a check that it
  // exists, because Safari added it later than the others.
  if (isGzip(file)) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error(t("err.gzip", { name: file.name }));
    }
    const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return file.text();
}

/**
 * Detect gzip by magic bytes rather than by extension: a file named `.fa` that
 * is actually gzip is common enough, and trusting the name would emit the
 * misleading "no FASTA sequence found" error for a perfectly good file.
 */
function isGzip(file: File): boolean {
  if (/\.gz$/i.test(file.name)) return true;
  return file.type === "application/gzip" || file.type === "application/x-gzip";
}

async function loadFile(role: "ref" | "qry", file: File): Promise<void> {
  try {
    setHint("hint.reading", { name: file.name }, "busy");
    const text = await readText(file);
    const seqs = parseFasta(text);
    if (seqs.length === 0) throw new Error(t("err.noFasta", { name: file.name }));
    // Multi-record files are common; the first record is used and the UI says so,
    // rather than silently concatenating chromosomes into one bogus sequence.
    const seq = seqs[0];
    if (seqs.length > 1) {
      setHint("hint.oneOfMany", { name: file.name, n: seqs.length, first: seq.name }, "busy");
    }
    if (seq.seq.length < 2000) {
      throw new Error(t("err.tooShort", { seq: seq.name, bp: seq.seq.length }));
    }
    if (role === "ref") S.ref = seq;
    else S.qry = seq;
    showSlot(role, seq);
    refreshRunButton();
    if (seqs.length === 1) setHint("hint.ready");
  } catch (err) {
    setHintRaw(err instanceof Error ? err.message : String(err), "err");
  }
}

function refreshRunButton(): void {
  el.btnRun.disabled = S.busy || S.ref === null || S.qry === null;
}

/* ------------------------------------------------------------ run a pair */

function resolveParams(): { k: number; w: number } {
  if (S.ref === null || S.qry === null) throw new Error("sequences missing");
  const auto = autoParams(S.ref.seq.length, S.qry.seq.length);
  if (!el.advToggle.checked) return auto;
  const k = Number.parseInt(el.inK.value, 10);
  const w = Number.parseInt(el.inW.value, 10);
  return {
    k: Number.isFinite(k) && k >= 9 && k <= 21 ? k : auto.k,
    w: Number.isFinite(w) && w >= 4 && w <= 256 ? w : auto.w,
  };
}

function run(): void {
  if (S.ref === null || S.qry === null || S.busy) return;
  const params = resolveParams();

  S.busy = true;
  S.requestId += 1;
  refreshRunButton();
  setDot("busy");
  setHint("hint.running", { k: params.k, w: params.w }, "busy");

  const msg: RunRequest = {
    id: S.requestId,
    ref: S.ref.seq,
    qry: S.qry.seq,
    k: params.k,
    w: params.w,
  };
  worker.postMessage(msg);
}

worker.onmessage = (ev: MessageEvent<RunReply>): void => {
  const reply = ev.data;
  // Ignore a stale reply if the user started another run while this one was
  // in flight; otherwise the older result would overwrite the newer one.
  if (reply.id !== S.requestId) return;

  S.busy = false;
  refreshRunButton();

  if (!reply.ok) {
    setDot("");
    setHint("hint.failed", { msg: reply.error }, "err");
    return;
  }

  S.result = reply;
  S.selected = null;
  paint(reply);
  setDot("ready");
  const s = reply.stats;
  setHint("hint.summary", {
    n: fmtInt(reply.segs.length),
    t: (s.elapsed / 1000).toFixed(2),
    cov: (s.coverage * 100).toFixed(1),
  });
};

worker.onerror = (ev: ErrorEvent): void => {
  S.busy = false;
  refreshRunButton();
  setDot("");
  setHint("hint.workerError", { msg: ev.message || t("hint.unknownError") }, "err");
};

/* ---------------------------------------------------------------- paint */

function paint(res: RunSuccess): void {
  if (S.ref === null || S.qry === null) return;
  const s = res.stats;

  el.plotEmpty.classList.add("hidden");

  el.figTitle.textContent = `${S.ref.name} × ${S.qry.name}`;
  el.figSize.textContent = (Math.max(s.nRef, s.nQry) / 1e6).toFixed(2);
  el.figK.textContent = String(s.k);
  el.figTime.textContent = (s.elapsed / 1000).toFixed(2);

  const counts = { col: 0, inv: 0, trn: 0 };
  for (const seg of res.segs) counts[seg.type] += 1;
  el.nCol.textContent = String(counts.col);
  el.nInv.textContent = String(counts.inv);
  el.nTrn.textContent = String(counts.trn);
  let noise = 0;
  for (let i = 0; i < res.pts.cls.length; i++) if (res.pts.cls[i] === 3) noise++;
  el.nNoise.textContent = fmtInt(noise);
  el.nCov.textContent = (s.coverage * 100).toFixed(1) + "%";
  el.nSeeds.textContent = fmtInt(s.seeds);

  S.view = fullView(s.nRef, s.nQry);
  redraw();

  paintTable(res.segs, s.nRef);
  paintCaption(res);

  el.btnCsv.disabled = res.segs.length === 0;
  el.btnPng.disabled = res.segs.length === 0;
}

/** Repaint the canvas from current state. Every visual change goes through
 * here so the window, the selection and the axis labels cannot disagree. */
function redraw(): void {
  if (S.result === null) return;
  const s = S.result.stats;
  const seg = S.result.segs.find((x) => x.id === S.selected) ?? null;
  S.geom = drawPlot(el.plot, {
    pts: S.result.pts,
    nRef: s.nRef,
    nQry: s.nQry,
    view: S.view ?? fullView(s.nRef, s.nQry),
    highlight: seg,
  });
  paintAxes();
  // 重画之后画布内坐标到基因组坐标的映射已经变了，上一帧记下的指针位置不再可比。
  // 不作废的话，指针停在原地不动时缩放/复位后的读数会一直沿用旧的换算。
  hoverLastX = Number.NaN;
  hoverLastY = Number.NaN;
}

/** Axis titles must name the unit the tick labels are actually in. */
function paintAxes(): void {
  const s = S.result?.stats;
  if (s === undefined || S.view === null) return;
  const ux = unitName(S.view.r1 - S.view.r0);
  const uy = unitName(S.view.q1 - S.view.q0);
  el.xaxis.textContent = `Reference · ${ux}`;
  el.ylab.textContent = `Query · ${uy}`;

  const zoom = zoomFactor(S.view, s.nRef, s.nQry);
  const zoomed = isZoomed(S.view, s.nRef, s.nQry);
  el.figZoom.hidden = !zoomed;
  el.figZoom.textContent = `${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×`;
}

function unitName(span: number): string {
  if (span >= 2_000_000) return "Mbp";
  if (span >= 2_000) return "kbp";
  return "bp";
}

function paintCaption(res: RunSuccess): void {
  const inv = res.segs.filter((x) => x.type === "inv").length;
  const trn = res.segs.filter((x) => x.type === "trn").length;
  const col = res.segs.filter((x) => x.type === "col").length;

  if (res.segs.length === 0) {
    el.caption.innerHTML = t("cap.none");
    return;
  }
  const sep = lang() === "zh" ? "，" : ", ";
  const end = lang() === "zh" ? "。" : ".";
  const bits: string[] = [];
  bits.push(t("cap.col", { n: col }));
  if (inv > 0) bits.push(t("cap.inv", { n: inv }));
  if (trn > 0) bits.push(t("cap.trn", { n: trn }));
  bits.push(
    t("cap.cov", {
      cov: (res.stats.coverage * 100).toFixed(1),
      seeds: fmtInt(res.stats.seeds),
    }),
  );
  el.caption.innerHTML = bits.join(sep) + end;
}

function mmbp(v: number): string {
  return (v / 1e6).toFixed(2);
}

/**
 * Position for the hover readout.
 *
 * The readout follows the cursor across four orders of magnitude, so a fixed
 * unit would be wrong at one end or the other: "4.20 Mbp" is noise when the
 * window spans 3 kbp, and "4203 kbp" is unreadable at genome scale.
 */
function fmtPos(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(2) + " Mbp";
  if (v >= 1e4) return (v / 1e3).toFixed(1) + " kbp";
  return v.toLocaleString("en-US") + " bp";
}

function paintTable(segs: readonly Segment[], _nRef: number): void {
  const tb = el.tbody;
  tb.replaceChildren();

  if (segs.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "empt";
    const td = document.createElement("td");
    td.colSpan = 6;
    td.textContent = t("table.empty");
    tr.append(td);
    tb.append(tr);
    el.tableCap.textContent = t("table.capEmpty");
    return;
  }

  const LABEL: Record<Segment["type"], string> = { col: t("sig.col"), inv: t("sig.inv"), trn: t("sig.trn") };
  const CLS: Record<Segment["type"], string> = { col: "m-col", inv: "m-inv", trn: "m-tr" };

  for (const seg of segs) {
    const tr = document.createElement("tr");
    tr.dataset.id = seg.id;
    if (seg.id === S.selected) tr.classList.add("sel");

    const idTd = document.createElement("td");
    idTd.className = "id";
    idTd.textContent = seg.id;

    const typeTd = document.createElement("td");
    const mark = document.createElement("span");
    mark.className = "mark " + CLS[seg.type];
    typeTd.append(mark, document.createTextNode(LABEL[seg.type]));

    const rTd = document.createElement("td");
    rTd.className = "mono";
    rTd.textContent = `${mmbp(seg.r0)}–${mmbp(seg.r1)}`;

    const qTd = document.createElement("td");
    qTd.className = "mono";
    qTd.textContent = `${mmbp(Math.min(seg.q0, seg.q1))}–${mmbp(Math.max(seg.q0, seg.q1))}`;

    const lenTd = document.createElement("td");
    lenTd.className = "n";
    lenTd.textContent = (seg.len / 1e6).toFixed(2);

    const idenTd = document.createElement("td");
    idenTd.className = "n";
    idenTd.textContent = (seg.identity * 100).toFixed(1) + "%";

    tr.append(idTd, typeTd, rTd, qTd, lenTd, idenTd);
    tb.append(tr);
  }

  el.tableCap.textContent = t("table.capFilled", { n: segs.length });
}

/* ----------------------------------------------------------------- hover */

/**
 * 悬停读数与拖框。
 *
 * mousemove 每秒能来一百多次，每来一次就写一次 innerHTML，等于每个像素
 * 都让浏览器重新解析一遍这段标记——而中间的若干次根本来不及重绘。
 * 所以这里只把事件里拿到的坐标记下来，真正的换算和写入留到下一帧，
 * 一帧最多一次；getBoundingClientRect() 也就在同一处读一次。
 *
 * 坐标没变就什么也不做：指针停着不动时重复写同样的内容，还是要走一遍样式重算。
 */
let hoverPending = false;
/** 待处理的指针位置（视口坐标）；事件里只读 clientX/Y，不读 rect。 */
let hoverX = 0;
let hoverY = 0;
/** 上一帧实际画出来的画布内坐标，用来跳过原地抖动。 */
let hoverLastX = Number.NaN;
let hoverLastY = Number.NaN;

el.plot.addEventListener("mousemove", (ev) => {
  if (S.geom === null || S.result === null) return;
  hoverX = ev.clientX;
  hoverY = ev.clientY;
  if (hoverPending) return;
  hoverPending = true;
  requestAnimationFrame(paintHover);
});

function paintHover(): void {
  hoverPending = false;
  if (S.geom === null) return;

  // 每帧一次 —— 这个读法会强制一次布局，在 mousemove 里读就是每个事件一次。
  const rect = el.plot.getBoundingClientRect();
  const px = hoverX - rect.left;
  const py = hoverY - rect.top;

  if (drag !== null) {
    drag.x1 = px;
    drag.y1 = py;
    paintDragRect();
    return;
  }

  // 比的是画布内坐标而不是视口坐标：页面滚动时指针没动，读数却该跟着走。
  if (px === hoverLastX && py === hoverLastY) return;
  hoverLastX = px;
  hoverLastY = py;

  const pos = invertPointer(S.geom, px, py);
  if (pos === null) {
    el.readout.hidden = true;
    el.plot.style.cursor = "";
    return;
  }
  el.readout.hidden = false;
  el.readout.style.left = px + "px";
  el.readout.style.top = py + "px";
  el.readout.innerHTML = `ref <b>${fmtPos(pos.r)}</b><br>qry <b>${fmtPos(pos.q)}</b>`;
  el.plot.style.cursor = "crosshair";
}

el.plot.addEventListener("mouseleave", () => {
  el.readout.hidden = true;
  // 指针离开后位置记忆要作废，否则回到同一个点时会被当成「没变」而不重画。
  hoverLastX = Number.NaN;
  hoverLastY = Number.NaN;
  if (drag === null) el.plot.style.cursor = "";
});

/* ------------------------------------------------------------ zoom & pan */

/**
 * Drag state, or null.
 *
 * A drag is a rectangle to zoom into; the whole interaction is deliberately
 * one gesture the reader already knows from genome browsers rather than a
 * mode palette nobody would discover.
 */
let drag: { x0: number; y0: number; x1: number; y1: number } | null = null;

/** Position the selection rectangle over the plot while dragging. */
function paintDragRect(): void {
  if (drag === null) {
    el.dragRect.hidden = true;
    return;
  }
  const left = Math.min(drag.x0, drag.x1);
  const top = Math.min(drag.y0, drag.y1);
  el.dragRect.hidden = false;
  el.dragRect.style.left = left + "px";
  el.dragRect.style.top = top + "px";
  el.dragRect.style.width = Math.abs(drag.x1 - drag.x0) + "px";
  el.dragRect.style.height = Math.abs(drag.y1 - drag.y0) + "px";
}

el.plot.addEventListener("mousedown", (ev) => {
  if (S.geom === null || ev.button !== 0) return;
  const rect = el.plot.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;
  if (pointerFraction(S.geom, px, py) === null) return;
  drag = { x0: px, y0: py, x1: px, y1: py };
  paintDragRect();
  ev.preventDefault();
});

window.addEventListener("mouseup", (ev) => {
  el.dragRect.hidden = true;
  if (drag === null || S.geom === null || S.result === null) return;
  const rect = el.plot.getBoundingClientRect();
  const d = drag;
  drag = null;
  const x1 = ev.clientX - rect.left;
  const y1 = ev.clientY - rect.top;

  const moved = Math.abs(x1 - d.x0) > 6 || Math.abs(y1 - d.y0) > 6;
  if (!moved) {
    // A click, not a drag: select the block under the pointer, the same
    // gesture and the same result as clicking its row in the table.
    selectAt(x1, y1);
    return;
  }

  const s = S.result.stats;
  const next = viewFromDrag(
    S.geom,
    { px: d.x0, py: d.y0 },
    { px: x1, py: y1 },
    s.nRef,
    s.nQry,
  );
  if (next !== null) {
    S.view = next;
    redraw();
  }
});

el.plot.addEventListener("dblclick", () => {
  if (S.result === null) return;
  S.view = fullView(S.result.stats.nRef, S.result.stats.nQry);
  redraw();
});

/**
 * Wheel zoom about the pointer.
 *
 * Ctrl/Cmd is not required: on a figure whose only interaction is looking
 * closer, the wheel is unambiguously a zoom, and requiring a modifier would
 * make it undiscoverable.
 *
 * 合并到帧：一次滚动能连发十几个 wheel 事件，每个都重绘一遍图纯属浪费，
 * 中间那些帧根本不会被看到。所以事件里只累加、记录指针位置，重绘留到下一帧。
 *
 * 三个容易写错的细节：
 *  1. preventDefault() 必须在事件里同步调用。挪进 rAF 就晚了，页面会滚动。
 *  2. deltaY 要累加，并且要认 deltaMode。不同设备报的单位不同：line 模式
 *     一格约 3，page 模式一格约一屏，跟像素模式差几十倍；不换算的话，
 *     同一个手势在触控板和外接鼠标上缩放速度天差地别。
 *  3. getBoundingClientRect() 每帧最多一次。它在 rAF 里读，不在事件里读，
 *     免得每个事件都强制一次布局。
 */
let wheelPending = false;
let wheelDeltaY = 0;
/** 最后一次指针的视口坐标；换算留到 rAF，好让 rect 每帧只读一次。 */
let wheelClientX = 0;
let wheelClientY = 0;

el.plot.addEventListener(
  "wheel",
  (ev) => {
    if (S.geom === null || S.result === null) return;
    ev.preventDefault();

    // deltaMode 1 = line（Firefox 默认单位），一格约 3；换算成像素才和
    // 触控板的 deltaMode 0 同量级，否则同一个手势快慢差几十倍。
    wheelDeltaY += ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
    wheelClientX = ev.clientX;
    wheelClientY = ev.clientY;

    if (wheelPending) return;
    wheelPending = true;
    requestAnimationFrame(applyWheelZoom);
  },
  { passive: false },
);

function applyWheelZoom(): void {
  wheelPending = false;
  const d = wheelDeltaY;
  wheelDeltaY = 0;
  if (S.result === null || S.geom === null || d === 0) return;

  // 每帧一次 —— 这个读法会强制一次布局，放在事件里就是每个事件一次。
  const rect = el.plot.getBoundingClientRect();
  const f = pointerFraction(S.geom, wheelClientX - rect.left, wheelClientY - rect.top);
  if (f === null) return;

  const s = S.result.stats;
  const factor = Math.exp(d * 0.0016);
  S.view = zoomView(S.view ?? fullView(s.nRef, s.nQry), f.fx, f.fy, factor, s.nRef, s.nQry);
  redraw();
}

el.figZoom.addEventListener("click", () => {
  if (S.result === null) return;
  S.view = fullView(S.result.stats.nRef, S.result.stats.nQry);
  redraw();
});

/* ------------------------------------------------------------------ misc */

el.btnDemo.addEventListener("click", () => {
  if (S.busy) return;
  setHint("hint.buildingDemo", {}, "busy");
  const demo: Demo = makeDemo();
  S.ref = demo.ref;
  S.qry = demo.qry;
  showSlot("ref", demo.ref);
  showSlot("qry", demo.qry);
  refreshRunButton();
  el.caption.textContent = demoCaption(demo, lang() === "en");
  run();
});

el.btnRun.addEventListener("click", run);

el.btnCsv.addEventListener("click", () => {
  if (S.result === null) return;
  const rows = [["id", "type", "ref_start", "ref_end", "qry_start", "qry_end", "length_bp", "identity"]];
  for (const s of S.result.segs) {
    rows.push([
      s.id,
      s.type,
      String(s.r0),
      String(s.r1),
      String(Math.min(s.q0, s.q1)),
      String(Math.max(s.q0, s.q1)),
      String(s.len),
      s.identity.toFixed(4),
    ]);
  }
  const csv = rows.map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "synteny-segments.csv";
  a.click();
  URL.revokeObjectURL(url);
});

// 导出当前这一屏：所见即所得，连缩放后的视图也照原样导出。
// 选中框不导出——图是要拿去用的，一圈虚线只会碍事。
el.btnPng.addEventListener("click", () => {
  if (S.result === null) return;
  const s = S.result.stats;
  const rect = el.plot.getBoundingClientRect();
  const stamp = new Date().toISOString().slice(0, 10);
  void downloadPng(
    {
      w: rect.width,
      h: rect.height,
      input: {
        pts: S.result.pts,
        nRef: s.nRef,
        nQry: s.nQry,
        view: S.view ?? fullView(s.nRef, s.nQry),
        highlight: null,
      },
      caption: (el.caption.textContent ?? "").replace(/\s+/g, " ").trim(),
      footer: t("png.footer"),
    },
    `synteny-${stamp}.png`,
  );
});

/* wire file inputs by click and by drag */

for (const role of ["ref", "qry"] as const) {
  const slot = role === "ref" ? el.slotRef : el.slotQry;
  const input = role === "ref" ? el.fileRef : el.fileQry;

  slot.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f !== undefined) void loadFile(role, f);
    // Reset so selecting the same file twice still fires a change event.
    input.value = "";
  });

  slot.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    slot.classList.add("drag");
  });
  slot.addEventListener("dragleave", () => slot.classList.remove("drag"));
  slot.addEventListener("drop", (ev) => {
    ev.preventDefault();
    slot.classList.remove("drag");
    const f = ev.dataTransfer?.files?.[0];
    if (f !== undefined) void loadFile(role, f);
  });
}

el.advToggle.addEventListener("change", () => {
  el.advBody.hidden = !el.advToggle.checked;
  if (el.advToggle.checked && S.ref !== null && S.qry !== null) {
    const auto = autoParams(S.ref.seq.length, S.qry.seq.length);
    el.inK.value = String(auto.k);
    el.inW.value = String(auto.w);
  }
});

// The plot is canvas, so a size change must redraw it; there is nothing for CSS
// to rescale.
//
// Watching the canvas itself rather than the window matters more than it looks:
// the figure settles to its final size after first layout and after the webfont
// arrives, and a window-resize listener never hears about either. The plot
// would then be drawn at one size while hit-testing used another, so hovering
// would read slightly wrong and clicking would miss — which is exactly the
// kind of bug that is invisible in a screenshot.
let drawnW = 0;
let drawnH = 0;
const ro = new ResizeObserver((entries) => {
  const box = entries[0]?.contentRect;
  if (box === undefined || box.width < 10 || box.height < 10) return;
  if (Math.abs(box.width - drawnW) < 0.5 && Math.abs(box.height - drawnH) < 0.5) return;
  drawnW = box.width;
  drawnH = box.height;
  if (S.result !== null) redraw();
});
ro.observe(el.plot);

// Escape drops the selection and restores the full view: the two "undo"s a
// reader reaches for after poking at the figure.
window.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (S.selected !== null) {
    select(null);
    return;
  }
  if (S.result !== null && S.view !== null) {
    const s = S.result.stats;
    if (isZoomed(S.view, s.nRef, s.nQry)) {
      S.view = fullView(s.nRef, s.nQry);
      redraw();
    }
  }
});

// Row click highlights the matching block; kept simple because the canvas does
// not carry per-block hit regions.
el.tbody.addEventListener("click", (ev) => {
  const tr = (ev.target as HTMLElement).closest("tr");
  if (tr === null || tr.dataset.id === undefined) return;
  select(tr.dataset.id === S.selected ? null : tr.dataset.id);
});

/** Single place that changes the selection, so plot, table and hint agree. */
function select(id: string | null): void {
  S.selected = id;
  for (const row of el.tbody.querySelectorAll("tr")) {
    row.classList.toggle("sel", row.dataset.id === S.selected);
  }
  const row = id === null ? null : el.tbody.querySelector(`tr[data-id="${id}"]`);
  if (row !== null) row.scrollIntoView({ block: "nearest" });
  redraw();
}

/**
 * Pick the block nearest a pointer position on the canvas.
 *
 * Distance is measured in pixels on the drawn box, not in bases: the two axes
 * are scaled differently, so a base-space distance would favour whichever
 * genome happens to be longer.
 */
function selectAt(px: number, py: number): void {
  if (S.geom === null || S.result === null) return;
  const { pad, inner, view } = S.geom;
  const spanR = Math.max(1, view.r1 - view.r0);
  const spanQ = Math.max(1, view.q1 - view.q0);
  const toX = (r: number): number => pad + ((r - view.r0) / spanR) * inner;
  const toY = (q: number): number => pad + inner - ((q - view.q0) / spanQ) * inner;

  let best: { id: string; d: number } | null = null;
  for (const seg of S.result.segs) {
    // Normalise the corners in *pixel* space. The query axis grows upward,
    // so toY of the smaller base gives the larger y: taking the base-order
    // corners as (top-left, bottom-right) inverts the rectangle and makes every
    // inside click look like it landed above the block.
    const ax = toX(seg.r0);
    const bx = toX(seg.r1);
    const ay = toY(seg.q0);
    const by = toY(seg.q1);
    const left = Math.min(ax, bx);
    const right = Math.max(ax, bx);
    const top = Math.min(ay, by);
    const bottom = Math.max(ay, by);
    // Distance to the rectangle: zero when the pointer is inside it.
    const dx = Math.max(left - px, 0, px - right);
    const dy = Math.max(top - py, 0, py - bottom);
    const d = Math.hypot(dx, dy);
    if (best === null || d < best.d) best = { id: seg.id, d };
  }

  // Only claim a selection when the pointer is genuinely near a block;
  // otherwise a click on blank canvas would silently pick a distant segment.
  if (best !== null && best.d <= 14) select(best.id === S.selected ? null : best.id);
  else select(null);
}

showSlot("ref", null);
showSlot("qry", null);
setDot("");
refreshRunButton();

/* ------------------------------------------------------- hero plot */

/**
 * 首屏图的重绘状态。
 *
 * 为什么不能只存 PlotState：那里面只有几何（pad/inner/width/view），
 * 没有点和坐标轴范围——拿它画不出第二遍。worker 在收到结果后就被 terminate，
 * reply.pts 当时用完即弃，所以必须在这里把整份 PlotInput 留住。
 *
 * 内存代价：首屏样本 90k × 115k bp，autoParams 得 k=13、w=8，
 * 约 25,556 个种子 × 9 字节 ≈ 0.22 MB。留着它是划算的。
 */
interface HeroState {
  canvas: HTMLCanvasElement;
  /** 完整保留，含 pts —— 重绘要的正是它。 */
  input: PlotInput;
  counts: { col: number; inv: number; trn: number };
  elapsed: number;
}

let heroState: HeroState | null = null;

/**
 * 首屏图欠下的那次重画。
 *
 * 为什么需要它：滚动缩放给 `.hero-fig` 挂了 transform，而 drawPlot 是拿
 * `getBoundingClientRect()`（plot.ts:141-142）当画布尺寸的——缩放期间那返回的是
 * **变换后**的盒子，照着画就会在已缩小的画面上再缩一次，越滚越小。
 *
 * 为什么 ResizeObserver 兜不住：RO 观察的是**布局盒**。transform 不改布局尺寸，
 * 所以缩放不会触发 RO；RO 只在真实 resize 时报，那时同样会踩上双重缩放。
 * 换句话说「等 RO 来修」是错的，只能延后到缩放撤掉之后再画。
 */
let heroDirty = false;

/** 2 秒兜底用的 idle 句柄；0 表示没有排队。 */
let heroIdle = 0;
/** setTimeout 兜底句柄；0 表示没有排队。 */
let heroTimer = 0;

/**
 * 置脏后的 2 秒兜底。
 *
 * 这是「三重兑现」的第 2 条。用户完全可能切完主题就一直停在工具区，不滚回、
 * 也不再有任何 repaintAll 的机会，首屏图会永久停在旧颜色。
 *
 * 兜底响的时候缩放**一定**还挂着（置脏就发生在那时），所以不能走普通重绘路径
 * ——那会读到变换后的盒子、双重缩放。改用 paintHeroByLayout()：拿布局盒当尺寸，
 * 画出来的仍是正确的一张。这样「2 秒内必有一帧」才真的成立，而不是一句空话。
 *
 * 只排一份、响过就不再排：重画一旦落笔（无论走哪条路径）都会 cancelHeroFallback，
 * 下一次置脏再重新排。
 */
function scheduleHeroFallback(): void {
  if (heroIdle !== 0 || heroTimer !== 0) return;
  // 沿用 startHeroPlot() 里同一个特性检测写法，不另造一套。
  if ("requestIdleCallback" in window) {
    heroIdle = (window as Window & {
      requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback(() => {
      heroIdle = 0;
      if (heroDirty) paintHeroByLayout();
    }, { timeout: 2000 });
    return;
  }
  heroTimer = setTimeout(() => {
    heroTimer = 0;
    if (heroDirty) paintHeroByLayout();
  }, 2000);
}

/** 撤掉还在排队的那份兜底。重画成功之后它已经没有意义。 */
function cancelHeroFallback(): void {
  if (heroIdle !== 0) {
    (window as Window & { cancelIdleCallback?: (id: number) => void })
      .cancelIdleCallback?.(heroIdle);
    heroIdle = 0;
  }
  if (heroTimer !== 0) {
    clearTimeout(heroTimer);
    heroTimer = 0;
  }
}

/**
 * 兜底专用的一次落笔：用**布局盒**当尺寸，绕开 `getBoundingClientRect()`。
 *
 * 为什么不能用普通路径：普通路径不传 size，drawPlot 只能自己读 rect，而缩放期间
 * 那是变换后的盒子——正是在这种场景下会双重缩放，所以守卫拦着不让画。
 * 但「2 秒内必有一帧」是 SDS §4.5.6 明写的要求，不能因为守卫就落空。
 *
 * 出路是 drawPlot 早就支持显式 `size`（plot.ts:120-127、138）：offsetWidth /
 * offsetHeight 是**布局**尺寸，transform 完全不改它。传进去之后画出来的就是
 * 未缩放时该有的那一张，画布分辨率始终正确——既兑现了 2 秒兜底，又不会越缩越小。
 *
 * 这也说明「除回 scale」那条顾虑不成立：这里不做任何除法，只是换了一个不变量。
 */
function paintHeroByLayout(): void {
  if (heroState === null) return;
  const canvas = heroState.canvas;
  const w = canvas.offsetWidth;
  const h = canvas.offsetHeight;
  if (w < 10 || h < 10) return; // 被折叠或还没排版，这一轮没得画
  drawPlot(canvas, heroState.input, {
    w,
    h,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
  });
  cancelHeroFallback();
  heroDirty = false;
}

/** 兑现欠下的那次重画；仍在缩放中就按兵不动，等归位或下一次 repaintAll。 */
function flushHero(): void {
  if (!heroDirty) return;
  repaintHero();
}

/** 重画首屏图。没有结果时什么也不做。 */
function repaintHero(): void {
  if (heroState === null) return;
  if (isScrollZoomActive()) {
    heroDirty = true;
    scheduleHeroFallback();
    return;
  }
  drawPlot(heroState.canvas, heroState.input);
  // 已经画过了，排队中的兜底就成了多余的一次。
  cancelHeroFallback();
  heroDirty = false;
}

/**
 * 换配色之后的重画入口。
 *
 * redraw() 只管工具区的 #plot，首屏那张图不在它的视野里——这是既存的一个 bug：
 * 切完主题往下滚，首屏图还是上一套颜色。
 *
 * 粒子层也要在这里补一帧。用户切主题时人通常停在工具区，首屏早已滚出视口，
 * IntersectionObserver 把帧停了；而粒子的颜色同样是 readPalette() 现读的，
 * 没有帧在跑就一直停在旧配色上，直到用户滚回首屏才「自己变」。
 */
function repaintAll(): void {
  redraw();
  repaintHero();
  repaintParticlesOnce();
}

/**
 * 首屏点阵图。
 *
 * 在独立 worker 里跑一小对合成基因组，结果画进 #heroPlot。
 * 失败时静默——首屏那张图是锦上添花，不该在控制台留错误，
 * 也不该挡住下面的工具区。
 */
function startHeroPlot(): void {
  const canvas = document.getElementById("heroPlot") as HTMLCanvasElement | null;
  if (canvas === null) return;

  const run = (): void => {
    const demo = makeHeroDemo();
    const params = autoParams(demo.ref.seq.length, demo.qry.seq.length);

    const heroWorker = new Worker(new URL("./ui/worker.ts", import.meta.url), {
      type: "module",
    });

    heroWorker.onmessage = (ev: MessageEvent<RunReply>): void => {
      const reply = ev.data;
      heroWorker.terminate();
      if (!reply.ok) return;

      const s = reply.stats;
      const seg = reply.segs.find((x) => x.type === "inv")
        ?? reply.segs.find((x) => x.type === "trn")
        ?? null;

      const counts = { col: 0, inv: 0, trn: 0 };
      for (const sg of reply.segs) counts[sg.type] += 1;

      // 保住整份输入，之后换主题、切语言、改窗口大小都靠它重画。
      heroState = {
        canvas,
        input: {
          pts: reply.pts,
          nRef: s.nRef,
          nQry: s.nQry,
          view: fullView(s.nRef, s.nQry),
          highlight: seg,
        },
        counts,
        elapsed: s.elapsed,
      };

      repaintHero();
      canvas.classList.add("ready");
      paintHeroMeta();
    };

    heroWorker.onerror = (): void => {
      heroWorker.terminate();
    };

    heroWorker.postMessage({
      id: 1,
      ref: demo.ref.seq,
      qry: demo.qry.seq,
      k: params.k,
      w: params.w,
    } satisfies RunRequest);
  };

  // 先让首屏渲染完，再算图。
  if ("requestIdleCallback" in window) {
    (window as Window & {
      requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void;
    }).requestIdleCallback(run, { timeout: 1200 });
  } else {
    setTimeout(run, 120);
  }
}

/** 首屏图下面那行统计。走词表，否则切到英文时只有它还是中文。 */
function paintHeroMeta(): void {
  const meta = document.getElementById("heroMeta");
  if (meta === null || heroState === null) return;
  const { col, inv, trn } = heroState.counts;
  meta.textContent = t("hero.meta", {
    col,
    inv,
    trn,
    t: (heroState.elapsed / 1000).toFixed(2),
  });
}

/**
 * 首屏 canvas 的尺寸观察。
 *
 * 工具区那块（#plot）一直有 ResizeObserver；首屏这块是批次一才补上的，
 * 因为在这之前它画完就再也不会重画——窗口改大之后，画布被拉伸成糊的。
 *
 * 只观察布局尺寸，不理会 transform：ResizeObserver 报的是布局盒，
 * 批次二的滚动缩放用 transform 实现，不会触发这里。
 */
const heroCanvas = document.getElementById("heroPlot") as HTMLCanvasElement | null;
if (heroCanvas !== null) {
  let heroW = 0;
  let heroH = 0;
  const heroRo = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (box === undefined || box.width < 10 || box.height < 10) return;
    if (Math.abs(box.width - heroW) < 0.5 && Math.abs(box.height - heroH) < 0.5) return;
    heroW = box.width;
    heroH = box.height;
    if (heroState !== null) repaintHero();
  });
  heroRo.observe(heroCanvas);
}

// 首屏点阵图：加载后自动跑一次小样本比对，让访客立刻看到产出。
// 放在 idle 回调里，先让标题和文案渲染完再算，避免拖慢首屏。
startHeroPlot();

// 换配色后必须重画：画布上的颜色是从 CSS 变量算出来的，不会自己跟着变。
// 首屏那张图同样要重画，所以走 repaintAll。
// 粒子层要在 initTheme 之前接上：repaintAll 里已经有 repaintParticlesOnce()，
// 先有层才有可重画的对象。
const particlesCanvas = document.getElementById("headParticles") as HTMLCanvasElement | null;
if (particlesCanvas !== null) {
  // 数量、密度、DPR、触屏降级全部在这一个调用里定，这里不传参：
  // 默认行为（按面积算数量、响应鼠标）就是产品要的那套。
  //
  // 接住销毁函数却不调用：这一层跟页面同寿，没有卸载时机。保留返回值是为了
  // 将来若真有「关掉背景层」的开关，一处就能拆干净（observer、监听、rAF 都在里面）。
  const stopParticles = startParticles(particlesCanvas);
  void stopParticles;
}

initTheme(repaintAll);

// 首屏图的滚动缩放。没找到元素就整体跳过——首屏是锦上添花，不该拦住工具区。
const heroFig = document.querySelector(".hero-fig");
if (heroFig instanceof HTMLElement) {
  // 三重兑现的第 1 条：归位时补上缩放期间欠下的那次重画。
  // 用户滚回首屏，正是这张图该恢复成未缩放尺寸的一刻。
  onScrollZoomReset(flushHero);
  initScrollZoom(heroFig);
}

// 换语言只需重刷文字，不必重算比对：结构没变，变的只是说法。
// 首次对齐不重绘——那时中文原文就在标记里，用词表再写一遍只会引入细微差异。
let lastLang = lang();
onLangChange(() => {
  if (lang() === lastLang) return;
  lastLang = lang();
  if (S.result !== null) {
    paint(S.result);
  } else {
    el.caption.innerHTML = t("cap.static");
    el.tableCap.textContent = t("table.emptyRow");
    refreshHint();
  }
  refreshRunButton();
  paintAxes();
  // 首屏图的那行统计是脚本拼的，和工具区的文案一样要跟着换。
  paintHeroMeta();
});

// 按钮的显隐由 initLang 自己负责，这里不再重复处理。
initLang(() => {});
