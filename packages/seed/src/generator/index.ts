import { ANOMALY_KINDS, buildManifest, injectAnomalies } from './anomalies';
import { checksumOf } from './canonical';
import { generateClients } from './clients';
import { generateCustomers, generateMerchants } from './merchants';
import { PAYROLL_SCENARIO_NAMES, generatePayroll } from './payroll';
import { CURRENT_MONTH, HISTORY_MONTHS, createTxContext, generateTransactions } from './transactions';
import type { AnomalyKind, DatasetStats, SyntheticDataset, SyntheticTransaction } from './types';

/**
 * MIN TAX OPS 합성 데이터셋 (실데이터 없음, 결정적).
 *
 *   const ds = generateDataset();            // seed 20260926
 *   ds.history   — 2026-03~08 확정 거래 (정답 = truth)
 *   ds.current   — 2026-09 미분류 원천자료 (+ 의도적 이상치)
 *   ds.failures  — 2026-09 정규화 실패로 남아야 할 원본 행
 *   ds.payroll   — 직원·급여 이력·9월 제출분·기대 변동
 *   ds.anomalies — 이상치 매니페스트 (ANOMALY_SPECS 건수와 일치)
 *
 * 같은 seed → 같은 출력 (datasetChecksum 이 같음). UUID 는 만들지 않는다 — 코드로 참조하고 로더가 매핑한다.
 */

export const DEFAULT_SEED = 20260926;

export interface GenerateOptions {
  seed?: number;
}

export function generateDataset(opts: GenerateOptions = {}): SyntheticDataset {
  const seed = opts.seed ?? DEFAULT_SEED;
  const usedBusinessNumbers = new Set<string>();
  // 시나리오 2 고정 이름은 다른 사람에게 배정되지 않도록 먼저 예약
  const usedNames = new Set<string>([PAYROLL_SCENARIO_NAMES.raised, PAYROLL_SCENARIO_NAMES.missing]);

  const clients = generateClients(seed, usedBusinessNumbers, usedNames);
  const merchants = generateMerchants(seed, usedBusinessNumbers, usedNames);
  const customers = generateCustomers(seed, usedBusinessNumbers, usedNames);

  const ctx = createTxContext(seed, clients, merchants, customers);
  const { history, currentBase } = generateTransactions(ctx);
  const injection = injectAnomalies(ctx, currentBase, usedBusinessNumbers, usedNames);

  // 당월: 거래처 순서대로 기본 거래 → 이상치 거래
  const byClient = new Map<string, SyntheticTransaction[]>(clients.map((c) => [c.code, []]));
  for (const t of [...currentBase, ...injection.added]) byClient.get(t.clientCode)!.push(t);
  const current = clients.flatMap((c) => byClient.get(c.code)!);

  const payroll = generatePayroll(seed, clients, usedNames);
  const anomalies = buildManifest(current, injection.failures, injection.ledgerAnomalies);

  const ds: Omit<SyntheticDataset, 'stats'> = {
    seed,
    historyMonths: [...HISTORY_MONTHS],
    currentMonth: CURRENT_MONTH,
    clients,
    merchants,
    customers,
    history,
    current,
    failures: injection.failures,
    payroll,
    anomalies,
    ledgerAnomalies: injection.ledgerAnomalies,
  };
  return { ...ds, stats: computeStats(ds) };
}

function countBy<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function computeStats(ds: Omit<SyntheticDataset, 'stats'>): DatasetStats {
  const anomalyCounts = Object.fromEntries(ANOMALY_KINDS.map((k) => [k, ds.anomalies.counts[k] ?? 0])) as Record<AnomalyKind, number>;
  return {
    clients: ds.clients.length,
    merchants: ds.merchants.length,
    customers: ds.customers.length,
    historyTransactions: ds.history.length,
    currentTransactions: ds.current.length,
    failureRows: ds.failures.length,
    historyByMonth: countBy(ds.history, (t) => t.period),
    currentByEvidence: countBy(ds.current, (t) => `${t.direction}:${t.evidenceType}`),
    currentByClient: countBy(ds.current, (t) => t.clientCode),
    cardPurchasesByClientCurrent: countBy(
      ds.current.filter((t) => t.direction === 'purchase' && t.evidenceType === 'card' && t.channel !== 'desktop_bridge'),
      (t) => t.clientCode,
    ),
    employees: ds.payroll.employees.length,
    payrollHistoryLines: ds.payroll.history.length,
    payrollCurrentLines: ds.payroll.current.length,
    anomalies: anomalyCounts,
  };
}

/** 데이터셋 전체 체크섬 — sha256Hex(canonical JSON) */
export function datasetChecksum(ds: SyntheticDataset): string {
  return checksumOf(ds);
}

export * from './types';
export { ANOMALY_KINDS, ANOMALY_SPECS, EXPECTED_BUCKETS_BY_ANOMALY, buildManifest } from './anomalies';
export { canonicalJson, checksumOf } from './canonical';
export { CLIENT_SPECS, SCENARIO_A_CODE, SCENARIO_PAYROLL_CODE, SPIKE_CLIENT_CODE } from './clients';
export {
  ACCOUNT_MAPPING_EXAMPLES,
  ASSET_THRESHOLD,
  MERCHANT_SPECS,
  SYNTHETIC_USD_KRW,
  truthAccountFor,
} from './merchants';
export {
  CAR_ALLOWANCE_NONTAXABLE,
  DEFAULT_BUSINESS_INCOME_CODE,
  MEAL_ALLOWANCE_NONTAXABLE,
  PAYROLL_PLANS,
  PAYROLL_SCENARIO_NAMES,
  businessIncomeTax,
  dailyIncomeTax,
  localIncomeTaxOf,
  syntheticEarnedIncomeTax,
} from './payroll';
export {
  CURRENT_MONTH,
  HISTORY_MONTHS,
  SCENARIO1_CARD_COUNT,
  SCENARIO_A_BASE_CARD_COUNT,
  SPIKE_PLAN,
  toHistoryEntry,
  toNormalizedTransaction,
} from './transactions';
export { ACCOUNT_NAMES, accountNameOf, purchaseVatTypeOf, vatTruthFor } from './truth';
export { isSyntheticBusinessNumber, isSyntheticResidentNumber } from './ids';
export {
  FILE_KINDS,
  buildAllFiles,
  buildCardPurchaseFile,
  buildCashReceiptFile,
  buildClientFiles,
  buildExemptInvoiceFile,
  buildResendFile,
  buildSourceFile,
  buildTaxInvoiceFile,
  fileKindOf,
  type SyntheticFile,
} from './files';
export {
  CARD_SALES_HEADERS,
  CASH_RECEIPT_SALES_HEADERS,
  FILE_LAYOUTS,
  HOMETAX_CARD_HEADERS,
  HOMETAX_CASH_RECEIPT_HEADERS,
  HOMETAX_INVOICE_EXEMPT_HEADERS,
  HOMETAX_TAX_INVOICE_HEADERS,
  WEMEMBERS_CARD_VARIANT_HEADERS,
} from './layouts';
