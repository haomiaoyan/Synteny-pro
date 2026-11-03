# 动效层实施计划（六批次）

**权威来源**：`docs/specs/2026-11-03-motion-layer-sds.md`（SDS v2.1）+ `docs/specs/2026-11-03-handoff.md`
**本文件的作用**：把 SDS §5 的六个批次写成可派发的 Task 1–6。冲突时以 SDS 为准；SDS 与代码冲突时以代码为准并记录。

---

## Global Constraints（每个任务都受约束）

| # | 约束 |
|---|---|
| G1 | **零新增依赖**。`package.json` 不得出现 `dependencies`；`devDependencies` 只能是 typescript/vite/vitest |
| G2 | `#method`、`#limits` 及其**所有子孙**不得有任何 `transition` / `transform` / `opacity` 变化 |
| G3 | **不用 `Math.random()`**；随机一律走 `src/core/prng.ts` 的 `xorshift32` |
| G4 | **不用 `ctx.scale`**；每帧 `ctx.setTransform(dpr,0,0,dpr,0,0)` |
| G5 | 删 `glyph.ts` 前先删 `main.ts:7` 的 import 与 `main.ts:862-863` 的调用，否则 TS2307 |
| G6 | MIT 署名用 `/*! ... */`，不能用 `/* ... */`（Vite 会压掉） |
| G7 | 每批结束：`npx tsc --noEmit` 零错误 + `npm test` 29/29 通过 + 提交 + 打 tag |
| G8 | `main` 分支不动；所有工作在 `feat/motion` |
| G9 | 沿用仓库既有风格：`src/ui/plot.ts:1-50` 的注释里写设计决策；中文注释；不引入框架 |

---

## Task 1：基础层（motion.ts、删 glyph、heroState、滚轮、mousemove、repaintAll、RO、i18n、prng）

**Tag**：`v0.2.0-foundation`

**对应 SDS**：§4.1、§4.5.1–§4.5.7、§3.1（prng.ts）

**新增**
- `src/ui/motion.ts`：`prefersReducedMotion(): boolean`、`onReducedMotionChange(cb): () => void`。`window.matchMedia?.()` 可选链；用 `addEventListener("change")` 而非轮询；返回取消订阅函数。
- `src/core/prng.ts`：`export function xorshift32(seed: number): () => number`，**行为必须与现有实现逐位一致**（`src/core/demo.ts` 的 `rng`、`src/ui/hero-demo.ts` 的 `xorshift32`）。

**修改**
- `src/main.ts:7` 删 `import { startGlyph }`；`src/main.ts:862-863` 删 glyph 调用
- `src/ui/glyph.ts` 删除
- `src/styles/app.css`：删 `.glyph`（266-276）与 `@keyframes glyph-in`；删 1010 行 `.glyph { display: none; }`
- `tools/glyph-check.mjs` 删除
- `src/ui/hero-demo.ts`、`src/core/demo.ts`：改用 `src/core/prng.ts`，**demo 输出必须不变**
- `src/main.ts` 新增 `heroState`（§4.5.2）：保留完整 `PlotInput`（含 `pts`）、`counts`、`elapsed`
- `src/main.ts` `repaintAll()`（§4.5.5）：`redraw()` + `repaintHero()` + `repaintParticlesOnce()`；`initTheme(repaintAll)`
- `src/main.ts` 滚轮 rAF 合并（§4.5.3）：`preventDefault()` 同步、`deltaY` 累加并处理 `deltaMode`（line 模式 ×16）、`getBoundingClientRect()` 每帧最多一次
- `src/main.ts` mousemove rAF 合并（§4.5.4）：坐标计算与 `innerHTML` 写入移到 rAF；只在坐标实际变化时更新
- `src/main.ts` `#heroPlot` 的 `ResizeObserver`（§4.5.6）：`heroDirty` 脏标记 + `repaintHero()` 守卫（`isScrollZoomActive()` 在批次二才存在，本批用「若存在则调用」的空实现或直接留钩子，不得引用未定义符号）
- i18n 补齐（§4.5.7）：`#heroPlot` 的 `aria-label` 改 `data-i18n-aria="hero.plot.aria"`；`#heroMeta` 文本走词表；`#figZoom` 的 `title` 加 `data-i18n-title`；`#plot` 补 `aria-label`（含 i18n 属性）。`src/i18n.ts` 词表补 key（中英双语）

**验收（本批）**
- `npx tsc --noEmit` 零错误；`npm test` 29/29
- `npm run build` 成功
- 无任何对已删除符号的引用（`grep -rn "startGlyph\|glyph-check" src tools` 为空）
- `heroState` 在切主题时被重绘（`initTheme(repaintAll)`）

---

## Task 2：滚动缩放（scroll-zoom.ts）

**Tag**：`v0.3.0-scroll`

**对应 SDS**：§4.2、§4.5.6（heroDirty 守卫接上）

**新增** `src/ui/scroll-zoom.ts`：`export function initScrollZoom(target: HTMLElement): () => void`

| 项 | 值 |
|---|---|
| 缩放 | 1.0 → **0.88** |
| 透明度 | 1.0 → **0** |
| `transform-origin` | **`50% 50%`** |
| 驱动 | `scroll` 只记录 `scrollY`，计算在 rAF |
| 进度 | `.hero-fig` 顶 → 工具区顶，clamp [0,1] |
| 归位 | 进度 0 时**移除**内联 `transform` / `opacity` |
| reduced-motion | 订阅 `onReducedMotionChange`，实时启用/禁用 |
| ≤760px | 不绑定 |
| 性能 | `rect.top` **每帧读一次**，不缓存 |

**同时修改** `src/main.ts`：接上 `isScrollZoomActive()` 供 `repaintHero()` 脏标记守卫；归位时兑现 `heroDirty`（三重兑现第 1 条）；另加 `requestIdleCallback` 2 秒兜底（第 2 条）与 `repaintAll()`（第 3 条）。

**验收（本批）**
- 滚动时 `.hero-fig` 内联 transform 从 1.0 到 0.88、opacity 到 0；回顶后内联属性被移除
- ≤760px 不产生内联 transform
- reduced-motion 下不生效
- `tsc` 零错误、29/29、build 成功

---

## Task 3：粒子层（particles.ts + `.head` 定位 CSS）

**Tag**：`v0.4.0-particles`

**对应 SDS**：§4.3

**新增** `src/ui/particles.ts`
```ts
export interface ParticleOptions { count?: number; interactive?: boolean }
export function startParticles(canvas: HTMLCanvasElement, opts?: ParticleOptions): () => void
export function repaintParticlesOnce(): void
```

| 项 | 值 |
|---|---|
| 挂载 | `.head` 内绝对定位，**覆盖整个首屏** |
| 数量 | `clamp(round(area / 9000), 18, 90)`；1440px→**90**，768px→**63**，390px→**24** |
| 鼠标半径 | **120px**，线性衰减 |
| 回弹 | 弹簧，向 `hx/hy` 收敛；阻尼 **0.86** |
| 连线 | 距离 <**100px**，透明度随距离衰减 |
| 漂移 | **无** |
| 颜色 | `readPalette().tierRgb[0]`（`--paper`），跟随四主题 |
| 粒子透明度 | **≤0.12**；实心圆半径 1.0–2.0px |
| 连线透明度 | 0.06–0.14，1px |
| DPR | 上限 2；每帧 `setTransform`，不用 `ctx.scale` |
| 尺寸 | `ResizeObserver` 观察 `.head`；resize 时**保留位置**只 clamp，**不重新随机** |
| 生命周期 | `IntersectionObserver` 滚出停 rAF、滚回恢复同一批粒子；销毁函数完整清理 |
| reduced-motion | 不启动 rAF、画**一帧静态**；订阅运行时切换停/启 |
| 触屏 | `matchMedia("(hover: none)")` 时 `interactive=false` |
| 确定性 | 固定种子走 `xorshift32` |

**修改**
- `index.html`：`.head` 内加粒子 canvas（`class="head-canvas"`）
- `src/styles/app.css`：`.head { position: relative }`；`.head-canvas { position:absolute; inset:0; z-index:0; pointer-events:none }`；`.hero, .hero-fig { position:relative; z-index:1 }`（**不得用 `z-index:-1`**）
- `src/main.ts`：`startParticles(...)` 接线；`repaintAll()` 已含 `repaintParticlesOnce()`

**验收（本批）**
- `canvas.getBoundingClientRect()` 的尺寸 ≈ `.head` 尺寸（覆盖整个首屏）
- 1440×900 下粒子数 90；390px 下 24
- 无 `Math.random()`、无 `ctx.scale`
- `tsc` 零错误、29/29、build 成功

---

## Task 4：CSS 动效层 + reveal.ts

**Tag**：`v0.5.0-micro`

**对应 SDS**：§4.7

**新增**
- `src/styles/motion.css`（在 `app.css` 里 `@import` 或在 `main.ts` 里 import，按仓库既有方式）
- `src/ui/reveal.ts`：`IntersectionObserver` 逐元素入场

**必须计数的 13 个元素**（全部「加载或滚动自动触发」，检查器从不 hover/click）

| 元素 | 数量 | 触发 |
|---|---|---|
| `.spec` | 4 | 滚动进入 |
| `.lg-item` | 3 | 加载时错开 |
| `.slot` | 2 | 滚动进入 |
| `.mast-top` | 1 | 加载时 |
| `.subnav` | 1 | 加载时 |
| `thead` | 1 | 滚动进入 |
| `footer .right` | 1 | 滚动进入 |

**隐藏态必须写在 `@media (prefers-reduced-motion: no-preference)` 内部**
```css
@media (prefers-reduced-motion: no-preference) {
  .reveal { opacity: 0; transform: translateY(16px); transition: opacity .5s, transform .5s; }
  .reveal.in { opacity: 1; transform: none; }
}
```
JS 三重保险：仅当 `IntersectionObserver` 可用才加 `.reveal`；1500ms 超时强制加 `.in`；reduced-motion 时不加 `.reveal`。

**禁止**：`.body-grid` 入场；`.note` 入场；`#method` / `#limits` 及其子孙任何 transition/transform/opacity（G2）。

**验收（本批）**
- `motion.elements >= 8`（`inspect.mjs`）
- reduced-motion 下内容全部可见（无 `reduced-hidden` FAIL）
- `tsc` 零错误、29/29、build 成功

---

## Task 5：tierFocus + 首屏图交互

**Tag**：`v0.6.0-interactive`

**对应 SDS**：§4.4、§4.6

**修改 `src/ui/plot.ts`**
- `PlotInput.tierFocus?: 0 | 1 | 2 | null`
- `PlotState.tiers?: Uint8Array`

淡化规则（噪声层 tier 3 **永不淡化**）：
```ts
const dim = input.tierFocus !== null && input.tierFocus !== undefined
  && tier !== 3
  && tier !== input.tierFocus;
const alpha = dim ? baseAlpha * 0.18 : baseAlpha;
```

`tiers` 输出**必须在 `plot.ts:259` 的 `tiers[k] = 0xff` 重置之前**写入独立数组：
```ts
if (collectTiers) outTiers[k] = tiers[k];   // 循环内，重置之前
...
counts[k] = 0; tiers[k] = 0xff;             // 循环末尾
```
仅首屏图请求（`collectTiers: true`），工具区图不请求。

**修改 `index.html` / `src/main.ts` / `src/styles/app.css`**
- `.lg-item` 由 `<span>` 改 `<button type="button">`
- 按钮 reset：`background:none; border:0; padding:0; margin:0; font:inherit; color:inherit; text-align:start; width:100%; cursor:pointer;`
- `hoverTier`（mouseenter/focus）与 `latchedTier`（click）分离；生效值 `hoverTier ?? latchedTier`
- `aria-pressed` **只反映 `latchedTier`**；`Esc` 清除 latched（扩展 `main.ts:707-720`）
- 反向命中：`#heroPlot` 鼠标位置 → 格子索引 → `tiers[]` → tier
- 键盘可达：focus 触发 highlight，Enter/Space 锁定

**验收（本批）**
- hover 图例时图中对应 tier 高亮、其余淡化；噪声层不淡化
- 点击锁定后 `aria-pressed` 正确；`Esc` 清除
- 图上 hover 反向高亮对应图例
- `tsc` 零错误、29/29、build 成功

---

## Task 6：验证与收尾

**Tag**：`v1.0.0-motion`

**对应 SDS**：§6

新增/扩展零依赖脚本：
1. `tools/motion-check.mjs`：断言 `#method`、`#limits` 及其子孙**无** transition/transform（D2 不变量）
2. 扩展 `tools/theme-check.mjs`：采样 `#heroPlot` + 粒子 canvas + `.lg-dot`，四主题 × 双语，断言颜色跟随主题
3. reduced-motion：CDP `Emulation.setEmulatedMedia`，断言粒子不启动、缩放不生效、**内容全部可见**
4. 帧时间：CDP 合成滚轮，p95 帧时间 < 20ms
5. 移动端 390px：无横向溢出、粒子数 24
6. 控制台零错误、零警告

检查器（基线 8 FAIL → 目标 5 FAIL）：
```bash
node "C:\Users\lenovo\.agents\skills\design-taste-frontend\scripts\inspect.mjs" \
  http://localhost:5174/ --out .taste-skill/check --allow palette-claude,few-pictures
```
- `still-page` 必须 PASS（`motion.elements >= 8`）
- 余下 5 个 FAIL 明确不处理：`mono`、`micro-label`、`hairline`、`outlined-box`、`small-text`

gzip 增量 < 12 KB（相对基线 23.6 KB）。`docs/screenshot.png` 更新。
