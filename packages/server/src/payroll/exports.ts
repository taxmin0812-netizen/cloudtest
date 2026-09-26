/**
 * 5단계 — WEHAGO 급여자료(근로)·사업소득·일용직 업로드 파일.
 *
 * 연동 상태 (정직하게): WEHAGO 급여 API 없음 → FILE_BASED. 급여 서식의 열 구성은 미확인(research/01 U7)이라
 * 사무소가 실제 서식을 등록하기 전에는 MOCK 서식으로만 만들고, 파일마다 "업로드 금지" 경고를 붙인다.
 * 파일은 만든 뒤 다시 읽어 인원·지급총액·세액·차인지급액을 1원 단위로 대조한다 (불일치 → blocked).
 * 주민번호는 payroll.sensitive 권한자가 만들 때만 파일에 넣고, 그 파일은 받을 때도 같은 권한이 필요하다.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  WEHAGO_PAYROLL_BUSINESS_TEMPLATE,
  WEHAGO_PAYROLL_DAILY_TEMPLATE,
  WEHAGO_PAYROLL_EARNED_TEMPLATE,
  buildTemplateFromSampleFile,
  computePayrollTotals,
  isAdapterError,
  templateHeaderHash,
  validatePayrollRows,
  validateTemplate,
  verifyPayrollExportFile,
  writePayrollExport,
  type PayrollExportRow,
  type WehagoTemplate,
} from '@mintax/adapters';
import { exportJobs, payrollMonths } from '@mintax/db';
import { formatWon, type IncomeType, type IntegrationStatus } from '@mintax/core';
import { AppError, ConflictError, NotFoundError, ValidationError } from '@mintax/security';
import { hasPermission, requirePermission, withTx, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { getSetting, setSetting } from '../infra/settings';
import { readStoredFile, storeFile } from '../infra/storage';
import { decryptIdNumber } from './employees';
import { XLSX_MIME, assertUuid, incomeTypeLabel, itemToLine, itemsDigest, payrollHref, toIso } from './helpers';
import { nameOf } from './month-engine';
import {
  ensureEmployeeCodes,
  loadEmployeeRows,
  loadItemRows,
  loadMonthContext,
  lockPayroll,
  patchTotals,
  type MonthContext,
} from './store';
import { runPayrollValidation } from './validation';
import { sumItemsInDb } from './withholding';
import type { PayrollExportDownload, PayrollExportJobDTO, PayrollExportKind, PayrollExportsResult, PayrollTemplateInfoDTO } from './types';

export const PAYROLL_EXPORT_NOTE =
  'WEHAGO 급여 API가 없어(공개 API 미확인) 파일로 전달합니다. 파일을 받아 WEHAGO 급여자료입력·사업소득·일용직 메뉴에서 직원이 직접 올려야 합니다.';
export const MOCK_TEMPLATE_WARNING = '개발용(MOCK) 서식 — WEHAGO 실제 급여 서식을 등록하기 전에는 이 파일을 WEHAGO에 올리지 마세요 (검토·대사용).';
export const UNVERIFIED_TEMPLATE_WARNING = '사무소 서식(첫 업로드 확인 전) — WEHAGO에 올린 뒤 화면의 인원·금액을 확인하고 검증 완료로 바꾸세요.';

export const PAYROLL_EXPORT_KIND_LABELS: Record<PayrollExportKind, string> = {
  payroll_earned: '급여자료(근로)',
  payroll_business: '사업소득',
  payroll_daily: '일용직',
};

const KIND_OF_INCOME: Record<IncomeType, PayrollExportKind> = { earned: 'payroll_earned', business: 'payroll_business', daily: 'payroll_daily' };
const DEFAULT_TEMPLATES: Record<PayrollExportKind, WehagoTemplate> = {
  payroll_earned: WEHAGO_PAYROLL_EARNED_TEMPLATE,
  payroll_business: WEHAGO_PAYROLL_BUSINESS_TEMPLATE,
  payroll_daily: WEHAGO_PAYROLL_DAILY_TEMPLATE,
};

function assertExportKind(kind: unknown): PayrollExportKind {
  if (kind === 'payroll_earned' || kind === 'payroll_business' || kind === 'payroll_daily') return kind;
  throw new ValidationError('급여 서식 종류는 payroll_earned(근로)·payroll_business(사업소득)·payroll_daily(일용직) 중 하나입니다.', [{ field: 'kind', message: 'payroll_*' }]);
}

// ────────────────────────────── 서식 (settings) ──────────────────────────────

export function payrollTemplateSettingKey(kind: PayrollExportKind): string {
  return `wehago_template_${kind}`;
}
function verificationKey(kind: PayrollExportKind): string {
  return `wehago_template_verified:${kind}`;
}

export interface ActivePayrollTemplate {
  kind: PayrollExportKind;
  template: WehagoTemplate;
  source: 'default' | 'office';
  errors: string[];
  warning: string | null;
}

export async function loadActivePayrollTemplate(ctx: Pick<ServiceContext, 'db'>, kind: PayrollExportKind): Promise<ActivePayrollTemplate> {
  const stored = await getSetting<{ template?: Partial<WehagoTemplate> } | null>(ctx, payrollTemplateSettingKey(kind), null);
  const base = DEFAULT_TEMPLATES[kind];
  const t0: WehagoTemplate = stored?.template && Array.isArray(stored.template.columns) ? ({ ...base, ...stored.template, columns: stored.template.columns } as WehagoTemplate) : base;
  const v = await getSetting<{ headerHash?: string; key?: string; version?: string } | null>(ctx, verificationKey(kind), null);
  const verified = t0.verified || (!!v && v.headerHash === templateHeaderHash(t0) && v.key === t0.key && v.version === t0.version);
  const template: WehagoTemplate = { ...t0, verified };
  const errors = stored ? validateTemplate(template) : [];
  const warning = verified ? null : template.status === 'mock' ? MOCK_TEMPLATE_WARNING : UNVERIFIED_TEMPLATE_WARNING;
  return { kind, template, source: stored ? 'office' : 'default', errors, warning };
}

function templateInfo(a: ActivePayrollTemplate): PayrollTemplateInfoDTO {
  return {
    kind: a.kind,
    key: a.template.key,
    version: a.template.version,
    name: a.template.name,
    status: a.template.status,
    verified: a.template.verified,
    source: a.source,
    columns: a.template.columns.map((c) => ({ header: c.header, field: c.field, required: !!c.required })),
    warning: a.warning,
    note: a.template.note,
  };
}

/** Automation Studio [파일 서식] 탭 — 급여 서식 3종의 등록·검증 상태 (MOCK 이면 그렇게 표시) */
export async function getPayrollTemplates(ctx: ServiceContext): Promise<PayrollTemplateInfoDTO[]> {
  requirePermission(ctx, 'payroll.read');
  return Promise.all((['payroll_earned', 'payroll_business', 'payroll_daily'] as const).map(async (k) => templateInfo(await loadActivePayrollTemplate(ctx, k))));
}

/** 사무소가 WEHAGO 에서 내려받은 급여 서식 등록 (열 자동 매칭). 필수 항목이 빠지면 거부 */
export async function registerPayrollTemplate(ctx: ServiceContext, input: { kind: PayrollExportKind; fileName: string; data: Buffer }): Promise<PayrollTemplateInfoDTO & { unmatchedHeaders: string[] }> {
  requirePermission(ctx, 'settings.write');
  const kind = assertExportKind(input?.kind);
  if (!input.data || input.data.length === 0) throw new ValidationError('빈 파일입니다. WEHAGO 에서 내려받은 서식 파일을 올려 주세요.');
  if (input.data.length > 5 * 1024 * 1024) throw new ValidationError('서식 파일은 5MB 이하만 올릴 수 있습니다.');
  let r;
  try {
    r = await buildTemplateFromSampleFile(input.data, input.fileName, { base: DEFAULT_TEMPLATES[kind], key: `${DEFAULT_TEMPLATES[kind].key}_office` });
  } catch (e) {
    if (isAdapterError(e)) throw new ValidationError(e.message);
    throw e;
  }
  if (r.missingRequired.length > 0) {
    throw new ValidationError(`서식에서 필수 항목을 찾지 못했습니다: ${r.missingRequired.join(', ')} — WEHAGO "엑셀서식 내려받기" 원본인지 확인해 주세요.`);
  }
  const errs = validateTemplate(r.template);
  if (errs.length) throw new ValidationError(`서식 오류: ${errs.slice(0, 3).join(' / ')}`);
  const stored = await storeFile(ctx, { data: input.data, originalName: input.fileName, purpose: 'wehago_template' });
  await setSetting(
    ctx,
    payrollTemplateSettingKey(kind),
    { template: r.template, meta: { registeredAt: ctx.now().toISOString(), registeredBy: ctx.actor.name, sourceFileId: stored.id, sourceFileName: input.fileName, headerHash: r.headerHash } },
    `WEHAGO ${PAYROLL_EXPORT_KIND_LABELS[kind]} 사무소 서식 등록 (${input.fileName}, ${r.template.columns.length}열)`,
  );
  return { ...templateInfo(await loadActivePayrollTemplate(ctx, kind)), unmatchedHeaders: r.unmatchedHeaders };
}

/** 첫 업로드 후 WEHAGO 화면의 인원·금액이 맞으면 검증 완료 표시 */
export async function confirmPayrollTemplateVerified(ctx: ServiceContext, kind: PayrollExportKind): Promise<PayrollTemplateInfoDTO> {
  requirePermission(ctx, 'settings.write');
  const k = assertExportKind(kind);
  const a = await loadActivePayrollTemplate(ctx, k);
  if (a.template.status === 'mock') {
    throw new ConflictError('개발용(MOCK) 서식은 검증 완료로 바꿀 수 없습니다. WEHAGO 실제 서식을 먼저 등록하세요.');
  }
  await setSetting(
    ctx,
    verificationKey(k),
    { key: a.template.key, version: a.template.version, headerHash: templateHeaderHash(a.template), verifiedAt: ctx.now().toISOString(), verifiedBy: ctx.actor.name },
    `WEHAGO ${PAYROLL_EXPORT_KIND_LABELS[k]} 서식 검증 완료 (첫 업로드 확인)`,
  );
  return templateInfo(await loadActivePayrollTemplate(ctx, k));
}

// ────────────────────────────── DTO ──────────────────────────────

type ExportJobRow = typeof exportJobs.$inferSelect;

interface PayrollExportValidation {
  payrollMonthId?: string;
  templateStatus?: string;
  templateVerified?: boolean;
  containsIdNumbers?: boolean;
  uploadAllowed?: boolean;
  warnings?: string[];
  errors?: string[];
  fileName?: string;
  itemsDigest?: string;
  totals?: { count: number; grossPay: number; incomeTax: number; localIncomeTax: number; netPay: number };
  supersededBy?: string;
}

function validationOf(row: ExportJobRow): PayrollExportValidation {
  return (row.validation ?? {}) as PayrollExportValidation;
}

export function toPayrollExportDTO(row: ExportJobRow): PayrollExportJobDTO {
  const v = validationOf(row);
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: PAYROLL_EXPORT_KIND_LABELS[row.kind as PayrollExportKind] ?? row.kind,
    status: row.status,
    templateKey: row.templateKey,
    templateVersion: row.templateVersion,
    templateStatus: v.templateStatus ?? 'unknown',
    templateVerified: !!v.templateVerified,
    rowCount: row.rowCount,
    grossPay: v.totals?.grossPay ?? row.totalAmount,
    incomeTax: v.totals?.incomeTax ?? 0,
    localIncomeTax: v.totals?.localIncomeTax ?? 0,
    netPay: v.totals?.netPay ?? 0,
    containsIdNumbers: !!v.containsIdNumbers,
    uploadAllowed: !!v.uploadAllowed && row.status !== 'blocked',
    warnings: v.warnings ?? [],
    blockedReason: row.blockedReason,
    fileId: row.fileId,
    fileName: v.fileName ?? null,
    createdAt: toIso(row.createdAt)!,
    downloadedAt: toIso(row.downloadedAt),
    integrationStatus: 'FILE_BASED',
  };
}

/** 그 달 급여 파일 목록 (최신순) — 권한 검사는 호출자 */
export async function listPayrollExportJobs(ctx: Pick<ServiceContext, 'db'>, payrollMonthId: string): Promise<PayrollExportJobDTO[]> {
  const rows = await ctx.db
    .select()
    .from(exportJobs)
    .where(and(inArray(exportJobs.kind, ['payroll_earned', 'payroll_business', 'payroll_daily']), sql`${exportJobs.validation}->>'payrollMonthId' = ${payrollMonthId}`))
    .orderBy(desc(exportJobs.createdAt));
  return rows.map(toPayrollExportDTO);
}

/** 그 달의 현재 유효한(대체·차단되지 않은) 파일 — kind 별 최신 1개 */
export async function currentPayrollExports(ctx: Pick<ServiceContext, 'db'>, payrollMonthId: string): Promise<Map<string, ExportJobRow>> {
  const rows = await ctx.db
    .select()
    .from(exportJobs)
    .where(and(inArray(exportJobs.kind, ['payroll_earned', 'payroll_business', 'payroll_daily']), sql`${exportJobs.validation}->>'payrollMonthId' = ${payrollMonthId}`))
    .orderBy(desc(exportJobs.createdAt));
  const out = new Map<string, ExportJobRow>();
  for (const r of rows) if (!out.has(r.kind)) out.set(r.kind, r);
  return out;
}

// ────────────────────────────── 생성 ──────────────────────────────

function fileNameFor(clientCode: string, clientName: string, period: string, kind: PayrollExportKind): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  return `${clean(clientCode)}_${clean(clientName)}_${period}_WEHAGO_${PAYROLL_EXPORT_KIND_LABELS[kind].replace(/[()]/g, '')}.xlsx`;
}

/**
 * 파일 생성 본체 (권한 검사 없음 — generatePayrollExports / markReadyForFiling 공용).
 * 검증 차단 이슈가 있으면 AppError. 서식·파일 재검증 실패는 export_jobs(status=blocked) 로 남긴다.
 */
export async function generatePayrollExportsInternal(ctx: ServiceContext, payrollMonthId: string): Promise<PayrollExportsResult> {
  const head = await loadMonthContext(ctx, payrollMonthId);
  return ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    await lockPayroll(t, head.month.clientId, head.month.period);
    const mc = await loadMonthContext(t, payrollMonthId, { forUpdate: true });
    const m = mc.month;
    const v = await runPayrollValidation(t, m.id, { persist: true, mc });
    if (!v.ok) {
      const first = v.issues.filter((i) => i.blocking).slice(0, 3).map((i) => i.message);
      throw new AppError({
        code: 'PAYROLL_EXPORT_BLOCKED',
        httpStatus: 409,
        userMessage: `급여 파일을 만들 수 없습니다 — ${v.summary}. ${first.join(' / ')}`,
        action: { label: '급여 검토로 이동', href: payrollHref(m.clientId, m.period) },
      });
    }
    const [items, employees, sums] = await Promise.all([loadItemRows(t, m.id), loadEmployeeRows(t, m.clientId), sumItemsInDb(t, m.id)]);
    const empById = new Map(employees.map((e) => [e.id, e]));
    const codes = await ensureEmployeeCodes(t, m.clientId, [...new Set(items.map((i) => i.employeeId))]);
    const includeIds = hasPermission(ctx, 'payroll.sensitive');
    const digest = itemsDigest(items);
    const prevCurrent = await currentPayrollExports(t, m.id);
    const jobs: PayrollExportJobDTO[] = [];
    const warningsAll: string[] = [];

    for (const incomeType of ['earned', 'business', 'daily'] as const) {
      const kind = KIND_OF_INCOME[incomeType];
      const typeItems = items.filter((i) => i.incomeType === incomeType);
      if (typeItems.length === 0) continue;
      const paidItems = typeItems.filter((i) => i.grossPay !== 0 || i.incomeTax !== 0);
      const active = await loadActivePayrollTemplate(t, kind);
      const template = active.template;
      const hasIdColumn = template.columns.some((c) => c.field === 'idNumber');
      const warnings: string[] = [];
      if (active.warning) warnings.push(active.warning);
      if (typeItems.length > paidItems.length) warnings.push(`지급 없음 ${typeItems.length - paidItems.length}명은 파일에서 뺐습니다.`);
      const autoCodes = paidItems.filter((i) => codes[i.employeeId]?.source !== 'user').length;
      if (autoCodes > 0) warnings.push(`사원코드 ${autoCodes}명은 MIN TAX OPS 자동 부여값입니다 — WEHAGO 사원코드와 다르면 직원 설정에서 고친 뒤 다시 만드세요.`);
      if (hasIdColumn && !includeIds) warnings.push('주민번호 열람 권한이 없어 주민번호 열을 비워 두었습니다 — 권한자가 다시 만들거나 WEHAGO 에서 입력하세요.');

      const rows: PayrollExportRow[] = paidItems.map((i) => {
        const emp = empById.get(i.employeeId);
        const line = itemToLine(i, nameOf(empById, i.employeeId));
        const days = line.workDays ?? 0;
        return {
          ...line,
          employeeCode: codes[i.employeeId]?.code ?? '',
          attributionMonth: m.period,
          idNumber: hasIdColumn && includeIds && emp ? decryptIdNumber(emp) : null,
          incomeCategoryCode: emp?.businessIncomeCode ?? null,
          taxRate: incomeType === 'business' ? 3 : null,
          dailyWage: incomeType === 'daily' && days > 0 && line.taxablePay % days === 0 ? line.taxablePay / days : null,
        };
      });
      const containsIdNumbers = rows.some((r) => !!r.idNumber);
      const pre = validatePayrollRows(template, rows);
      for (const w of pre.warnings) if (w.code !== 'unverified_template') warnings.push(w.message);
      const expectedTotals = computePayrollTotals(rows);
      const dbType = sums.byIncomeType[incomeType];
      const errors: string[] = [...active.errors.map((e) => `서식 오류: ${e}`), ...pre.errors.map((e) => e.message)];
      if (expectedTotals.grossPay !== dbType.grossPay || expectedTotals.incomeTax !== dbType.incomeTax || expectedTotals.localIncomeTax !== dbType.localIncomeTax) {
        errors.push(`파일 합계가 급여 행 합계와 다릅니다 (지급총액 ${formatWon(expectedTotals.grossPay)} / ${formatWon(dbType.grossPay)})`);
      }

      let fileId: string | null = null;
      let status = 'ready';
      let blockedReason: string | null = null;
      let verifySummary: string | null = null;
      const fileName = fileNameFor(mc.clientCode, mc.clientName, m.period, kind);
      if (errors.length === 0) {
        try {
          const buffer = await writePayrollExport(template, rows, { generatedAt: ctx.now(), allowMockTemplate: true });
          const verify = await verifyPayrollExportFile(buffer, template, { ...expectedTotals, employeeIds: rows.map((r) => r.employeeId) });
          verifySummary = verify.summary;
          if (!verify.ok) {
            errors.push(...verify.diffs.filter((d) => d.blocking).map((d) => d.message));
          } else {
            const stored = await storeFile(t, { data: buffer, originalName: fileName, mimeType: XLSX_MIME, purpose: 'payroll_export', clientId: m.clientId });
            fileId = stored.id;
          }
        } catch (e) {
          if (!isAdapterError(e)) throw e;
          errors.push(e.message);
        }
      }
      if (errors.length > 0) {
        status = 'blocked';
        blockedReason = errors.slice(0, 3).join(' / ');
      }
      const validation: PayrollExportValidation & Record<string, unknown> = {
        payrollMonthId: m.id,
        paymentPeriod: m.paymentPeriod,
        templateStatus: template.status,
        templateVerified: template.verified,
        templateSource: active.source,
        containsIdNumbers,
        uploadAllowed: template.status !== 'mock' && status === 'ready',
        warnings,
        errors,
        fileName,
        itemsDigest: digest,
        totals: expectedTotals,
        dbTotals: { grossPay: dbType.grossPay, incomeTax: dbType.incomeTax, localIncomeTax: dbType.localIncomeTax, netPay: dbType.netPay },
        verify: verifySummary,
      };
      const [row] = await t.db
        .insert(exportJobs)
        .values({
          clientId: m.clientId,
          period: m.period,
          kind,
          templateKey: template.key,
          templateVersion: template.version,
          status,
          fileId,
          validation,
          rowCount: rows.length,
          supplyAmount: 0,
          vatAmount: 0,
          totalAmount: expectedTotals.grossPay,
          blockedReason,
          createdBy: ctx.actor.userId,
          createdAt: ctx.now(),
        })
        .returning();
      // 이전 버전 대체 표시
      const old = prevCurrent.get(kind);
      if (old && ['ready', 'downloaded', 'blocked'].includes(old.status)) {
        await t.db
          .update(exportJobs)
          .set({ status: 'blocked', blockedReason: '새 버전으로 대체되었습니다.', validation: sql`${exportJobs.validation} || ${JSON.stringify({ supersededBy: row!.id })}::jsonb` })
          .where(eq(exportJobs.id, old.id));
      }
      const label = `${incomeTypeLabel(incomeType)} ${rows.length}명`;
      await writeAudit(t, {
        action: 'export.create',
        category: 'data_change',
        entityType: 'export_job',
        entityId: row!.id,
        clientId: m.clientId,
        summary: `${mc.clientName} ${m.period} WEHAGO ${PAYROLL_EXPORT_KIND_LABELS[kind]} 파일 ${status === 'ready' ? '생성' : '차단'}: ${label}, 지급총액 ${formatWon(expectedTotals.grossPay)}, 소득세 ${formatWon(expectedTotals.incomeTax)}${template.status === 'mock' ? ' — 개발용(MOCK) 서식' : ''}${containsIdNumbers ? ' — 주민번호 포함(암호화 저장)' : ''}${blockedReason ? ` — ${blockedReason}` : ''}`,
        after: { kind, status, rowCount: rows.length, totals: expectedTotals, templateKey: template.key, templateStatus: template.status, containsIdNumbers },
      });
      jobs.push(toPayrollExportDTO(row!));
      warningsAll.push(...warnings.map((w) => `${PAYROLL_EXPORT_KIND_LABELS[kind]}: ${w}`));
    }
    if (jobs.length === 0) throw new ValidationError('파일로 만들 급여 행이 없습니다.');
    const allReady = jobs.every((j) => j.status === 'ready');
    if (allReady) await patchTotals(t, m.id, {}, { wizardStep: Math.max(m.wizardStep, 6) });
    const summary = jobs.map((j) => `${j.kindLabel} ${j.rowCount}명 ${j.status === 'ready' ? '준비' : '차단'}`).join(' · ');
    return {
      payrollMonthId: m.id,
      jobs,
      warnings: [...new Set(warningsAll)],
      integrationStatus: 'FILE_BASED' as IntegrationStatus,
      note: PAYROLL_EXPORT_NOTE,
      summary: `${mc.clientName} ${m.period} WEHAGO 급여 파일: ${summary}`,
    };
  });
}

/** 5단계 — WEHAGO 급여 파일 생성 (근로·사업·일용 종류별) + 재검증 */
export async function generatePayrollExports(ctx: ServiceContext, payrollMonthId: string): Promise<PayrollExportsResult> {
  requirePermission(ctx, 'export.create');
  assertUuid(payrollMonthId, 'payrollMonthId', '급여 월');
  return generatePayrollExportsInternal(ctx, payrollMonthId);
}

// ────────────────────────────── 받기 · 업로드 확인 ──────────────────────────────

async function loadPayrollExportJob(ctx: Pick<ServiceContext, 'db'>, exportJobId: string): Promise<ExportJobRow> {
  assertUuid(exportJobId, 'exportJobId', '급여 파일');
  const [row] = await ctx.db.select().from(exportJobs).where(eq(exportJobs.id, exportJobId));
  if (!row || !['payroll_earned', 'payroll_business', 'payroll_daily'].includes(row.kind)) throw new NotFoundError('급여 파일');
  return row;
}

/** 급여 파일 받기 — 다운로드 감사. 주민번호가 든 파일은 payroll.sensitive 필요. 파일 생성 뒤 급여가 바뀌었으면 거부 */
export async function downloadPayrollExport(ctx: ServiceContext, exportJobId: string): Promise<PayrollExportDownload> {
  requirePermission(ctx, 'export.download');
  const job = await loadPayrollExportJob(ctx, exportJobId);
  const v = validationOf(job);
  if (v.containsIdNumbers) requirePermission(ctx, 'payroll.sensitive');
  const monthId = v.payrollMonthId ?? '';
  const mc = await loadMonthContext(ctx, monthId);
  if (job.status === 'blocked' || !job.fileId) {
    throw new AppError({
      code: 'EXPORT_BLOCKED',
      httpStatus: 409,
      userMessage: `받을 수 없는 급여 파일입니다: ${job.blockedReason ?? '사전검증 실패'}`,
      action: { label: '급여 파일 다시 만들기', href: payrollHref(mc.month.clientId, mc.month.period) },
    });
  }
  const items = await loadItemRows(ctx, monthId);
  if (v.itemsDigest && itemsDigest(items) !== v.itemsDigest) {
    await ctx.db.update(exportJobs).set({ status: 'blocked', blockedReason: '파일 생성 뒤 급여가 바뀌었습니다.' }).where(eq(exportJobs.id, job.id));
    throw new AppError({
      code: 'EXPORT_STALE',
      httpStatus: 409,
      userMessage: '이 파일을 만든 뒤 급여가 바뀌었습니다. 파일을 다시 만드세요 — 바뀐 급여가 반영되지 않은 파일은 WEHAGO에 올리면 안 됩니다.',
      action: { label: '급여 파일 다시 만들기', href: payrollHref(mc.month.clientId, mc.month.period) },
    });
  }
  const { data, row: file } = await readStoredFile(ctx, job.fileId);
  return ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    const [updated] = await t.db
      .update(exportJobs)
      .set({ status: job.status === 'ready' ? 'downloaded' : job.status, downloadedAt: job.downloadedAt ?? ctx.now() })
      .where(eq(exportJobs.id, job.id))
      .returning();
    if (mc.month.status === 'confirmed') {
      await t.db.update(payrollMonths).set({ status: 'exported', updatedAt: ctx.now() }).where(eq(payrollMonths.id, mc.month.id));
    }
    await writeAudit(t, {
      action: 'export.download',
      category: 'download',
      entityType: 'export_job',
      entityId: job.id,
      clientId: job.clientId,
      summary: `${mc.clientName} ${mc.month.period} WEHAGO ${PAYROLL_EXPORT_KIND_LABELS[job.kind as PayrollExportKind]} 파일 받음 (${job.rowCount}명${v.containsIdNumbers ? ', 주민번호 포함' : ''})`,
      after: { fileId: job.fileId, sha256: file.sha256, containsIdNumbers: !!v.containsIdNumbers },
    });
    return {
      fileName: file.originalName,
      mimeType: file.mimeType ?? XLSX_MIME,
      data,
      sizeBytes: data.length,
      sha256: file.sha256,
      warnings: v.warnings ?? [],
      exportJob: toPayrollExportDTO(updated!),
    };
  });
}

/** WEHAGO 업로드 완료 확인 (사람이 올렸다는 기록 — API 없음, FILE_BASED) */
export async function confirmPayrollUpload(ctx: ServiceContext, exportJobId: string): Promise<{ exportJob: PayrollExportJobDTO; integrationStatus: IntegrationStatus; note: string }> {
  requirePermission(ctx, 'export.create');
  const job = await loadPayrollExportJob(ctx, exportJobId);
  if (!['ready', 'downloaded', 'uploaded_confirmed'].includes(job.status)) {
    throw new ConflictError(`업로드 확인할 수 없는 상태입니다 (${job.status}). 최신 급여 파일을 받아 올린 뒤 확인하세요.`);
  }
  if (!validationOf(job).uploadAllowed) {
    throw new ConflictError('개발용(MOCK) 서식 파일은 WEHAGO 업로드용이 아닙니다. WEHAGO 실제 급여 서식을 등록한 뒤 파일을 다시 만드세요.');
  }
  const [u] = await ctx.db
    .update(exportJobs)
    .set({ status: 'uploaded_confirmed', uploadConfirmedAt: job.uploadConfirmedAt ?? ctx.now(), uploadConfirmedBy: ctx.actor.userId })
    .where(eq(exportJobs.id, job.id))
    .returning();
  await writeAudit(ctx, {
    action: 'export.confirm_upload',
    category: 'data_change',
    entityType: 'export_job',
    entityId: job.id,
    clientId: job.clientId,
    summary: `WEHAGO ${PAYROLL_EXPORT_KIND_LABELS[job.kind as PayrollExportKind]} 업로드 완료 확인 (${job.rowCount}명, 사람이 업로드 — API 없음)`,
    before: { status: job.status },
    after: { status: 'uploaded_confirmed' },
  });
  return { exportJob: toPayrollExportDTO(u!), integrationStatus: 'FILE_BASED', note: 'MIN TAX OPS 는 WEHAGO 에 직접 올리지 않습니다. 직원이 올렸다고 확인한 기록입니다.' };
}

