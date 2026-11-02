import { invalidatePalette } from "./palette.js";

/**
 * 配色切换。
 *
 * 颜色本身全部住在 CSS 变量里，这个模块只负责把 <html data-theme> 挪来挪去，
 * 外加三件容易漏的事：
 *
 *   1. 画布的颜色是从 CSS 变量读出来的，并且有缓存 —— 不失效它，页面换了肤、
 *      图还留在上一套颜色里。
 *   2. 移动端地址栏的 theme-color 必须跟着改，否则浅色页面顶着一条黑边。
 *   3. 色块按钮的选中态要跟着走，不然点完四个看着一模一样。
 */

export type ThemeName = "ink" | "paper" | "indigo" | "moss";

const NAMES: readonly ThemeName[] = ["ink", "paper", "indigo", "moss"];

/** 浏览器地址栏/状态栏配色，必须等于各主题的页面底色。 */
const CHROME: Record<ThemeName, string> = {
  ink: "#12100d",
  paper: "#f4f1ea",
  indigo: "#0e1420",
  moss: "#101410",
};

const STORE_KEY = "synteny.theme";

const isTheme = (v: unknown): v is ThemeName =>
  typeof v === "string" && (NAMES as readonly string[]).includes(v);

/** 当前生效的配色。墨是默认值，它靠 :root 生效、不写属性。 */
export function readTheme(): ThemeName {
  const v = document.documentElement.getAttribute("data-theme");
  return isTheme(v) ? v : "ink";
}

/** 只改变外观，不落盘、不回调；供初始化复用。 */
function paint(name: ThemeName): void {
  const root = document.documentElement;
  if (name === "ink") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", name);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", CHROME[name]);
  // 画布色板是缓存过的，这里必须作废，否则图不会跟着换色。
  invalidatePalette();
}

export function setTheme(name: ThemeName, onChange?: () => void): void {
  paint(name);
  try {
    localStorage.setItem(STORE_KEY, name);
  } catch {
    // 隐私模式下 localStorage 会抛异常；记不住偏好比整页崩掉好。
  }
  onChange?.();
}

/**
 * 接上页眉那四个色块。
 * @param onChange 换色之后要做的事（重绘画布、重算对比度之类）。
 */
export function initTheme(onChange: () => void): void {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".sw-b"),
  );
  const sync = (name: ThemeName): void => {
    for (const b of buttons) {
      b.setAttribute("aria-pressed", String(b.dataset.sw === name));
    }
  };

  // 首屏的配色是 <head> 里那段内联脚本定的，这里只把可见状态补齐。
  paint(readTheme());

  for (const b of buttons) {
    b.addEventListener("click", () => {
      const next = b.dataset.sw;
      if (!isTheme(next)) return;
      setTheme(next, () => {
        sync(next);
        onChange();
      });
    });
  }

  sync(readTheme());
}