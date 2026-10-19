import { all, get } from '../../db/index.js';
import {
  FAMILY_NUMBERING,
  type AccountTemplate,
  type TemplateFamilyId,
} from '../../generate/design/contract.js';

/**
 * 模板族注册表（阶段 D 的生产入口）。
 *
 * 【硬性规则：只用 verified 的族】
 * page_evidence.verified = 0 的族不能用于生产渲染 —— 它只证明「这一族的
 * 页面存在」，不证明「我们的渲染能把这一族复原」。这两件事过去被混为一谈：
 * 报告里「已验证模板覆盖率 0%」就是这个区分的量化结果。
 *
 * 没有 verified 族时的行为：**阻断并说清楚**，不是静默回落到通用主题然后
 * 继续标注「1:1 复刻」。报告 5.4 明确要求
 * `template missing 不能静默退回通用主题后仍贴"1:1复刻"`。
 *
 * 【本阶段实际状态】
 * 2026-10-19：五族已由 extract-page-evidence 全量分类（664 页，unknown 15），
 * 但**尚无任何族通过原文回放验收**，所以 verified 仍为 0 —— 生产此刻
 * 应当阻断。这是正确的失败姿态，不是缺陷。
 */

export interface FamilyStatus {
  /** 族标识；'unknown' 是校准队列的占位，不是合法模板族。 */
  family: TemplateFamilyId | 'unknown';
  /** 该族已分类页数 */
  pages: number;
  /** 已通过原文回放验收的页数 */
  verifiedPages: number;
  /** 是否可用于生产 */
  productionReady: boolean;
  /** 编号渲染形态（读 schema 的族映射） */
  numbering: string;
}

export type RegistryStatus =
  | { kind: 'ready'; families: FamilyStatus[]; note: string }
  | { kind: 'blocked'; reason: string; families: FamilyStatus[] };

/** 读某来源各族的页数与验证状态。 */
export function familyStatuses(sourceId: number, extractorVersion: string): FamilyStatus[] {
  const rows = all<{ family: string; pages: number; verified: number }>(
    `SELECT family,
            COUNT(*) AS pages,
            SUM(verified) AS verified
       FROM page_evidence
      WHERE source_id = ? AND extractor_version = ?
      GROUP BY family
      ORDER BY pages DESC`,
    sourceId,
    extractorVersion,
  );
  return rows.map((r) => {
    const fam = r.family as TemplateFamilyId;
    const known = fam in FAMILY_NUMBERING;
    return {
      family: fam,
      pages: r.pages,
      verifiedPages: r.verified,
      // 生产可用 = 已分类（非 unknown）+ 至少一页通过验收
      productionReady: known && r.pages > 0 && r.verified > 0,
      numbering: known ? FAMILY_NUMBERING[fam] : 'n/a',
    };
  });
}

/**
 * 生产入口闸门：返回可用的 verified 族，或明确阻断。
 *
 * 阻断信息要能直接给人看（界面/日志），所以用中文句子而不是错误码。
 */
export function productionGate(
  sourceId: number,
  extractorVersion: string,
): RegistryStatus {
  const families = familyStatuses(sourceId, extractorVersion);
  const ready = families.filter((f) => f.productionReady);
  if (ready.length > 0) {
    return {
      kind: 'ready',
      families,
      note: `可用模板族：${ready.map((f) => `${f.family}(${f.verifiedPages}/${f.pages}页已验证)`).join('、')}`,
    };
  }
  const classified = families.filter((f) => f.family !== 'unknown');
  return {
    kind: 'blocked',
    families,
    reason:
      classified.length === 0
        ? '该来源尚无任何已分类页面：先跑 extract-page-evidence，再跑原文回放验收。' +
          '在模板库建立之前禁止声称复刻。'
        : `已分类 ${classified.reduce((a, f) => a + f.pages, 0)} 页，但没有一族通过原文回放验收（verified=0）。` +
          `复刻渲染是未验证的，不得进入生产。需要先跑 verify-template-replay。`,
  };
}

/**
 * 该来源当前应使用的模板族。
 *
 * 取**页数最多的 verified 族**作为默认；调用方可以显式覆盖。
 * 返回 null 表示阻断，调用方必须处理（不能 fallback）。
 */
export function resolveProductionFamily(
  sourceId: number,
  extractorVersion: string,
): TemplateFamilyId | null {
  const gate = productionGate(sourceId, extractorVersion);
  if (gate.kind === 'blocked') return null;
  const top = gate.families
    .filter((f) => f.productionReady)
    .sort((a, b) => b.verifiedPages - a.verifiedPages || b.pages - a.pages)[0];
  // productionReady 已排除 unknown，这里再窄化一次让类型成立
  return top && top.family !== 'unknown' ? top.family : null;
}

/** 覆盖率快照（三项独立，不合并）。生产与界面都读它。 */
export interface CoverageSnapshot {
  textDistilled: { done: number; total: number };
  visualPages: { done: number; total: number };
  templateVerified: { done: number; total: number };
  unknownPages: number;
  byFamily: FamilyStatus[];
}

export function coverageSnapshot(sourceId: number, extractorVersion: string): CoverageSnapshot {
  const totalNotes = get<{ c: number }>('SELECT COUNT(*) AS c FROM notes WHERE source_id = ?', sourceId)?.c ?? 0;
  const textDistilled = get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM note_styles ns JOIN notes n ON n.id = ns.note_id WHERE n.source_id = ?',
    sourceId,
  )?.c ?? 0;
  const totalPages = get<{ c: number }>('SELECT COUNT(*) AS c FROM note_images ni JOIN notes n ON n.id = ni.note_id WHERE n.source_id = ?', sourceId)?.c ?? 0;
  const visualPages = get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM page_evidence WHERE source_id = ? AND extractor_version = ?',
    sourceId, extractorVersion,
  )?.c ?? 0;
  const verified = get<{ c: number }>(
    'SELECT COUNT(*) AS c FROM page_evidence WHERE source_id = ? AND extractor_version = ? AND verified = 1',
    sourceId, extractorVersion,
  )?.c ?? 0;
  const families = familyStatuses(sourceId, extractorVersion);
  const unknownPages = families.find((f) => f.family === 'unknown')?.pages ?? 0;
  const classified = families.filter((f) => f.family !== 'unknown').reduce((a, f) => a + f.pages, 0);

  return {
    textDistilled: { done: textDistilled, total: totalNotes },
    visualPages: { done: visualPages, total: totalPages },
    // 分母是「已分类页」，不是全部页 —— 未分类页不该算作「没通过」，
    // 它们在 unknown 队列里单独呈现。
    templateVerified: { done: verified, total: classified },
    unknownPages,
    byFamily: families,
  };
}

/** 该族对应的账号模板（把族特征映射到渲染契约）。 */
export function templateForFamily(family: TemplateFamilyId): AccountTemplate {
  const base: AccountTemplate = {
    family,
    cover_header_text: '',
    cover_header_sub: '',
    cover_header_bg: '#FFFFFF',
    cover_header_ink: '#111827',
    cover_logo_text: '',
    inner_footer_text: '',
    inner_footer_sub: '',
    inner_footer_bg: '#333333',
    inner_footer_ink: '#FFFFFF',
    accent: '#007CFE',
    numbering: '01',
    columns: 1,
  };
  // 族特有差异：label-dark 与 title-top 无页码，blue-tag 用标签形态
  if (FAMILY_NUMBERING[family] === 'none') base.numbering = 'none';
  return base;
}
