/**
 * 대사 입력 적재 — transaction_sources · transactions · export_items → core reconcile() 입력.
 *
 * 대사 범위 (docs/03 §8.1):
 * - 수임처 × 기간. 원본 행은 연결 거래의 period 로 나눈다. 거래가 없는 실패 행은 import_jobs.period,
 *   그것도 없으면 그 가져오기가 걸친 모든 기간에 넣는다(한 기간에서도 빠지지 않게 — 차단 쪽이 안전).
 * - 수임처 전송 범위가 wehago_collects 인 증빙유형은 뺀다 (전송하지 않는 원천).
 * - scopeKind 가 있으면 다른 전표 종류로 가는 승인 거래와 그 원본 행을 함께 뺀다 (양변에서 같이 빠지므로 등식 유지).
 */
import { sql } from 'drizzle-orm';
import type { ReconExportRow, ReconSourceRow, ReconTransaction } from '@mintax/core/engine/vat-risk-index';
import type { TransactionStatus } from '@mintax/core';
import type { WehagoTemplate } from '@mintax/adapters';
import type { DbOrTx } from '@mintax/db';
import { APPROVED_STATUSES, routeForExport } from '../export/helpers';
import type { WehagoExportKind } from '../export/types';

export interface ReconLoadOptions {
  clientId: string;
  period: string;
  excludedEvidenceTypes: readonly string[];
  scopeKind: WehagoExportKind | null;
  /** scopeKind 경로 판정용 매입매출 서식 */
  psTemplate: WehagoTemplate;
  /** 파일 모드: 이 전송파일들의 export_items. null = 전송 전(ready) */
  exportJobIds: readonly string[] | null;
}

export interface LoadedReconInput {
  sourceRows: ReconSourceRow[];
  transactions: ReconTransaction[];
  exportRows: ReconExportRow[] | undefined;
  meta: {
    importJobCount: number;
    excludedByScope: number;
    excludedOtherKind: number;
    unroutable: number;
  };
}

const APPROVED = new Set<string>(APPROVED_STATUSES);

interface TxRow {
  id: string;
  status: string;
  evidence_type: string;
  account_code: string | null;
  account_name: string | null;
  supply_amount: number;
  vat_amount: number;
  total_amount: number;
  transaction_date: string;
  merchant_name: string;
  duplicate_reason: string | null;
  excluded_reason: string | null;
  direction: 'purchase' | 'sales';
  vat_type: string | null;
  deductible: boolean | null;
  [k: string]: unknown;
}

interface SourceRow {
  row_number: number;
  outcome: 'ok' | 'duplicate' | 'failed';
  transaction_id: string | null;
  supply_amount: number | null;
  vat_amount: number | null;
  total_amount: number | null;
  error_reason: string | null;
  import_job_id: string;
  file_name: string | null;
  [k: string]: unknown;
}

export async function loadReconInput(db: DbOrTx, o: ReconLoadOptions): Promise<LoadedReconInput> {
  const txRes = await db.execute<TxRow>(sql`
    select id, status, evidence_type, account_code, account_name, supply_amount, vat_amount, total_amount,
           transaction_date, merchant_name, duplicate_reason, excluded_reason, direction, vat_type, deductible
    from transactions
    where client_id = ${o.clientId} and period = ${o.period}
    order by transaction_date, id
  `);
  const excluded = new Set(o.excludedEvidenceTypes);
  const dropped = new Set<string>();
  let excludedByScope = 0;
  let excludedOtherKind = 0;
  let unroutable = 0;
  const txs: ReconTransaction[] = [];
  for (const t of txRes.rows) {
    if (excluded.has(t.evidence_type)) {
      dropped.add(t.id);
      excludedByScope++;
      continue;
    }
    if (o.scopeKind && APPROVED.has(t.status)) {
      const r = routeForExport(
        { direction: t.direction, evidenceType: t.evidence_type, vatType: t.vat_type, deductible: t.deductible, vatAmount: Number(t.vat_amount) },
        o.psTemplate,
      );
      if (r.route === 'unroutable') unroutable++;
      else if (r.route !== o.scopeKind) {
        dropped.add(t.id);
        excludedOtherKind++;
        continue;
      }
    }
    txs.push({
      id: t.id,
      status: t.status as TransactionStatus,
      evidenceType: t.evidence_type,
      accountCode: t.account_code,
      accountName: t.account_name,
      supplyAmount: Number(t.supply_amount),
      vatAmount: Number(t.vat_amount),
      totalAmount: Number(t.total_amount),
      transactionDate: t.transaction_date,
      merchantName: t.merchant_name,
      duplicateReason: t.duplicate_reason,
      excludedReason: t.excluded_reason,
    });
  }

  const srcRes = await db.execute<SourceRow>(sql`
    select ts.row_number, ts.outcome, ts.transaction_id, ts.supply_amount, ts.vat_amount, ts.total_amount, ts.error_reason,
           ts.import_job_id, f.original_name as file_name
    from transaction_sources ts
    join import_jobs ij on ij.id = ts.import_job_id
    left join files f on f.id = ij.file_id
    left join transactions t on t.id = ts.transaction_id
    where ij.client_id = ${o.clientId}
      and (
        (t.id is not null and t.client_id = ${o.clientId} and t.period = ${o.period})
        or (t.id is null and (
              ij.period = ${o.period}
              or (ij.period is null and exists (select 1 from transactions t2 where t2.import_job_id = ij.id and t2.period = ${o.period}))
           ))
      )
    order by ij.created_at, ij.id, ts.row_number
  `);
  const importJobs = new Set(srcRes.rows.map((r) => r.import_job_id));
  const multiFile = importJobs.size > 1;
  const sourceRows: ReconSourceRow[] = [];
  for (const r of srcRes.rows) {
    if (r.transaction_id && dropped.has(r.transaction_id)) continue;
    const reason = r.error_reason && multiFile && r.outcome === 'failed' && r.file_name ? `(${r.file_name}) ${r.error_reason}` : r.error_reason;
    sourceRows.push({
      rowNumber: r.row_number,
      outcome: r.outcome,
      transactionId: r.transaction_id,
      supplyAmount: r.supply_amount === null ? null : Number(r.supply_amount),
      vatAmount: r.vat_amount === null ? null : Number(r.vat_amount),
      totalAmount: r.total_amount === null ? null : Number(r.total_amount),
      errorReason: reason,
    });
  }

  let exportRows: ReconExportRow[] | undefined;
  if (o.exportJobIds) {
    exportRows = [];
    if (o.exportJobIds.length > 0) {
      const exRes = await db.execute<{ transaction_id: string | null; supply_amount: number; vat_amount: number; total_amount: number; account_code: string | null; row_number: number; [k: string]: unknown }>(sql`
        select ei.transaction_id, ei.supply_amount, ei.vat_amount, ei.total_amount, ei.account_code, ei.row_number
        from export_items ei
        where ei.export_job_id = any(${sql.param([...o.exportJobIds])}::uuid[])
        order by ei.export_job_id, ei.row_number
      `);
      for (const r of exRes.rows) {
        if (r.transaction_id && dropped.has(r.transaction_id)) continue;
        exportRows.push({
          transactionId: r.transaction_id,
          supplyAmount: Number(r.supply_amount),
          vatAmount: Number(r.vat_amount),
          totalAmount: Number(r.total_amount),
          accountCode: r.account_code,
          rowNumber: r.row_number,
        });
      }
    }
  }

  return { sourceRows, transactions: txs, exportRows, meta: { importJobCount: importJobs.size, excludedByScope, excludedOtherKind, unroutable } };
}
