import type { GoldenExpected } from './index';

/**
 * 골든 데이터셋 고정 기대값 (seed 20260926, 2026-09, 1,000건, GOLDEN_SPEC v2) — 정답(truth)에서 계산해 고정한 값.
 * 생성기를 의도적으로 바꿨다면 buildGoldenDataset() 결과의 expected / checksum 으로 이 파일을 갱신한다.
 */
export const GOLDEN_EXPECTED: GoldenExpected = {
  size: 1_000,
  byDirection: { purchase: 806, sales: 194 },
  byEvidence: { 'purchase:card': 732, 'purchase:cash_receipt': 19, 'purchase:invoice_exempt': 7, 'purchase:tax_invoice': 48, 'sales:card': 157, 'sales:cash_receipt': 18, 'sales:invoice_exempt': 1, 'sales:tax_invoice': 18 },
  byClient: { C001: 114, C002: 115, C003: 57, C004: 47, C005: 80, C006: 29, C007: 24, C008: 37, C009: 48, C010: 11, C011: 40, C012: 33, C013: 57, C014: 27, C015: 60, C016: 34, C017: 28, C018: 20, C019: 28, C020: 24, C021: 19, C022: 24, C023: 27, C024: 17 },
  byAccount: { '134': 2, '146': 37, '153': 90, '212': 6, '338': 3, '401': 190, '404': 3, '811': 333, '812': 11, '813': 11, '814': 5, '815': 3, '816': 1, '819': 7, '820': 1, '822': 44, '824': 36, '826': 25, '828': 2, '829': 12, '830': 143, '831': 28, '833': 5, '837': 1, '904': 1 },
  purchaseVat: { deductible: 671, nonDeductible: 135 },
  byVatType: { purchase_card: 607, purchase_card_exempt: 41, purchase_cash_receipt: 17, purchase_exempt: 7, purchase_no_evidence: 86, purchase_non_deductible: 1, purchase_taxable: 47, sales_card: 157, sales_cash_receipt: 18, sales_exempt: 1, sales_taxable: 18 },
  nonDeductibleByReason: { 'VAT-BIZ-01': 5, 'VAT-CAR-01': 11, 'VAT-CARD-03': 2, 'VAT-ENT-01': 11, 'VAT-EXM-01': 34, '없음': 72 },
  byAnomaly: { account_spike: 6, asset_purchase: 3, cancel_negative: 3, correction_target: 4, entertainment: 5, foreign_saas: 4, new_merchant_high_amount: 2, personal_use: 5, possible_duplicate: 4, treatment_changed: 1, unclassifiable_merchant: 6, vat_mismatch: 4 },
  anomalyTransactions: 47,
  scenarioTransactions: 30,
  totals: { supplyAmount: 314_933_334, vatAmount: 28_758_184, totalAmount: 343_811_518 },
};

export const GOLDEN_CHECKSUM = 'c37c61414eb4e26ee35fbf0108ebae6281fb6155a1e807779967519087100e63';
