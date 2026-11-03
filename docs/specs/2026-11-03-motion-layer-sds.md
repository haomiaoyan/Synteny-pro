# Synteny 动效层 —— 软件设计说明（SDS）

**版本**：2.1（实测校正版）
**日期**：2026-11-03
**状态**：待确认
**目标项目**：`D:\ai项目（自用）\synteny`（本地） / `https://github.com/haomiaoyan/Synteny-pro`（远端）
**基线 tag**：`v0.1.0-hero`

> **v2.0 修订说明**：v1.0 经独立审核发现 6 个 BLOCKING、12 个 MAJOR、9 个 MINOR 问题，全部已核实并修复。
>
> **v2.1 修订说明**：v2.0 的关键数字经 Chrome 无头模式**实测校正**（1440×900 视口）。修正了 3 处估算错误（`.head` 尺寸、粒子数、种子数内存）和 1 处逻辑错误（`tiers` 重置时机）。详见 §10。

---

## 1. 目标与范围

### 1.1 一句话目标

给 Synteny 增加一层**有节制的动效**：首屏随滚动产生镜头拉远的纵深，页面上有一层鼠标可扰动的背景粒子，工具区有克制的微交互——同时不牺牲这个工具的可信度、可读性和性能。

### 1.2 已确认的设计决策

| 编号 | 决策 | 取值 |
|---|---|---|
| D1 | 动效目的 | 展示能力 + 引导理解（**不含**纯氛围） |
| D2 | 动效节奏 | 首屏强烈，工具区收敛，`#method` 与 `#limits` 两段正文**完全静止** |
| D3 | 滚动缩放 | 有，缩到 **0.88**，不用 sticky |
| D4 | 粒子层数 | **单层**，覆盖整个 `.head`，透明度 ≤0.12 |
| D5 | 粒子交互 | **要**「推开」物理（新写，非移植） |
| D6 | 首屏图交互 | **完整做**：图例与图中 tier 双向高亮 + 键盘可达 |
| D7 | 性能底线 | 桌面为主，移动端与 reduced-motion 降级 |
| D8 | 检查器目标 | 从 **8 FAIL 降到 5 FAIL**，2 个用 `--allow` 豁免 |
| D9 | 依赖 | **零新增依赖** |
| D10 | reduced-motion | **运行时响应切换**，非一次性判断 |
| D11 | hero 数据保留 | 保留完整 `PlotInput`（内存 +2.1 MB） |

### 1.3 明确不做的事

- 不引入 React、Three.js、GSAP、任何动画库
- 不在点阵图**内部**叠加粒子（§2.2）
- 不修 `mono` / `micro-label` / `hairline` / `outlined-box` / `small-text` 五个 FAIL
- 不改配色（`palette-claude` 用 `--allow`）
- 不加真实照片（`few-pictures` 用 `--allow`）
- 不改任何比对算法
- 不给 `#method` / `#limits` 加任何 transition / transform / opacity 变化

---

## 2. 现状分析（已核实）

### 2.1 项目基线

| 项 | 值 |
|---|---|
| 技术栈 | Vite 6 + TypeScript 5.7 + 原生 DOM，无框架 |
| 源码规模 | **18 文件 / 4520 行** |
| 产物 | 63.9 KB raw / **23.6 KB gzip** |
| 测试 | 29 个单元测试（core + engine），`npm test` 无 DOM 环境 |
| Canvas 元素 | 2 个：`#heroPlot`、`#plot` |
| 现有动效 | 2 个 CSS keyframe + 7 个 transition + 1 个 rAF（在死代码里） |

### 2.2 为什么粒子不放在图内

`src/ui/plot.ts:10-14` 写明了这个工具的设计立场：

> Draws the actual seed hits the engine produced, not a fitted line. That distinction matters: a line drawing hides whether the underlying evidence is dense or sparse.

在图内叠加装饰粒子正是这段注释所防范的失败模式。加上技术上 `drawPlot` 会先铺不透明底色（`plot.ts:160-161`），图下方粒子不可见、图上方粒子糊住数据——**粒子层只能放在图背后或图区之外**。

### 2.3 检查器的 motion 统计机制

`inspect.mjs:78-88` 只监听三种事件：

```js
addEventListener('animationstart', ...)   // CSS 动画
addEventListener('transitionrun', ...)    // CSS 过渡
MutationObserver(内联 style 的 transform/opacity/scale/rotate/clip-path)
```

**三条关键约束**（决定批次四的设计）：

1. **canvas 的 rAF 循环不计数** —— 粒子场对 `still-page` 贡献为 0
2. **只有实际运行的 transition 才计数** —— `cdp.mjs:237` 是唯一的 `Input.dispatchMouseEvent`，且只派发 `mouseWheel`；`inspect.mjs` 中**零** `.click(` 调用。所以 hover/click/drag 触发的过渡**永远不计数**
3. **`MOTION_MIN = 8`**（`inspect.mjs:74`）

推论：**只有「页面加载 + 滚动时自动触发」的 CSS 过渡能计数**。必须逐子元素入场。

### 2.4 检查器 FAIL 基线（8 个）

从 `.taste-skill/after4/report.json` 实测：

```
mono, micro-label, hairline, outlined-box,
palette-claude, few-pictures, small-text, still-page
```

`--allow` 的机制是**完全抑制**（`rules.mjs:24`：`if (!allow.includes(id)) out.push(...)`），所以被 allow 的规则不计入任何统计。

---

## 3. 架构设计

### 3.1 新增文件

```
src/ui/
├── motion.ts          [新增] reduced-motion 检测 + 运行时订阅
├── particles.ts       [新增] 背景粒子场
├── scroll-zoom.ts     [新增] 首屏滚动缩放
└── reveal.ts          [新增] 逐元素入场（IntersectionObserver）

src/core/
└── prng.ts            [新增] xorshift32 提取（消除三处重复）

src/styles/
└── motion.css         [新增] 动效 CSS
```

### 3.2 修改文件

```
src/main.ts            [改] 删 glyph、heroState、repaintAll、滚轮/mousemove 合并、接线
src/ui/plot.ts         [改] PlotInput 增加 tierFocus；PlotState 增加 tiers
src/ui/hero-demo.ts    [改] 改用 src/core/prng.ts
src/styles/app.css     [改] 删 .glyph、.head 定位、按钮 reset
index.html             [改] .lg-item 改 button、加粒子 canvas、i18n 属性
```

### 3.3 删除文件

```
src/ui/glyph.ts        [删]
tools/glyph-check.mjs  [删]
```

### 3.4 模块依赖图

```
main.ts
  ├── motion.ts         (prefersReducedMotion, onReducedMotionChange)
  ├── scroll-zoom.ts    (initScrollZoom)
  ├── particles.ts      (startParticles)
  │     ├── palette.ts  (readPalette)
  │     └── prng.ts     (xorshift32)
  ├── reveal.ts         (initReveal)
  └── plot.ts           (drawPlot, PlotInput.tierFocus)

theme.ts  [不改]  initTheme 已接受回调（theme.ts:64）
```

**注意**：`theme.ts` **不需要修改**。`initTheme` 已接受 `onChange` 回调（`theme.ts:64`），`invalidatePalette()` 已在 `paint()` 内部调用（`theme.ts:47`）。只需改 `main.ts:870` 传入的函数。

---

## 4. 详细设计

### 4.1 `src/ui/motion.ts`

**职责**：全项目唯一的 reduced-motion 判定入口，**支持运行时变化**。

**为什么需要**：现有代码只有 `glyph.ts:164` 一处 `matchMedia` 且只读一次。CSS 的 `@media (prefers-reduced-motion: reduce)`（`app.css:1018-1020`）对 canvas rAF 完全无效。

**接口**：

```ts
export function prefersReducedMotion(): boolean
export function onReducedMotionChange(cb: (reduced: boolean) => void): () => void
```

**实现要点**：
- `window.matchMedia?.()` 可选链
- `addEventListener("change")` 而非轮询
- 返回取消订阅函数

**关键要求（修复 MAJOR-12）**：`scroll-zoom.ts` 和 `particles.ts` **都必须订阅**，实现运行时切换：

```ts
const off = onReducedMotionChange((reduced) => {
  if (reduced) stopLoop();        // 停 rAF，保留粒子位置
  else startLoop();               // 从当前位置继续
});
```

---

### 4.2 `src/ui/scroll-zoom.ts`

**职责**：首屏 `.hero-fig` 随滚动缩小淡出。

**为什么只缩图不缩文字**：`p.standfirst` 19px 缩后 16.7px 尚可；但 `.lg-item em`、`.lg-meta`、`.lg-note` 都是 13px，缩后低于可读下限，且 `transform` 不改 computed `font-size`，检查器**看不见**。

**接口**：

```ts
export function initScrollZoom(target: HTMLElement): () => void
```

**行为规格**：

| 项 | 值 |
|---|---|
| 缩放 | 1.0 → **0.88** |
| 透明度 | 1.0 → **0** |
| `transform-origin` | **`50% 50%`**（均匀缩放，对称收缩） |
| 驱动 | `scroll` + rAF 合并 |
| 进度 | 元素顶部到工具区顶部的滚动距离，clamp [0,1] |
| 归位 | 进度 0 时**移除**内联 transform / opacity |
| reduced-motion | 订阅变化，实时启用/禁用 |
| 移动端 ≤760px | 不绑定 |

**性能要求（修复 MINOR-13）**：
- `scroll` 处理器只记录 `scrollY`，计算在 rAF 里
- **`rect.top` 每帧读一次**（允许，因 rAF 每帧一次），不缓存——因为 `onLangChange`（`main.ts:875-887`）会重写标题文本，`clamp(38,5.6vw,72)` + `text-wrap:balance` 在中英切换时换行不同，会让 `.hero-fig` 移动一整行
- 同时监听 `document.fonts.ready` 与 `onLangChange` 使缓存失效（如果实现选择缓存）

---

### 4.3 `src/ui/particles.ts`

**职责**：首屏背景粒子场，鼠标可扰动。

**来源与授权**：物理模型参考 ThreeUI `particle-drift.html:106-227`（MIT, Copyright (c) 2026 Meng To），但**视觉、物理、坐标系统全部重写**。

**关键修正（修复 BLOCKING-3）**：

v1.0 把粒子 canvas 放在 `.hero-fig` 内并 `z-index:-1`，实际效果是「40px 缝隙里的 12 个点」。v2.0 改为：

| 项 | v1.0（错） | v2.0（对） |
|---|---|---|
| 挂载位置 | `.hero-fig` 内 | **`.head` 内，绝对定位覆盖整个首屏** |
| 可见面积 | 约 34%（图区被遮挡） | **整个首屏**（标题区 + 图区两侧 + 图例栏） |
| z-index | -1（会逃逸到 `.wrap`） | **0**（canvas） / **1**（`.hero-plot`, `.hero-legend`） |
| 透明度 | 0.25 | **≤0.12**（因现在会经过文字区） |

**接口**：

```ts
export interface ParticleOptions {
  count?: number;
  interactive?: boolean;
}
export function startParticles(canvas: HTMLCanvasElement, opts?: ParticleOptions): () => void
export function repaintParticlesOnce(): void   // 供 repaintAll 调用
```

**粒子数量（修复 BLOCKING-3b，v2.1 实测校正）**：

按**实测** `.head` 尺寸计算。1440×900 视口下实测：

| 项 | 实测值 |
|---|---|
| `.head` 宽 | **905px**（`.page` 的 1080px − 80px padding − 滚动条） |
| `.head` 高 | **926px** |
| `.heroPlot` | **565×565** |
| `.hero-legend` | 300×565 |

| 视口 | `.head` 面积 | 公式结果 | 实际 |
|---|---|---|---|
| 1440px | 905×926 = 838,030 | 93 | **90**（clamp 上限） |
| 768px | ~688×820 = 564,160 | 63 | **63** |
| 390px | ~310×700 = 217,000 | 24 | **24** |

公式：`count = clamp(round(area / 9000), 18, 90)`

**物理规格**：

| 项 | 值 |
|---|---|
| 鼠标影响半径 | **120px** |
| 推力 | 线性衰减到 0 |
| 回弹 | 弹簧，向 `hx/hy` 收敛 |
| 阻尼 | 0.86 |
| 连线 | 距离 <100px 画线，透明度随距离衰减 |
| 漂移 | **无**（避免干扰阅读） |

**视觉规格**：

| 项 | 值 |
|---|---|
| 颜色 | `readPalette().tierRgb[0]`（`--paper`），四主题跟随 |
| 透明度 | **≤0.12**（经文字区，必须克制） |
| 粒子 | 实心圆，半径 1.0–2.0px |
| 连线 | 1px，透明度 0.06–0.14 |

**层级实现（修复 BLOCKING-3c / MAJOR-16）**：

```css
.head { position: relative; }              /* 建立定位上下文 */
.head-canvas { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
.hero, .hero-fig { position: relative; z-index: 1; }   /* 内容在上 */
```

**必须显式设 `pointer-events: none`**，否则 canvas 会拦截图例的鼠标事件。

**确定性（修复 MINOR-22/23）**：

提取 `src/core/prng.ts`：

```ts
export function xorshift32(seed: number): () => number
```

理由不是「`diff-shots.mjs` 会失败」（该脚本不在 CI 里，见 MINOR-23），而是：**无漂移 + 弹簧收敛 = 静止时完全静态**，这才是真正的确定性来源。固定种子额外保证了首帧一致。

**坐标与尺寸**：
- `ResizeObserver` 监听 `.head`（不是 window resize，避免移动端地址栏收放）
- resize 时**保留位置**，只 clamp 到新边界，**不重新随机**
- DPR 上限 2
- 每帧 `ctx.setTransform(dpr,0,0,dpr,0,0)`（**不是** `ctx.scale`）

**生命周期**：
- `IntersectionObserver` 滚出视口时 `cancelAnimationFrame`
- 滚回时**恢复同一批粒子**
- 销毁函数：`cancelAnimationFrame` + 移除监听 + `disconnect()` 两个 observer + 取消 reduced-motion 订阅

**reduced-motion 降级**：
- 不启动 rAF，画**一帧静态**
- 订阅 `onReducedMotionChange`，运行时切换时停/启

**触屏（修复 MINOR-27）**：`interactive` 在 `matchMedia("(hover: none)")` 时为 `false`，跳过推开物理。

---

### 4.4 `src/ui/plot.ts` 修改

**新增输入**：

```ts
export interface PlotInput {
  pts: SeedPoints;
  nRef: number;
  nQry: number;
  view?: View;
  highlight?: Segment | null;
  /** 只强调某一 tier。null/undefined = 行为完全不变。 */
  tierFocus?: 0 | 1 | 2 | null;
}
```

**新增输出（修复 MAJOR-11）**：

```ts
export interface PlotState {
  pad: number;
  inner: number;
  width: number;
  view: View;
  /** 每格子的 tier，供首屏图反向命中测试。仅当请求时返回。 */
  tiers?: Uint8Array;
}
```

**淡化规则（修复 MAJOR-17 / Q22=a）**：

```ts
const dim = input.tierFocus !== null && input.tierFocus !== undefined
  && tier !== 3                        // 噪声层永不淡化
  && tier !== input.tierFocus;
const alpha = dim ? baseAlpha * 0.18 : baseAlpha;
```

**为什么噪声层不能淡化**：噪声峰值已是 0.55（`palette.ts:39`），×0.18 = 0.099，低于网格线权重，等于抹掉「这是实测数据不是拟合线」的证据——正是 §2.2 引用来禁止图内粒子的理由。

**`tiers` 数组的内存代价**：`cells = inner * dpr`，1440px 下约 1448，`1448² = 2.1 MB`。**仅首屏图请求**（传 `collectTiers: true`），工具区图不请求。

---

### 4.5 `src/main.ts` 修改

#### 4.5.1 删除 glyph（顺序关键）

`glyph.ts` 是 **runtime 死代码但编译期活引用**：

```
main.ts:7      import { startGlyph } from "./ui/glyph.js";
main.ts:862-3  const glyph = ...; if (glyph !== null) startGlyph(glyph);
```

**必须先删 import 和调用，再删文件**，否则 `tsc --noEmit` 报 TS2307，而 `tsc` 是 `npm run build` 与 CI 的一环。

删除清单：
1. `main.ts:7`
2. `main.ts:862-863`
3. `src/ui/glyph.ts`
4. `app.css:266-276`（`.glyph` + `@keyframes glyph-in`）
5. `app.css:1010`（`.glyph { display: none; }`）
6. `tools/glyph-check.mjs`

#### 4.5.2 heroState（修复 BLOCKING-4）

**问题**：v1.0 说「保存 PlotState 与数据引用」，但 `PlotState` 只有几何信息（`plot.ts:70-78`：pad/inner/width/view），**没有 pts/nRef/nQry**。而且 hero worker 在 `main.ts:812` 被 `terminate()`，`reply.pts` 用完即弃。

**修复**：

```ts
interface HeroState {
  canvas: HTMLCanvasElement;
  input: PlotInput;          // 完整保留，含 pts（约 2.1 MB）
  counts: { col: number; inv: number; trn: number };
  elapsed: number;
}
let heroState: HeroState | null = null;

function repaintHero(): void {
  if (heroState === null) return;
  drawPlot(heroState.canvas, heroState.input);
}
```

**内存代价（v2.1 实测校正）**：

hero demo 是 90k × 115k bp。`autoParams`（`fasta.ts:60-66`）对 `n=115000` 算出 `k=13, w=8`：

```
seeds ≈ 2n/(w+1) = 2×115000/9 ≈ 25,556
内存 = 25556 × (4 + 4 + 1) B ≈ 0.22 MB
```

不是 v2.0 写的 0.5 MB。**代价可接受。**

**`tiers` 数组的正确实现（v2.1 关键修正）**：

`plot.ts:259` 是 `tiers[k] = 0xff`，在写入循环**末尾**重置。所以 v2.0 说「返回 tiers」拿到的是**全 0xff 的空数组**——反向高亮永远失效。

**正确做法**：在**重置之前**把当前格子已确定的 tier 写入一个独立输出数组：

```ts
// 在 for 循环内，重置之前
if (collectTiers) outTiers[k] = tiers[k];

// 循环末尾
counts[k] = 0;
tiers[k] = 0xff;
```

`outTiers` 是调用方传入的 `Uint8Array`，与复用缓冲区分开。大小 `cells²`，1440px 下 `1448² ≈ 2.1 MB`（Uint8Array 每格 1 字节）。

#### 4.5.3 滚轮 rAF 合并（修复 MINOR-21）

```ts
let wheelPending = false;
let wheelDeltaY = 0;
let wheelFx = 0, wheelFy = 0;
let wheelPx = 0, wheelPy = 0;      // 事件时捕获，不在 rAF 里读 rect

el.plot.addEventListener("wheel", (ev) => {
  if (S.geom === null || S.result === null) return;
  ev.preventDefault();                          // 必须同步
  const rect = el.plot.getBoundingClientRect(); // 每帧最多一次
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;
  const f = pointerFraction(S.geom, px, py);
  if (f === null) return;
  wheelDeltaY += ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;  // 处理 line 模式
  wheelFx = f.fx; wheelFy = f.fy;
  wheelPx = px; wheelPy = py;
  if (wheelPending) return;
  wheelPending = true;
  requestAnimationFrame(() => {
    wheelPending = false;
    const d = wheelDeltaY; wheelDeltaY = 0;
    const s = S.result!.stats;
    const factor = Math.exp(d * 0.0016);
    S.view = zoomView(S.view ?? fullView(s.nRef, s.nQry), wheelFx, wheelFy, factor, s.nRef, s.nQry);
    redraw();
  });
}, { passive: false });
```

**三个必须遵守的细节**：
1. `ev.preventDefault()` 同步调用
2. `deltaY` **累加**，且处理 `deltaMode`（line 模式 deltaY≈3，page 模式≈视口高，差 60 倍）
3. `getBoundingClientRect()` 每帧最多一次

#### 4.5.4 mousemove rAF 合并

现状 `main.ts:468-469` 每个 mousemove 写 `innerHTML`，等于每像素一次 HTML 解析。

**要求**：
- 坐标计算与 `innerHTML` 写入移到 rAF
- 只在坐标**实际变化**时更新
- `getBoundingClientRect()` 每帧一次

#### 4.5.5 `repaintAll()` 与主题接线（修复 MAJOR-14）

**现状 bug**：`main.ts:870` 是 `initTheme(redraw)`，`redraw()`（`main.ts:312-324`）只重绘 `el.plot`。**切主题后首屏图颜色不变**——既存 bug。

```ts
function repaintAll(): void {
  redraw();               // #plot
  repaintHero();          // #heroPlot
  repaintParticlesOnce(); // 粒子（因为 IntersectionObserver 可能已停帧）
}
initTheme(repaintAll);
```

**为什么需要 `repaintParticlesOnce()`**：用户切主题时通常在工具区，首屏已滚出视口，`IntersectionObserver` 已停止 rAF。`readPalette()` 缓存已失效（`theme.ts:47`），但没有帧运行，粒子会停留在旧色直到滚回。所以必须主动画一帧。

#### 4.5.6 `#heroPlot` 的 ResizeObserver（修复 MAJOR-7）

**v2.0 的错误诊断**：说「RO 会因 CSS transform 触发」。**错**。`ResizeObserver` 观察的是**布局盒**变化，CSS transform 不改变布局尺寸，**RO 不会触发**。

**真实风险**：`drawPlot` 内部用 `getBoundingClientRect()`（`plot.ts:141-142`），在 transform 生效时返回**变换后**尺寸，导致双重缩放。触发路径不是 RO，而是：
- 切主题（`initTheme` 回调，用户可在任意滚动位置点）
- 切语言
- 真实的窗口 resize

**修复**：不用「除回 scale」（有 canvas.width 取整误差），改用**脏标记**：

```ts
let heroDirty = false;
function repaintHero(): void {
  if (heroState === null) return;
  if (isScrollZoomActive()) { heroDirty = true; return; }  // 延后
  drawPlot(heroState.canvas, heroState.input);
  heroDirty = false;
}
```

**延后重绘的兑现时机（v2.1 补全）**：

v2.0 只说「scroll-zoom 归位时」，但用户可能切完主题后**再也不滚回首屏**，hero 会永久 stale。

**三重兑现**（任一满足即重绘）：

1. scroll-zoom 归位（`initScrollZoom` 的销毁/归零回调里检查 `heroDirty`）
2. `requestIdleCallback` 兜底：置脏后 2 秒内必重绘一次
3. 下次 `repaintAll()` 调用时

这样即使一直停在工具区，hero 也会在 2 秒内更新。

`ResizeObserver` 仍然要加（真实 resize 需要重绘），但只观察布局变化。

#### 4.5.7 i18n 补齐（修复 BLOCKING-6）

**v1.0 的错误**：说「`aria-label` 加 `data-i18n`」。**错**，`data-i18n` 写的是 `textContent`（`i18n.ts:310-314`）。

**正确属性**（`i18n.ts` 已支持）：
- `data-i18n-aria` → `aria-label`（`i18n.ts:329`）
- `data-i18n-title` → `title`（`i18n.ts:338`）

修复清单：
- `#heroPlot` 的 `aria-label` 加 `data-i18n-aria="hero.plot.aria"`
- `#heroMeta` 文本走词表（`main.ts:830-836` 硬编码中文）
- `#figZoom` 的 `title` 加 `data-i18n-title`
- `#plot` 目前无 `aria-label`，补上

---

### 4.6 首屏图交互（批次五）

**双向高亮**：

| 状态 | 来源 | 生效 tier |
|---|---|---|
| `hoverTier` | mouseenter/focus | 临时 |
| `latchedTier` | click | 持久 |
| 实际生效 | `hoverTier ?? latchedTier` | — |

**真值表（修复 MAJOR-10）**：

| hoverTier | latchedTier | 生效 | aria-pressed |
|---|---|---|---|
| null | null | null（全部正常） | 全 false |
| 0 | null | 0 | 全 false |
| null | 1 | 1 | 倒位=true |
| 0 | 1 | 0（hover 优先） | 倒位=true |
| 0 | 0 | 0 | 共线=true |
| null | null（Esc 后） | null | 全 false |

**`aria-pressed` 只反映 `latchedTier`**（点击锁定的状态），不反映 hover。`Esc` 清除 latched（扩展 `main.ts:707-720` 的现有处理器）。

**按钮 reset（修复 MAJOR-9）**：

`app.css` **没有 button reset**（只有 `* { box-sizing }`，line 96），所有按钮都带显式 class。裸 `<button>` 会得到 2px outset 边框、buttonface 背景、居中文字、系统字体——还会加剧 `outlined-box`（已 3 个）和 `font-count`（已 3 个）。

```css
.lg-item {
  background: none; border: 0; padding: 0; margin: 0;
  font: inherit; color: inherit; text-align: start;
  width: 100%; cursor: pointer;
}
```

**反向命中测试（修复 MAJOR-11）**：

`#heroPlot` 无 hit-testing，且 `tiers[k]` 在写入循环中被重置为 0xff（`plot.ts:258-260`），画完后 map 是空的。像素回读不可靠（max-blend + 3×3 splat + 0.18 淡化）。

修复：`drawPlot` 可选返回 `tiers: Uint8Array`（§4.4），hero 请求它，鼠标位置 → 格子索引 → tier。

---

### 4.7 CSS 动效层（批次四，修复 BLOCKING-1/2）

**`still-page` 要求 ≥8 个 DOM 元素有**「加载或滚动时自动触发」**的 CSS 过渡**。

**v1.0 的错误**：数了 13 个，但其中 7 个需要 hover/click/drag，检查器**从不触发**（§2.3）。实际只有 6 个区块入场 → 6 < 8 → 只能降到 WARN。

**v2.0 方案：逐子元素入场**

| 元素 | 数量 | 触发 |
|---|---|---|
| `.spec`（规格条 4 个） | 4 | 滚动进入 |
| `.lg-item`（图例 3 个） | 3 | 加载时错开 |
| `.mast-top` | 1 | 加载时 |
| `.subnav` | 1 | 加载时 |
| `.slot`（文件槽 2 个） | 2 | 滚动进入 |
| `thead` | 1 | 滚动进入 |
| `footer .right` | 1 | 滚动进入 |

合计 **13 个**，全部是「加载或滚动自动触发」，**可计数**。

**D2 约束（修复 BLOCKING-2）**：

v1.0 要动画 `.body-grid`，但 `#method` 和 `#limits` **就在 `.body-grid` 里面**（`index.html:184` 起），直接违背 D2。

v2.0 明确：

> **`#method`、`#limits` 及其所有子孙元素，不得有任何 `transition`、`transform`、`opacity` 变化。**

这条要写成**可测的不变量**（§6）。

`.note` 是 `.body-grid` 的子元素（`index.html:227`），也不动画（避免嵌套 reveal + 双重 transform）。

**入场动画的初始态（修复 MAJOR-8）**：

v1.0 说「JS 加载后才加 `.reveal` 类」，**这正是产生 `opacity:0` 的原因**——如果 IO 不触发，`.reveal.in` 永不到来，内容永久不可见。

**正确做法**：

```css
/* 隐藏态只在允许动效时存在 */
@media (prefers-reduced-motion: no-preference) {
  .reveal { opacity: 0; transform: translateY(16px); transition: opacity .5s, transform .5s; }
  .reveal.in { opacity: 1; transform: none; }
}
```

JS 侧三重保险：
1. 仅当 `IntersectionObserver` 可用时才添加 `.reveal` 类
2. 1500ms 超时强制添加 `.in`
3. `prefers-reduced-motion` 时不添加 `.reveal`

**规则名修正**：不是 `revealed-text`（不存在），而是 **`reduced-hidden`**（`inspect.mjs:244-259`），且只在 ≥1100px 的首屏文字上检查。

---

## 5. 交付批次（修复 MAJOR-15）

| 批次 | 内容 | Tag |
|---|---|---|
| **一** | §4.1 motion.ts、§4.5.1 删 glyph、§4.5.2 heroState、§4.5.3 滚轮、§4.5.4 mousemove、§4.5.5 repaintAll、§4.5.6 RO、§4.5.7 i18n、prng.ts 提取 | `v0.2.0-foundation` |
| **二** | §4.2 scroll-zoom.ts（含 heroDirty 守卫） | `v0.3.0-scroll` |
| **三** | §4.3 particles.ts + `.head` 定位 CSS | `v0.4.0-particles` |
| **四** | §4.7 CSS 动效层 + reveal.ts | `v0.5.0-micro` |
| **五** | §4.4 tierFocus + §4.6 图交互 | `v0.6.0-interactive` |
| **六** | 验证与收尾 | `v1.0.0-motion` |

**顺序修正**：
- `§4.5.2 heroState` 移入批次一（v1.0 遗漏，导致批次一验收不可达）
- `§4.5.6` 的 zoom 守卫移到批次二（批次一时 scroll-zoom 还不存在）
- `.head { position: relative }` 移入批次三（与粒子一起）

---

## 6. 验收标准（修复 MAJOR-18）

### 6.1 必须通过（脚本可验证）

- [ ] `npx tsc --noEmit` 零错误
- [ ] `npm test` 29 个测试全过
- [ ] `npm run build` 成功，产物 gzip 增量 **< 12 KB**
- [ ] **D2 不变量**：`node tools/motion-check.mjs` 断言 `#method`、`#limits` 及其子孙**无** transition/transform
- [ ] **motion 计数**：`inspect.mjs` 的 `motion.elements >= 8`
- [ ] **主题跟随**：扩展 `tools/theme-check.mjs`，采样 `#heroPlot` + 粒子 canvas + `.lg-dot`，四主题 × 双语，断言颜色随主题变化
- [ ] **reduced-motion**：CDP `Emulation.setEmulatedMedia` 模拟，断言粒子不启动、缩放不生效、**内容全部可见**
- [ ] **帧时间**：CDP 合成滚轮，p95 帧时间 < 20ms
- [ ] 移动端 390px：无横向溢出、粒子数 = 21
- [ ] 控制台零错误、零警告

### 6.2 检查器目标（修复 BLOCKING-5）

**基线 8 个 FAIL**：
`mono, micro-label, hairline, outlined-box, palette-claude, few-pictures, small-text, still-page`

**目标**：
- `still-page` → **PASS**（靠批次四的 13 个元素）
- `palette-claude`、`few-pictures` → **`--allow` 豁免**
- **结果：8 - 1 - 2 = 5 FAIL**

**明确未处理**（5 个）：
`mono`、`micro-label`、`hairline`、`outlined-box`、`small-text`

### 6.3 基线可复现（修复 MINOR-25）

`.taste-skill/` 被 gitignore（`.gitignore:3`），基线报告不在仓库里。

**要求**：
- 提交 `docs/baseline/after4-report.json`（复制一份进仓库）
- 在 SDS 中写明复现命令：
  ```
  node <skill>/scripts/inspect.mjs http://localhost:5173/ --out .taste-skill/after --allow palette-claude,few-pictures
  ```

### 6.4 明确不承诺

- 不承诺 0 FAIL（D8）
- 不承诺 `npm test` 覆盖新代码（项目无 DOM 测试环境，D9 禁止新增依赖）——但 `tools/*.mjs` 的零依赖脚本**可以**扩展（见 §6.1）
- 不承诺滚动缩放期间点阵图完全锐利（CSS transform 重采样固有代价，D3 已接受）

---

## 7. 风险与缓解

| 风险 | 可能性 | 缓解 |
|---|---|---|
| 粒子 canvas 定位错、覆盖全文档 | 中 | `.head { position: relative }`；第一个验收项检查 `canvas.getBoundingClientRect().height ≈ .head 高度` |
| 主题切换后粒子/hero 图不更新 | 中 | `repaintAll()` 调 `repaintParticlesOnce()`（因为 IO 可能已停帧） |
| reduced-motion 下内容不可见 | 中 | 隐藏态写在 `@media (prefers-reduced-motion: no-preference)` 内部；`reduced-hidden` 规则检查 |
| 手机端粒子过多 | 低 | 按面积缩放（390px → 21）；IO 滚出即停 |
| 滚动缩放让点阵图糊掉 | 中 | D3 已接受；只缩图不缩文字；0.88 而非更低 |
| `drawPlot` 在 transform 下拿到错误尺寸 | 中 | 脏标记延后重绘（§4.5.6），不靠 RO |
| MIT 署名被 Vite 压缩掉 | 低 | `/*! ... */` 而非 `/* ... */` |
| 逐元素入场触发不足 8 个 | 低 | 13 个元素全部是自动触发；`motion-check.mjs` 断言 |

---

## 8. 未决事项

1. **粒子是否漂移**：本 SDS 规定**不漂移**。若要更活跃可加极慢 `vy`，但需重评对阅读的影响。
2. **滚动缩放触发区间**：本 SDS 规定「`.hero-fig` 顶部 → 工具区顶部」。观感不合适可调。
3. **`docs/screenshot.png`**：首屏变化后需重截图。

---

## 9. 参考

- 设计检查器：`C:\Users\lenovo\.agents\skills\design-taste-frontend\scripts\inspect.mjs`
- 粒子物理参考：ThreeUI `particle-drift.html:106-227`（MIT, Copyright (c) 2026 Meng To）
- 项目设计规范：`src/ui/plot.ts:1-50` 的注释

---

## 10. 修订记录（v1.0 → v2.0）

### BLOCKING（6 个，全部修复）

| # | 问题 | 修复 |
|---|---|---|
| 1 | 批次四数了 13 个动效，但 7 个需 hover/click，检查器从不触发 → 6 < 8，`still-page` 不可 PASS | §4.7 改为逐子元素入场，13 个全部自动触发 |
| 2 | 动画 `.body-grid` 违背 D2（`#method`/`#limits` 在其中） | §4.7 明确禁止，写成可测不变量 |
| 3 | 粒子层是「40px 缝里的 12 个点」 | §4.3 移到 `.head` 覆盖首屏，透明度 ≤0.12 |
| 4 | `repaintHero()` 无数据（`PlotState` 无 pts，worker 已 terminate） | §4.5.2 新增 `heroState` 保留完整 `PlotInput` |
| 5 | D8 算术错（漏 `small-text`），且与 §6.2 互斥 | §6.2 改为 8→5，补全 5 个未处理项 |
| 6 | `data-i18n` 不能写 `aria-label` | §4.5.7 改用 `data-i18n-aria` / `data-i18n-title` |

### MAJOR（12 个，全部修复）

| # | 问题 | 修复 |
|---|---|---|
| 7 | RO 不会因 transform 触发，风险诊断错 | §4.5.6 改为脏标记，风险改写 |
| 8 | 「JS 加载后加 .reveal」正是产生不可见的原因 | §4.7 三重保险 + 规则名改 `reduced-hidden` |
| 9 | 裸 `<button>` 无 reset | §4.6 给出完整 reset |
| 10 | `aria-pressed` 与 hover 冲突 | §4.6 分离 `hoverTier`/`latchedTier` + 真值表 |
| 11 | 反向高亮无机制，`tiers` 被重置 | §4.4 `PlotState.tiers` + §4.6 格子索引命中 |
| 12 | `onReducedMotionChange` 无人订阅 | §4.1 要求两个消费者都订阅（D10） |
| 13 | 缓存 `offset` 会过期 | §4.2 每帧读 rect |
| 14 | 粒子「下一帧自动重读」与 IO 停帧矛盾 | §4.3 新增 `repaintParticlesOnce()` |
| 15 | `§4.5.6` 不在任何批次，且批次一依赖批次二 | §5 重排批次 |
| 16 | `z-index:-1` 逃逸出 `.hero-fig` | §4.3 改 `z-index: 0/1` + `pointer-events: none` |
| 17 | `tierFocus` 淡化噪声层，违背 §2.2 | §4.4 噪声层永不淡化 |
| 18 | 验收标准不可客观检验 | §6.1 全部改为脚本可验证 |

### MINOR（9 个，全部修复）

| # | 问题 | 修复 |
|---|---|---|
| 19 | 文件数/行数错（17/4491 → 18/4520） | §2.1 修正 |
| 20 | `transform-origin` 理由错 | §4.2 改回 `50% 50%` |
| 21 | 示例代码违反自己的规则；未处理 `deltaMode` | §4.5.3 修正 |
| 22 | 需第三份 `xorshift32` | §3.1 提取 `src/core/prng.ts` |
| 23 | 确定性理由引用错的依据 | §4.3 改为「无漂移 + 弹簧收敛」 |
| 24 | D1（不含纯氛围）未被满足 | §8 未决事项 |
| 25 | 基线不可复现（gitignore） | §6.3 提交基线 JSON + 命令 |
| 26 | `theme.ts` 被列为修改但不需要 | §3.4 标注不改 |
| 27 | 移动端粒子数错（18 非 ~20）；触屏未禁用交互 | §4.3 修正为 21；`hover: none` 时禁用 |

---

## 11. 修订记录（v2.0 → v2.1，实测校正）

v2.0 的数字多为估算。v2.1 用 Chrome 无头模式在 1440×900 视口实测（`--dump-dom` + iframe 内 `getBoundingClientRect`）。

### 实测数据（1440×900）

```
.head       905 × 926 px
.hero-fig   905 × 565 px
#heroPlot   565 × 565 px
.hero-legend 300 × 565 px
元素计数    .spec=4  .lg-item=3  .slot=2  .mast-top=1  .subnav=1  thead=1  footer .right=1  → 共 13
```

### 修正项

| # | v2.0 | v2.1（实测） | 影响 |
|---|---|---|---|
| 28 | `.head` 1000×780 | **905×926** | 粒子数公式结果从 87 变 **90**（触及 clamp 上限） |
| 29 | `.heroPlot` 660×660 | **565×565** | §4.6 反向命中的 `cells` 尺寸变化 |
| 30 | 种子数「约 6 万」，内存 0.5 MB | **25,556 个，0.22 MB** | `autoParams` 对 115k bp 算 `k=13,w=8` |
| 31 | 「返回 tiers」 | **必须在重置前写入独立数组** | 否则拿到全 0xff 空数组，反向高亮失效 |
| 32 | 脏标记只在「归位时」兑现 | **三重兑现**（归位 / 2 秒 idle 兜底 / 下次 repaintAll） | 否则用户停在下滚位置时 hero 永久 stale |

### 已验证为正确的部分

- 13 个入场元素计数（`.spec`×4 + `.lg-item`×3 + `.slot`×2 + `.mast-top` + `.subnav` + `thead` + `footer .right`）
- `tools/theme-check.mjs:92` **确实**用 `getImageData` 采样 canvas 像素 → §6.1 的主题跟随验收可实现
- `tools/glyph-check.mjs:146` **确实**用过 `Emulation.setEmulatedMedia` → §6.1 的 reduced-motion 验收可实现
- `app.css` 无 `transition: all`，D2 的静止要求无需额外覆盖
