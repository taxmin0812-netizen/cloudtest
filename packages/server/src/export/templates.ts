/**
 * WEHAGO 서식 관리 — 사무소가 WEHAGO 에서 내려받은 실제 엑셀서식을 등록하면 그 서식으로 파일을 만든다.
 * 등록 전에는 adapters 의 표준 서식(verified=false)을 쓰고, 결과 화면에 경고를 그대로 보여준다.
 *
 * 저장: settings[wehago_template_purchase_sales | wehago_template_general_journal] = { template, meta }
 *       settings[wehago_template_verified:<kind>] = 서식 검증 기록 (첫 업로드 확인 / 역수입 대사 1원 일치)
 */
import {
  DOUZONE_VAT_TYPE_TABLE,
  WEHAGO_GENERAL_JOURNAL_TEMPLATE,
  WEHAGO_PURCHASE_SALES_TEMPLATE,
  buildTemplateFromSampleFile,
  isAdapterError,
  templateHeaderHash,
  validateTemplate,
  type WehagoTemplate,
} from '@mintax/adapters';
import { eq } from 'drizzle-orm';
import { exportJobs, settings } from '@mintax/db';
import { AppError, ValidationError } from '@mintax/security';
import { requirePermission, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { SETTING_KEYS, getSetting, setSetting } from '../infra/settings';
import { storeFile } from '../infra/storage';
import { EXPORT_KIND_LABELS, TEMPLATES_HREF, assertKind, kstCompactDate } from './helpers';
import type { TemplateInfoDTO, TemplatePreviewDTO, WehagoExportKind } from './types';

export const DEFAULT_TEMPLATE_WARNING = '기본 서식(미검증) 사용 — WEHAGO에서 내려받은 실제 서식을 등록하세요';
export const OFFICE_TEMPLATE_WARNING =
  '사무소 서식(첫 업로드 확인 전) — WEHAGO에 올린 뒤 화면의 건수·금액을 확인하고 매입매출장 역수입 대사를 실행하세요';

const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;

interface StoredTemplateValue {
  template: WehagoTemplate;
  meta: {
    registeredAt: string;
    registeredBy: string;
    registeredById: string | null;
    sourceFileId: string | null;
    sourceFileName: string;
    headerHash: string;
  };
}

interface TemplateVerification {
  templateKey: string;
  templateVersion: string;
  headerHash: string;
  verifiedAt: string;
  verifiedBy: string;
  method: 'manual' | 'wehago_reimport';
  exportJobId: string | null;
}

export interface ActiveTemplate {
  kind: WehagoExportKind;
  template: WehagoTemplate;
  source: 'default' | 'office';
  headerHash: string;
  /** 등록 서식 검증 오류 (있으면 파일을 만들면 안 된다) */
  errors: string[];
  meta: StoredTemplateValue['meta'] | null;
  verification: TemplateVerification | null;
}

export function templateSettingKey(kind: WehagoExportKind): string {
  return kind === 'wehago_purchase_sales' ? SETTING_KEYS.wehagoPurchaseTemplate : SETTING_KEYS.wehagoJournalTemplate;
}

function verificationKey(kind: WehagoExportKind): string {
  return `wehago_template_verified:${kind}`;
}

function defaultTemplate(kind: WehagoExportKind): WehagoTemplate {
  return kind === 'wehago_purchase_sales' ? WEHAGO_PURCHASE_SALES_TEMPLATE : WEHAGO_GENERAL_JOURNAL_TEMPLATE;
}

/** 저장된 JSON → 템플릿 (코드표 등 빠진 필드는 기본값으로 채움) */
function hydrate(kind: WehagoExportKind, raw: unknown): { template: WehagoTemplate; meta: StoredTemplateValue['meta'] | null } | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<StoredTemplateValue>;
  const t = v.template as Partial<WehagoTemplate> | undefined;
  if (!t || !Array.isArray(t.columns)) return null;
  const base = defaultTemplate(kind);
  const template: WehagoTemplate = {
    ...base,
    ...t,
    vatTypeCodes: { ...base.vatTypeCodes, ...(t.vatTypeCodes ?? {}) },
    vatTypeTable: Array.isArray(t.vatTypeTable) && t.vatTypeTable.length > 0 ? t.vatTypeTable : DOUZONE_VAT_TYPE_TABLE,
    journalTypeCodes: { ...base.journalTypeCodes, ...(t.journalTypeCodes ?? {}) },
    slipSideCodes: base.slipSideCodes,
    columns: t.columns,
  } as WehagoTemplate;
  return { template, meta: v.meta ?? null };
}

/** 서비스 내부용: 현재 사용할 서식 (권한 검사 없음) */
export async function loadActiveTemplate(ctx: Pick<ServiceContext, 'db'>, kind: WehagoExportKind): Promise<ActiveTemplate> {
  const stored = hydrate(kind, await getSetting<unknown>(ctx, templateSettingKey(kind), null));
  const verification = await getSetting<TemplateVerification | null>(ctx, verificationKey(kind), null);
  const template0 = stored?.template ?? defaultTemplate(kind);
  const headerHash = templateHeaderHash(template0);
  const verified =
    template0.verified ||
    (!!verification && verification.headerHash === headerHash && verification.templateKey === template0.key && verification.templateVersion === template0.version);
  const template: WehagoTemplate = { ...template0, verified };
  const errors = stored ? validateTemplate(template) : [];
  if (stored && template.kind !== (kind === 'wehago_purchase_sales' ? 'purchase_sales' : 'general_journal')) {
    errors.push(`등록된 서식 종류(${template.kind})가 ${EXPORT_KIND_LABELS[kind]}와 다릅니다.`);
  }
  return { kind, template, source: stored ? 'office' : 'default', headerHash, errors, meta: stored?.meta ?? null, verification: verified ? verification : null };
}

export function templateWarning(t: Pick<ActiveTemplate, 'source' | 'template'>): string | null {
  if (t.template.verified) return null;
  if (t.template.status === 'mock') return '개발용(MOCK) 서식 — WEHAGO에 올리지 마세요';
  return t.source === 'default' ? DEFAULT_TEMPLATE_WARNING : OFFICE_TEMPLATE_WARNING;
}

export function templateInfo(t: ActiveTemplate): TemplateInfoDTO {
  return {
    kind: t.kind,
    key: t.template.key,
    version: t.template.version,
    name: t.template.name,
    status: t.template.status,
    verified: t.template.verified,
    source: t.source,
    headerHash: t.headerHash,
    columns: t.template.columns.map((c) => ({ header: c.header, field: c.field, required: !!c.required })),
    note: t.template.note,
    warning: templateWarning(t),
    registeredAt: t.meta?.registeredAt ?? null,
    registeredBy: t.meta?.registeredBy ?? null,
    sourceFileName: t.meta?.sourceFileName ?? null,
    verifiedAt: t.verification?.verifiedAt ?? null,
  };
}

/** 현재 사용 중인 WEHAGO 서식 (등록 서식이 없으면 표준 서식 + 미검증 경고) */
export async function getActiveTemplate(ctx: ServiceContext, kind: WehagoExportKind): Promise<TemplateInfoDTO> {
  requirePermission(ctx, 'export.create');
  return templateInfo(await loadActiveTemplate(ctx, assertKind(kind)));
}

// ────────────────────────────── 서식 등록 ──────────────────────────────

export interface TemplateUploadInput {
  kind: WehagoExportKind;
  fileName: string;
  data: Buffer;
}

async function buildFromUpload(ctx: ServiceContext, input: TemplateUploadInput) {
  const kind = assertKind(input.kind);
  if (!Buffer.isBuffer(input.data) || input.data.length === 0) {
    throw new ValidationError('서식 파일이 비어 있습니다. WEHAGO에서 "엑셀서식 내려받기"한 파일을 올려주세요.', [{ field: 'data', message: '필수' }]);
  }
  if (input.data.length > MAX_TEMPLATE_BYTES) {
    throw new ValidationError('서식 파일이 너무 큽니다(5MB 초과). WEHAGO에서 내려받은 빈 서식 파일을 올려주세요.', [{ field: 'data', message: '5MB 이하' }]);
  }
  const fileName = (input.fileName || 'wehago_template.xlsx').slice(0, 200);
  try {
    const r = await buildTemplateFromSampleFile(input.data, fileName, {
      base: defaultTemplate(kind),
      key: `${defaultTemplate(kind).key}_office`,
      sourceFileName: fileName,
    });
    // 같은 날 두 번 등록해도 제목행이 다르면 다른 버전이 되도록
    r.template.version = `${kstCompactDate(ctx.now())}-${r.headerHash.slice(0, 8)}`;
    return { kind, fileName, result: r };
  } catch (e) {
    if (isAdapterError(e)) {
      throw new AppError({
        code: 'TEMPLATE_INVALID',
        httpStatus: 422,
        userMessage: e.message,
        action: { label: 'WEHAGO 서식 안내', href: TEMPLATES_HREF },
      });
    }
    throw e;
  }
}

function previewDTO(kind: WehagoExportKind, fileName: string, r: Awaited<ReturnType<typeof buildFromUpload>>['result']): TemplatePreviewDTO {
  const errors = validateTemplate(r.template);
  if (r.missingRequired.length > 0) errors.push(`필수 항목을 서식에서 찾지 못했습니다: ${r.missingRequired.join(', ')}`);
  return {
    kind,
    fileName,
    sheetName: r.sheetName,
    headerRowIndex: r.headerRowIndex,
    columns: r.columns.map((c) => ({ index: c.index, header: c.header, field: c.field, matchedBy: c.matchedBy })),
    unmatchedHeaders: r.unmatchedHeaders,
    missingRequired: r.missingRequired,
    confidence: r.confidence,
    warnings: r.warnings,
    canRegister: errors.length === 0,
    errors: [...new Set(errors)],
    headerHash: r.headerHash,
  };
}

/** 서식 파일을 읽어 열 매핑 미리보기 (저장하지 않음) */
export async function previewWehagoTemplate(ctx: ServiceContext, input: TemplateUploadInput): Promise<TemplatePreviewDTO> {
  requirePermission(ctx, 'settings.write');
  const { kind, fileName, result } = await buildFromUpload(ctx, input);
  return previewDTO(kind, fileName, result);
}

/**
 * 사무소 WEHAGO 서식 등록. 필수 항목이 모두 매핑되어야 저장한다.
 * 등록해도 verified=false 로 둔다 — 첫 업로드 후 역수입 대사 1원 일치(자동) 또는 사람이 확인(confirmWehagoTemplateVerified)해야 검증됨.
 */
export async function registerWehagoTemplate(ctx: ServiceContext, input: TemplateUploadInput): Promise<{ template: TemplateInfoDTO; preview: TemplatePreviewDTO }> {
  requirePermission(ctx, 'settings.write');
  const { kind, fileName, result } = await buildFromUpload(ctx, input);
  const preview = previewDTO(kind, fileName, result);
  if (!preview.canRegister) {
    throw new ValidationError(
      `서식을 등록할 수 없습니다: ${preview.errors.join(' / ')} — WEHAGO "엑셀서식 내려받기" 원본 파일인지 확인하세요.`,
      preview.errors.map((m) => ({ field: 'template', message: m })),
    );
  }
  const file = await storeFile(ctx, { data: input.data, originalName: fileName, purpose: 'wehago_template', mimeType: null });
  const value: StoredTemplateValue = {
    template: result.template,
    meta: {
      registeredAt: ctx.now().toISOString(),
      registeredBy: ctx.actor.name,
      registeredById: ctx.actor.userId,
      sourceFileId: file.id,
      sourceFileName: fileName,
      headerHash: result.headerHash,
    },
  };
  const mapped = preview.columns.filter((c) => c.field).length;
  await setSetting(
    ctx,
    templateSettingKey(kind),
    value,
    `WEHAGO ${EXPORT_KIND_LABELS[kind]} 서식 등록: ${fileName} (${preview.columns.length}열 중 ${mapped}열 매핑, 첫 업로드 확인 전)`,
  );
  return { template: templateInfo(await loadActiveTemplate(ctx, kind)), preview };
}

/** 등록 서식 삭제 → 표준 서식으로 복귀 */
export async function resetWehagoTemplate(ctx: ServiceContext, kind: WehagoExportKind): Promise<TemplateInfoDTO> {
  requirePermission(ctx, 'settings.write');
  const k = assertKind(kind);
  const current = await getSetting<StoredTemplateValue | null>(ctx, templateSettingKey(k), null);
  if (current !== null) {
    await ctx.db.delete(settings).where(eq(settings.key, templateSettingKey(k)));
    await writeAudit(ctx, {
      action: 'settings.update',
      category: 'data_change',
      entityType: 'setting',
      entityId: templateSettingKey(k),
      summary: `WEHAGO ${EXPORT_KIND_LABELS[k]} 사무소 서식 해제 → 표준 서식(미검증) 사용`,
      before: { templateKey: current.template?.key ?? null, templateVersion: current.template?.version ?? null, sourceFileName: current.meta?.sourceFileName ?? null },
      after: { templateKey: defaultTemplate(k).key, templateVersion: defaultTemplate(k).version },
      revertible: false,
    });
  }
  return templateInfo(await loadActiveTemplate(ctx, k));
}

/** 검증 기록 저장 (내부) */
export async function recordTemplateVerification(
  ctx: ServiceContext,
  active: ActiveTemplate,
  method: TemplateVerification['method'],
  exportJobId: string | null,
): Promise<void> {
  const value: TemplateVerification = {
    templateKey: active.template.key,
    templateVersion: active.template.version,
    headerHash: active.headerHash,
    verifiedAt: ctx.now().toISOString(),
    verifiedBy: ctx.actor.name,
    method,
    exportJobId,
  };
  await setSetting(
    ctx,
    verificationKey(active.kind),
    value,
    method === 'wehago_reimport'
      ? `WEHAGO ${EXPORT_KIND_LABELS[active.kind]} 서식 검증 완료: 역수입 대사 1원 단위 일치 (${active.template.name})`
      : `WEHAGO ${EXPORT_KIND_LABELS[active.kind]} 서식 검증 확인: 첫 업로드 후 WEHAGO 화면 건수·금액 확인 (${active.template.name})`,
  );
}

/**
 * 첫 업로드 후 WEHAGO 화면의 건수·금액이 맞았음을 사람이 확인 → 현재 서식을 검증됨으로 표시.
 * exportJobId 는 그 파일이 현재 서식으로 만들어졌는지 확인하는 데 쓴다.
 */
export async function confirmWehagoTemplateVerified(ctx: ServiceContext, input: { kind: WehagoExportKind; exportJobId: string }): Promise<TemplateInfoDTO> {
  requirePermission(ctx, 'settings.write');
  const kind = assertKind(input.kind);
  const active = await loadActiveTemplate(ctx, kind);
  const [job] = await ctx.db.select().from(exportJobs).where(eq(exportJobs.id, input.exportJobId));
  if (!job || job.kind !== kind) throw new ValidationError('확인할 전송파일을 찾을 수 없습니다.', [{ field: 'exportJobId', message: '없음' }]);
  if (job.templateKey !== active.template.key || job.templateVersion !== active.template.version) {
    throw new ValidationError('이 파일은 현재 서식이 아닌 이전 서식으로 만들어졌습니다. 현재 서식으로 만든 파일을 올려 확인하세요.', [
      { field: 'exportJobId', message: '서식 버전 다름' },
    ]);
  }
  if (job.status !== 'uploaded_confirmed') {
    throw new ValidationError('WEHAGO 업로드 완료 확인을 먼저 해 주세요.', [{ field: 'exportJobId', message: '업로드 확인 전' }]);
  }
  if (!active.template.verified) await recordTemplateVerification(ctx, active, 'manual', job.id);
  return templateInfo(await loadActiveTemplate(ctx, kind));
}
