/**
 * 区块转场 —— 让「工具 / 方法 / 不算什么」三段之间滑得顺。
 *
 * 这个站只有一页，导航是三个同页锚点（`#tool` / `#method` / `#limits`）。
 * 所以「页面之间滑动」在这里指的是**区块之间的过场**，不是路由切换。
 *
 * 用原生能力，不引动画库：
 *
 * 1. **滚动进度驱动**。`scroll` 只记位置，所有计算进 rAF——和项目里
 *    滚轮、mousemove 的合并方式一致，避免每个滚动事件都读一次几何。
 * 2. **方向感知**。往下滚和往上滚，区块的进场方向相反（往上滚时从下方
 *    迎上来，往下滚时从上方沉下来）。这样回读上一段时不会像倒带。
 * 3. **只动 transform 与 opacity**。不发散到改宽高——那会让浏览器每帧重排，
 *    在一个本来就在跑粒子和点阵的页面上负担不起。
 * 4. **导航激活态随滚动联动**。此前 `class="on"` 是写死在「工具」上的，
 *    滚到方法段也还亮着，是个明确的错误。
 *
 * 为什么不用 scroll-driven animations（`animation-timeline: view()`）：
 * 那个方向更优雅，但 Chrome 115+ 才有、Safari 至今不支持。这个站的读者
 * 里有人用 Safari，所以走 rAF 这条到处都能跑的路。代价是多一次每帧
 * 的几何读取——已经和现有粒子层共用一个帧预算，实测 p95 仍在 20ms 内。
 */

/** 段落的进场位移。够看出方向，又不至于像幻灯片。 */
const SHIFT_PX = 28;

/**
 * 一段要走到视口这个位置才开始算「接近」。
 * 0.85 表示元素顶进入视口下沿 85% 处时，进度约为 0。
 */
const ENTER_AT = 0.85;

/** 进度低于这个值就完全不可见；高于 1 就完全就位。 */
const HIDDEN_BELOW = 0;

export interface RevealSection {
  /** 区块元素，需要能被滚动定位。 */
  el: HTMLElement;
  /** 对应导航里的锚点，用来联动 `.on`。可以为 null（比如页脚）。 */
  navAnchor: HTMLAnchorElement | null;
  /**
   * 是否允许对这块施加位移。
   *
   * D2 硬约束：`#method` 与 `#limits` 两段正文完全静止。这两段住在
   * `.body-grid` 里面，所以**不能**把 transform 加在 `.body-grid` 上——
   * 那会让整段正文跟着平移，等于绕过约束。
   *
   * 因此对这类容器只用导航联动，不动它的几何。设 false 即可。
   */
  animate?: boolean;
}

/**
 * 绑定区块转场。
 *
 * @param sections 按文档顺序排列的区块
 * @returns 销毁函数
 */
export function initSectionFlow(sections: RevealSection[]): () => void {
  if (sections.length === 0) return () => {};

  // 减少动效时不接管：内容本来就该是可见的，这里再加一层位移
  // 反而会成为新的遮挡来源。
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true) {
    return () => {};
  }

  let raf = 0;
  let lastScrollY = window.scrollY;
  let direction: 1 | -1 = 1;

  /** 每段的当前进度，避免同一帧里重复写同一个值。 */
  const applied = new Map<HTMLElement, number>();

  const schedule = (): void => {
    if (raf !== 0) return;
    raf = requestAnimationFrame(frame);
  };

  const frame = (): void => {
    raf = 0;

    // 几何一次读完，再统一写样式：读写在 rAF 内部分批，
    // 不会在循环里混着读导致反复强制布局。
    const vh = window.innerHeight;
    const y = window.scrollY;
    if (y !== lastScrollY) {
      direction = y > lastScrollY ? 1 : -1;
      lastScrollY = y;
    }

    // 先读全部
    const measured = sections.map((s) => {
      const r = s.el.getBoundingClientRect();
      return { ...s, top: r.top, height: r.height };
    });

    // 再写全部
    let active: HTMLAnchorElement | null = null;
    for (const s of measured) {
      // 进度：0 = 还没进到视口下沿附近；1 = 已经完全就位。
      const start = vh * ENTER_AT;
      const travel = Math.max(1, s.height * 0.35);
      const p = Math.min(1, Math.max(HIDDEN_BELOW, (start - s.top) / travel));

      // D2：受保护的正文容器只参与导航联动，几何一律不碰。
      // 注意这里只在「写样式」这一步跳过，不能 continue 掉整个循环体——
      // 下面的激活态判定还要用到它。
      if (s.animate !== false && applied.get(s.el) !== p) {
        applied.set(s.el, p);

        if (p >= 1) {
          // 就位后清掉内联样式，交还给 CSS。留着 will-change 会让
          // 浏览器一直给这块内容保留一个合成层，白占显存。
          s.el.style.removeProperty("transform");
          s.el.style.removeProperty("opacity");
          s.el.style.removeProperty("will-change");
        } else {
          // 方向决定从哪一侧迎上来：往下滚从上方沉下，往上滚从下方浮起。
          const shift = (1 - p) * SHIFT_PX * direction;
          s.el.style.transform = `translate3d(0, ${shift.toFixed(2)}px, 0)`;
          // 下限 0.55 而不是 0.35：再淡就接近「内容没加载出来」的样子了。
          // 这一层只是过场提示，不该让正文看起来像坏了。
          s.el.style.opacity = (0.55 + 0.45 * p).toFixed(3);
          s.el.style.willChange = "transform, opacity";
        }
      }

      // 激活态：取「顶部越过视口中线」且最靠下的那一段。
      if (s.navAnchor !== null && s.top <= vh * 0.5) active = s.navAnchor;
    }

    // 还没滚到任何一段的中线（首屏就在这个区间）时，兜底亮第一段。
    // 否则导航会一段都点不亮，看起来像坏掉的 tab。
    if (active === null) {
      const first = measured.find((s) => s.navAnchor !== null);
      if (first !== undefined) active = first.navAnchor;
    }

    // 导航联动。写成循环而不是 CSS，因为 `.on` 还带一条下划线，
    // 那是布局的一部分，不能靠 transition 猜。
    for (const s of sections) {
      if (s.navAnchor === null) continue;
      s.navAnchor.classList.toggle("on", s.navAnchor === active);
    }
  };

  const onScroll = (): void => schedule();
  const onResize = (): void => schedule();

  // passive：这个监听只读滚动位置，绝不 preventDefault，别挡住原生滚动。
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize);
  // 首次进来也要算一遍：可能在带锚点的 URL 上直接打开。
  schedule();

  return () => {
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
    for (const s of sections) {
      s.el.style.removeProperty("transform");
      s.el.style.removeProperty("opacity");
      s.el.style.removeProperty("will-change");
    }
    applied.clear();
  };
}
