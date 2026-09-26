/**
 * 신고 결과 — 신고 완료 표시 · 접수증/납부서 올리기.
 *
 * 정직한 연동 상태: 홈택스·위택스 전자신고 API 없음 → FILE_BASED.
 * "신고 완료"는 사람이 홈택스 파일 변환신고(또는 위택스)로 제출했다는 기록이다. MIN TAX OPS 는 제출하지 않는다.
 * 「홈택스 이용에 관한 규정」 제13조(접수증 보관) — 접수증이 있어야 신고 단계가 완료로 표시된다.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { files, filingJobs, filingResults, payrollMonths, clients } from '@mintax/db';
import { formatWon, type IntegrationStatus } from '@mintax/core';
import { AppError, NotFoundError, ValidationError } from '@mintax/security';
import { requirePermission, withTx, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { sha256OfBuffer, storeFile } from '../infra/storage';
import { assertUuid, kstToday, daysBetween, toIso } from '../payroll/helpers';
import { toJobSummary } from './board';
import { FILING_KIND_LABELS, READY_STEP_OF, currentStepOf, type FilingKind } from './steps';
import { FILING_CHANNEL_NOTE, payloadOf, type FilingJobRow } from './sync';
import type { FilingJobDTO, FilingResultDTO, MarkFiledResult, UploadFilingResultOutput } from './types';

const RESULT_KIND_LABELS: Record<string, string> = { receipt: '접수증', payment_slip: '납부서', filed_data: '신고 기록' };
const MAX_RESULT_BYTES = 20 * 1024 * 1024;

type ResultRow = typeof filingResults.$inferSelect;

async function loadJob(ctx: Pick<ServiceContext, 'db'>, filingJobId: string, forUpdate = false): Promise<{ job: FilingJobRow; clientName: string }> {
  assertUuid(filingJobId, 'filingJobId', '신고 작업');
  const q = ctx.db
    .select({ job: filingJobs, clientName: clients.name })
    .from(filingJobs)
    .innerJoin(clients, eq(clients.id, filingJobs.clientId))
    .where(eq(filingJobs.id, filingJobId));
  const [row] = forUpdate ? await q.for('update', { of: filingJobs }) : await q;
  if (!row) throw new NotFoundError('신고 작업');
  return row;
}

async function loadResults(ctx: Pick<ServiceContext, 'db'>, filingJobId: string): Promise<Array<ResultRow & { fileName: string | null }>> {
  const rows = await ctx.db
    .select({ r: filingResults, fileName: files.originalName })
    .from(filingResults)
    .leftJoin(files, eq(files.id, filingResults.fileId))
    .where(eq(filingResults.filingJobId, filingJobId))
    .orderBy(asc(filingResults.createdAt), asc(filingResults.id));
  return rows.map((x) => ({ ...x.r, fileName: x.fileName }));
}

function toResultDTO(r: ResultRow & { fileName: string | null }, canonicalId: string | null): FilingResultDTO {
  return {
    id: r.id,
    filingJobId: r.filingJobId,
    kind: r.kind,
    kindLabel: RESULT_KIND_LABELS[r.kind] ?? r.kind,
    fileId: r.fileId,
    fileName: r.fileName,
    receiptNumber: r.receiptNumber,
    amount: r.amount,
    filedAt: toIso(r.filedAt),
    collectedVia: r.collectedVia,
    createdAt: toIso(r.createdAt)!,
    canonical: r.id === canonicalId,
  };
}

async function toJobDTO(ctx: Pick<ServiceContext, 'db'> & { now: () => Date }, job: FilingJobRow, clientName: string, extraWarnings: string[] = []): Promise<FilingJobDTO> {
  const results = await loadResults(ctx, job.id);
  const receipts = results.filter((r) => r.kind === 'receipt');
  const canonical = receipts.length ? receipts[receipts.length - 1]!.id : null;
  const p = payloadOf(job);
  const warnings = [...(p.warnings ?? []), ...extraWarnings];
  if (p.amendmentWarning) warnings.unshift(p.amendmentWarning);
  if (job.steps?.filed && receipts.length === 0) warnings.push('신고 완료로 표시됐지만 접수증이 없습니다 — 홈택스 이용 규정 제13조에 따라 접수증을 올려 보관하세요.');
  if (job.dueDate && !job.steps?.filed) {
    const d = daysBetween(kstToday(ctx.now()), job.dueDate);
    if (d < 0) warnings.push(`신고 기한(${job.dueDate})이 ${-d}일 지났습니다 — 기한 후 신고·가산세를 확인하세요.`);
  }
  const months = Object.values(p.months ?? {}).sort((a, b) => a.paymentPeriod.localeCompare(b.paymentPeriod));
  return {
    ...toJobSummary(job, { receipts: receipts.length, paymentSlips: results.filter((r) => r.kind === 'payment_slip').length }),
    clientId: job.clientId,
    clientName,
    steps: job.steps ?? {},
    channelStatus: job.channelStatus,
    channelNote: p.channelNote ?? FILING_CHANNEL_NOTE,
    results: results.map((r) => toResultDTO(r, canonical)),
    warnings: [...new Set(warnings)],
    payload: {
      months: months.map((e) => ({
        paymentPeriod: e.paymentPeriod,
        attributionPeriod: e.attributionPeriod,
        payrollMonthId: e.payrollMonthId,
        persons: e.persons,
        totalPay: e.totalPay,
        incomeTax: e.incomeTax,
        localIncomeTax: e.localIncomeTax,
        rows: e.rows,
      })),
      withholdingRows: months.length === 1 ? months[0]!.withholdingRows ?? [] : [],
    },
  };
}

/** 신고 작업 상세 (접수증·납부서 목록, 최신 접수증 = 정본) */
export async function getFilingJob(ctx: ServiceContext, filingJobId: string): Promise<FilingJobDTO> {
  requirePermission(ctx, 'filing.write');
  const { job, clientName } = await loadJob(ctx, filingJobId);
  return toJobDTO(ctx, job, clientName);
}

function parseFiledAt(v: unknown, now: Date): Date {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  const s = String(v ?? '').trim();
  let d: Date | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d = new Date(`${s}T00:00:00+09:00`);
  else if (/^\d{4}-\d{2}-\d{2}T/.test(s)) d = new Date(s);
  if (!d || Number.isNaN(d.getTime())) {
    throw new ValidationError('신고일시 형식이 올바르지 않습니다. 예: 2026-10-08 또는 2026-10-08T14:30:00+09:00', [{ field: 'filedAt', message: 'date' }]);
  }
  if (d.getTime() > now.getTime() + 24 * 3600 * 1000) throw new ValidationError('신고일시가 미래입니다. 홈택스 접수증의 접수일시를 입력하세요.', [{ field: 'filedAt', message: '미래' }]);
  if (d.getUTCFullYear() < 2020) throw new ValidationError('신고일시가 너무 이릅니다.', [{ field: 'filedAt', message: 'range' }]);
  return d;
}

/**
 * 신고 완료 표시 — 사람이 홈택스(파일 변환신고)·위택스에서 제출했다는 기록 (FILE_BASED).
 * 같은 신고를 다시 전송하면 최종분이 유효하므로 filedAt 을 최신으로 갱신하고 이력을 남긴다.
 */
export async function markFiled(ctx: ServiceContext, input: { filingJobId: string; filedAt: string | Date; receiptNumber?: string | null }): Promise<MarkFiledResult> {
  requirePermission(ctx, 'filing.write');
  const filedAt = parseFiledAt(input?.filedAt, ctx.now());
  const receiptNumber = input.receiptNumber ? String(input.receiptNumber).trim().slice(0, 60) : null;
  if (receiptNumber && !/^[0-9A-Za-z-]{4,60}$/.test(receiptNumber)) {
    throw new ValidationError('접수번호는 숫자·영문·하이픈만 입력하세요.', [{ field: 'receiptNumber', message: 'format' }]);
  }
  return ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    const { job, clientName } = await loadJob(t, input.filingJobId, true);
    const kind = job.kind as FilingKind;
    const warnings: string[] = [];
    const steps: Record<string, string | null> = { ...(job.steps ?? {}) };
    if (!steps[READY_STEP_OF[kind] ?? 'withholding_ready']) {
      warnings.push('MIN TAX OPS 에서 신고 준비(급여 확정) 전에 신고 완료로 표시했습니다 — 신고 금액과 급여 합계를 대조하세요.');
    }
    const wasFiled = steps.filed ?? null;
    steps.filed = filedAt.toISOString();
    const p = payloadOf(job);
    const filedHistory = [...(p.filedHistory ?? []), { filedAt: steps.filed, by: ctx.actor.name, receiptNumber }];
    const [updated] = await t.db
      .update(filingJobs)
      .set({ steps, currentStep: currentStepOf(steps), payload: { ...p, filedHistory } as unknown as Record<string, unknown>, updatedAt: ctx.now() })
      .where(eq(filingJobs.id, job.id))
      .returning();
    if (receiptNumber) {
      await t.db.insert(filingResults).values({ filingJobId: job.id, kind: 'filed_data', receiptNumber, filedAt, collectedVia: 'manual_entry', createdAt: ctx.now() });
    }
    if (kind === 'withholding') {
      const monthIds = Object.values(p.months ?? {}).map((e) => e.payrollMonthId);
      if (monthIds.length) {
        await t.db
          .update(payrollMonths)
          .set({ status: 'filed', updatedAt: ctx.now() })
          .where(and(sql`${payrollMonths.id} = any(${sql.param(monthIds)}::uuid[])`, sql`${payrollMonths.status} in ('confirmed', 'exported')`));
      }
    }
    await writeAudit(t, {
      action: 'filing.mark_filed',
      category: 'data_change',
      entityType: 'filing_job',
      entityId: job.id,
      clientId: job.clientId,
      summary: `${clientName} ${job.period} ${FILING_KIND_LABELS[kind] ?? kind} 신고완료 표시${receiptNumber ? ` (접수번호 ${receiptNumber})` : ''} — 사람이 홈택스/위택스에 제출 (FILE_BASED)${wasFiled ? ' · 재제출(최종분 유효)' : ''}`,
      before: { filed: wasFiled },
      after: { filed: steps.filed, receiptNumber },
    });
    return {
      job: await toJobDTO(t, updated!, clientName, warnings),
      integrationStatus: 'FILE_BASED' as IntegrationStatus,
      note: 'MIN TAX OPS 는 신고를 제출하지 않습니다. 직원이 홈택스(파일 변환신고)·위택스에서 제출한 사실을 기록했습니다. 접수증을 올려야 신고 단계가 완료됩니다.',
      warnings,
    };
  });
}

// ────────────────────────────── 접수증 · 납부서 ──────────────────────────────

type SniffedType = 'pdf' | 'png' | 'jpeg' | 'zip' | 'text';

function sniff(data: Buffer): SniffedType | null {
  if (data.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (data[0] === 0x89 && data.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data[0] === 0x50 && data[1] === 0x4b) return 'zip';
  const head = data.subarray(0, Math.min(data.length, 4096));
  if (!head.includes(0)) return 'text';
  return null;
}

const MIME: Record<SniffedType, string> = { pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg', zip: 'application/zip', text: 'text/plain' };

/** 파일명·텍스트에서 금액 읽기 ("납부서_123,450원.pdf", "납부할세액 123,450") */
export function parseAmountHint(fileName: string, text: string | null): { amount: number | null; source: 'file_name' | 'file_text' | null } {
  const fromName = [...fileName.matchAll(/(\d{1,3}(?:,\d{3})+|\d{3,})\s*원/g)].map((m) => Number(m[1]!.replace(/,/g, '')));
  if (fromName.length) return { amount: fromName[fromName.length - 1]!, source: 'file_name' };
  const n2 = /(?:금액|세액)[_\s-]*(\d{3,})/.exec(fileName);
  if (n2) return { amount: Number(n2[1]), source: 'file_name' };
  if (text) {
    const m = /(납부할?\s*세액|납부\s*금액|납부할\s*금액|세액\s*합계|합\s*계\s*세액)[^\d]{0,30}(\d{1,3}(?:,\d{3})+|\d+)/.exec(text);
    if (m) return { amount: Number(m[2]!.replace(/,/g, '')), source: 'file_text' };
  }
  return { amount: null, source: null };
}

export function parseReceiptNumberHint(fileName: string, text: string | null): string | null {
  const src = `${fileName}\n${text ?? ''}`;
  const m = /접수번호[^0-9A-Za-z]{0,10}([0-9][0-9A-Za-z-]{5,40})/.exec(src);
  return m ? m[1]! : null;
}

/**
 * 접수증·납부서 올리기 — 암호화 저장, filing_results 기록, 단계 갱신.
 * 금액은 입력값 → 파일명 → (텍스트 파일이면) 본문 순서로 읽고, 신고 요약 세액과 다르면 경고한다.
 * PDF 본문 판독은 샘플 확보 전까지 하지 않는다 (사람이 금액을 입력하거나 파일명에 포함).
 */
export async function uploadFilingResult(
  ctx: ServiceContext,
  input: { filingJobId: string; kind: 'receipt' | 'payment_slip'; fileName: string; data: Buffer; amount?: number | null; receiptNumber?: string | null },
): Promise<UploadFilingResultOutput> {
  requirePermission(ctx, 'filing.write');
  if (input?.kind !== 'receipt' && input?.kind !== 'payment_slip') {
    throw new ValidationError('올릴 파일 종류는 접수증(receipt) 또는 납부서(payment_slip)입니다.', [{ field: 'kind', message: 'receipt | payment_slip' }]);
  }
  const fileName = String(input.fileName ?? '').trim() || (input.kind === 'receipt' ? '접수증.pdf' : '납부서.pdf');
  const data = input.data;
  if (!data || data.length === 0) throw new ValidationError('빈 파일입니다. 파일을 다시 선택해 주세요.');
  if (data.length > MAX_RESULT_BYTES) throw new ValidationError('접수증·납부서 파일은 20MB 이하만 올릴 수 있습니다.');
  const type = sniff(data);
  if (!type) throw new ValidationError('PDF·이미지(PNG/JPG)·텍스트(HTML) 파일만 올릴 수 있습니다.');
  if (type === 'zip') {
    throw new AppError({
      code: 'FILING_ZIP_UNSUPPORTED',
      httpStatus: 400,
      userMessage: '위멤버스 신고리스트 일괄 ZIP 자동 분류는 아직 지원하지 않습니다 (ZIP 형식 샘플 확보 전). 접수증·납부서 PDF 를 하나씩 올려 주세요.',
    });
  }
  if (input.amount !== undefined && input.amount !== null && (!Number.isSafeInteger(input.amount) || input.amount < 0)) {
    throw new ValidationError('금액은 0 이상의 원 단위 정수여야 합니다.', [{ field: 'amount', message: 'int >= 0' }]);
  }
  const text = type === 'text' ? data.toString('utf8').replace(/<[^>]+>/g, ' ').slice(0, 200_000) : null;
  const hint = input.amount !== undefined && input.amount !== null ? { amount: input.amount, source: 'input' as const } : parseAmountHint(fileName, text);
  const receiptNumber = input.receiptNumber?.trim() || parseReceiptNumberHint(fileName, text);
  const sha = sha256OfBuffer(data);

  return ctx.db.transaction(async (tx) => {
    const t = withTx(ctx, tx);
    const { job, clientName } = await loadJob(t, input.filingJobId, true);
    const kind = job.kind as FilingKind;
    const dup = await t.db
      .select({ r: filingResults, sha: files.sha256, fileName: files.originalName })
      .from(filingResults)
      .innerJoin(files, eq(files.id, filingResults.fileId))
      .where(and(eq(filingResults.filingJobId, job.id), eq(filingResults.kind, input.kind), eq(files.sha256, sha)));
    if (dup[0]) {
      return {
        result: toResultDTO({ ...dup[0].r, fileName: dup[0].fileName }, null),
        job: await toJobDTO(t, job, clientName),
        duplicate: true,
        amountSource: hint.source,
        warnings: ['같은 파일이 이미 올라와 있습니다 — 다시 저장하지 않았습니다.'],
      };
    }
    const stored = await storeFile(t, {
      data,
      originalName: fileName,
      mimeType: MIME[type],
      purpose: input.kind === 'receipt' ? 'filing_receipt' : 'payment_slip',
      clientId: job.clientId,
    });
    const steps: Record<string, string | null> = { ...(job.steps ?? {}) };
    const warnings: string[] = [];
    const nowIso = ctx.now().toISOString();
    if (input.kind === 'receipt') {
      steps.receipt_collected = nowIso;
      if (!steps.filed) {
        steps.filed = nowIso;
        warnings.push('접수증으로 신고 사실을 확인해 신고 완료로 표시했습니다 — 접수일시가 다르면 신고 완료 표시에서 고치세요.');
      }
    } else {
      steps.payment_slip_collected = nowIso;
    }
    const p = payloadOf(job);
    const expected = kind === 'withholding' ? p.totals?.incomeTax : kind === 'local_income_tax' ? p.totals?.localIncomeTax : undefined;
    if (input.kind === 'payment_slip' && hint.amount !== null && expected !== undefined && hint.amount !== expected) {
      warnings.push(`납부서 금액 ${formatWon(hint.amount)} ≠ 신고 요약 세액 ${formatWon(expected)} — 가산세·조정환급 반영 여부를 확인하세요.`);
    }
    if (input.kind === 'payment_slip' && hint.amount === null) warnings.push('납부서 금액을 읽지 못했습니다 — 금액을 입력하면 신고 세액과 대조합니다.');
    const [res] = await t.db
      .insert(filingResults)
      .values({
        filingJobId: job.id,
        kind: input.kind,
        fileId: stored.id,
        receiptNumber: receiptNumber ?? null,
        amount: hint.amount,
        filedAt: input.kind === 'receipt' ? new Date(steps.filed!) : null,
        collectedVia: 'manual_upload',
        createdAt: ctx.now(),
      })
      .returning();
    const [updated] = await t.db
      .update(filingJobs)
      .set({ steps, currentStep: currentStepOf(steps), updatedAt: ctx.now() })
      .where(eq(filingJobs.id, job.id))
      .returning();
    await writeAudit(t, {
      action: 'filing.upload_result',
      category: 'data_change',
      entityType: 'filing_job',
      entityId: job.id,
      clientId: job.clientId,
      summary: `${clientName} ${job.period} ${FILING_KIND_LABELS[kind] ?? kind} ${RESULT_KIND_LABELS[input.kind]} 올림 (${fileName}${hint.amount !== null ? `, ${formatWon(hint.amount)}` : ''}${receiptNumber ? `, 접수번호 ${receiptNumber}` : ''})`,
      after: { resultId: res!.id, fileId: stored.id, kind: input.kind, amount: hint.amount, amountSource: hint.source, receiptNumber: receiptNumber ?? null },
    });
    const all = await loadResults(t, job.id);
    const receipts = all.filter((r) => r.kind === 'receipt');
    return {
      result: toResultDTO({ ...res!, fileName: stored.originalName }, receipts.length ? receipts[receipts.length - 1]!.id : null),
      job: await toJobDTO(t, updated!, clientName, warnings),
      duplicate: false,
      amountSource: hint.source,
      warnings,
    };
  });
}
