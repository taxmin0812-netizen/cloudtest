import type { GoldenExpected } from './index';

/**
 * 골든 데이터셋 고정 기대값 (seed 20260926, 2026-09, 1,000건) — 정답(truth)에서 계산해 고정한 값.
 * 생성기를 의도적으로 바꿨다면 buildGoldenDataset() 결과의 expected / checksum 으로 이 파일을 갱신한다.
 */
export const GOLDEN_EXPECTED: GoldenExpected = {
  size: 1_000,
  byDirection: { purchase: 804, sales: 196 },
  byEvidence: { 'purchase:card': 730, 'purchase:cash_receipt': 18, 'purchase:invoice_exempt': 7, 'purchase:tax_invoice': 49, 'sales:card': 159, 'sales:cash_receipt': 18, 'sales:invoice_exempt': 1, 'sales:tax_invoice': 18 },
  byClient: { C001: 113, C002: 116, C003: 56, C004: 47, C005: 79, C006: 29, C007: 24, C008: 37, C009: 49, C010: 11, C011: 40, C012: 33, C013: 56, C014: 27, C015: 59, C016: 35, C017: 28, C018: 20, C019: 29, C020: 24, C021: 19, C022: 24, C023: 27, C024: 18 },
  byAccount: { '134': 2, '146': 35, '153': 89, '212': 6, '338': 3, '401': 192, '404': 3, '811': 333, '812': 10, '813': 11, '814': 6, '815': 3, '816': 1, '819': 7, '820': 1, '822': 46, '824': 36, '826': 24, '828': 2, '829': 12, '830': 141, '831': 30, '833': 5, '837': 1, '904': 1 },
  purchaseVat: { deductible: 672, nonDeductible: 132 },
  byVatType: { purchase_card: 607, purchase_card_exempt: 40, purchase_cash_receipt: 17, purchase_exempt: 7, purchase_no_evidence: 84, purchase_non_deductible: 1, purchase_taxable: 48, sales_card: 159, sales_cash_receipt: 18, sales_exempt: 1, sales_taxable: 18 },
  nonDeductibleByReason: { 'VAT-BIZ-01': 5, 'VAT-CAR-01': 11, 'VAT-CARD-03': 2, 'VAT-ENT-01': 11, 'VAT-EXM-01': 34, '없음': 69 },
  byAnomaly: { account_spike: 6, asset_purchase: 3, cancel_negative: 3, correction_target: 4, entertainment: 5, foreign_saas: 4, new_merchant_high_amount: 2, personal_use: 5, possible_duplicate: 4, treatment_changed: 1, unclassifiable_merchant: 6, vat_mismatch: 4 },
  anomalyTransactions: 47,
  scenarioTransactions: 30,
  totals: { supplyAmount: 314_450_011, vatAmount: 28_772_654, totalAmount: 343_342_665 },
};

export const GOLDEN_CHECKSUM = '2757999bd646d182ca8377d7b2eec415ec5551a5c96077b6b62520572d87b8d4';
