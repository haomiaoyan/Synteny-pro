import { onReducedMotionChange, prefersReducedMotion } from "./motion.js";

/**
 * 首屏 `.hero-fig` 随滚动缩小淡出。
 *
 * 为什么只缩这张图、不缩文字：首屏导语 19px，缩到 16.7px 还能读；但图例里
 * `.lg-item em`、`.lg-meta`、`.lg-note` 都是 13px，再缩就低于可读下限。
 * 而且 transform 不改 computed font-size，检查器**看不见**这种退化——
 * 「看起来变小了但没人量得出来」，最容易一路错到底。
 *
 * 为什么用 transform 而不是改宽高：改宽高每帧都要重排一张 565px 见方的画布，
 * 代价太高；transform 只走合成。
 *
 * 代价是 `getBoundingClientRect()` 在缩放期间返回**变换后**的盒子。
 * drawPlot（plot.ts:141-142）正是拿它当尺寸的，所以缩放期间不能重画 canvas。
 * 这件事由 main.ts 的 heroDirty 守卫负责，本模块不碰 canvas。
 */

/** 与 app.css 的 `@media (max-width: 760px)` 对齐：窄屏上首屏图已压到屏宽，再缩只会更难读。 */
const NARROW_PX = 760;

/** 1.0 → 0.88。1440 视口下画布约 660px，缩到底约收 79px，看得出来又不至于空出一块。 */
const SHRINK = 0.12;

/** 缩放中心的百分比。 */
const ORIGIN = "50% 50%";

/** 当前元素上是否真的挂着一层缩放（供 main.ts 判断要不要延后重画）。 */
let applied = false;

/**
 * 缩放此刻是否生效。
 *
 * 必须是**当下**的状态：减弱动效打开、视口 ≤760px、进度归零，任一成立都得是 false，
 * 否则 main.ts 会一直延后重画，首屏图永远不更新。
 */
export function isScrollZoomActive(): boolean {
  return applied;
}

type ResetListener = () => void;
const resetListeners = new Set<ResetListener>();

/**
 * 订阅「归位」——缩放从生效变成不生效的那一刻（滚回顶部、切到减弱动效、销毁）。
 *
 * 为什么要有这个口子：缩放期间的首屏重绘被延后了，而「滚回首屏」正是最常见的
 * 兑现时机——图就在那一刻恢复成真实尺寸，也正好该顺便把欠下的那一笔补上。
 */
export function onScrollZoomReset(cb: ResetListener): () => void {
  resetListeners.add(cb);
  return () => {
    resetListeners.delete(cb);
  };
}

/**
 * 把滚动缩放挂到 `target` 上，返回销毁函数。
 *
 * 进度 = 「`.hero-fig` 顶从视口顶滑到工具区顶」这段行程走了几成：
 * 进度 0 时首屏图原样（它顶还在视口里），进度 1 时缩到 0.88、完全透明，
 * 那正是工具区顶抵达视口顶、接管画面的一刻。
 *
 * 为什么分子用 rect.top 而不是 scrollY：切语言时 onLangChange 会重写标题，
 * 中英换行不同会让 `.hero-fig` 整体挪动一整行。几何驱动的写法下，图与工具区
 * 一起平移，进度自动跟上；用 scrollY 算的话，重排后的进度会错出一整行。
 */
export function initScrollZoom(target: HTMLElement): () => void {
  const narrowMq = window.matchMedia?.(`(max-width: ${NARROW_PX}px)`) ?? null;
  // 和 CSS 用同一个断点判断。innerWidth 含滚动条宽度而媒体查询不含，
  // 两者在断点边缘会差出一个滚动条；能拿到 matchMedia 就别拿 innerWidth 凑。
  const isNarrow = (): boolean =>
    narrowMq === null ? window.innerWidth <= NARROW_PX : narrowMq.matches;

  // 窄屏直接不绑定：监听都不挂，滚动开销为零。
  if (isNarrow()) return () => {};

  // 工具区顶是进度的终点。元素在这里解析一次即可——不缓存的是**几何**（rect），
  // 不是禁止持有节点引用。
  const tool = document.getElementById("tool");
  if (tool === null) return () => {};

  let reduced = prefersReducedMotion();
  /** 事件里记下的滚动位置。 */
  let pendingY = 0;
  /** 上一帧实际算过的滚动位置；NaN 表示「没有有效值，下一帧必须算」。 */
  let lastY = Number.NaN;
  /** 已排队的帧；0 表示没有。 */
  let raf = 0;

  /**
   * 摘掉内联样式。
   *
   * 写 `transform: none` / `opacity: 1` 是错的：那会在元素上留一个恒等变换，
   * 多一层合成与包含块，而且「到底生效没有」就再也无法从样式上看出来。
   *
   * 摘除若发生在「曾经挂着」之后，就算一次归位，通知外面兑现脏标记。
   */
  const release = (): void => {
    const was = applied;
    applied = false;
    target.style.removeProperty("transform");
    target.style.removeProperty("opacity");
    target.style.removeProperty("transform-origin");
    if (!was) return;
    for (const cb of resetListeners) cb();
  };

  const frame = (): void => {
    raf = 0;

    // 横向滚动、滚动条回弹都会发 scroll 但 scrollY 没变：这一帧没有新信息。
    if (pendingY === lastY) return;
    lastY = pendingY;

    // rect.top 每帧读一次，**不缓存**。onLangChange 会重写标题文本，
    // clamp(38px, 5.6vw, 72px) 配 text-wrap: balance 在中英文下换行不同，
    // `.hero-fig` 会整整挪动一行高度；缓存的 top 会让进度错出整整一行。
    // 这一帧里两次读几何都排在写样式之前，只强制一次布局。
    const top = target.getBoundingClientRect().top;
    // 工具区顶同步读。两者都是视口坐标，滚动时一起平移，差值恒等于它们在文档里的
    // 距离，所以它天然是这段行程的分母，也不受滚动影响；重排后又自动纠正。
    const span = tool.getBoundingClientRect().top - top;

    // span 退化（工具区跑到首屏上方、或被隐藏）就没有可插值的区间。
    if (span <= 0) {
      release();
      return;
    }

    // 分子取负：向下滚时 top 变小，翻成正数才是「已经滑过去多远」。
    // 进度 0 = 图顶还在视口顶之下（未开始）；1 = 图顶恰好滑到工具区原来的位置，
    // 也就是工具区顶刚好抵达视口顶、接管画面的那一刻。
    const p = Math.min(Math.max(-top / span, 0), 1);

    // 减弱动效 / 窄屏 / 还没滚到图：一律把样式摘干净，不留恒等变换。
    if (reduced || isNarrow() || p <= 0) {
      release();
      return;
    }

    applied = true;
    // transform-origin 默认就是 50% 50%，这里仍然显式写死：将来若有人给
    // `.hero-fig` 加一条 transform-origin，收缩中心会悄悄跑偏，而截图上几乎看不出来。
    target.style.transformOrigin = ORIGIN;
    // 留 4 位小数：0.12 不是二进制精确值，p=1 时 1-0.12 会算出 0.8799999…，
    // 直接写进样式就是差一点点的 0.88，验收时对不上。
    target.style.transform = `scale(${(1 - SHRINK * p).toFixed(4)})`;
    target.style.opacity = (1 - p).toFixed(4);
  };

  const schedule = (): void => {
    if (raf !== 0) return;
    raf = requestAnimationFrame(frame);
  };

  const onScroll = (): void => {
    // 事件里只记位置：不读 rect、不写样式。scroll 一秒能发几十次，
    // 在这里读几何等于每个事件强制一次布局。
    pendingY = window.scrollY;
    schedule();
  };

  const offReduced = onReducedMotionChange((r) => {
    reduced = r;
    if (r) {
      // 立刻停下并摘掉样式，不等下一次滚动——用户可能正停在半路。
      release();
      return;
    }
    // 关掉「减弱动效」后从当前位置恢复，同样不必等滚动。
    lastY = Number.NaN;
    schedule();
  });

  /**
   * 视口在窄/宽之间变化。
   *
   * 缩小到 ≤760px 时页面不会滚动，也就没有帧来摘样式；不在这里主动清一次，
   * `applied` 会一直停在 true，isScrollZoomActive() 从此说谎，首屏图再也不会重画。
   * 变回宽屏时同理要补一帧，否则要等用户碰一下滚动才恢复。
   */
  const onNarrowChange = (): void => {
    lastY = Number.NaN;
    if (isNarrow()) release();
    else schedule();
  };
  narrowMq?.addEventListener("change", onNarrowChange);

  window.addEventListener("scroll", onScroll, { passive: true });
  // 刷新后浏览器可能停在上次的位置，这种恢复不发 scroll 事件；
  // 先自己算一帧，页面一出现就是对的。
  schedule();

  return () => {
    window.removeEventListener("scroll", onScroll);
    narrowMq?.removeEventListener("change", onNarrowChange);
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    offReduced();
    release();
  };
}
