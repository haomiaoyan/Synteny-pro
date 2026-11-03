/**
 * reduced-motion 判定。
 *
 * 为什么需要这个模块：CSS 那边的 `@media (prefers-reduced-motion: reduce)`
 * 只能管住样式表里的 transition/animation，对 canvas 里的 rAF 循环完全无效。
 * 粒子场、滚动缩放都是自己算帧的，只能由脚本自己判断。
 *
 * 为什么支持运行时变化：用户在系统设置里打开「减弱动态效果」之后，
 * 已经开着的页面并不会重新加载。只在启动时读一次，等于让这次设置
 * 等到下次刷新才生效。
 *
 * matchMedia 用可选链：老浏览器里它可能不存在，缺了它应当退回「允许动效」，
 * 而不是让整个模块抛错。
 */

const QUERY = "(prefers-reduced-motion: reduce)";

/** 当前是否要求减弱动效。 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.(QUERY).matches ?? false;
}

/**
 * 订阅 reduced-motion 的变化，返回取消订阅函数。
 *
 * 用 addEventListener("change") 而不是轮询 matchMedia：轮询要么慢半拍，
 * 要么白烧 CPU，而浏览器本来就会在设置变化时通知监听者。
 */
export function onReducedMotionChange(cb: (reduced: boolean) => void): () => void {
  const mq = window.matchMedia?.(QUERY);
  if (mq === undefined) return () => {};

  const handler = (ev: MediaQueryListEvent): void => cb(ev.matches);
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
