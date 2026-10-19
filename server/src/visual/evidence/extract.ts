import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 逐页视觉证据提取（阶段 C）。
 *
 * 【职责边界】
 * 这一层**只做像素测量与族分类**，不调用模型、不猜字体、不生成 HTML。
 * 模型给语义（这页是不是案例页），像素给事实（页脚顶边在哪、编号多大）。
 * 两者冲突时以像素为准，模型的解释另存，不覆盖测量值。
 *
 * 为什么需要它：report 的 2.2 指出「图片输入存在 ≠ 建立了逐页视觉档案」。
 * 没有这一层，「已蒸馏 98%」里的 98% 是**文本**覆盖率，
 * 视觉覆盖率完全不可见 —— 用户看到的进度与模板库的真实状态脱节。
 *
 * 【离线】只读 data/media 下的本地文件，不访问网络、不碰小红书。
 */

/**
 * 提取器版本：提取逻辑变更必须升版本，否则旧行会被当新证据用。
 *
 * v1（2026-10-19）：初版，只有两族判据。
 * v2（2026-10-19）：从 unknown 队列校准出第三族 wow-label-dark-v1 ——
 *   「细字编号」与「编号颜色」被误当成一个维度，实际是两个。v1 的 73 个
 *   unknown 里绝大多数是深灰细字页，v2 起单独成族。
 * v3（2026-10-19）：修 v2 的判定顺序错误 —— label-dark 抢走了 321 页含
 *   大号浅蓝块的 ip-trend 页（浅蓝抗锯齿边缘亮度低，误落深灰条件）。
 *   v3 起 ip-trend 优先判定，label-dark 收紧到字高 <50。
 */
export const EXTRACTOR_VERSION = 'v8';

export type FamilyId = 'wow-ip-trend-v1' | 'wow-brand-case-v1' | 'wow-label-dark-v1' | 'wow-title-top-v1' | 'wow-blue-tag-v1' | 'unknown';

export interface PageMeasurement {
  /** 画布尺寸 */
  width: number;
  height: number;
  /** 页眉条（封面才有）：白底条的高度 */
  headerBarHeight: number | null;
  /** 页脚条（内页）：深色条顶边与高度 */
  footerTopEdge: number | null;
  footerBarHeight: number | null;
  /** 页脚条底色中位值 */
  footerBarColor: string | null;
  /** 页面底色（取四角与中心的众数，排除条带） */
  pageBg: string | null;
  /** 大号浅蓝编号的 bbox（ip-trend 族特征） */
  bigNumberBox: { x: number; y: number; w: number; h: number } | null;
  /** 细字强调色编号的 bbox（brand-case 族特征） */
  labelNumberBox: { x: number; y: number; w: number; h: number } | null;
  /** 细字深灰编号的 bbox（label-dark 族特征：同位置同字距，但颜色是正文深灰） */
  labelDarkBox: { x: number; y: number; w: number; h: number } | null;
  /** 蓝底反白标签的 bbox（blue-tag 族特征：顶部 y99..166、宽约 226px） */
  blueTagBox: { x: number; y: number; w: number; h: number } | null;
  /** 封面强调块（蓝底白字）bbox */
  accentBlockBox: { x: number; y: number; w: number; h: number } | null;
  /** 顶部区域内的强调色像素占比（判断是否有细字栏目编号） */
  topAccentRatio: number;
}

export interface PageClassification {
  family: FamilyId;
  confidence: number;
  /** 判据说明，进 unknown 队列时给人看 */
  reason: string;
}

const median = (a: number[]): number => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
};

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

/**
 * 测量一张图。纯像素、零模型调用。
 *
 * @param file 本地绝对路径
 */
export async function measurePage(file: string): Promise<PageMeasurement> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const px = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * channels;
    return [data[i]!, data[i + 1]!, data[i + 2]!];
  };
  const lum = (x: number, y: number): number => {
    const [r, g, b] = px(x, y);
    return (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
  };

  /* --- 页脚条：找底部连续深色区 --- */
  let footerTopEdge: number | null = null;
  for (let y = Math.floor(height * 0.8); y < height - 6; y++) {
    let dark = 0;
    let n = 0;
    for (let x = 5; x < width - 5; x += 6) {
      n++;
      if (lum(x, y) < 0.3) dark++;
    }
    if (dark > n * 0.85) {
      footerTopEdge = y;
      break;
    }
  }
  const footerBarHeight = footerTopEdge === null ? null : height - footerTopEdge;
  let footerBarColor: string | null = null;
  if (footerTopEdge !== null) {
    const midY = footerTopEdge + Math.floor((height - footerTopEdge) / 2);
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    for (let x = 20; x < width - 20; x += 7) {
      const [r, g, b] = px(x, midY);
      rs.push(r); gs.push(g); bs.push(b);
    }
    footerBarColor = toHex(median(rs), median(gs), median(bs));
  }

  /* --- 页眉条：顶部是否有白底条（封面特征）--- */
  let headerBarHeight: number | null = null;
  {
    // 从顶部逐行看是否整行近白且有边界（封面上部留白 + 品牌条）
    let run = 0;
    for (let y = 0; y < Math.floor(height * 0.16); y++) {
      const [r, g, b] = px(Math.floor(width / 2), y);
      const nearWhite = r > 235 && g > 235 && b > 235;
      if (nearWhite) run++;
      else break;
    }
    // 封面：整页近白（无页脚条）；内页：顶部近白但下方进入正文
    headerBarHeight = footerTopEdge === null ? run : null;
  }

  /* --- 页面底色：避开条带取四角+中心的众数 --- */
  const bgSamples: string[] = [];
  const bgYs = footerTopEdge === null
    ? [Math.floor(height * 0.5), Math.floor(height * 0.85)]
    : [Math.floor(height * 0.35), Math.floor(height * 0.6)];
  for (const y of bgYs) {
    for (const x of [30, Math.floor(width / 2), width - 30]) {
      const [r, g, b] = px(x, y);
      // 太暗/太艳的跳过（那是内容或色块）
      if (r > 200 && g > 200 && b > 200) bgSamples.push(toHex(r, g, b));
    }
  }
  const bgCount = new Map<string, number>();
  for (const c of bgSamples) bgCount.set(c, (bgCount.get(c) ?? 0) + 1);
  const pageBg = [...bgCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  /* --- 编号形态 bbox（两族的判别特征）--- */
  const boxOf = (x0: number, y0: number, x1: number, y1: number, test: (r: number, g: number, b: number) => boolean): PageMeasurement['bigNumberBox'] => {
    let mnx = 1e9, mxx = -1, mny = 1e9, mxy = -1, cnt = 0;
    for (let y = y0; y < Math.min(y1, height); y++) {
      for (let x = x0; x < Math.min(x1, width); x++) {
        const [r, g, b] = px(x, y);
        if (test(r, g, b)) {
          cnt++;
          if (x < mnx) mnx = x;
          if (x > mxx) mxx = x;
          if (y < mny) mny = y;
          if (y > mxy) mxy = y;
        }
      }
    }
    if (cnt < 40) return null;
    return { x: mnx, y: mny, w: mxx - mnx + 1, h: mxy - mny + 1 };
  };

  // 大号浅蓝：b 高、r 也很高（#D8E9FB 带），且成大块
  // ⚠️ 三个约束缺一不可（v3→v4 就是因为漏了它们）：
  //  1) 位置限定 y 140..360 —— 编号固定在这个带；
  //  2) 宽 <200px —— 编号「01」实测宽约 130px，正文里的蓝色胶囊/色块更宽；
  //  3) 高 >60px —— 细字行只有约 20px 高。
  // 少了 2) 时页面上任何蓝色强调块都被当成编号：v3 把 583 页判成 ip-trend，
  // 其中大量其实是含蓝色按钮的 brand-case / label-dark 页。
  const bigNumberBox = boxOf(20, 140, 460, 360, (r, g, b) => b > 200 && b - r > 8 && r > 190);
  const bigPale =
    bigNumberBox && bigNumberBox.h > 60 && bigNumberBox.w < 200 ? bigNumberBox : null;
  // 细字强调色：b 高、r 低（纯 #007CFE），高度小
  const labelNumberBox = boxOf(40, 90, 1000, 220, (r, g, b) => b > 170 && b - r > 60 && r < 140);
  // 蓝底反白标签：顶部带内的强调蓝色**实心块**（357/2 实测 x99..324、y99..166）。
  // 与 ip-trend 编号的区别是宽度与位置：编号窄（<200）且在 y140 之后，
  // 标签宽（约 226）且贴近页顶（y≈99）。
  const blueTagBox = boxOf(40, 80, 1040, 230, (r, g, b) => b > 190 && b - r > 90 && g < 160);
  // 细字深灰：低亮度、几乎无色偏（#333/#2B2B2B），同样在顶部细字带内。
  // 与 labelNumberBox 的区别**只有颜色** —— 这是第三族（wow-label-dark-v1）
  // 的判据，2026-10-19 从 unknown 队列校准得出。
  const labelDarkBox = boxOf(40, 90, 1000, 220, (r, g, b) => {
    const lum = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
    return lum < 0.42 && Math.max(r, g, b) - Math.min(r, g, b) < 40;
  });

  /* --- 顶部强调色占比（brand-case 的细字行会命中）--- */
  let topAccent = 0;
  let topTotal = 0;
  for (let y = 110; y < 170; y++) {
    for (let x = 60; x < 1000; x += 2) {
      const [r, g, b] = px(x, y);
      topTotal++;
      if (b > 170 && b - r > 60 && r < 140) topAccent++;
    }
  }
  const topAccentRatio = topTotal ? topAccent / topTotal : 0;

  /* --- 封面强调块（蓝底白字）：y 350..700 的亮蓝大面积 --- */
  let accMnX = 1e9, accMxX = -1, accMnY = 1e9, accMxY = -1, accCnt = 0;
  for (let y = 300; y < Math.min(800, height); y++) {
    for (let x = 40; x < width - 40; x++) {
      const [r, g, b] = px(x, y);
      if (b > 200 && b - r > 90 && g < 170) {
        accCnt++;
        if (x < accMnX) accMnX = x;
        if (x > accMxX) accMxX = x;
        if (y < accMnY) accMnY = y;
        if (y > accMxY) accMxY = y;
      }
    }
  }
  const accentBlockBox = accCnt > 2000
    ? { x: accMnX, y: accMnY, w: accMxX - accMnX + 1, h: accMxY - accMnY + 1 }
    : null;

  return {
    width, height,
    headerBarHeight, footerTopEdge, footerBarHeight, footerBarColor,
    pageBg, bigNumberBox: bigPale, labelNumberBox, labelDarkBox, blueTagBox, topAccentRatio, accentBlockBox,
  };
}

/**
 * 分类：这一页属于哪个模板族？
 *
 * 判据取**互斥的像素特征**，不用「投票多数」——投票会让两族互相淘汰。
 *  - brand-case：顶部有细字强调色行（topAccentRatio > 阈值）
 *  - ip-trend：顶部有大号浅蓝块（bigNumberBox 存在且高 > 60）
 *  - 都测不到 → unknown（进校准队列，不硬塞）
 */
export function classify(m: PageMeasurement, isCover: boolean): PageClassification {
  // 封面：按有无强调块判断（封面无编号）
  if (isCover) {
    if (m.accentBlockBox) {
      return { family: 'wow-ip-trend-v1', confidence: 0.6, reason: '封面有蓝底白字强调块' };
    }
    return { family: 'unknown', confidence: 0.2, reason: '封面无强调块，族特征不明确' };
  }

  // 内页：编号形态 × 编号颜色 = 两个独立维度（第三族就是只改颜色的结果）
  //  1) 大号浅蓝块（高 >60、成块）→ ip-trend
  //  2) 细字 + 强调蓝             → brand-case
  //  3) 细字 + 深灰、无大号块     → label-dark
  //
  // ⚠️ 顺序与阈值都不能松：v2 首跑把 label-dark 放在最前且只判「低亮度低色偏」，
  // 导致 376 页里 321 页同时含大号浅蓝块却被判成 label-dark —— 浅蓝编号的
  // 抗锯齿边缘像素亮度 <0.42 落进了深灰条件。
  // 现在：ip-trend 的「大块浅蓝 + 高度大」优先；label-dark 额外要求字高 <50
  // （细字行实测 h≈14..46）与「上方无浅蓝底」。
  // 蓝底反白标签优先：大号浅蓝编号是**浅蓝**（r>190），标签是**实心强调蓝**
  // 且带白字，两者在像素上不冲突，但先判标签更安全（标签更少见、更强特征）。
  if (m.blueTagBox && m.blueTagBox.h >= 40 && m.blueTagBox.h <= 110 && m.blueTagBox.y < 140) {
    return {
      family: 'wow-blue-tag-v1',
      confidence: 0.7,
      reason: `蓝底反白标签（bbox ${JSON.stringify(m.blueTagBox)}）`,
    };
  }
  const hasBigPale = Boolean(m.bigNumberBox);
  if (hasBigPale) {
    return {
      family: 'wow-ip-trend-v1',
      confidence: 0.8,
      reason: `大号浅蓝编号（bbox ${JSON.stringify(m.bigNumberBox)}）`,
    };
  }
  // ⚠️ 判据是「bbox 形态」，不是「像素占比」：v4 用 topAccentRatio > 0.02 判
  // brand-case，结果 340/1 这类正常页（占比 0.0118）被误判 unknown，
  // unknown 从 48 涨到 242。占比随文字长度波动，形态不波动。
  if (m.labelNumberBox && m.labelNumberBox.h < 40 && m.labelNumberBox.y < 240) {
    return {
      family: 'wow-brand-case-v1',
      confidence: 0.75,
      reason: `细字栏目编号·强调色（bbox ${JSON.stringify(m.labelNumberBox)}）`,
    };
  }
  // 深灰细字：高度 <50（细字行实测 14..46）、起点在顶部细字带 x<200。
  // 339/1 的 dark bbox 落在 x262（标题行）而非 x98（编号列），用起点排除。
  if (m.labelDarkBox && m.labelDarkBox.h < 50 && m.labelDarkBox.x < 200 && m.labelDarkBox.y < 240) {
    return {
      family: 'wow-label-dark-v1',
      confidence: 0.7,
      reason: `细字栏目编号·深灰（bbox h=${m.labelDarkBox.h}）`,
    };
  }
  // 无页码、标题直接置顶的版式（342/1 实测）：顶部有深灰文字、高度约
  // 54px（是标题字号，不是编号字号），且页面**没有任何**编号特征。
  // 「没有编号」本身就是一种可复刻的族特征 —— 不能一律当 unknown。
  // 标题置顶有两种起排：直接标题（342/1，y≈153）与 eyebrow+标题（357/1
  // 顶部先出 THE PROBLEM，eyebrow 在 y≈115 会把深灰墨迹整体上移），
  // 所以 y 带放宽到 90..230、高度到 110。
  if (m.labelDarkBox && m.labelDarkBox.y >= 90 && m.labelDarkBox.y <= 230 && m.labelDarkBox.h >= 40 && m.labelDarkBox.h <= 110) {
    return {
      family: 'wow-title-top-v1',
      confidence: 0.6,
      reason: `无页码·标题置顶（top ink bbox ${JSON.stringify(m.labelDarkBox)}）`,
    };
  }
  return { family: 'unknown', confidence: 0, reason: '编号与标题形态均未命中（配图页/异形版式）' };
}

/** 列出某来源的全部本地图片路径（按 note/idx 排序）。 */
export async function listCorpusImages(
  corpusDir: string,
): Promise<Array<{ noteId: number; pageIndex: number; file: string }>> {
  const out: Array<{ noteId: number; pageIndex: number; file: string }> = [];
  let notes: string[];
  try {
    notes = (await fs.readdir(corpusDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const noteDir of notes) {
    const dir = path.join(corpusDir, noteDir);
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
    } catch {
      continue;
    }
    files.forEach((f, i) => {
      out.push({ noteId: Number(noteDir), pageIndex: i, file: path.join(dir, f) });
    });
  }
  return out;
}
