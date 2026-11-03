import { prefersReducedMotion } from "./motion.js";

/**
 * 逐元素入场（SDS §4.7）。
 *
 * 为什么非得像这样一个个来：验收用的检查器只合成滚轮（cdp.mjs:237），
 * 整个脚本里没有一次点击，也从不 hover。所以 hover / click / 拖拽触发的过渡
 * **一律不计数**，只有「加载或滚动自动触发」的才算。这一层因此只做一件事：
 * 把已经在页面里的静态元素，在它们出现的那一刻浮起来。
 *
 * 隐藏态写在 styles/motion.css 的
 * `@media (prefers-reduced-motion: no-preference)` 内部，本模块只负责加摘
 * `.reveal` / `.in` 两个类。也就是说：**类加错了，内容就永久看不见**。
 * 下面的保险一律偏向「可见」而不是「好看」：
 *
 * 1. 拿不到 IntersectionObserver 就一个类都不加——没有隐藏态，内容就是普通元素
 * 2. 1500ms 后强行兑现一次（见下面「兜底」一节）
 * 3. 减弱动效下从头到尾不加 `.reveal`
 *
 * 不订阅 reduced-motion 的运行时变化，是有意的：两条规则都在 no-preference
 * 里，用户中途打开「减弱动效」时那条规则直接失效，元素立刻回到可见——
 * 不需要我们撤销任何东西。反过来（用户中途关掉）什么都不做才是对的：
 * 那时给已经静止的内容补一次入场，等于凭空闪一下。
 */

/** 加载时进场的元素：都在首屏，不必等滚动。 */
const ON_LOAD = [".mast-top", ".subnav", ".lg-item"] as const;

/** 滚动进入视口时进场的元素。 */
const ON_SCROLL = [".spec", ".slot", "thead", "footer .right"] as const;

/** 兜底时间。比 CSS 里最长的一条（.5s + 180ms 延迟）宽裕得多。 */
const SAFETY_MS = 1500;

/**
 * 让一个元素到位。
 *
 * 先读一次计算样式再改类名，不是多余的：`.reveal` 刚加上、还没被算进样式时，
 * 浏览器会把「隐藏 → 显示」合并成同一次样式计算，只看见终态，过渡根本不会
 * 被创建，`transitionrun` 也就不会发。这一读把隐藏态钉成「上一次的计算结果」，
 * 过渡才有起点可插值。
 *
 * 代价是一次样式计算（不是重排），每个元素一次，只在入场时发生。
 */
const show = (el: HTMLElement): void => {
  if (el.classList.contains("in")) return;
  void getComputedStyle(el).opacity;
  el.classList.add("in");
};

/**
 * 挂上入场动画，返回销毁函数（与 initScrollZoom 一致）。
 *
 * 传 root 可以只作用于一部分元素；不传就是全站默认的那 13 个。
 * 选择器统一用类名与元素名，不写 `span.lg-item` 这类结构选择器——
 * 批次五会把图例项换成 <button>，结构一改，结构性选择器就悄悄失效，
 * 而失效的表现只是「少了一个入场」，很难发现。
 */
export function initReveal(root: ParentNode = document): () => void {
  // 保险 1 与 3 的入口：任一不成立就原样返回，一个类都不加。
  // 不加 `.reveal` 的元素没有任何隐藏态，看得见就是看得见。
  if (prefersReducedMotion()) return () => {};
  if (typeof IntersectionObserver === "undefined") return () => {};

  const targets: HTMLElement[] = [];
  const load: HTMLElement[] = [];
  for (const sel of ON_LOAD) {
    for (const el of root.querySelectorAll(sel)) {
      if (el instanceof HTMLElement) {
        targets.push(el);
        load.push(el);
      }
    }
  }
  for (const sel of ON_SCROLL) {
    for (const el of root.querySelectorAll(sel)) {
      if (el instanceof HTMLElement) targets.push(el);
    }
  }
  if (targets.length === 0) return () => {};

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        if (!(el instanceof HTMLElement)) continue;
        show(el);
        // 已经在场就没什么可等的了；留着观察反而每次滚动都要跑一遍回调。
        observer.unobserve(el);
      }
    },
    {
      // 底部收进 8%：元素刚好探进视口边缘时不动，等它真进来再浮起，
      // 免得入场发生在屏幕最下沿、只有一两个像素看得见。
      rootMargin: "0px 0px -8% 0px",
      threshold: 0,
    },
  );

  const allIn = (): boolean => targets.every((el) => el.classList.contains("in"));

  let raf = 0;

  /**
   * 兜底：把「此刻本该看得见、却还没到位」的全部补上。
   *
   * 这里刻意**不**无条件地把 13 个全设成 `.in`，虽然那样最省事。
   * 实测（1440×900，t=600ms 时 `.spec`/`.slot`/`thead`/`footer .right`
   * 都还没到位，t=2000ms 时全部到位）证明：无条件兜底会把页面下半部分
   * 的入场在**屏外**就烧掉——访客滚到那里时内容早就是最终态，
   * §4.7 表里「滚动进入」那一列变成空话，13 个元素实际只剩首屏 6 个真在动。
   * 检查器照样数得出 13（它按元素去重，不看时机），但产品上少了整整一层。
   *
   * 保住「永远不会永久隐藏」这条底线的是判据本身：只补
   * `getBoundingClientRect().top < innerHeight` 的元素，也就是**此刻就在
   * 视口里、或已经从上方滚过去**的。首屏一定覆盖；观察器彻底失灵时，
   * 但凡滚到的内容也会在滚到时被补上。屏外的元素继续等自己的时机。
   */
  const reconcile = (): void => {
    for (const el of targets) {
      if (el.classList.contains("in")) continue;
      if (el.getBoundingClientRect().top < window.innerHeight) {
        show(el);
        observer.unobserve(el);
      }
    }
    if (allIn()) detach();
  };

  const detach = (): void => {
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
  };

  /**
   * 滚动 / 改窗口时的第二道账。
   *
   * 观察器正常时它什么都不会做（回调先到）。它存在是为了
   * 「观察器活着但漏了某个元素」——祖先被 transform、被 content-visibility
   * 推迟、尺寸为 0 之后又被撑开，这些都会让 IO 静默不回调。这一道按几何
   * 说话，不依赖 IO 的心情。全部到位后自己摘掉监听，此后滚动零开销。
   */
  const onScroll = (): void => {
    if (raf !== 0) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      reconcile();
    });
  };

  for (const el of targets) el.classList.add("reveal");
  for (const el of targets) observer.observe(el);

  // 首屏这 6 个不等观察器：它的第一次回调要等下一次渲染，
  // 而它们本来就在视口里，等一等只会让首屏空一拍。
  // 走 requestAnimationFrame 而不是同步加 `.in`：同步加的话，
  // 上面那句 `.reveal` 与这次 `.in` 可能落在同一帧里，过渡不成立。
  const firstFrame = requestAnimationFrame(() => {
    for (const el of load) {
      show(el);
      observer.unobserve(el);
    }
    if (allIn()) detach();
  });

  // 保险 2：无论观察器有没有回调过，1500ms 时把该看得见的都兑现。
  const safety = window.setTimeout(reconcile, SAFETY_MS);

  // 兜底之后仍要继续盯滚动：屏外的元素正是靠这里（以及 IO）在到位的。
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);

  return () => {
    cancelAnimationFrame(firstFrame);
    if (raf !== 0) cancelAnimationFrame(raf);
    window.clearTimeout(safety);
    detach();
    observer.disconnect();
    // 摘干净：销毁之后页面应当回到「没有这一层」的样子。
    // 留下 `.in` 等于留下一次已经结束的过渡的痕迹。
    for (const el of targets) el.classList.remove("reveal", "in");
  };
}
