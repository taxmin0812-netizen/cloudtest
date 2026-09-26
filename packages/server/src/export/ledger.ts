/**
 * WEHAGO 매입매출장 역수입 → 전송 후 대사 (post_export).
 *
 * 흐름: 파일 저장(암호화, purpose wehago_reimport) → adapters 대사용 프로필로 읽기 → 거래처코드 학습
 *      → 최신 업로드 전송파일과 비교 → 일치: 거래 reconciled / 불일치: recon_mismatch 알림(설명 포함)
 */
import { and, eq, sql } from 'drizzle-orm';
import { formatWon } from '@mintax/core';
import { clients, exportJobs } from '@mintax/db';
import { ValidationError } from '@mintax/security';
import { requirePermission, withTx, type ServiceContext } from '../context';
import { writeAudit } from '../infra/audit';
import { loadClientProfile } from '../infra/clients';
import { notifyProblem } from '../infra/notify';
import { storeFile } from '../infra/storage';
import { parseWehagoLedger } from '../reconciliation/ledger';
import { applyPostExportOutcome, executeReconciliation, latestTakenExport, lockClientPeriod } from '../reconciliation/run';
import { assertPeriod, assertUuid, transferHref } from './helpers';
import { learnPartnerCodes } from './partner-codes';
import type { LedgerImportResult } from './types';

const MAX_LEDGER_BYTES = 50 * 1024 * 1024;

export async function importWehagoLedger(ctx: ServiceContext, input: { clientId: string; period: string; fileName: string; data: Buffer }): Promise<LedgerImportResult> {
  requirePermission(ctx, 'export.create');
  const clientId = assertUuid(input.clientId, 'clientId', '거래처');
  const period = assertPeriod(input.period);
  if (!Buffer.isBuffer(input.data) || input.data.length === 0) {
    throw new ValidationError('WEHAGO 매입매출장 파일이 비어 있습니다. WEHAGO [매입매출장]에서 "엑셀 변환"한 파일을 올려주세요.', [{ field: 'data', message: '필수' }]);
  }
  if (input.data.length > MAX_LEDGER_BYTES) {
    throw new ValidationError('파일이 너무 큽니다(50MB 초과). 기간을 한 달로 줄여 변환해 주세요.', [{ field: 'data', message: '50MB 이하' }]);
  }
  const fileName = (input.fileName || 'wehago_ledger.xlsx').slice(0, 200);
  const client = await loadClientProfile(ctx, clientId);
  const refs = await ctx.db.select({ id: clients.id, businessNumber: clients.businessNumber, name: clients.name }).from(clients).where(eq(clients.active, true));
  // 읽기 실패(형식 불일치·다른 수임처 자료)는 저장·대사 전에 사용자 오류로 돌려준다
  const ledger = await parseWehagoLedger(input.data, fileName, { id: clientId, businessNumber: client.businessNumber }, period, refs);

  return ctx.db.transaction(async (tx) => {
    const tctx = withTx(ctx, tx);
    await lockClientPeriod(tctx, clientId, period);
    const file = await storeFile(tctx, { data: input.data, originalName: fileName, purpose: 'wehago_reimport', clientId, mimeType: null });
    const learned = await learnPartnerCodes(
      tctx,
      clientId,
      ledger.rows.map((r) => ({ code: r.counterpartyCode, businessNumber: r.businessNumber, merchantName: r.merchantName })),
    );
    const target = await latestTakenExport(tctx, clientId, period);
    const rec = await executeReconciliation(tctx, {
      clientId,
      period,
      phase: 'post_export',
      mode: target ? 'file' : 'verify',
      exportJobIds: target ? [target.id] : undefined,
      exportJobId: target?.id ?? null,
      scopeKind: 'wehago_purchase_sales',
      wehago: { rows: ledger.rows, fileId: file.id, fileName, failures: ledger.failures, outOfPeriod: ledger.outOfPeriod },
    });
    const outcome = await applyPostExportOutcome(tctx, rec, { clientId, clientName: client.name, period, exportJobId: target?.id ?? null });
    // 받지도 않은 전송파일이 있는데 WEHAGO 에 이미 같은 전표가 모두 있다 → 그 파일을 올리면 이중 기장
    let doubleBookingWarning: string | null = null;
    if (!target && outcome.matched) {
      const [pending] = await tx
        .select({ id: exportJobs.id, rowCount: exportJobs.rowCount, totalAmount: exportJobs.totalAmount })
        .from(exportJobs)
        .where(and(eq(exportJobs.clientId, clientId), eq(exportJobs.period, period), eq(exportJobs.status, 'ready'), sql`not (${exportJobs.validation} ? 'supersededBy')`))
        .limit(1);
      if (pending) {
        doubleBookingWarning = `WEHAGO에 이미 이 기간 전표가 모두 있습니다 — 준비된 전송파일(${pending.rowCount}건 · ${formatWon(pending.totalAmount)})을 올리면 이중 기장됩니다. WEHAGO 자동수집 여부와 수임처 전송 범위를 확인하세요.`;
        await notifyProblem(tctx, {
          kind: 'export_error',
          severity: 'high',
          title: `${client.name} ${period} 이중 기장 위험: WEHAGO에 이미 반영된 전표`,
          body: doubleBookingWarning,
          href: transferHref(clientId, period),
          clientId,
          dedupeKey: `double_booking:${clientId}:${period}`,
        });
      }
    }
    const wTotals = rec.result.stages.wehago;
    const mism = rec.discrepancies.filter((d) => d.blocking && d.kind !== 'pending_review').length;
    const summary0 = outcome.matched
      ? `${client.name} ${period} WEHAGO 반영 확인: 매입매출장 ${wTotals?.count ?? 0}건 · 합계 ${formatWon(wTotals?.totalAmount ?? 0)} — 전송파일과 1원 단위까지 일치 (거래 ${outcome.transactionsReconciled}건 대사완료)`
      : `${client.name} ${period} WEHAGO 대사 불일치 ${mism}건 — ${rec.meta.stageLine}`;
    const summary = doubleBookingWarning ? `${summary0} ${doubleBookingWarning}` : summary0;
    await writeAudit(tctx, {
      action: 'reconciliation.wehago_import',
      category: 'data_change',
      entityType: 'reconciliation_job',
      entityId: rec.id,
      clientId,
      summary,
      before: null,
      after: {
        fileId: file.id,
        fileName,
        rows: ledger.rows.length,
        failures: ledger.failures.length,
        outOfPeriod: ledger.outOfPeriod,
        matched: outcome.matched,
        transactionsReconciled: outcome.transactionsReconciled,
        uploadInferred: outcome.uploadInferred,
        templateVerified: outcome.templateVerified,
        learnedPartnerCodes: learned,
        doubleBookingWarning,
      },
    });
    return {
      reconciliationId: rec.id,
      matched: outcome.matched,
      transactionsReconciled: outcome.transactionsReconciled,
      exportJobId: target?.id ?? null,
      ledger: {
        fileId: file.id,
        fileName,
        rows: ledger.rows.length,
        failures: ledger.failures,
        outOfPeriod: ledger.outOfPeriod,
        excludedByScope: rec.meta.wehago?.excludedByScope ?? 0,
        learnedPartnerCodes: learned,
      },
      doubleBookingWarning,
      summary,
    };
  });
}
