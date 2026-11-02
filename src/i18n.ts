/**
 * 中英文案。
 *
 * 没有用 i18n 库：这个站只有两种语言、一张页面，引一个库换来的只是
 * 一层间接和一份要跟着升级的依赖。这里只要两样东西——一张词表，
 * 和一次「把词表刷到页面上」的动作。
 *
 * 中文写在标记里当作默认值，所以禁掉 JS 也还是完整的中文页面；
 * 英文只在 data-i18n 标记过的地方替换。
 */

export type Lang = "zh" | "en";

interface Entry {
  readonly zh: string;
  readonly en: string;
}

const STORE_KEY = "synteny.lang";

/** 带 {name} 占位符的句子用 t() 的第二个参数填。 */
const DICT: Record<string, Entry> = {
  // ---------------- 文档级 ----------------
  "doc.title": {
    zh: "Synteny — 把两个基因组画成一张图",
    en: "Synteny — two genomes, one picture",
  },
  "doc.desc": {
    zh: "在浏览器里比较两个基因组的结构：共线区段、倒位、易位。不上传任何序列。",
    en: "Compare two genomes in the browser: collinear blocks, inversions, translocations. Nothing is uploaded.",
  },

  // ---------------- 页眉与导航 ----------------
  "mast.desc": {
    zh: "一个用来读基因组结构的小工具",
    en: "a small tool for reading genome structure",
  },
  "nav.tool": { zh: "工具", en: "Tool" },
  "nav.method": { zh: "方法", en: "Method" },
  "nav.limits": { zh: "不算什么", en: "Limits" },
  "nav.r": {
    zh: "完全在浏览器内运行 · 无服务器 · 零上传",
    en: "runs entirely in your browser · no server · nothing uploaded",
  },
  "ctrl.lang": { zh: "EN", en: "中" },

  // ---------------- 首屏 ----------------
  "hero.kicker": {
    zh: "基因组结构 · 点阵比对",
    en: "genome structure · dot plot",
  },
  "hero.title": {
    zh: '两个基因组之间，<br><span class="thin">究竟是哪里不一样。</span>',
    en: 'Between two genomes,<br><span class="thin">what actually differs.</span>',
  },
  "hero.standfirst": {
    zh: "不做碱基级比对，不上传任何序列。把两个 FASTA 拖进浏览器，它会告诉你哪几段是对齐的、哪一段整个倒了过来、哪一段搬到了别处——<b>一张图，一眼。</b>",
    en: "No base-level alignment, no uploads. Drop two FASTA files into the browser and it shows you which stretches line up, which one got flipped end to end, and which one moved somewhere else — <b>one figure, one glance.</b>",
  },
  "spec.method.k": { zh: "方法", en: "Method" },
  "spec.method.v": { zh: "minimiser + 链化", en: "minimiser + chaining" },
  "spec.scope.k": { zh: "适用范围", en: "Up to" },
  "spec.where.k": { zh: "计算位置", en: "Compute" },
  "spec.upload.k": { zh: "上传字节", en: "Uploaded" },

  // ---------------- 输入 ----------------
  "slot.ref.tag": { zh: "参考", en: "Ref" },
  "slot.qry.tag": { zh: "查询", en: "Query" },
  "slot.name.empty": { zh: "未选择", en: "nothing chosen" },
  "slot.meta.empty": {
    zh: "拖入 FASTA（可 .gz），或点击选择",
    en: "drop a FASTA (.gz ok), or click to choose",
  },
  "btn.demo": { zh: "打开示例数据", en: "Load demo data" },
  "btn.run": { zh: "开始比对", en: "Compare" },
  "hint.default": {
    zh: "示例数据是两个程序合成的基因组，含倒位、易位与一段重复。",
    en: "The demo is a pair of synthetic genomes with inversions, translocations and a duplication.",
  },
  "adv.toggle": { zh: "手动调参", en: "Manual parameters" },
  "adv.note": {
    zh: "k 越大越严格，w 越大种子越稀。留空则按序列长度自动选择。",
    en: "Larger k is stricter; larger w thins the seeds. Leave either blank to size it from the sequence.",
  },

  // ---------------- 图 ----------------
  "fig.title.empty": { zh: "尚无数据", en: "no data yet" },
  "fig.zoom.reset": { zh: "恢复到完整视图", en: "back to the full view" },
  "legend.h": { zh: "区段", en: "Blocks" },
  "legend.col": { zh: "共线", en: "Collinear" },
  "legend.inv": { zh: "倒位", en: "Inverted" },
  "legend.trn": { zh: "易位", en: "Translocated" },
  "legend.noise": { zh: "噪声", en: "Noise" },
  "legend.cov": { zh: "覆盖", en: "Covered" },
  "legend.seeds": { zh: "种子", en: "Seeds" },
  "legend.note": {
    zh: "点密度经分箱。<br>仅表示结构对应，<br>不表示碱基一致性。",
    en: "dot density is binned.<br>structure only —<br>not base identity.",
  },
  "empty.t": { zh: "还没有比对结果", en: "no comparison yet" },
  "empty.s": {
    zh: "打开示例数据，或拖入自己的两个 FASTA",
    en: "load the demo, or drop in two FASTA files of your own",
  },
  "table.h": { zh: "检出区段", en: "Detected blocks" },
  "table.th.block": { zh: "区段", en: "Block" },
  "table.th.type": { zh: "类型", en: "Type" },
  "table.th.ref": { zh: "参考", en: "Reference" },
  "table.th.qry": { zh: "查询", en: "Query" },
  "table.th.len": { zh: "长度", en: "Length" },
  "table.th.ident": { zh: "一致", en: "Ident" },
  "btn.png": { zh: "导出 PNG", en: "Export PNG" },
  "btn.csv": { zh: "导出 CSV", en: "Export CSV" },
  "png.footer": { zh: "Synteny · 浏览器内的共线性点阵图", en: "Synteny · genome dot plots in the browser" },
  "sig.col": { zh: "共线", en: "collinear" },
  "sig.inv": { zh: "倒位", en: "inverted" },
  "sig.trn": { zh: "易位", en: "translocated" },
  "sig.n": { zh: "图", en: "Fig." },

  // ---------------- 正文 ----------------
  "prose.p1": {
    zh: '<span class="dropcap">点</span>阵比对是基因组学里最古老的观察方式之一：两条序列分置两轴，彼此相似处点一个点。共线的地方连成对角线，倒过来的地方是一条反斜线，搬了家的地方则是脱离主轴的方块。它不解释原因，但把「结构」变成了一眼可见的东西。',
    en: '<span class="dropcap">D</span>ot plots are among the oldest ways of looking at a genome: put two sequences on the two axes and draw a dot wherever they resemble each other. Stretches that stay in step form the diagonal, a stretch flipped end to end draws the anti-diagonal, and a stretch that moved somewhere else lands as a square off the axis. The picture offers no explanation, but it turns structure into something the eye can take in at once.',
  },
  "prose.p2": {
    zh: '这个工具没有超出这个范围。它的价值在于<b>不用装</b>——不需要 conda，不需要 Java 运行时，不需要把几十兆的 FASTA 交给别人的服务器。文件留在你的硬盘里，计算在你的 CPU 上完成。',
    en: 'This tool does not go beyond that. What it offers is <b>nothing to install</b> — no conda, no Java runtime, no handing eighty megabytes of FASTA to somebody else&rsquo;s server. The files stay on your disk and the work happens on your CPU.',
  },
  "limits.h": { zh: "它不算什么", en: "What it is not" },
  "limits.p1": {
    zh: '它不做碱基级比对。共线区段之间的间隔一律按断点处理，所以看到的是结构，不是单碱基的插入与缺失。需要精确变异列表时，把区段导出去交给 <code>minimap2</code> 或 <code>MUMmer</code>。这个工具的定位是<b>先看一眼</b>。',
    en: 'It does not align base by base. Gaps between collinear blocks are treated as breakpoints, so what you see is structure, not single-base insertions and deletions. When you need an exact variant list, export the blocks and hand them to <code>minimap2</code> or <code>MUMmer</code>. This tool is for <b>looking first</b>.',
  },
  "limits.p2": {
    zh: '一致性由种子密度反推（<code>p ≈ (seeds/span)^(1/k)</code>），因为 minimiser 采样偏差而略偏低，只能当估计值看。',
    en: 'Identity is inferred from seed density (<code>p ≈ (seeds/span)^(1/k)</code>); minimiser sampling bias makes it read slightly low, so treat it as an estimate.',
  },

  // ---------------- 尾部 ----------------
  "faq.h": { zh: "如何开始", en: "How to start" },
  "faq.p": {
    zh: "页面加载后点「打开示例数据」，会在本地生成一对带已知结构变异的合成基因组并立即比对。想看自己的数据，把两个 FASTA 拖进上面的方框即可。超过 50 Mbp 建议按染色体切开分别运行，否则浏览器内存会先于算法到达极限。",
    en: "Click load demo and the page builds a pair of synthetic genomes with known structural changes, then compares them right away. For your own data, drop two FASTA files into the boxes above. Beyond 50 Mbp, split by chromosome and run each one: browser memory, not the algorithm, will hit its limit first.",
  },
  "footer.left": {
    zh: "Synteny · TypeScript 与 Canvas 写成 · 算法为 minimiser 采样与加权链化",
    en: "Synteny · TypeScript and Canvas · minimiser sampling with weighted chaining",
  },
  "link.source": { zh: "源码", en: "Source" },
  "link.author": { zh: "作者", en: "Author" },

  // ---------------- 动态文案 ----------------
  "hint.ready": {
    zh: "两个文件都就位后即可开始。",
    en: "Both files in place — ready when you are.",
  },
  "hint.reading": { zh: "正在读取 {name}…", en: "reading {name}…" },
  "hint.oneOfMany": {
    zh: "「{name}」含 {n} 条序列，已取第一条（{first}）",
    en: "“{name}” holds {n} sequences; using the first ({first})",
  },
  "hint.readyOne": {
    zh: "「{name}」已就位，还差一个文件。",
    en: "“{name}” is ready; one more file to go.",
  },
  "hint.readBoth": {
    zh: "两个文件都就位后即可开始。",
    en: "Both files in place — ready when you are.",
  },
  "hint.running": {
    zh: "比对中… k={k}, w={w}",
    en: "comparing… k={k}, w={w}",
  },
  "hint.failed": { zh: "比对失败：{msg}", en: "comparison failed: {msg}" },
  "hint.workerError": { zh: "Worker 出错：{msg}", en: "worker error: {msg}" },
  "hint.unknownError": { zh: "未知错误", en: "unknown error" },
  "hint.buildingDemo": {
    zh: "正在生成示例基因组…",
    en: "building the demo genomes…",
  },
  "hint.summary": {
    zh: "{n} 个区段 · {t} s · 覆盖 {cov}%",
    en: "{n} blocks · {t} s · {cov}% covered",
  },
  "err.emptyFile": { zh: "「{name}」是空文件", en: "“{name}” is empty" },
  "err.tooBig": {
    zh: "「{name}」有 {mb} MB，超过浏览器可处理的上限",
    en: "“{name}” is {mb} MB, past what the browser can hold",
  },
  "err.gzip": {
    zh: "「{name}」是 gzip 压缩文件，当前浏览器不支持直接解压。请先解压成 .fa 再拖进来",
    en: "“{name}” is gzipped and this browser cannot unpack it here. Decompress it to .fa first.",
  },
  "err.noFasta": {
    zh: "「{name}」里没有找到 FASTA 序列",
    en: "no FASTA records found in “{name}”",
  },
  "err.tooShort": {
    zh: "「{seq}」只有 {bp} bp，太短了，比对结果没有意义",
    en: "“{seq}” is only {bp} bp — too short for the comparison to mean anything",
  },
  "cap.none": {
    zh: '<span class="n">图</span>没有找到任何保守区段。两条序列可能没有同源关系，或者 k 太大、w 太小。<b>先确认输入</b>，再动手调参。',
    en: '<span class="n">Fig.</span> No conserved block was found. The two sequences may be unrelated, or k may be too large and w too small. <b>Check the input first</b>, then adjust the parameters.',
  },
  "cap.col": {
    zh: '<span class="n">图</span>共线 {n} 段',
    en: '<span class="n">Fig.</span> {n} collinear',
  },
  "cap.inv": { zh: "倒位 {n} 段（反斜线）", en: "{n} inverted (anti-diagonal)" },
  "cap.trn": {
    zh: "易位 {n} 段（脱离主轴的正斜率方块）",
    en: "{n} translocated (squares off the main axis)",
  },
  "cap.cov": {
    zh: "覆盖参考的 {cov}%，共 {seeds} 个种子",
    en: "covering {cov}% of the reference, from {seeds} seeds",
  },
  "table.empty": { zh: "没有检出区段", en: "no blocks detected" },
  "table.capEmpty": { zh: "没有可列出的区段。", en: "Nothing to list." },
  "table.capFilled": {
    zh: "共 {n} 段，按参考位置排序。坐标以 Mbp 计；一致性由种子密度反推。",
    en: "{n} blocks, sorted by reference position. Coordinates in Mbp; identity inferred from seed density.",
  },
  "cap.static": {
    zh: '<span class="n">图 1</span>主对角线是共线保守区段；落在主轴之外、斜率为正的独立方块是易位； 斜率为负的一段是倒位。刻度以 Mbp 计。',
    en: '<span class="n">Fig. 1</span> The main diagonal is the collinear backbone. A separate square off the axis with a positive slope is a translocation; a stretch with negative slope is an inversion. Ticks in Mbp.',
  },
  "table.emptyRow": {
    zh: "尚无结果。按参考位置排序；坐标以 Mbp 计。",
    en: "No results yet. Sorted by reference position; coordinates in Mbp.",
  },
  "demo.caption": { zh: "", en: "" },
};

let current: Lang = "zh";

export function lang(): Lang {
  return current;
}

/** 取一条文案；占位符 {name} 由 vars 填。 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const e = DICT[key] as Entry | undefined;
  if (e === undefined) {
    // 缺词条在开发时会静默显示成 key，比显示空白好查。
    console.warn("i18n 缺少词条:", key);
    return key;
  }
  let s = e[current];
  if (vars !== undefined) {
    for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

/** 换语言后，页面里那些由 JS 拼出来的文字要自己再刷一遍。 */
let listeners: (() => void)[] = [];

export function onLangChange(fn: () => void): void {
  listeners.push(fn);
}

/** 元素切到英文之前长什么样。中文一律从这份原文还原。 */
interface Saved {
  text?: string;
  html?: string;
  aria?: string;
  title?: string;
}

const originals = new WeakMap<HTMLElement, Saved>();

function savedFor(el: HTMLElement): Saved {
  let s = originals.get(el);
  if (s === undefined) {
    s = {};
    originals.set(el, s);
  }
  return s;
}

/** 不看当前语言，直接取某一种语言的那一句。 */
function pick(key: string, l: Lang): string {
  const e = DICT[key] as Entry | undefined;
  if (e === undefined) {
    console.warn("i18n 缺少词条:", key);
    return key;
  }
  return e[l];
}

/**
 * 把整页文字刷成指定语言。
 *
 * 中文不另存一份：标记里写的就是中文原文，切回中文时按原文还回去。
 * 如果中文也从词表里生成，那两份文字迟早会差一个标点或者一个空格，
 * 而中文才是这个站点的正本，不能有第二种写法。
 */
export function applyLang(next: Lang): void {
  current = next;
  const root = document.documentElement;
  root.setAttribute("data-lang", next);
  root.lang = next === "zh" ? "zh-CN" : "en";
  document.title = pick("doc.title", next);
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute("content", pick("doc.desc", next));

  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const s = savedFor(el);
    if (next === "en") {
      if (s.text === undefined) s.text = el.textContent ?? "";
      el.textContent = pick(el.dataset.i18n ?? "", "en");
    } else if (s.text !== undefined) {
      el.textContent = s.text;
    }
  }
  // 带内联标记的句子（<b>、<code>、首字下沉）只能整段换掉。
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-html]")) {
    const s = savedFor(el);
    if (next === "en") {
      if (s.html === undefined) s.html = el.innerHTML;
      el.innerHTML = pick(el.dataset.i18nHtml ?? "", "en");
    } else if (s.html !== undefined) {
      el.innerHTML = s.html;
    }
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-aria]")) {
    const s = savedFor(el);
    if (next === "en") {
      if (s.aria === undefined) s.aria = el.getAttribute("aria-label") ?? "";
      el.setAttribute("aria-label", pick(el.dataset.i18nAria ?? "", "en"));
    } else if (s.aria !== undefined) {
      el.setAttribute("aria-label", s.aria);
    }
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    const s = savedFor(el);
    if (next === "en") {
      if (s.title === undefined) s.title = el.getAttribute("title") ?? "";
      el.setAttribute("title", pick(el.dataset.i18nTitle ?? "", "en"));
    } else if (s.title !== undefined) {
      el.setAttribute("title", s.title);
    }
  }

  for (const fn of listeners) fn();
}

/** 首次进入：读内联脚本已经定好的语言，把按钮和文案对齐。 */
export function initLang(onToggle: () => void): void {
  const stored = document.documentElement.getAttribute("data-lang");
  const initial: Lang = stored === "en" ? "en" : "zh";
  applyLang(initial);
  try {
    localStorage.setItem(STORE_KEY, initial);
  } catch {
    // 隐私模式；记不住无所谓。
  }

  // 按钮在标记里是 hidden 的：脚本没跑起来时它不该出现，出现了也点不动。
  // 但“显示”必须发生在初始化这里，不能放在点击回调里——那样按钮永远藏着，
  // 用户根本没有可点的对象。（这个错误真的发生过一次。）
  const btn = document.getElementById("btnLang");
  btn?.removeAttribute("hidden");
  btn?.addEventListener("click", () => {
    const next: Lang = current === "zh" ? "en" : "zh";
    applyLang(next);
    try {
      localStorage.setItem(STORE_KEY, next);
    } catch {
      // 同上。
    }
    onToggle();
  });
}