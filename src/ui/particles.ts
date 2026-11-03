import { xorshift32 } from "../core/prng.js";
import { onReducedMotionChange, prefersReducedMotion } from "./motion.js";
import { readPalette } from "./palette.js";

/*! 物理模型参考 ThreeUI `particle-drift.html:106-227`
 *  Copyright (c) 2026 Meng To — MIT License
 *  借的只有「弹簧回弹 + 鼠标推开 + 近邻连线」这套模型本身；视觉、物理常数、
 *  坐标系统全部重写。参考实现里粒子会自己漂，这一层里漂移是明令禁止的。 */

/**
 * 首屏背景粒子层。
 *
 * 为什么粒子不画进点阵图：`plot.ts:10-14` 写明了那张图的立场——它只画引擎真实
 * 产出的种子点，因为「线段图会把密/疏这件事藏起来」。在图内叠一层装饰粒子，
 * 正是那段注释在防的失败模式。技术上也不成立：`drawPlot` 先铺不透明底色
 * （`plot.ts:160-161`），图下的粒子不可见，图上的粒子糊住数据。
 * 所以这一层只能铺在 `.head` 上、压在内容下面：整块首屏是它的画布
 * （标题区 + 图区两侧 + 图例栏都算），但透明度封顶 0.12，不与文字抢注意力。
 *
 * 为什么静止时**真的**静止：这一层没有漂移。每个粒子有一个家 `hx/hy`，鼠标
 * 把它们推开，手一停弹簧就送回原处，收敛后直接停帧——不排帧、不重画、不耗电。
 * 所以「同一时刻同一画面」不是靠截图比对凑出来的，而是这层压根没有自发运动；
 * 固定种子只是额外把首帧也钉死，让刷新后的第一眼和上一次逐位一致。
 *
 * 为什么不用 `ctx.scale`：scale 是累乘的，任何一次漏掉复位就再也回不到 1:1，
 * 而症状是「图慢慢变大」这种没人第一眼看得出、量起来又确凿的东西。每帧
 * `setTransform(dpr,0,0,dpr,0,0)` 写的是绝对值，画错也只错这一帧。
 */

/** 一个粒子的全部状态。位置与速度都在 CSS 像素坐标系里，与 dpr 无关。 */
interface Particle {
  /** 当前位置。 */
  x: number;
  y: number;
  /** 当前速度，单位 px/帧。 */
  vx: number;
  vy: number;
  /** 家。没有外力时弹簧把粒子收敛回这里。 */
  hx: number;
  hy: number;
  /** 半径，1.0–2.0px。 */
  r: number;
  /** 透明度档位 0…DOT_ALPHA_BUCKETS-1，绘制时换算成具体 alpha。 */
  ab: number;
}

/**
 * 粒子数量上限。
 *
 * 1440px 视口下实测 `.head` 是 1000×1058.8（`.page` 的 1080 − 80 padding
 * − 滚动条），面积 1,058,797，公式给 118，被这里夹到 90。
 * 也就是说桌面端实际永远是 90，这个上限就是「桌面端人数」。
 */
const MAX_COUNT = 90;

/** 数量下限。再少就只剩几个孤点，连线也成不了网。 */
const MIN_COUNT = 18;

/**
 * 每个粒子分摊的面积。
 *
 * SDS §4.3 定 9000，实测三个断点都落在预期档位上：
 *
 * | 视口 | `.head` 实测 | 面积 | 公式 | 结果 |
 * |---|---|---|---|---|
 * | 1440 | 1000×1058.8 | 1,058,797 | 118 | **90**（clamp 上限） |
 * | 768 | 724×714.4 | 517,219 | 57 | **57** |
 * | 390 | 346×957.3 | 331,241 | 37 | **37** |
 *
 * 与 SDS 表格里的 90 / 63 / 24 不同，但差别不在公式，而在分母：SDS 那张表
 * 记的 `.head` 宽是 905，实测 1440 视口下是 1000。905 不是 1440 CSS px 下的
 * 宽度——把视口压到 985px 才能复现 905×565 那一组数，也就是那张表实际是在
 * 约 985 CSS px 下量的（1280 窗口配 1.3 倍缩放）。SDS 自己的公式与 clamp 都
 * 没变，所以这里按公式走、按实测报数，不改公式。
 */
const AREA_PER_PARTICLE = 9000;

/** 鼠标影响半径。超出这个距离推力为 0。 */
const POINTER_RADIUS = 120;

/**
 * 推力上限，单位 px/帧²。
 *
 * 平衡位移 = 推力 / 弹簧刚度 ≈ 2.2 / 0.045 ≈ 49px，但粒子被推开后距离变大、
 * 推力随之线性衰减，实际停在 30–40px 之间——看得见被扰动，又不会把粒子甩飞。
 */
const POINTER_PUSH = 2.2;

/**
 * 弹簧刚度。
 *
 * 这个值只决定振荡快慢，不决定衰减快慢：衰减包络由 DAMPING 单独定（每帧保留
 * 0.86，行列式也是 0.86，所以模长约 0.927/帧，约一秒内收敛到亚像素）。
 * 0.045 配上 0.86 是轻微过阻尼偏振荡，回弹时有一点点「弹一下」的手感。
 */
const SPRING = 0.045;

/** 阻尼。每帧速度保留 86%。SDS §4.3 指定的值。 */
const DAMPING = 0.86;

/** 连线阈值：距离小于它就画一条线。 */
const LINK_DISTANCE = 100;

/** 连线透明度区间：刚好 100px 时 0.06，几乎重合时 0.14。 */
const LINK_MIN_ALPHA = 0.06;
const LINK_MAX_ALPHA = 0.14;

/**
 * 连线透明度的分档数。
 *
 * 不逐条 `stroke()`：90 个粒子约 4000 对，逐条描边就是 4000 次状态切换 + 4000 次
 * 绘制调用，真正贵的不是像素而是调用本身。按透明度分 6 档、每档一条路径一次
 * stroke，压缩到 6 次。0.06–0.14 之间分 6 档，肉眼分不出来。
 */
const LINK_BUCKETS = 6;

const DOT_RADIUS_MIN = 1;
const DOT_RADIUS_MAX = 2;

/** 粒子透明度封顶 0.12：这层会经过标题文字，必须克制。 */
const DOT_ALPHA_MIN = 0.055;
const DOT_ALPHA_MAX = 0.12;

/** 粒子透明度分档数。分档理由同连线：省的是状态切换，不是像素。 */
const DOT_ALPHA_BUCKETS = 4;

/** devicePixelRatio 上限。再高只是白烧显存，2 倍已经看不出锯齿。 */
const MAX_DPR = 2;

/**
 * 判定「速度已经没了」的阈值，单位 px/帧。
 *
 * 收敛是渐近的，永远差最后一点点；不设阈值就永远不许停，那「静止时完全静态」
 * 就是空话。0.05px/帧 大约是一个像素要跑 20 帧，肉眼是静止的。
 */
const SETTLE_V = 0.05;

/**
 * 判定「可以吸附回家」的阈值，单位 px。
 *
 * 弹簧收敛到 0.05px 以内时速度已经低于阈值，但位置可能还差零点几像素。
 * 这时直接赋值到 home：位移看不见，但从此这一帧可以逐位比较，也让「真的停了」
 * 成立，而不是「几乎停了」。0.25px 留够余量，避免收敛到一半就被吸附。
 */
const SNAP_D = 0.25;

/** 固定种子。见文件头：真正保证确定性的是「无漂移 + 弹簧收敛」，种子只钉首帧。 */
const SEED = 0x9e3779b9;

export interface ParticleOptions {
  /** 覆盖按面积算出的数量；不传就走 `clamp(round(area/9000), 18, 90)`。 */
  count?: number;
  /** 是否响应鼠标。默认 true；(hover: none) 的触屏设备上强制为 false。 */
  interactive?: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** 连线按档位复用的顶点缓冲，跨帧保留，避免每帧几千次数组分配。 */
const linkBuckets: number[][] = Array.from({ length: LINK_BUCKETS }, () => []);

/**
 * 画所有连线。
 *
 * 距离越近线越实：线本身也是「哪几个粒子挨着」的提示，离得远的没有信息量。
 */
function paintLinks(ctx: CanvasRenderingContext2D, list: readonly Particle[], r: number, g: number, b: number): void {
  for (const bucket of linkBuckets) bucket.length = 0;

  const max2 = LINK_DISTANCE * LINK_DISTANCE;
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j += 1) {
      const c = list[j];
      const dx = a.x - c.x;
      const dy = a.y - c.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= max2) continue;
      // t: 0 = 刚好在阈值上（最淡），1 = 完全重合（最实）
      const t = 1 - Math.sqrt(d2) / LINK_DISTANCE;
      const bucket = linkBuckets[Math.min(LINK_BUCKETS - 1, Math.floor(t * LINK_BUCKETS))];
      bucket.push(a.x, a.y, c.x, c.y);
    }
  }

  ctx.lineWidth = 1;
  for (let i = 0; i < LINK_BUCKETS; i += 1) {
    const buf = linkBuckets[i];
    if (buf.length === 0) continue;
    // 档位 0 最淡、档位 5 最实，正好落在 0.06–0.14 的两端。
    const alpha = LINK_MIN_ALPHA + (LINK_MAX_ALPHA - LINK_MIN_ALPHA) * (i / (LINK_BUCKETS - 1));
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    ctx.beginPath();
    for (let k = 0; k < buf.length; k += 4) {
      ctx.moveTo(buf[k], buf[k + 1]);
      ctx.lineTo(buf[k + 2], buf[k + 3]);
    }
    ctx.stroke();
  }
}

/**
 * 画所有粒子：实心圆，半径逐个不同。
 *
 * 每个档位一条路径一次 fill：`arc` 之间必须先 `moveTo` 到起点，否则前一段弧的
 * 末端会被连到下一段弧的起点，画出一堆横穿画面的直线。
 */
function paintDots(ctx: CanvasRenderingContext2D, list: readonly Particle[], r: number, g: number, b: number): void {
  for (let bucket = 0; bucket < DOT_ALPHA_BUCKETS; bucket += 1) {
    let started = false;
    for (const p of list) {
      if (p.ab !== bucket) continue;
      if (!started) {
        ctx.beginPath();
        started = true;
      }
      ctx.moveTo(p.x + p.r, p.y);
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    }
    if (!started) continue;
    // 取档位中点，四档平均铺在 0.055–0.12 之间，任何一档都不越过 0.12 的天花板。
    const alpha = DOT_ALPHA_MIN + (DOT_ALPHA_MAX - DOT_ALPHA_MIN) * ((bucket + 0.5) / DOT_ALPHA_BUCKETS);
    ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    ctx.fill();
  }
}

/** 当前活着的那一层。`repaintParticlesOnce` 靠它拿到一个「立刻画一帧」的入口。 */
let painter: (() => void) | null = null;

/**
 * 立刻重画一帧。
 *
 * 存在的理由只有一条（SDS §4.5.5）：用户切主题时人通常停在工具区，首屏早就
 * 滚出视口，IntersectionObserver 已经把帧停了。`readPalette()` 的缓存确实作废了
 * （`theme.ts:47`），但没有帧在跑，粒子就会一直停在旧配色上，直到用户滚回首屏
 * 才「自己变」。所以由 `repaintAll()` 主动补这一帧。
 */
export function repaintParticlesOnce(): void {
  painter?.();
}

/**
 * 把粒子层挂到 `canvas` 上，返回销毁函数。
 *
 * 尺寸、密度都从画布自己的布局盒来算：canvas 由 CSS `inset:0` 撑满 `.head`，
 * 所以它的盒子就是首屏的盒子——不额外查 `.head`，也就不存在「查到的元素和
 * 画布不是同一个盒子」这种错位。
 */
export function startParticles(canvas: HTMLCanvasElement, opts: ParticleOptions = {}): () => void {
  const ctx = canvas.getContext("2d");
  // 拿不到 2D 上下文（被策略禁用）就安静地退场：背景层不该拦住整个页面。
  if (ctx === null) return () => {};

  // 触屏没有 hover，推开物理既看不见又白烧帧，直接关掉。
  const hoverNone = window.matchMedia?.("(hover: none)") ?? null;
  const interactive = (opts.interactive ?? true) && hoverNone?.matches !== true;

  const fixedCount =
    typeof opts.count === "number" && Number.isFinite(opts.count)
      ? clamp(Math.round(opts.count), 0, MAX_COUNT)
      : null;

  let reduced = prefersReducedMotion();

  /**
   * 粒子池与随机流。
   *
   * 池子按需增长：先建够当前数量，窗口变大要更多粒子时再接着往下抽。之所以能
   * 「接着抽」，是因为 xorshift32 的返回值只取决于它是第几个数——按固定顺序
   * 每颗粒子消耗固定的几个随机数（位置 x、y、半径、透明度档），第 i 颗粒子
   * 拿到的值就与它是什么时候被建出来的无关。
   *
   * 注意这里的不变量是「同一个视口宽度下，前 N 颗是同一批」：粒子 0…36 在
   * 390px 下建出来时按 346×957 取位置，在 1440px 下直接建则是按 1000×1058 取，
   * 两者本就该不同（那是首屏大小变了）。真正被保证的是 resize **不会**重新
   * 抽数——同一个宽度反复出现，前 N 颗永远是同一批。
   *
   * 反过来，一次性建满 MAX_COUNT 颗再截前 N 颗是错的：390px 上只画 37 颗，
   * 池里另外 53 颗的家落在画布外，虽然不画，但 resize 把它们夹回边界时会有
   * 粒子「凭空出现在边上」。
   */
  let pool: Particle[] = [];
  const rand = xorshift32(SEED);
  /** 当前生效的粒子，就是池子的前 N 颗；单独拎出来是为了循环里少一层下标。 */
  let active: Particle[] = [];
  /** 已排队的帧；0 表示没有。 */
  let raf = 0;
  /** 画布是否在视口内。初始按 true 起步，IntersectionObserver 随后会纠正。 */
  let visible = true;

  /** 指针位置（视口坐标）与是否有效。 */
  const pointer = { clientX: 0, clientY: 0, on: false };

  const measure = (): { w: number; h: number } => ({
    w: canvas.offsetWidth,
    h: canvas.offsetHeight,
  });

  /** 把池子补到至少 n 颗。只追加，不改动已有的。 */
  const ensurePool = (n: number, w: number, h: number): void => {
    for (let i = pool.length; i < n; i += 1) {
      const x = rand() * w;
      const y = rand() * h;
      pool.push({
        x,
        y,
        vx: 0,
        vy: 0,
        hx: x,
        hy: y,
        r: DOT_RADIUS_MIN + rand() * (DOT_RADIUS_MAX - DOT_RADIUS_MIN),
        ab: Math.min(DOT_ALPHA_BUCKETS - 1, Math.floor(rand() * DOT_ALPHA_BUCKETS)),
      });
    }
  };

  const countFor = (w: number, h: number): number =>
    fixedCount ?? clamp(Math.round((w * h) / AREA_PER_PARTICLE), MIN_COUNT, MAX_COUNT);

  /**
   * 按当前盒子大小对齐状态：补池、把越界的粒子夹回边界、更新数量。
   *
   * resize 只夹边界、不重新随机。粒子位置是「用户上一眼看到的东西」，窗口一拉
   * 就整片换位置，等于把画面重来一遍——那正是确定性要防的事。
   */
  const syncLayout = (): void => {
    const { w, h } = measure();
    if (w < 10 || h < 10) return;
    const n = countFor(w, h);
    ensurePool(n, w, h);
    for (const p of pool) {
      p.x = clamp(p.x, 0, w);
      p.hx = clamp(p.hx, 0, w);
      p.y = clamp(p.y, 0, h);
      p.hy = clamp(p.hy, 0, h);
    }
    active = pool.slice(0, n);
    // 验收/调试用：数量由面积公式定死，这里只是把它写出来可读，
    // 免得为了验证 90/63/24 去数像素。不参与任何渲染决策。
    canvas.dataset.particleCount = String(active.length);
  };

  /**
   * 上一次真正画出去时的几何。用来识别「ResizeObserver 报了一次但其实没变」。
   *
   * RO 在开始观察时会**立刻**回调一次（初始通知）。不复用这个记录的话，
   * 启动时就会画两帧：startParticles 自己画的那一帧，加上 RO 立刻补的那一帧。
   * 减弱动效下「画一帧静态」于是变成画两帧，虽然结果相同，但那属于白烧。
   */
  let lastW = 0;
  let lastH = 0;
  let lastDpr = 0;
  let lastCount = -1;

  const draw = (): void => {
    const { w, h } = measure();
    if (w < 10 || h < 10) return;

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const dw = Math.max(1, Math.round(w * dpr));
    const dh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== dw || canvas.height !== dh) {
      // 写 width/height 会清空画布并重置变换，所以尺寸同步只能排在绘制之前。
      canvas.width = dw;
      canvas.height = dh;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    lastW = w;
    lastH = h;
    lastDpr = dpr;
    lastCount = active.length;
    if (active.length === 0) return;

    // 每帧读一次色板。命中缓存时只是一次取值，主题切换后（缓存被 theme.ts 作废）
    // 下一帧自动换成新颜色，不需要这一层自己订阅主题。
    const [r, g, b] = readPalette().tierRgb[0];
    paintLinks(ctx, active, r, g, b);
    paintDots(ctx, active, r, g, b);
  };

  /**
   * 推进一帧物理，返回**是否还需要继续跑帧**（true = 还没停）。
   *
   * 半隐式欧拉：先加速度、再阻尼、最后积分。顺序固定下来，同样的输入永远
   * 得到同样的下一帧——这也是「首帧可复现」的一部分。
   *
   * 几何只在有指针时读，且读在所有绘制之前：这一帧最多一次布局读取，不会在
   * 写样式之后再把布局强制刷新一遍。
   *
   * 「可以停」的判据**逐颗**决定，看的是这颗粒子这一帧有没有真的被推：
   *
   *   - 没被推（不在 120px 半径内）：弹簧会把它送回 `hx/hy`，必须**吸附到位**
   *     才算完。只看速度是不够的——速度掉到阈值以下那一刻，粒子可能还差一大截
   *     没走完，此时收工它就永久停在半路，「静止画面」于是和首帧不一致。
   *     实测（离线复算）：被推开 11.66px 时速度先到阈，此刻仍差 0.96px；
   *     推开 40px 差 3.31px；推开 200px 差 16.56px。
   *   - 正在被推（在半径内）：它会被推到「推力 = 弹簧」的平衡位移上（离家
   *     30–40px），速度在那里归零。这时只能按速度收工，否则鼠标停在标题上
   *     一整天，这一层就跟着空转一整天。指针一动就会重新唤醒。
   *
   * 注意这里的豁免是**逐颗**的，不是「有没有指针」：指针只要进过窗口，
   * `pointer.on` 就会一直为真（只有文档级 pointerleave / blur 才清），
   * 拿它当豁免条件等于让「没被推的粒子」也享受平衡态豁免——那正好把上面
   * 第一条要防的「永久停在半路」又请了回来。
   */
  const step = (): boolean => {
    const rect = interactive && pointer.on ? canvas.getBoundingClientRect() : null;
    const px = rect === null ? 0 : pointer.clientX - rect.left;
    const py = rect === null ? 0 : pointer.clientY - rect.top;
    const max2 = POINTER_RADIUS * POINTER_RADIUS;

    let busy = false;
    for (const p of active) {
      // 这一颗本帧是否真的被推。判据就下面那个 d2，不掺任何全局状态。
      let pushed = false;
      if (rect !== null) {
        const dx = p.x - px;
        const dy = p.y - py;
        const d2 = dx * dx + dy * dy;
        if (d2 < max2) {
          pushed = true;
          const d = Math.sqrt(d2);
          // 线性衰减：贴着鼠标时最大，到 120px 处正好为 0。
          // d 可能为 0（鼠标正落在粒子上），除法前先托住。
          const f = (1 - d / POINTER_RADIUS) * POINTER_PUSH;
          p.vx += (dx / (d || 1)) * f;
          p.vy += (dy / (d || 1)) * f;
        }
      }

      p.vx += (p.hx - p.x) * SPRING;
      p.vy += (p.hy - p.y) * SPRING;
      p.vx *= DAMPING;
      p.vy *= DAMPING;
      p.x += p.vx;
      p.y += p.vy;

      const slow = Math.abs(p.vx) <= SETTLE_V && Math.abs(p.vy) <= SETTLE_V;
      const nearHome = Math.abs(p.hx - p.x) <= SNAP_D && Math.abs(p.hy - p.y) <= SNAP_D;
      if (slow && nearHome) {
        // 速度没了、离家也只差零点几像素：直接吸附。位移看不见，但从此这一帧
        // 可以逐位比较，「停下来」这件事才真的成立，而不是「几乎停了」。
        p.x = p.hx;
        p.y = p.hy;
        p.vx = 0;
        p.vy = 0;
        continue;
      }
      if (!slow) busy = true;
      // 没被推却不靠近家：说明还在回弹路上，必须继续跑，直到吸附。
      else if (!pushed) busy = true;
    }
    return busy;
  };

  /**
   * 排一帧。
   *
   * 三个条件就是这层「不该动」的全部理由：已经有帧在排队（重复排等于白烧）、
   * 减弱动效（不许动）、滚出视口（看不见，动了也没人看）。
   */
  const wake = (): void => {
    if (raf !== 0 || reduced || !visible) return;
    raf = requestAnimationFrame(frame);
  };

  function frame(): void {
    raf = 0;
    // 兜底：切进减弱动效后即便还有漏排的帧也不再继续。
    if (reduced) return;
    const busy = step();
    draw();
    // 还在动就接着排；停了就真的不排——静止之后这一层一帧都不烧。
    if (busy) wake();
  }

  const onResize = (): void => {
    syncLayout();
    const { w, h } = measure();
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    // RO 开始观察时会立刻回调一次。几何一模一样就没有重画的理由——尤其
    // 减弱动效下，「画一帧静态」不该变成画两帧。
    if (w === lastW && h === lastH && dpr === lastDpr && active.length === lastCount) return;
    // 减弱动效下没有帧可排，必须当场补一帧，否则拖窗口时粒子会留在旧尺寸上。
    if (reduced) draw();
    else wake();
  };

  /** 把全部粒子放回各自的家。减弱动效切换时用，让静止帧和首帧一致。 */
  const settleAll = (): void => {
    for (const p of active) {
      p.x = p.hx;
      p.y = p.hy;
      p.vx = 0;
      p.vy = 0;
    }
  };

  const stopFrame = (): void => {
    if (raf === 0) return;
    cancelAnimationFrame(raf);
    raf = 0;
  };

  // ---- 监听 ----------------------------------------------------------------

  const onPointerMove = (ev: PointerEvent): void => {
    // 减弱动效下不响应指针：那一帧必须是真静止，不能靠「用户没动鼠标」来成立。
    if (reduced) return;
    pointer.clientX = ev.clientX;
    pointer.clientY = ev.clientY;
    pointer.on = true;
    wake();
  };

  const onPointerLeave = (): void => {
    if (!pointer.on) return;
    pointer.on = false;
    // 指针离场后要排一帧，让被推开的粒子自己弹回去；不排的话它们会停在半路。
    wake();
  };

  const offPointer: () => void = interactive
    ? (() => {
        // pointermove 挂 window：canvas 是 pointer-events:none，事件落在下面的标题、
        // 图例、图上，只有 window 这一级能看到全部。坐标再换算回画布局部坐标。
        window.addEventListener("pointermove", onPointerMove, { passive: true });
        const root = document.documentElement;
        root.addEventListener("pointerleave", onPointerLeave);
        window.addEventListener("blur", onPointerLeave);
        return () => {
          window.removeEventListener("pointermove", onPointerMove);
          root.removeEventListener("pointerleave", onPointerLeave);
          window.removeEventListener("blur", onPointerLeave);
        };
      })()
    : () => {};

  const offReduced = onReducedMotionChange((r) => {
    reduced = r;
    if (r) {
      // 立刻停帧，并把粒子放回各自的家：减弱动效下看到的那一帧应当和首帧一致，
      // 而不是「动画恰好停在这里」的半路状态。
      stopFrame();
      settleAll();
      draw();
      return;
    }
    // 关掉「减弱动效」后不必等用户交互，从当前位置恢复。
    wake();
  });

  // 观察 `.head`（canvas 的父元素）而不是 window：移动端地址栏收放会发 resize
  // 但首屏根本没变，按 window 处理等于白白重排一次。
  const ro = new ResizeObserver(() => onResize());
  ro.observe(canvas.parentElement ?? canvas);

  /**
   * 滚出视口就停帧，滚回恢复**同一批**粒子。
   *
   * 恢复时不重建池、不重新随机：粒子还是那批，只是重新排了一帧。
   */
  const io = new IntersectionObserver((entries) => {
    const last = entries[entries.length - 1];
    if (last === undefined) return;
    visible = last.isIntersecting;
    if (visible) wake();
    else stopFrame();
  });
  io.observe(canvas);

  // ---- 起步 ----------------------------------------------------------------

  syncLayout();
  // 先同步画一帧：不做的话首屏会先空一下，等第一个 rAF 才出现粒子。
  // 粒子本来就在 home 上、速度为零，所以这一帧之后 loop 会立刻判定静止并停下。
  draw();

  if (reduced) {
    // 减弱动效：不启动 rAF，上面那一帧就是全部。
  } else {
    wake();
  }

  const repaint = (): void => {
    syncLayout();
    draw();
  };
  painter = repaint;

  return () => {
    stopFrame();
    ro.disconnect();
    io.disconnect();
    offReduced();
    offPointer();
    if (painter === repaint) painter = null;
  };
}
