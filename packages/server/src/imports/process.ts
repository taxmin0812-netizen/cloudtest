/**
 * 작업 처리기 'import_file' — 원본 파일 → 정규화 → 중복 판정 → transaction_sources(모든 행) + transactions → classify_batch.
 *
 * - 판정과 삽입은 수임처 단위 advisory lock 을 잡은 **한 DB 트랜잭션** 안에서 한다 (동시 가져오기 경쟁 방지, 04-erd §11.2).
 *   트랜잭션이라 중간에 죽어도 반쯤 적재된 상태가 남지 않는다. 재실행(리퍼 회수·재시도)은 이미 적재된 가져오기를 다시 쓰지 않는다.
 * - 행 계산 불변식: 수집(totalRows) = 가져옴 + 중복 + 실패. 어긋나면 적재를 취소하고 실패로 남긴다.
 * - 합계·반복 제목·안내 문구 행(어댑터 non_data_row)은 거래가 아니므로 건수에서 빼고 메시지로 알린다
 *   (실패로 넣으면 대사 parse_failed 가 항상 차단이라 그 기간이 영구히 전송 불가가 된다 — 03 §14 G6).
 * - 세금계산서 품목 행 병합분은 부모 거래 rawData.__items 에 남는다 (대사 source 는 묶은 뒤 거래 단위, 03 §8.2).
 */
import { randomUUID } from 'node:crypto';
import { and, between, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { detectDuplicates, type DuplicateHit } from '@mintax/core/engine/vat-risk-index';
import type { NormalizedTransaction, RiskFlag } from '@mintax/core';
import { importJobs, transactionSources, transactions, type Database } from '@mintax/db';
import { isAdapterError, normalizeRows, previewImport, type FormatDetection, type NormalizeResult, type RowFailure } from '@mintax/adapters';
import { AppError } from '@mintax/security';
import { withTx } from '../context';
import { writeAudit } from '../infra/audit';
import { loadClientProfile } from '../infra/clients';
import { notifyProblem, resolveProblem } from '../infra/notify';
import { readStoredFile } from '../infra/storage';
import { enqueueJob } from '../jobs/queue';
import type { JobResult, JobRunContext } from '../jobs/registry';
import { ImportRejectedError, fromAdapterError, importHref } from './errors';
import {
  IMPORT_LOCK_NAMESPACE,
  NEEDS_MAPPING_TAG,
  SOURCE_CHUNK,
  TX_CHUNK,
  WEHAGO_DUPLICATE_REASON,
  WEHAGO_DUPLICATE_RULE_CODE,
  buildImportSummary,
  checkRowAccounting,
  chooseImportPeriod,
  chunk,
  failureNotificationTitle,
  formatCount,
  matchWehagoDoubleBooking,
  summarizeWarnings,
  wehagoDuplicateKey,
} from './helpers';
import { assertNoClientConflict, detectionFromMapping, loadClientRefs, needsMappingMessage } from './shared';
import type { ImportFilePayload } from './upload';

type ImportJobRow = typeof importJobs.$inferSelect;
type TxInsert = typeof transactions.$inferInsert;
type SourceInsert = typeof transactionSources.$inferInsert;

export interface ImportFileJobResult extends Record<string, unknown> {
  importJobId: string;
  clientId: string;
  totalRows: number;
  importedRows: number;
  duplicateRows: number;
  failedRows: number;
  wehagoDuplicateRows: number;
  nonDataRows: number;
  mergedRows: number;
  periods: string[];
  classifyJobIds: string[];
  summary: string;
  alreadyProcessed: boolean;
}

/** 사용자가 서식을 지정해야 해결되는 오류 (상태 needs_mapping 으로 남긴다) */
class NeedsMappingError extends ImportRejectedError {
  constructor(message: string) {
    super('IMPORT_NEEDS_MAPPING', message.replace(/^\[[^\]]+\]\s*/, ''), { details: { taggedMessage: message } });
  }
}

function parsePayload(raw: Record<string, unknown>): ImportFilePayload {
  const p = raw as Partial<ImportFilePayload>;
  if (typeof p.importJobId !== 'string' || p.importJobId === '') {
    throw new ImportRejectedError('IMPORT_BAD_PAYLOAD', '가져오기 작업 정보가 올바르지 않습니다. 파일을 다시 올려 주세요.');
  }
  return p as ImportFilePayload;
}

function resultFromRow(row: ImportJobRow, alreadyProcessed: boolean): ImportFileJobResult {
  return {
    importJobId: row.id,
    clientId: row.clientId ?? '',
    totalRows: row.totalRows,
    importedRows: row.importedRows,
    duplicateRows: row.duplicateRows,
    failedRows: row.failedRows,
    wehagoDuplicateRows: 0,
    nonDataRows: 0,
    mergedRows: 0,
    periods: row.period ? [row.period] : [],
    classifyJobIds: [],
    summary: buildImportSummary(row, row.status === 'partial' ? 'partial' : 'succeeded'),
    alreadyProcessed,
  };
}

/** 작업 처리기 본체 — registerImportsJobHandlers() 가 'import_file' 로 등록한다. 테스트에서는 직접 호출한다. */
export async function runImportFileJob(run: JobRunContext): Promise<JobResult> {
  const payload = parsePayload(run.job.payload);
  const [importJob] = await run.ctx.db.select().from(importJobs).where(eq(importJobs.id, payload.importJobId));
  if (!importJob) {
    throw new ImportRejectedError('IMPORT_NOT_FOUND', '가져오기 기록을 찾을 수 없습니다. 파일을 다시 올려 주세요.');
  }
  if (importJob.status === 'succeeded' || importJob.status === 'partial') {
    return { status: importJob.status, result: resultFromRow(importJob, true) };
  }
  try {
    const res = await processImport(run, importJob, payload);
    return { status: res.failedRows > 0 ? 'partial' : 'succeeded', result: res };
  } catch (e) {
    const err = toAppError(e);
    await markFailed(run, importJob, err).catch(() => undefined);
    throw err;
  }
}

function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (isAdapterError(e)) {
    if (e.code === 'COLUMN_MAPPING_REQUIRED' || e.code === 'HEADER_NOT_FOUND') return new NeedsMappingError(`${NEEDS_MAPPING_TAG} ${e.message}`);
    return fromAdapterError(e);
  }
  return new AppError({
    code: 'IMPORT_UNEXPECTED',
    httpStatus: 500,
    userMessage: '파일을 처리하는 중 일시적인 오류가 발생했습니다. 자동으로 다시 시도합니다. 계속 실패하면 관리자에게 문의하세요.',
    message: e instanceof Error ? e.message : String(e),
    retryable: true,
    cause: e,
  });
}

async function markFailed(run: JobRunContext, importJob: ImportJobRow, err: AppError): Promise<void> {
  const { ctx, job } = run;
  const willRetry = err.retryable && job.attempts < job.maxAttempts;
  const tagged = typeof err.details?.taggedMessage === 'string' ? (err.details.taggedMessage as string) : null;
  const message = willRetry ? `일시 오류로 다시 시도합니다: ${err.userMessage}` : (tagged ?? err.userMessage);
  await ctx.db
    .update(importJobs)
    .set({ status: willRetry ? 'queued' : 'failed', message, finishedAt: willRetry ? null : ctx.now() })
    .where(eq(importJobs.id, importJob.id));
  if (!willRetry) {
    await notifyProblem(ctx, {
      kind: 'import_failed',
      severity: 'warning',
      title: tagged ? '서식 확인 필요 — 가져오지 못한 파일이 있습니다' : '가져오기 실패 — 파일을 확인하세요',
      body: err.userMessage,
      href: importHref(importJob.id),
      clientId: importJob.clientId,
      dedupeKey: `import_failed:${importJob.id}`,
    });
  }
}

async function processImport(run: JobRunContext, importJob: ImportJobRow, payload: ImportFilePayload): Promise<ImportFileJobResult> {
  const { ctx, progress } = run;
  const clientId = importJob.clientId;
  if (!clientId) {
    throw new ImportRejectedError('IMPORT_CLIENT_REQUIRED', '수임처가 정해지지 않은 가져오기입니다. 가져오기 화면에서 수임처를 선택하세요.', {
      action: { label: '수임처 선택', href: importHref(importJob.id) },
    });
  }
  if (!importJob.fileId) throw new ImportRejectedError('IMPORT_FILE_MISSING', '원본 파일이 보관되어 있지 않습니다. 파일을 다시 올려 주세요.');

  await ctx.db.update(importJobs).set({ status: 'running', message: null }).where(eq(importJobs.id, importJob.id));
  await progress(1, 100);

  const client = await loadClientProfile(ctx, clientId);
  const clientRefs = await loadClientRefs(ctx.db);
  const { data, row: fileRow } = await readStoredFile(ctx, importJob.fileId);
  const fileName = fileRow.originalName;

  // ── 읽기 · 판정 ──
  let preview;
  try {
    preview = await previewImport(data, fileName, { clients: clientRefs, ...(payload.sheetIndex !== undefined ? { sheetIndex: payload.sheetIndex } : {}) });
  } catch (e) {
    throw toAppError(e);
  }
  await progress(8, 100);
  assertNoClientConflict(preview.client, clientId, client.name, payload.allowClientConflict);

  let detection: FormatDetection;
  if (payload.mapping) {
    detection = detectionFromMapping(preview, payload.mapping);
  } else {
    detection = preview.detection;
    if (detection.requiresUserMapping && !detection.userConfirmed) throw new NeedsMappingError(needsMappingMessage(preview));
  }
  if (detection.profile.purpose !== 'transactions') {
    throw new ImportRejectedError('IMPORT_WRONG_PURPOSE', `${detection.profile.name} 파일은 거래로 가져오지 않습니다. WEHAGO 전송센터의 대사 화면에서 올려 주세요.`, {
      action: { label: 'WEHAGO 전송센터', href: '/transfer' },
    });
  }

  // ── 정규화 ──
  let normalized: NormalizeResult;
  try {
    normalized = normalizeRows(detection, preview.rows, {
      clientId,
      businessNumber: client.businessNumber,
      channel: importJob.channel as NormalizedTransaction['channel'],
      clientVatType: client.vatType,
      sheetName: preview.sheetName,
      ...(payload.mapping?.direction ? { direction: payload.mapping.direction } : {}),
      ...(payload.mapping?.evidenceType ? { evidenceType: payload.mapping.evidenceType } : {}),
    });
  } catch (e) {
    throw toAppError(e);
  }
  await progress(20, 100);

  const txs = normalized.transactions;
  const realFailures: RowFailure[] = normalized.failures.filter((f) => f.code !== 'non_data_row');
  const nonData = normalized.failures.filter((f) => f.code === 'non_data_row');

  // 어댑터 계산 확인: 데이터 행 = 거래 + 실패(비거래 포함) + 병합
  const adapterSum = txs.length + normalized.failures.length + normalized.mergedRows.length;
  if (adapterSum !== normalized.stats.dataRows) {
    throw new ImportRejectedError(
      'IMPORT_ROW_ACCOUNTING',
      `원본 데이터 행 ${formatCount(normalized.stats.dataRows)}건과 정규화 결과(거래 ${formatCount(txs.length)} + 실패 ${formatCount(
        normalized.failures.length,
      )} + 병합 ${formatCount(normalized.mergedRows.length)})가 맞지 않아 적재하지 않았습니다. 데이터 유실을 막기 위한 조치입니다 — 관리자에게 문의하세요.`,
    );
  }

  const now = ctx.now();
  const outcome = await ctx.db.transaction(async (tx) => {
    const tctx = withTx(ctx, tx);
    await tx.execute(sql`select pg_advisory_xact_lock(${IMPORT_LOCK_NAMESPACE}::int4, hashtext(${clientId}))`);

    // 재실행 방지: 다른 워커가 이미 적재했다면 그대로 결과만 돌려준다
    const [{ n: already } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(transactionSources)
      .where(eq(transactionSources.importJobId, importJob.id));
    if (already > 0) {
      const [cur] = await tx.select().from(importJobs).where(eq(importJobs.id, importJob.id));
      return { alreadyProcessed: true as const, row: cur! };
    }

    // ── 중복 판정 (파일 날짜 범위 안의 기존 fingerprint 만 조회) ──
    let minDate: string | null = null;
    let maxDate: string | null = null;
    for (const t of txs) {
      if (minDate === null || t.transactionDate < minDate) minDate = t.transactionDate;
      if (maxDate === null || t.transactionDate > maxDate) maxDate = t.transactionDate;
    }
    const existing =
      minDate && maxDate
        ? await tx
            .select({ id: transactions.id, fingerprint: transactions.fingerprint })
            .from(transactions)
            .where(and(eq(transactions.clientId, clientId), between(transactions.transactionDate, minDate, maxDate), ne(transactions.status, 'duplicate')))
        : [];
    const dedupe = detectDuplicates(txs, existing);
    const dupByIndex = new Map<number, DuplicateHit>();
    for (const d of dedupe.duplicates) dupByIndex.set(d.index, d);

    // ── WEHAGO 이중 기장 가드: 다른 채널로 이미 전송된 거래와 일자·사업자번호·금액·과세유형이 같으면 보류 ──
    const exported =
      minDate && maxDate
        ? await tx
            .select({
              id: transactions.id,
              direction: transactions.direction,
              transactionDate: transactions.transactionDate,
              merchantBusinessNumber: transactions.merchantBusinessNumber,
              totalAmount: transactions.totalAmount,
              evidenceType: transactions.evidenceType,
            })
            .from(transactions)
            .where(
              and(
                eq(transactions.clientId, clientId),
                between(transactions.transactionDate, minDate, maxDate),
                isNotNull(transactions.merchantBusinessNumber),
                ne(transactions.channel, importJob.channel),
                or(inArray(transactions.status, ['exported', 'reconciled']), isNotNull(transactions.exportJobId)),
                sql`${transactions.status} not in ('duplicate', 'excluded')`,
              ),
            )
        : [];
    const preConsumed = new Set<string>();
    for (const d of dedupe.duplicates) if (d.duplicateOf.startsWith('existing:')) preConsumed.add(d.duplicateOf.slice('existing:'.length));
    const wehagoMatch = matchWehagoDoubleBooking(
      txs.map((t, index) => ({ index, key: dupByIndex.has(index) ? null : wehagoDuplicateKey(t) })),
      exported.map((e) => ({ id: e.id, key: wehagoDuplicateKey(e) })),
      preConsumed,
    );

    // ── 행 구성 ──
    const ids = txs.map(() => randomUUID());
    const txRows: TxInsert[] = [];
    const sourceRows: SourceInsert[] = [];
    let importedRows = 0;
    let duplicateRows = 0;
    let existingDup = 0;
    let batchDup = 0;
    const periodCounts = new Map<string, number>();
    const importedPeriods = new Set<string>();
    const wehagoFlagged: Array<{ tx: NormalizedTransaction; exportedId: string }> = [];

    txs.forEach((t, i) => {
      const period = t.transactionDate.slice(0, 7);
      periodCounts.set(period, (periodCounts.get(period) ?? 0) + 1);
      const hit = dupByIndex.get(i);
      const wehagoOf = wehagoMatch.get(i);
      let status = 'imported';
      let duplicateOfId: string | null = null;
      let duplicateReason: string | null = null;
      let buckets: TxInsert['buckets'] = [];
      let riskFlags: RiskFlag[] = [];
      if (hit) {
        status = 'duplicate';
        if (hit.duplicateOf.startsWith('existing:')) {
          duplicateOfId = hit.duplicateOf.slice('existing:'.length);
          existingDup++;
        } else {
          duplicateOfId = ids[Number(hit.duplicateOf.slice('batch:'.length))] ?? null;
          batchDup++;
        }
        duplicateReason = hit.reason;
      } else if (wehagoOf) {
        status = 'duplicate';
        duplicateOfId = wehagoOf;
        duplicateReason = WEHAGO_DUPLICATE_REASON;
        buckets = ['duplicate'];
        riskFlags = [
          {
            ruleCode: WEHAGO_DUPLICATE_RULE_CODE,
            ruleName: 'WEHAGO 이중 기장 의심',
            bucket: 'duplicate',
            severity: 'high',
            blocksAutoApproval: true,
            message: `${t.transactionDate} ${t.merchantName} ${formatCount(t.totalAmount)}원 — ${WEHAGO_DUPLICATE_REASON}. 다른 거래라면 중복을 해제하세요.`,
          },
        ];
        wehagoFlagged.push({ tx: t, exportedId: wehagoOf });
      }
      if (status === 'imported') {
        importedRows++;
        importedPeriods.add(period);
      } else duplicateRows++;

      txRows.push({
        id: ids[i],
        clientId,
        businessNumber: t.businessNumber,
        importJobId: importJob.id,
        source: t.source,
        channel: t.channel,
        direction: t.direction,
        period,
        transactionDate: t.transactionDate,
        evidenceType: t.evidenceType,
        merchantName: t.merchantName,
        merchantKey: t.merchantKey,
        merchantBusinessNumber: t.merchantBusinessNumber,
        merchantCategory: t.merchantCategory,
        merchantTaxType: t.merchantTaxType,
        description: t.description,
        supplyAmount: t.supplyAmount,
        vatAmount: t.vatAmount,
        serviceCharge: t.serviceCharge,
        totalAmount: t.totalAmount,
        cardNumberMasked: t.cardNumberMasked,
        approvalNumber: t.approvalNumber,
        invoiceNumber: t.evidenceType === 'tax_invoice' || t.evidenceType === 'invoice_exempt' ? t.approvalNumber : null,
        originalSourceId: t.originalSourceId,
        currency: t.currency,
        isForeign: t.isForeign,
        sourceDeductibleHint: t.sourceDeductibleHint,
        rawData: t.rawData,
        fingerprint: t.fingerprint,
        duplicateOfId,
        duplicateReason,
        buckets,
        riskFlags,
        status,
        touchCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      sourceRows.push({
        importJobId: importJob.id,
        rowNumber: t.sourceRowNumber ?? i + 1,
        rawData: t.rawData,
        outcome: status === 'imported' ? 'ok' : 'duplicate',
        errorReason: duplicateReason,
        errorField: null,
        transactionId: ids[i],
        supplyAmount: t.supplyAmount,
        vatAmount: t.vatAmount,
        totalAmount: t.totalAmount,
        createdAt: now,
      });
    });
    for (const f of realFailures) {
      sourceRows.push({
        importJobId: importJob.id,
        rowNumber: f.sourceRowNumber,
        rawData: f.rawData,
        outcome: 'failed',
        errorReason: f.reason,
        errorField: f.field ?? null,
        transactionId: null,
        supplyAmount: f.amounts?.supplyAmount ?? null,
        vatAmount: f.amounts?.vatAmount ?? null,
        totalAmount: f.amounts?.totalAmount ?? null,
        createdAt: now,
      });
    }

    const counts = { totalRows: txs.length + realFailures.length, importedRows, duplicateRows, failedRows: realFailures.length };
    const violation = checkRowAccounting(counts);
    if (violation || sourceRows.length !== counts.totalRows) {
      throw new ImportRejectedError('IMPORT_ROW_ACCOUNTING', violation ?? `원본 행 기록(${sourceRows.length})과 수집 건수(${counts.totalRows})가 다릅니다. 적재를 취소했습니다.`);
    }

    // ── 청크 적재 ──
    const totalWrites = txRows.length + sourceRows.length;
    let written = 0;
    const report = async () => progress(20 + Math.floor((75 * written) / Math.max(1, totalWrites)), 100);
    for (const part of chunk(txRows, TX_CHUNK)) {
      await tx.insert(transactions).values(part);
      written += part.length;
      await report();
    }
    for (const part of chunk(sourceRows, SOURCE_CHUNK)) {
      await tx.insert(transactionSources).values(part);
      written += part.length;
      await report();
    }

    // ── 기간 · 안내 ──
    const requested = importJob.period ?? payload.period ?? null;
    const period = chooseImportPeriod(periodCounts, requested);
    const notes: string[] = [];
    if (txs.length + realFailures.length === 0) notes.push('거래 행이 0건입니다. 조회 기간과 파일을 확인하세요.');
    if (nonData.length > 0) {
      const rows = nonData.slice(0, 5).map((f) => f.sourceRowNumber).join(', ');
      notes.push(`합계·제목·안내 행 ${formatCount(nonData.length)}건은 거래가 아니어서 건수에서 제외했습니다 (${rows}${nonData.length > 5 ? ' …' : ''}행).`);
    }
    if (normalized.mergedRows.length > 0) notes.push(`세금계산서 품목 행 ${formatCount(normalized.mergedRows.length)}건은 같은 승인번호 거래에 합쳤습니다.`);
    if (existingDup > 0) notes.push(`이미 등록된 거래와 같은 ${formatCount(existingDup)}건은 중복으로 보관했습니다 (삭제하지 않음).`);
    if (batchDup > 0) notes.push(`파일 안에서 반복된 ${formatCount(batchDup)}건은 중복으로 보관했습니다.`);
    if (wehagoFlagged.length > 0) {
      notes.push(`WEHAGO 이중 기장 의심 ${formatCount(wehagoFlagged.length)}건은 중복으로 보류했습니다 — ${WEHAGO_DUPLICATE_REASON}. 다른 거래라면 중복을 해제하세요.`);
    }
    if (requested) {
      const outside = [...periodCounts.entries()].filter(([p]) => p !== requested);
      if (outside.length > 0) {
        const n = outside.reduce((s, [, c]) => s + c, 0);
        notes.push(`선택한 기간(${requested}) 밖의 거래 ${formatCount(n)}건은 거래일자 기준 기간(${outside.map(([p]) => p).join(', ')})으로 넣었습니다.`);
      }
    } else if (periodCounts.size > 1) {
      notes.push(`여러 달 거래가 섞여 있습니다: ${[...periodCounts.entries()].sort().map(([p, c]) => `${p} ${formatCount(c)}건`).join(', ')} — 거래일자 기준 기간으로 나눠 넣었습니다.`);
    }
    // 파일 단위 안내(다른 시트에 거래자료가 더 있음, 확장자와 실제 형식 불일치 등) + 행 경고 요약
    notes.push(...preview.file.warnings);
    notes.push(...summarizeWarnings(normalized.warnings));

    const status = counts.failedRows > 0 ? 'partial' : 'succeeded';
    const summary = buildImportSummary(counts, status);
    await tx
      .update(importJobs)
      .set({
        status,
        formatProfile: detection.profile.id,
        source: detection.profile.source,
        period,
        totalRows: counts.totalRows,
        importedRows: counts.importedRows,
        duplicateRows: counts.duplicateRows,
        failedRows: counts.failedRows,
        sourceSupplyAmount: normalized.sourceTotals.supplyAmount,
        sourceVatAmount: normalized.sourceTotals.vatAmount,
        sourceTotalAmount: normalized.sourceTotals.totalAmount,
        message: notes.length > 0 ? notes.join('\n') : null,
        finishedAt: ctx.now(),
      })
      .where(eq(importJobs.id, importJob.id));

    // ── 다음 단계: 분류 ──
    const classifyJobIds: string[] = [];
    for (const p of [...importedPeriods].sort()) {
      classifyJobIds.push(
        await enqueueJob(tx as unknown as Database, 'classify_batch', { clientId, period: p, importJobId: importJob.id }, {
          parentJobId: run.job.id,
          createdBy: importJob.createdBy,
        }),
      );
    }

    await writeAudit(tctx, {
      action: 'import.process',
      category: 'data_change',
      entityType: 'import_job',
      entityId: importJob.id,
      clientId,
      summary: `${client.name} · ${fileName}: ${summary}${wehagoFlagged.length > 0 ? ` · WEHAGO 이중 기장 의심 ${formatCount(wehagoFlagged.length)}건 보류` : ''}`,
      before: { status: importJob.status },
      after: {
        status,
        ...counts,
        wehagoDuplicateRows: wehagoFlagged.length,
        nonDataRows: nonData.length,
        mergedRows: normalized.mergedRows.length,
        sourceTotals: normalized.sourceTotals,
        period,
        formatProfile: detection.profile.id,
        classifyJobIds,
      },
    });

    // ── 문제 알림만 ──
    if (counts.failedRows > 0) {
      await notifyProblem(tctx, {
        kind: 'import_failed',
        severity: 'warning',
        title: failureNotificationTitle(counts.failedRows),
        body: `${client.name} · ${fileName} — ${summary}`,
        href: importHref(importJob.id),
        clientId,
        dedupeKey: `import_failed:${importJob.id}`,
      });
    } else {
      await resolveProblem(tctx, `import_failed:${importJob.id}`);
    }
    if (wehagoFlagged.length > 0) {
      await notifyProblem(tctx, {
        kind: 'import_failed',
        severity: 'warning',
        title: `WEHAGO 이중 기장 의심 ${formatCount(wehagoFlagged.length)}건 — 중복으로 보류했습니다`,
        body: `${client.name} · ${fileName}: 이미 WEHAGO에 전송된 거래와 일자·사업자번호·금액·과세유형이 같습니다. 다른 거래라면 중복을 해제하세요.`,
        href: `${importHref(importJob.id)}?filter=wehago_duplicate`,
        clientId,
        dedupeKey: `import_wehago_dup:${importJob.id}`,
      });
    }

    return {
      alreadyProcessed: false as const,
      result: {
        importJobId: importJob.id,
        clientId,
        ...counts,
        wehagoDuplicateRows: wehagoFlagged.length,
        nonDataRows: nonData.length,
        mergedRows: normalized.mergedRows.length,
        periods: [...periodCounts.keys()].sort(),
        classifyJobIds,
        summary,
        alreadyProcessed: false,
      } satisfies ImportFileJobResult,
    };
  });

  await progress(100, 100);
  if (outcome.alreadyProcessed) return resultFromRow(outcome.row, true);
  return outcome.result;
}
