# 动效层验收：复现命令

SDS `2026-11-03-motion-layer-sds.md` §6 的全部验收项都在 `tools/` 下有对应的
零依赖脚本（Node 内置模块 + 本机 Chrome 的 CDP，不新增任何 npm 包）。这份
note 记录怎么跑、期望看到什么，以及几条**已知且已接受**的偏差，免得下次
有人把它们当成回归。

## 0. 起一个可验收的服务

Windows 上不要用 `npx vite --port 5174`（EBUSY），也不要用 dev server：

```bash
npm run build
npx vite preview --port 4173
```

`vite preview` 只监听 IPv6 的 `localhost`，所以 `http://127.0.0.1:4173/`
连不上、`http://localhost:4173/` 可以。`tools/*.mjs` 默认打
`http://127.0.0.1:5174/`，并且会自动回退到 `localhost:4173`，也可以显式指定：

```bash
export SYNTENY_URL=http://localhost:4173/
```

## 1. 结构不变量（D2）

```bash
node tools/motion-check.mjs
```

断言：

- `#method`、`#limits` 及其**每一个子孙**在加载后的前 1 秒（11 次密集采样）
  与滚动全程（7 个位置）都没有 transition / transform / opacity 变化；
- 发布产物里那唯一一份 CSS 中，没有任何声明了这些属性的规则能匹配到两棵子树
  内部（`@media` 不成立的规则整棵跳过；选择器直接写 `#method`/`#limits` 的
  一律算命中）；
- 减弱动效（`Emulation.setEmulatedMedia`）下：页面上 `.reveal` 数为 0、
  首屏按检查器 `reduced-hidden` 的判据 **0 个**不可见文字块、滚动缩放不生效、
  粒子层只画一帧静态画面且指针推不动。

范围只限两棵子树：`thead` 在 `.body-grid > .data`，是 `#method` 的兄弟分支，
给它加入场是合规的，脚本里专门断言了这一点。

## 2. 动效计数（still-page 守门）

```bash
node tools/motion-count.mjs
```

把检查器 `inspect.mjs:78-88` 的记录器原样搬过来（animationstart /
transitionrun / 内联 style 变更），合成滚轮滚过整页，然后：

- `motion.elements >= 8`（检查器的门槛），并要求 ≥13；
- 13 个入场目标**逐条点名**对账，掉一个就红：
  `.mast-top`×1、`.subnav`×1、`.lg-item`×3、`.spec`×4、`.slot`×2、
  `thead`×1、`footer .right`×1；
- 同一趟里量帧时间：滚过整页时 p95 帧间隔 < 20ms；
- 390×844：无横向溢出、粒子数 = `clamp(round(area/9000), 18, 90)`、
  粒子 canvas 与 `.head` 同尺寸；
- 两次加载的控制台零 error / warning / exception。

## 3. 主题跟随

```bash
node tools/theme-check.mjs
```

四套主题 × 两种语言，每次采样断言：

- 页面底色 = 该主题的 `--ink`；
- `#plot`、`#heroPlot` 的众数底色 = `--ink3`，且首屏图上有与 `--paper`
  相符的点；
- 粒子层 `#headParticles` 的上色像素均值 ≈ 该主题的 `--paper`；
- `.lg-dot` 三色分别 = `--paper` / `--amber` / `--accent-soft`；
- 跨主题：`#heroPlot` 底色四套各不相同、图例圆点四套各不相同、
  粒子颜色在浅↔深之间有翻转（ink 与 indigo 的 `--paper` 只差 8，不要求可分）；
- 同一主题下 zh 与 en 的采样逐字节相同。

## 4. 检查器：8 FAIL → 5 FAIL

```bash
node "C:/Users/lenovo/.agents/skills/design-taste-frontend/scripts/inspect.mjs" \
  http://localhost:4173/ --out .taste-skill/after4-final --allow palette-claude,few-pictures
```

期望 `RESULT: 5 FAIL, 7 WARN`，5 个 FAIL 固定为：

```
mono, micro-label, hairline, outlined-box, small-text
```

`still-page` 必须 PASS（motion.elements = 16/16/15，门槛 8）。这 5 个是 §6.2
明确不处理的项。

## 5. 基线文件

`docs/baseline/` 下两份检查器报告：

| 文件 | 含义 | 关键读数 |
|---|---|---|
| `before4-report.json` | 批次四**之前**的快照（原 `after4-report.json`，只是名字起错了） | `elements: 2`，`still-page` FAIL |
| `after4-report.json` | 本次验收的**真实** after 快照 | `elements: 16`，5 FAIL |

## 6. 已知且已接受的偏差（不要当回归修）

1. **粒子数**：公式是 `clamp(round(area/9000), 18, 90)`，在 1440/768/390 下
   实测 90/57/37。SDS §4.3 表里的 90/63/24 是在约 985 CSS px 下量的，不是
   1440；脚本因此断言**公式**，不断言魔数。
2. **`tools/shots/zh-before.json` 是过期基线**（期望 emptyLen 1197，HEAD
   实测 1277）。它属于 i18n 文本基线，不是动效层的一部分；本次没有重新生成
   它，以免把动效层的验收混进 i18n 的变更里。
3. **入场兜底是条件式的**：`reveal.ts` 的保险只在
   `getBoundingClientRect().top < innerHeight` 时兑现，不是无条件 1500ms 强制。
   这是为了让屏外内容保留自己的入场时机（已批准）。
4. **gzip 增量**：JS 20.96 KB + CSS 4.65 KB = **25.61 KB** gzip，相对 SDS 的
   23.6 KB 基线增加 **约 2.0 KB**，仍在 §6.1 的 12 KB 预算内。