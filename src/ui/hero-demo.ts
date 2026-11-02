/**
 * Hero demo — 首屏的「活」点阵图。
 *
 * 首屏最大的问题是图区一片空白：访客要先点按钮才能知道这工具产出什么。
 * 这里用一段固定种子合成的迷你基因组（约 120 kbp × 130 kbp）在页面加载时
 * 自动跑一次比对，把真实结果画进首屏的 canvas。
 *
 * 三条约束：
 * 1. 用真实引擎，不是画假图 —— 访客看到的每个点都是 minimiser 命中。
 * 2. 固定种子 —— 每次加载图形一致，截图对比才有意义。
 * 3. 不阻塞首屏 —— 在 requestIdleCallback 里跑，先把标题和文案画出来。
 *
 * 与 core/demo.ts 的区别：那个是给「打开示例数据」按钮用的完整演示（2 Mbp），
 * 这个是首屏专用的小样本，追求 100ms 内出图。
 */

/** 与 core/demo.ts 相同的确定性 PRNG，复制而非 import，避免把完整 demo
 *  拉进首屏 chunk。 */
function xorshift32(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x100000000;
  };
}

const BASES = "ACGT";

function randSeq(len: number, rnd: () => number): string {
  const out: string[] = [];
  for (let i = 0; i < len; i++) out.push(BASES[(rnd() * 4) | 0] as string);
  return out.join("");
}

function revComp(s: string): string {
  let out = "";
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i];
    out += c === "A" ? "T" : c === "T" ? "A" : c === "C" ? "G" : c === "G" ? "C" : c;
  }
  return out;
}

export interface HeroDemo {
  ref: { name: string; seq: string };
  qry: { name: string; seq: string };
}

/**
 * 合成一对带结构变异的迷你基因组。
 *
 * 布局（以 1000 bp 为单位，总长约 120 kbp）：
 *   0–40    共线块 A
 *   40–55   倒位块（反向互补）
 *   55–80   共线块 B
 *   80–95   易位块（来自块 B 的副本，搬到别处）
 *   95–120  共线块 C
 *
 * 与 core/demo.ts 的大样本思路一致，但规模小一个数量级，能在首屏预算内跑完。
 */
export function makeHeroDemo(): HeroDemo {
  const rnd = xorshift32(0x5eed_1234);
  const blockA = randSeq(40_000, rnd);
  const blockB = randSeq(25_000, rnd);
  const blockC = randSeq(25_000, rnd);

  // 参考序列：A + B + C，共 90 kbp
  const ref = blockA + blockB + blockC;

  // 查询序列：A + inv(B) + C + trn(B) ，共约 115 kbp
  const qry =
    blockA +
    revComp(blockB) +
    blockC +
    blockB.slice(0, 20_000);

  return {
    ref: { name: "hero_ref", seq: ref },
    qry: { name: "hero_qry", seq: qry },
  };
}
