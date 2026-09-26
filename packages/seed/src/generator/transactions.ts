import {
  computeFingerprint,
  formatBusinessNumber,
  normalizeMerchantName,
  splitVatInclusive,
  vatOf,
  weekdayOf,
  type EvidenceType,
  type IndustryKey,
  type IngestChannel,
  type LocalDate,
  type NormalizedTransaction,
  type HistoryEntry,
  type TransactionSource,
  type TransactionStatus,
  type Won,
  type YearMonth,
} from '@mintax/core';
import { SCENARIO_A_CODE, SCENARIO_PAYROLL_CODE, SPIKE_CLIENT_CODE, clientSpecOf, type ClientSpec } from './clients';
import { makeCardApproval, makeCashReceiptApproval, makeInvoiceApproval, makeMaskedCard } from './ids';
import {
  cardPurchaseRaw,
  cardSalesRaw,
  cashReceiptPurchaseRaw,
  cashReceiptSalesRaw,
  deductibleLabel,
  exemptInvoiceRaw,
  merchantTypeLabel,
  taxInvoiceRaw,
  type PartyInfo,
} from './layouts';
import { RESERVED_MERCHANT_NAMES, SYNTHETIC_USD_KRW, VAT_ON_SLIP_SIMPLIFIED_NAMES, truthAccountFor } from './merchants';
import { Rng, rngFor } from './prng';
import { accountNameOf, hometaxDeductibleHint, vatTruthFor } from './truth';
import type {
  AnomalyKind,
  EvidenceKind,
  GroundTruth,
  MerchantKind,
  SyntheticCard,
  SyntheticClient,
  SyntheticCustomer,
  SyntheticMerchant,
  SyntheticTransaction,
} from './types';

/**
 * 거래 생성 — 수임처별 2026-03~08 확정 이력 + 2026-09 당월 원천자료(미분류).
 *
 * - 이력: status 'exported'(03~07) / 'approved'(08), 정답 = 확정 계정·부가세.
 * - 당월: status 'imported', rawData 에 원본 행(헤더→값), 채널 'hometax_file'.
 * - 정답 계정은 merchants.truthAccountFor(가맹점 종류 × 업종 × 금액), 부가세는 truth.vatTruthFor.
 * - fingerprint 는 clientId 자리에 거래처 코드를 넣어 계산한 값 — 로더는 toNormalizedTransaction() 으로 재계산한다.
 */

export const HISTORY_MONTHS: readonly YearMonth[] = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
export const CURRENT_MONTH: YearMonth = '2026-09';

/** 2026-09 A거래처 기본 카드 건수 (이상치 제외) */
export const SCENARIO_A_BASE_CARD_COUNT = 490;
/** 2026-09 시나리오상사 카드 건수 (docs/06-mvp-plan.md 시나리오 1) */
export const SCENARIO1_CARD_COUNT = 500;

// ────────────────────────────── 컨텍스트 ──────────────────────────────

export interface TxContext {
  seed: number;
  clients: SyntheticClient[];
  merchants: SyntheticMerchant[];
  customers: SyntheticCustomer[];
  merchantByName: Map<string, SyntheticMerchant>;
  /** 거래처별 사용한 카드·현금영수증 승인번호 */
  approvals: Map<string, Set<string>>;
  invoiceApprovals: Set<string>;
  usedCustomerCards: Set<string>;
}

export function createTxContext(seed: number, clients: SyntheticClient[], merchants: SyntheticMerchant[], customers: SyntheticCustomer[]): TxContext {
  return {
    seed,
    clients,
    merchants,
    customers,
    merchantByName: new Map(merchants.map((m) => [m.name, m])),
    approvals: new Map(clients.map((c) => [c.code, new Set<string>()])),
    invoiceApprovals: new Set<string>(),
    usedCustomerCards: new Set<string>(),
  };
}

export function merchantNamed(ctx: TxContext, name: string): SyntheticMerchant {
  const m = ctx.merchantByName.get(name);
  if (!m) throw new Error(`가맹점 우주에 없는 이름: ${name}`);
  return m;
}

function approvalsOf(ctx: TxContext, code: string): Set<string> {
  const s = ctx.approvals.get(code);
  if (!s) throw new Error(`거래처 승인번호 집합 없음: ${code}`);
  return s;
}

// ────────────────────────────── 날짜 ──────────────────────────────

function daysIn(ym: YearMonth): number {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function dateOf(ym: YearMonth, day: number): LocalDate {
  const d = Math.min(Math.max(1, day), daysIn(ym));
  return `${ym}-${String(d).padStart(2, '0')}`;
}

export function isWeekend(date: LocalDate): boolean {
  const w = weekdayOf(date);
  return w === 0 || w === 6;
}

/** weekendMode: 'any' 주말 포함 / 'rare' 주말 15%만 허용 / 'never' 평일만 */
export function pickDate(rng: Rng, ym: YearMonth, weekendMode: 'any' | 'rare' | 'never'): LocalDate {
  for (let i = 0; i < 50; i++) {
    const date = dateOf(ym, rng.int(1, daysIn(ym)));
    if (!isWeekend(date) || weekendMode === 'any') return date;
    if (weekendMode === 'rare' && rng.chance(0.15)) return date;
  }
  return firstWeekday(ym);
}

function firstWeekday(ym: YearMonth): LocalDate {
  for (let d = 1; d <= 7; d++) {
    const date = dateOf(ym, d);
    if (!isWeekend(date)) return date;
  }
  return dateOf(ym, 1);
}

/** 주말이면 다음 평일로 */
export function nextWeekday(date: LocalDate): LocalDate {
  let d = date;
  const ym = date.slice(0, 7);
  let day = Number(date.slice(8));
  while (isWeekend(d) && day < daysIn(ym)) {
    day += 1;
    d = dateOf(ym, day);
  }
  if (isWeekend(d)) {
    // 월말 주말 → 앞쪽 평일
    while (isWeekend(d) && day > 1) {
      day -= 1;
      d = dateOf(ym, day);
    }
  }
  return d;
}

function timeOf(rng: Rng): string {
  return `${String(rng.int(8, 21)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}`;
}

function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

// ────────────────────────────── 거래 초안 → 확정 ──────────────────────────────

export type TxDraft = Omit<SyntheticTransaction, 'id' | 'fingerprint'>;

function partyOfClient(c: SyntheticClient): PartyInfo {
  return { businessNumber: formatBusinessNumber(c.businessNumber), name: c.name, representativeName: c.representativeName, address: c.address, email: c.email };
}

function partyOfMerchant(m: SyntheticMerchant): PartyInfo {
  return {
    businessNumber: m.businessNumber ? formatBusinessNumber(m.businessNumber) : '',
    name: m.name,
    representativeName: m.representativeName,
    address: m.address,
    email: m.email,
  };
}

function partyOfCustomer(k: SyntheticCustomer): PartyInfo {
  return { businessNumber: formatBusinessNumber(k.businessNumber), name: k.name, representativeName: k.representativeName, address: k.address, email: k.email };
}

const SOURCE_OF: Record<EvidenceKind, TransactionSource> = {
  card: 'business_card',
  cash_receipt: 'cash_receipt',
  tax_invoice: 'tax_invoice',
  invoice_exempt: 'tax_invoice',
};

export interface PurchaseParams {
  client: SyntheticClient;
  period: YearMonth;
  date: LocalDate;
  evidence: EvidenceKind;
  merchant: SyntheticMerchant;
  /** 우주 밖 가맹점 (신규·미상) → merchantId null */
  adHoc?: boolean;
  /** 카드·현금영수증: VAT 포함 합계 */
  total?: Won;
  /** 세금계산서·계산서: 공급가액 */
  supply?: Won;
  /** 금액 강제 (부가세 오류 이상치) */
  amounts?: { supply: Won; vat: Won; serviceCharge: Won; total: Won };
  serviceCharge?: Won;
  description?: string;
  card?: SyntheticCard;
  channel: IngestChannel;
  status: TransactionStatus;
  accountCode?: string;
  /** undefined → 홈택스 규칙 */
  hint?: boolean | null;
  approvalNumber?: string;
  cancel?: boolean;
  anomalies?: AnomalyKind[];
  scenarioTags?: string[];
  truthExtra?: Partial<GroundTruth>;
  withRaw: boolean;
  /** rawData 의 합계 칸을 문자열로 덮어쓰기 (파싱 실패 행 등) */
  rawTotalOverride?: string;
  rng: Rng;
}

const EVIDENCE_TYPE: Record<EvidenceKind, EvidenceType> = {
  card: 'card',
  cash_receipt: 'cash_receipt',
  tax_invoice: 'tax_invoice',
  invoice_exempt: 'invoice_exempt',
};

function slipIsTaxed(m: SyntheticMerchant): boolean {
  if (m.foreign) return false;
  if (m.taxType === 'general') return true;
  return m.taxType === 'simplified' && VAT_ON_SLIP_SIMPLIFIED_NAMES.has(m.name);
}

export function buildPurchase(ctx: TxContext, p: PurchaseParams): TxDraft {
  const { client, merchant: m, evidence } = p;
  let supply: Won;
  let vat: Won;
  let serviceCharge = p.serviceCharge ?? 0;
  let total: Won;
  if (p.amounts) {
    ({ supply, vat, serviceCharge, total } = p.amounts);
  } else if (evidence === 'tax_invoice') {
    supply = p.supply ?? 0;
    vat = vatOf(supply);
    total = supply + vat;
  } else if (evidence === 'invoice_exempt') {
    supply = p.supply ?? 0;
    vat = 0;
    total = supply;
  } else {
    total = p.total ?? 0;
    const base = total - serviceCharge;
    if (slipIsTaxed(m)) ({ supplyAmount: supply, vatAmount: vat } = splitVatInclusive(base));
    else {
      supply = base;
      vat = 0;
    }
  }

  const cardLike = evidence === 'card' || evidence === 'cash_receipt';
  const hint = cardLike ? (p.hint !== undefined ? p.hint : hometaxDeductibleHint(m, vat)) : null;
  const description = p.description ?? (evidence === 'tax_invoice' || evidence === 'invoice_exempt' ? (m.items[0] ?? '') : '');
  const accountCode = p.accountCode ?? truthAccountFor(m.kind, client.industry, total);
  const merchantTaxType = m.foreign ? 'unknown' : m.taxType;
  const vt = vatTruthFor(
    {
      direction: 'purchase',
      evidenceType: EVIDENCE_TYPE[evidence],
      vatAmount: vat,
      isForeign: m.foreign,
      merchantTaxType,
      merchantKind: m.kind,
      sourceDeductibleHint: hint,
      description,
      accountCode,
    },
    client,
  );

  let approvalNumber: string | null = p.approvalNumber ?? null;
  if (approvalNumber === null) {
    if (evidence === 'card') approvalNumber = makeCardApproval(p.rng, approvalsOf(ctx, client.code));
    else if (evidence === 'cash_receipt') approvalNumber = makeCashReceiptApproval(p.rng, approvalsOf(ctx, client.code));
    else approvalNumber = makeInvoiceApproval(p.rng, p.date, ctx.invoiceApprovals);
  }

  const card = evidence === 'card' ? (p.card ?? client.cards[0]!) : null;
  let rawData: Record<string, unknown>;
  if (!p.withRaw) rawData = { 원천: '합성 이력' };
  else if (evidence === 'card') {
    rawData = cardPurchaseRaw({
      date: p.date,
      cardCompany: card!.company,
      cardMasked: card!.masked,
      merchantBusinessNumber: m.businessNumber ? formatBusinessNumber(m.businessNumber) : '',
      merchantName: m.name,
      supply: m.foreign ? '' : supply,
      vat: m.foreign ? '' : vat,
      serviceCharge: m.foreign ? '' : serviceCharge,
      total: p.rawTotalOverride ?? total,
      merchantTypeLabel: merchantTypeLabel(m),
      bizType: m.foreign ? '' : m.bizType,
      category: m.foreign ? '' : m.category,
      deductibleLabel: deductibleLabel(hint),
      note: [m.foreign ? '해외' : '', p.cancel ? '취소' : '', description].filter(Boolean).join(' '),
      approvalNumber: approvalNumber ?? '',
    });
    if (m.foreign) {
      rawData['통화'] = 'USD';
      rawData['외화금액'] = (Math.round((total / SYNTHETIC_USD_KRW) * 100) / 100).toFixed(2);
    }
  } else if (evidence === 'cash_receipt') {
    rawData = cashReceiptPurchaseRaw({
      dateTime: `${p.date} ${timeOf(p.rng)}`,
      userName: client.representativeName,
      merchantBusinessNumber: m.businessNumber ? formatBusinessNumber(m.businessNumber) : '',
      merchantName: m.name,
      category: m.category,
      supply,
      vat,
      serviceCharge,
      total,
      approvalNumber: approvalNumber ?? '',
      cancel: !!p.cancel,
      deductibleLabel: deductibleLabel(hint),
      note: '',
    });
  } else {
    const src = {
      date: p.date,
      sendDate: addDays(p.date, 1),
      approvalNumber: approvalNumber ?? '',
      supplier: partyOfMerchant(m),
      buyer: partyOfClient(client),
      supply,
      vat,
      total,
      itemName: description,
      note: '',
    };
    rawData = evidence === 'tax_invoice' ? taxInvoiceRaw(src) : exemptInvoiceRaw(src);
  }

  const truth: GroundTruth = {
    accountCode,
    accountName: accountNameOf(accountCode),
    deductible: vt.deductible,
    vatType: vt.vatType,
    nonDeductibleReasonCode: vt.nonDeductibleReasonCode,
    ...(p.truthExtra ?? {}),
  };

  return {
    clientCode: client.code,
    businessNumber: client.businessNumber,
    period: p.period,
    status: p.status,
    source: SOURCE_OF[evidence],
    channel: p.channel,
    direction: 'purchase',
    transactionDate: p.date,
    evidenceType: EVIDENCE_TYPE[evidence],
    merchantName: m.name,
    merchantKey: normalizeMerchantName(m.name),
    merchantBusinessNumber: m.businessNumber,
    merchantCategory: evidence === 'card' || evidence === 'cash_receipt' ? (m.foreign ? null : m.category || null) : null,
    merchantTaxType,
    description,
    supplyAmount: supply,
    vatAmount: vat,
    serviceCharge,
    totalAmount: total,
    cardNumberMasked: card ? card.masked : null,
    approvalNumber,
    originalSourceId: null,
    currency: m.currency,
    isForeign: m.foreign,
    sourceDeductibleHint: hint,
    rawData,
    sourceRowNumber: null,
    merchantId: p.adHoc ? null : m.id,
    truth,
    anomalies: p.anomalies ? [...p.anomalies] : [],
    scenarioTags: p.scenarioTags ? [...p.scenarioTags] : [],
  };
}

export interface SaleParams {
  client: SyntheticClient;
  period: YearMonth;
  date: LocalDate;
  evidence: EvidenceKind;
  customer?: SyntheticCustomer;
  supply?: Won;
  total?: Won;
  itemName?: string;
  cardCompany?: string;
  channel: IngestChannel;
  status: TransactionStatus;
  withRaw: boolean;
  rng: Rng;
}

export function salesAccountOf(industry: IndustryKey): string {
  if (industry === 'manufacturing') return '404';
  if (industry === 'rental') return '904';
  return '401';
}

export function buildSale(ctx: TxContext, s: SaleParams): TxDraft {
  const { client, evidence } = s;
  let supply: Won;
  let vat: Won;
  let total: Won;
  if (evidence === 'tax_invoice') {
    supply = s.supply ?? 0;
    vat = vatOf(supply);
    total = supply + vat;
  } else if (evidence === 'invoice_exempt') {
    supply = s.supply ?? 0;
    vat = 0;
    total = supply;
  } else {
    total = s.total ?? 0;
    if (client.vatType === 'exempt') {
      supply = total;
      vat = 0;
    } else ({ supplyAmount: supply, vatAmount: vat } = splitVatInclusive(total));
  }
  const accountCode = salesAccountOf(client.industry);
  const vt = vatTruthFor(
    {
      direction: 'sales',
      evidenceType: EVIDENCE_TYPE[evidence],
      vatAmount: vat,
      isForeign: false,
      merchantTaxType: 'unknown',
      merchantKind: null,
      sourceDeductibleHint: null,
      description: '',
      accountCode,
    },
    client,
  );

  let merchantName: string;
  let merchantBusinessNumber: string | null = null;
  let approvalNumber: string;
  let cardNumberMasked: string | null = null;
  let rawData: Record<string, unknown> = { 원천: '합성 이력' };
  const itemName = s.itemName ?? '';
  if (evidence === 'tax_invoice' || evidence === 'invoice_exempt') {
    const k = s.customer!;
    merchantName = k.name;
    merchantBusinessNumber = k.businessNumber;
    approvalNumber = makeInvoiceApproval(s.rng, s.date, ctx.invoiceApprovals);
    if (s.withRaw) {
      const src = {
        date: s.date,
        sendDate: addDays(s.date, 1),
        approvalNumber,
        supplier: partyOfClient(client),
        buyer: partyOfCustomer(k),
        supply,
        vat,
        total,
        itemName,
        note: '',
      };
      rawData = evidence === 'tax_invoice' ? taxInvoiceRaw(src) : exemptInvoiceRaw(src);
    }
  } else if (evidence === 'card') {
    const company = s.cardCompany ?? '신한카드';
    merchantName = `${company} 카드매출`;
    approvalNumber = makeCardApproval(s.rng, approvalsOf(ctx, client.code));
    cardNumberMasked = makeMaskedCard(s.rng, ctx.usedCustomerCards);
    if (s.withRaw) rawData = cardSalesRaw({ date: s.date, cardCompany: company, cardMasked: cardNumberMasked, approvalNumber, total, cancel: false });
  } else {
    merchantName = '현금영수증 매출(소비자)';
    approvalNumber = makeCashReceiptApproval(s.rng, approvalsOf(ctx, client.code));
    if (s.withRaw) rawData = cashReceiptSalesRaw({ dateTime: `${s.date} ${timeOf(s.rng)}`, supply, vat, total, approvalNumber });
  }

  return {
    clientCode: client.code,
    businessNumber: client.businessNumber,
    period: s.period,
    status: s.status,
    source: SOURCE_OF[evidence],
    channel: s.channel,
    direction: 'sales',
    transactionDate: s.date,
    evidenceType: EVIDENCE_TYPE[evidence],
    merchantName,
    merchantKey: normalizeMerchantName(merchantName),
    merchantBusinessNumber,
    merchantCategory: null,
    merchantTaxType: 'unknown',
    description: itemName,
    supplyAmount: supply,
    vatAmount: vat,
    serviceCharge: 0,
    totalAmount: total,
    cardNumberMasked,
    approvalNumber,
    originalSourceId: null,
    currency: 'KRW',
    isForeign: false,
    sourceDeductibleHint: null,
    rawData,
    sourceRowNumber: null,
    merchantId: null,
    truth: {
      accountCode,
      accountName: accountNameOf(accountCode),
      deductible: vt.deductible,
      vatType: vt.vatType,
      nonDeductibleReasonCode: null,
    },
    anomalies: [],
    scenarioTags: [],
  };
}

/** clientId 자리에 거래처 코드를 넣은 fingerprint */
export function syntheticFingerprint(d: TxDraft): string {
  return computeFingerprint({ ...d, clientId: d.clientCode });
}

const EVIDENCE_ORDER: Record<EvidenceType, number> = { card: 0, cash_receipt: 1, tax_invoice: 2, invoice_exempt: 3, bank: 4, other: 5 };

function cmp(a: string | number, b: string | number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 초안 정렬(일자·방향·증빙·상호·금액·승인번호) 후 안정 ID 부여 */
export function finalizeDrafts(drafts: TxDraft[], clientCode: string, period: YearMonth): SyntheticTransaction[] {
  const sorted = drafts
    .map((d, i) => ({ d, i }))
    .sort(
      (x, y) =>
        cmp(x.d.transactionDate, y.d.transactionDate) ||
        cmp(x.d.direction, y.d.direction) ||
        cmp(EVIDENCE_ORDER[x.d.evidenceType], EVIDENCE_ORDER[y.d.evidenceType]) ||
        cmp(x.d.merchantName, y.d.merchantName) ||
        cmp(x.d.totalAmount, y.d.totalAmount) ||
        cmp(x.d.approvalNumber ?? '', y.d.approvalNumber ?? '') ||
        x.i - y.i,
    );
  return sorted.map(({ d }, idx) => ({ ...d, id: `${clientCode}-${period}-${String(idx + 1).padStart(4, '0')}`, fingerprint: syntheticFingerprint(d) }));
}

/** 이상치로 추가되는 거래 (ID 'C001-2026-09-X01') */
export function finalizeInjected(d: TxDraft, seq: number): SyntheticTransaction {
  return { ...d, id: `${d.clientCode}-${d.period}-X${String(seq).padStart(2, '0')}`, fingerprint: syntheticFingerprint(d) };
}

// ────────────────────────────── 풀(거래처별 가맹점 구성) ──────────────────────────────

interface KindWeight {
  kind: MerchantKind;
  weight: number;
  /** 서로 다른 가맹점 수 */
  count: number;
}

const K = (kind: MerchantKind, weight: number, count = 1): KindWeight => ({ kind, weight, count });

const OFFICE_BASE: KindWeight[] = [
  K('coffee', 14, 3), K('restaurant_meal', 16, 5), K('convenience', 8, 2), K('ecommerce_market', 5, 2), K('office_supply', 3),
  K('daiso', 3), K('mart', 3), K('courier', 2), K('taxi', 3), K('parking', 1), K('printing', 1), K('bookstore', 1),
  K('delivery_app', 3), K('flowers', 0.3),
];

const CARD_POOLS: Record<IndustryKey, KindWeight[]> = {
  design: [
    ...OFFICE_BASE, K('ecommerce_market', 14, 3), K('electronics', 1.2, 2), K('furniture', 0.5), K('printing', 3), K('courier', 5, 2),
    K('advertising', 1), K('lodging', 0.5), K('train', 0.6), K('saas_domestic', 1), K('office_supply', 2, 2),
  ],
  service: [...OFFICE_BASE, K('train', 0.5), K('lodging', 0.3), K('fine_dining', 1, 2), K('electronics', 0.3)],
  meat_restaurant: [
    K('mart', 12, 2), K('food_wholesale_exempt', 10), K('daiso', 3), K('convenience', 3), K('coffee', 2), K('restaurant_meal', 3, 2),
    K('delivery_app', 2), K('ecommerce_market', 3), K('hardware_tools', 1), K('fuel', 3),
  ],
  construction: [
    K('restaurant_meal', 22, 5), K('convenience', 10, 2), K('fuel', 14, 3), K('hardware_tools', 8, 2), K('toll', 5), K('parking', 2),
    K('coffee', 4, 2), K('daiso', 2), K('ecommerce_market', 3), K('lodging', 1.5), K('mart', 1), K('fine_dining', 2, 2),
  ],
  ecommerce: [
    K('ecommerce_market', 22, 4), K('courier', 16, 3), K('advertising', 3, 2), K('daiso', 3), K('office_supply', 2), K('coffee', 6, 2),
    K('restaurant_meal', 8, 3), K('convenience', 4), K('fuel', 3), K('saas_domestic', 1.5),
  ],
  interior: [
    K('hardware_tools', 12, 2), K('restaurant_meal', 16, 4), K('fuel', 8, 2), K('daiso', 5), K('ecommerce_market', 6, 2), K('convenience', 6),
    K('furniture', 1.5), K('toll', 2), K('coffee', 4), K('parking', 1), K('fine_dining', 1),
  ],
  academy: [
    K('bookstore', 5, 2), K('office_supply', 8, 2), K('daiso', 5), K('coffee', 6, 2), K('restaurant_meal', 8, 2), K('mart', 4),
    K('convenience', 3), K('ecommerce_market', 3), K('fuel', 2), K('printing', 2),
  ],
  clinic: [
    K('office_supply', 3), K('mart', 3), K('restaurant_meal', 12, 3), K('coffee', 10, 2), K('daiso', 2), K('delivery_app', 4),
    K('ecommerce_market', 3), K('convenience', 2),
  ],
  wholesale_retail: [
    K('fuel', 8, 2), K('courier', 10, 2), K('restaurant_meal', 14, 3), K('toll', 4), K('coffee', 5, 2), K('convenience', 4),
    K('ecommerce_market', 4), K('daiso', 2), K('parking', 2), K('fine_dining', 1), K('office_supply', 2),
  ],
  rental: [K('hardware_tools', 4), K('daiso', 4), K('restaurant_meal', 6, 2), K('coffee', 4), K('fuel', 3), K('office_supply', 2), K('convenience', 2)],
  manufacturing: [
    K('hardware_tools', 8, 2), K('fuel', 6), K('restaurant_meal', 16, 3), K('convenience', 8, 2), K('courier', 4), K('toll', 3),
    K('coffee', 4), K('daiso', 2), K('ecommerce_market', 3), K('fine_dining', 1), K('mart', 2),
  ],
  it_service: [
    K('coffee', 18, 3), K('restaurant_meal', 16, 4), K('delivery_app', 7, 2), K('convenience', 5), K('taxi', 6, 2), K('electronics', 2, 2),
    K('office_supply', 2), K('ecommerce_market', 4), K('train', 1), K('lodging', 0.6), K('airline', 0.3), K('saas_domestic', 2, 2),
    K('bookstore', 1), K('fuel', 2),
  ],
  cafe: [K('mart', 14, 2), K('food_wholesale_exempt', 6), K('daiso', 5), K('ecommerce_market', 6, 2), K('convenience', 4), K('restaurant_meal', 3)],
  restaurant: [
    K('mart', 14, 2), K('food_wholesale_exempt', 10), K('daiso', 3), K('convenience', 3), K('delivery_app', 2), K('ecommerce_market', 3),
    K('restaurant_meal', 2), K('coffee', 2),
  ],
  other: [
    K('mart', 3), K('daiso', 4), K('restaurant_meal', 8, 2), K('coffee', 6, 2), K('convenience', 4), K('ecommerce_market', 6, 2),
    K('advertising', 2), K('electronics', 0.5),
  ],
};

const CASH_KINDS: MerchantKind[] = ['restaurant_meal', 'convenience', 'mart', 'office_supply', 'hardware_tools', 'parking', 'daiso', 'printing'];

const INVOICE_POOLS: Partial<Record<IndustryKey, KindWeight[]>> = {
  construction: [K('building_materials', 6, 4), K('waste_disposal', 1)],
  interior: [K('building_materials', 5, 3), K('waste_disposal', 1)],
  manufacturing: [K('machine_parts', 5, 3), K('packaging', 1)],
  wholesale_retail: [K('goods_supplier', 5, 3), K('packaging', 1)],
  ecommerce: [K('goods_supplier', 4, 2), K('packaging', 3, 2)],
  clinic: [K('medical_supplies', 4, 2)],
  cafe: [K('coffee_beans', 4)],
  design: [K('printing', 3), K('goods_supplier', 2), K('packaging', 1)],
  it_service: [K('printing', 1)],
  service: [K('printing', 1)],
  academy: [K('printing', 1)],
  rental: [K('building_materials', 1), K('waste_disposal', 1)],
  other: [K('printing', 1)],
};

const EXEMPT_INVOICE_POOLS: Partial<Record<IndustryKey, KindWeight[]>> = {
  meat_restaurant: [K('meat_supplier', 5, 2)],
  restaurant: [K('food_wholesale_exempt', 4, 2)],
  cafe: [K('dairy_supplier', 4)],
  academy: [K('education_materials', 3, 2)],
  manufacturing: [K('food_wholesale_exempt', 4, 2)],
};

/** 접대비(813)로 가는 종류 — 급증 시나리오 거래처는 전용 경로로만 생성 */
const ENTERTAINMENT_KINDS: ReadonlySet<MerchantKind> = new Set(['fine_dining', 'golf', 'flowers', 'bar', 'dept_store']);

interface PoolEntry {
  merchant: SyntheticMerchant;
  weight: number;
}

/** 해당 종류가 풀에 들어가면 반드시 포함되는 가맹점 */
const PREFERRED_MERCHANTS: ReadonlySet<string> = new Set(['쿠팡']);

function buildPool(
  ctx: TxContext,
  client: SyntheticClient,
  weights: KindWeight[],
  evidence: EvidenceKind,
  label: string,
): PoolEntry[] {
  const rng = rngFor(ctx.seed, 'pool', client.code, label);
  const merged = new Map<MerchantKind, { weight: number; count: number }>();
  for (const w of weights) {
    const prev = merged.get(w.kind);
    merged.set(w.kind, prev ? { weight: prev.weight + w.weight, count: Math.max(prev.count, w.count) } : { weight: w.weight, count: w.count });
  }
  const out: PoolEntry[] = [];
  for (const [kind, { weight, count }] of merged) {
    if (client.code === SPIKE_CLIENT_CODE && ENTERTAINMENT_KINDS.has(kind)) continue;
    const candidates = ctx.merchants.filter(
      (m) =>
        m.kind === kind &&
        !RESERVED_MERCHANT_NAMES.has(m.name) &&
        !VAT_ON_SLIP_SIMPLIFIED_NAMES.has(m.name) &&
        (evidence === 'card' || evidence === 'cash_receipt' ? m.evidence === 'card' && !m.foreign : m.evidence === evidence),
    );
    if (candidates.length === 0) continue;
    // 대표 가맹점(쿠팡 등)은 항상 1순위로 넣는다 — 업종별 계정 차이 시나리오가 모든 거래처에서 재현되도록
    const preferred = candidates.filter((m) => PREFERRED_MERCHANTS.has(m.name));
    const others = candidates.filter((m) => !PREFERRED_MERCHANTS.has(m.name));
    const chosen = [...preferred, ...rng.sample(others, Math.max(0, count - preferred.length))].slice(0, Math.max(count, preferred.length));
    // Zipf 비슷한 분배 — 첫 가맹점이 가장 자주
    const z = chosen.map((_, i) => 1 / (i + 1));
    const zs = z.reduce((a, b) => a + b, 0);
    chosen.forEach((m, i) => out.push({ merchant: m, weight: (weight * z[i]!) / zs }));
  }
  // Map 순서는 삽입 순서 — 결정적
  return out;
}

// ────────────────────────────── 금액 ──────────────────────────────

function industryScale(kind: MerchantKind, industry: IndustryKey): number {
  switch (kind) {
    case 'utility_power':
      return industry === 'manufacturing' ? 12 : industry === 'restaurant' || industry === 'meat_restaurant' ? 4 : industry === 'cafe' ? 2.5 : industry === 'clinic' ? 2 : 1;
    case 'utility_gas':
      return industry === 'manufacturing' ? 6 : industry === 'restaurant' || industry === 'meat_restaurant' ? 3 : 1.5;
    case 'mart':
      return industry === 'restaurant' || industry === 'meat_restaurant' || industry === 'cafe' ? 2 : 1;
    case 'ecommerce_market':
      return industry === 'ecommerce' ? 3 : industry === 'wholesale_retail' ? 2 : 1;
    case 'hardware_tools':
      return industry === 'construction' || industry === 'interior' ? 1.5 : 1;
    case 'food_wholesale_exempt':
      return industry === 'meat_restaurant' ? 2 : industry === 'manufacturing' ? 3 : 1;
    case 'building_materials':
      return industry === 'construction' ? 1.8 : industry === 'interior' ? 0.8 : 0.3;
    case 'courier':
      return industry === 'ecommerce' ? 1.2 : 1;
    default:
      return 1;
  }
}

export function amountFor(rng: Rng, m: SyntheticMerchant, industry: IndustryKey): Won {
  const s = industryScale(m.kind, industry);
  const a = m.amount;
  return rng.amount(a.median * s, a.sigma, a.min, a.max * Math.max(1, s), a.unit);
}

function jitterCount(rng: Rng, mean: number, pct = 0.06): number {
  if (mean <= 0) return 0;
  return Math.max(1, Math.round(mean * (1 + pct * rng.normal())));
}

export function pickCard(rng: Rng, client: SyntheticClient): SyntheticCard {
  if (client.cards.length === 1) return client.cards[0]!;
  return rng.weighted(client.cards, (c) => (c === client.cards[0] ? 3 : 1));
}

const VEHICLE_KINDS: ReadonlySet<MerchantKind> = new Set(['fuel', 'toll', 'parking']);

/** 차량 관련 지출이면 차량번호 메모 (카드-차량 매핑 가정) */
function vehicleMemo(rng: Rng, m: SyntheticMerchant, client: SyntheticClient): string | undefined {
  if (!VEHICLE_KINDS.has(m.kind) || client.vehicles.length === 0) return undefined;
  if (m.kind === 'parking' && rng.chance(0.5)) return undefined;
  return `차량 ${rng.pick(client.vehicles).plate}`;
}

// ────────────────────────────── 정기 거래 ──────────────────────────────

interface Recurring {
  merchant: SyntheticMerchant;
  evidence: EvidenceKind;
  day: number;
  /** 카드: 합계 / 세금계산서: 공급가액 */
  amount: Won;
  /** 월별 변동폭 (0 = 고정) */
  jitter: number;
  unit: Won;
}

const SEATS_FOREIGN: Record<string, Record<string, number>> = {
  C001: { 'ADOBE *CREATIVE CLOUD': 4, 'GOOGLE *WORKSPACE': 8, 'CANVA PTY LTD': 1, 'DROPBOX INC': 2 },
  C002: { 'ADOBE *CREATIVE CLOUD': 1 },
  C012: { 'AMAZON WEB SERVICES': 1, 'GITHUB INC': 6, 'SLACK TECHNOLOGIES': 1, 'GOOGLE *WORKSPACE': 12, 'MICROSOFT 365': 3 },
  C020: { 'MICROSOFT 365': 6 },
  C022: { 'ADOBE *CREATIVE CLOUD': 3, 'DROPBOX INC': 1 },
  C013: { 'FACEBK *ADS': 1 },
};

const RENTLESS = new Set(['C010']);
const BUILDING_MGMT = new Set(['C001', 'C008', 'C012', 'C016', 'C020', 'C022']);
const SECURITY = new Set(['C001', 'C007', 'C008', 'C013', 'C015', 'C016', 'C024']);
const RENTAL_EQUIP = new Set(['C001', 'C007', 'C008', 'C012', 'C020']);
const INSURANCE = new Set(['C004', 'C009', 'C011', 'C019']);
const GAS = new Set<IndustryKey>(['restaurant', 'meat_restaurant', 'cafe', 'manufacturing']);
const AD_CARD: Record<string, string> = { C005: '네이버 검색광고', C001: '카카오 비즈보드', C024: '네이버 검색광고' };

function recurringFor(ctx: TxContext, client: SyntheticClient): Recurring[] {
  const rng = rngFor(ctx.seed, 'recurring', client.code);
  const out: Recurring[] = [];
  const add = (name: string, evidence: EvidenceKind, day: number, amount: Won, jitter: number, unit: Won) =>
    out.push({ merchant: merchantNamed(ctx, name), evidence, day, amount, jitter, unit });
  const scenario = client.code === SCENARIO_PAYROLL_CODE;

  add(rng.pick(['KT', 'SK텔레콤', 'LG유플러스']), 'card', 20, rng.amount(90_000, 0.4, 40_000, 400_000, 10), 0.03, 10);
  const foreign = SEATS_FOREIGN[client.code] ?? {};
  for (const [name, seats] of Object.entries(foreign)) {
    const m = merchantNamed(ctx, name);
    add(name, 'card', 3 + (Object.keys(foreign).indexOf(name) % 5), m.amount.median * seats, 0.02, 1);
  }
  if (scenario) {
    // 시나리오상사: 카드 500건 구성을 단순하게 유지 (통신비·Adobe 만 정기 카드). 세금계산서 정기분은 별도.
    add('가람세무회계', 'tax_invoice', 10, 200_000, 0, 10_000);
    add('해솔빌딩', 'tax_invoice', 25, 1_500_000, 0, 10_000);
    return out;
  }
  const powerBase = 150_000 * industryScale('utility_power', client.industry);
  add('한국전력공사', 'card', 15, rng.amount(powerBase, 0.3, 30_000, 6_000_000, 10), 0.12, 10);
  if (GAS.has(client.industry)) add('한빛도시가스', 'card', 18, rng.amount(100_000 * industryScale('utility_gas', client.industry), 0.3, 20_000, 2_000_000, 10), 0.15, 10);
  if (!RENTLESS.has(client.code)) {
    const rentBase = client.industry === 'manufacturing' ? 5_000_000 : client.industry === 'clinic' ? 4_000_000 : client.businessType === 'corporation' ? 2_800_000 : 1_600_000;
    add(rng.pick(['해솔빌딩', '청운타워', '가람프라자']), 'tax_invoice', 25, Math.round(rng.amount(rentBase, 0.2, 600_000, 9_000_000, 10_000) / 10_000) * 10_000, 0, 10_000);
  }
  if (BUILDING_MGMT.has(client.code)) add(rng.pick(['해솔빌딩 관리사무소', '청운타워 관리단']), 'tax_invoice', 28, rng.amount(420_000, 0.3, 100_000, 1_500_000, 10), 0.08, 10);
  add('가람세무회계', 'tax_invoice', 10, client.businessType === 'corporation' ? 300_000 : 180_000, 0, 10_000);
  if (SECURITY.has(client.code)) add('세이프가드 보안', 'card', 5, 110_000, 0, 10);
  if (RENTAL_EQUIP.has(client.code)) add(rng.pick(['청정수렌탈', '가상복합기렌탈']), 'card', 7, rng.pick([39_900, 88_000, 132_000]), 0, 100);
  if (INSURANCE.has(client.code)) add('한빛화재해상보험', 'card', 12, rng.amount(250_000, 0.4, 50_000, 1_500_000, 10), 0, 10);
  const ad = AD_CARD[client.code];
  if (ad) add(ad, 'card', 1, rng.amount(600_000, 0.4, 100_000, 3_000_000, 1000), 0.2, 1000);
  return out;
}

function recurringAmount(rng: Rng, r: Recurring): Won {
  if (r.jitter === 0) return r.amount;
  const v = r.amount * (1 + r.jitter * rng.normal());
  return Math.max(r.unit, Math.round(v / r.unit) * r.unit);
}

// ────────────────────────────── 매출 ──────────────────────────────

interface SalesProfile {
  median: Won;
  sigma: number;
  min: Won;
  max: Won;
  items: string[];
}

const SALES_INVOICE: Record<IndustryKey, SalesProfile> = {
  design: { median: 3_500_000, sigma: 0.6, min: 500_000, max: 25_000_000, items: ['브랜드 디자인 용역', '패키지 디자인 용역', '디자인 소품 납품'] },
  service: { median: 1_800_000, sigma: 0.5, min: 300_000, max: 10_000_000, items: ['업무지원 용역'] },
  construction: { median: 25_000_000, sigma: 0.6, min: 3_000_000, max: 150_000_000, items: ['공사 기성금', '설비공사 대금'] },
  interior: { median: 9_000_000, sigma: 0.6, min: 1_000_000, max: 60_000_000, items: ['인테리어 공사 대금'] },
  wholesale_retail: { median: 2_500_000, sigma: 0.7, min: 200_000, max: 20_000_000, items: ['생활용품 납품'] },
  rental: { median: 2_000_000, sigma: 0.3, min: 800_000, max: 5_000_000, items: ['임대료'] },
  manufacturing: { median: 8_000_000, sigma: 0.6, min: 500_000, max: 60_000_000, items: ['정밀가공품 납품', '반찬류 납품'] },
  it_service: { median: 7_000_000, sigma: 0.6, min: 1_000_000, max: 50_000_000, items: ['소프트웨어 개발 용역', '유지보수 용역'] },
  academy: { median: 1_200_000, sigma: 0.5, min: 200_000, max: 6_000_000, items: ['교구 판매'] },
  ecommerce: { median: 1_500_000, sigma: 0.5, min: 200_000, max: 8_000_000, items: ['상품 납품'] },
  restaurant: { median: 500_000, sigma: 0.5, min: 100_000, max: 3_000_000, items: ['단체 도시락'] },
  meat_restaurant: { median: 800_000, sigma: 0.5, min: 100_000, max: 3_000_000, items: ['단체 회식'] },
  clinic: { median: 800_000, sigma: 0.5, min: 100_000, max: 3_000_000, items: ['검진 용역'] },
  cafe: { median: 300_000, sigma: 0.5, min: 50_000, max: 2_000_000, items: ['단체 음료'] },
  other: { median: 600_000, sigma: 0.5, min: 100_000, max: 3_000_000, items: ['기업 회원권'] },
};

const CARD_SALES: Record<string, { count: number; median: Won; sigma: number; min: Won; max: Won }> = {
  C001: { count: 60, median: 42_000, sigma: 0.6, min: 8_000, max: 400_000 },
  C003: { count: 100, median: 110_000, sigma: 0.5, min: 20_000, max: 800_000 },
  C005: { count: 80, median: 38_000, sigma: 0.6, min: 5_000, max: 300_000 },
  C007: { count: 45, median: 350_000, sigma: 0.3, min: 150_000, max: 900_000 },
  C008: { count: 90, median: 25_000, sigma: 0.6, min: 5_000, max: 300_000 },
  C013: { count: 140, median: 12_000, sigma: 0.5, min: 3_000, max: 80_000 },
  C014: { count: 70, median: 14_000, sigma: 0.5, min: 4_000, max: 60_000 },
  C015: { count: 110, median: 45_000, sigma: 0.6, min: 8_000, max: 400_000 },
  C016: { count: 80, median: 180_000, sigma: 0.6, min: 20_000, max: 2_000_000 },
  C017: { count: 30, median: 120_000, sigma: 0.5, min: 30_000, max: 600_000 },
  C018: { count: 50, median: 9_000, sigma: 0.6, min: 1_000, max: 80_000 },
  C021: { count: 45, median: 55_000, sigma: 0.4, min: 20_000, max: 200_000 },
  C024: { count: 40, median: 150_000, sigma: 0.5, min: 30_000, max: 600_000 },
};

function customersFor(ctx: TxContext, client: SyntheticClient): SyntheticCustomer[] {
  const rng = rngFor(ctx.seed, 'customers', client.code);
  return rng.sample(ctx.customers, client.industry === 'rental' ? 6 : rng.int(3, 6));
}

// ────────────────────────────── 월 생성 ──────────────────────────────

interface ClientPools {
  card: PoolEntry[];
  cash: PoolEntry[];
  invoice: PoolEntry[];
  exemptInvoice: PoolEntry[];
  recurring: Recurring[];
  customers: SyntheticCustomer[];
  rentByCustomer: Map<string, Won>;
}

function poolsFor(ctx: TxContext, client: SyntheticClient): ClientPools {
  const spec = clientSpecOf(client.code);
  const cardPool = buildPool(ctx, client, CARD_POOLS[client.industry], 'card', 'card');
  const cashWeights = CARD_POOLS[client.industry].filter((w) => CASH_KINDS.includes(w.kind)).map((w) => ({ ...w, count: 1 }));
  const customers = customersFor(ctx, client);
  const rentRng = rngFor(ctx.seed, 'rent-sales', client.code);
  return {
    card: cardPool,
    cash: buildPool(ctx, client, cashWeights.length ? cashWeights : [K('restaurant_meal', 1)], 'cash_receipt', 'cash'),
    invoice: spec.volume.taxInvoice > 0 ? buildPool(ctx, client, INVOICE_POOLS[client.industry] ?? [K('printing', 1)], 'tax_invoice', 'invoice') : [],
    exemptInvoice: spec.volume.exemptInvoice > 0 ? buildPool(ctx, client, EXEMPT_INVOICE_POOLS[client.industry] ?? [], 'invoice_exempt', 'exempt') : [],
    recurring: recurringFor(ctx, client),
    customers,
    rentByCustomer: new Map(customers.map((k) => [k.id, Math.round(rentRng.amount(2_000_000, 0.35, 800_000, 5_000_000, 10_000) / 10_000) * 10_000])),
  };
}

interface MonthMode {
  period: YearMonth;
  current: boolean;
  status: TransactionStatus;
  channel: IngestChannel;
}

function modeOf(period: YearMonth): MonthMode {
  const current = period === CURRENT_MONTH;
  return {
    period,
    current,
    status: current ? 'imported' : period === HISTORY_MONTHS[HISTORY_MONTHS.length - 1] ? 'approved' : 'exported',
    channel: current ? 'hometax_file' : 'wemembers_file',
  };
}

function weekendModeOf(spec: ClientSpec): 'any' | 'rare' {
  return spec.volume.weekendActive ? 'any' : 'rare';
}

function generateRegularMonth(ctx: TxContext, client: SyntheticClient, pools: ClientPools, mode: MonthMode): TxDraft[] {
  const spec = clientSpecOf(client.code);
  const rng = rngFor(ctx.seed, 'tx', client.code, mode.period);
  const drafts: TxDraft[] = [];
  const wk = weekendModeOf(spec);
  const base = { client, period: mode.period, channel: mode.channel, status: mode.status, withRaw: mode.current, rng };

  // 사업용카드
  const nCard =
    mode.current && client.code === SCENARIO_A_CODE ? SCENARIO_A_BASE_CARD_COUNT : jitterCount(rng, spec.volume.card - pools.recurring.filter((r) => r.evidence === 'card').length);
  for (let i = 0; i < nCard; i++) {
    const { merchant } = rng.weighted(pools.card, (e) => e.weight);
    const total = amountFor(rng, merchant, client.industry);
    drafts.push(
      buildPurchase(ctx, { ...base, date: pickDate(rng, mode.period, wk), evidence: 'card', merchant, total, card: pickCard(rng, client), description: vehicleMemo(rng, merchant, client) }),
    );
  }
  // 정기
  for (const r of pools.recurring) {
    const date = nextWeekday(dateOf(mode.period, r.day));
    const amount = recurringAmount(rng, r);
    if (r.evidence === 'card') drafts.push(buildPurchase(ctx, { ...base, date, evidence: 'card', merchant: r.merchant, total: amount, card: client.cards[0] }));
    else drafts.push(buildPurchase(ctx, { ...base, date, evidence: r.evidence, merchant: r.merchant, supply: amount, description: r.merchant.items[0] }));
  }
  // 현금영수증
  const nCash = jitterCount(rng, spec.volume.cash, 0.25);
  for (let i = 0; i < nCash && pools.cash.length > 0; i++) {
    const { merchant } = rng.weighted(pools.cash, (e) => e.weight);
    drafts.push(buildPurchase(ctx, { ...base, date: pickDate(rng, mode.period, wk), evidence: 'cash_receipt', merchant, total: amountFor(rng, merchant, client.industry) }));
  }
  // 세금계산서 매입
  const nInv = pools.invoice.length ? jitterCount(rng, spec.volume.taxInvoice, 0.2) : 0;
  for (let i = 0; i < nInv; i++) {
    const { merchant } = rng.weighted(pools.invoice, (e) => e.weight);
    const supply = Math.round(amountFor(rng, merchant, client.industry) / 1.1 / 10) * 10;
    drafts.push(buildPurchase(ctx, { ...base, date: pickDate(rng, mode.period, 'never'), evidence: 'tax_invoice', merchant, supply, description: rng.pick(merchant.items) }));
  }
  // 계산서(면세) 매입
  const nEx = pools.exemptInvoice.length ? jitterCount(rng, spec.volume.exemptInvoice, 0.2) : 0;
  for (let i = 0; i < nEx; i++) {
    const { merchant } = rng.weighted(pools.exemptInvoice, (e) => e.weight);
    const supply = Math.round(amountFor(rng, merchant, client.industry) / 10) * 10;
    drafts.push(buildPurchase(ctx, { ...base, date: pickDate(rng, mode.period, 'never'), evidence: 'invoice_exempt', merchant, supply, description: rng.pick(merchant.items) }));
  }
  drafts.push(...generateSales(ctx, client, pools, mode, rng));
  return drafts;
}

function generateSales(ctx: TxContext, client: SyntheticClient, pools: ClientPools, mode: MonthMode, rng: Rng): TxDraft[] {
  const spec = clientSpecOf(client.code);
  const drafts: TxDraft[] = [];
  const base = { client, period: mode.period, channel: mode.channel, status: mode.status, withRaw: mode.current, rng };
  const prof = SALES_INVOICE[client.industry];
  if (client.industry === 'rental') {
    // 임차인별 월 임대료 (고정)
    for (const k of pools.customers) {
      drafts.push(buildSale(ctx, { ...base, date: nextWeekday(dateOf(mode.period, 1)), evidence: 'tax_invoice', customer: k, supply: pools.rentByCustomer.get(k.id)!, itemName: '임대료' }));
    }
  } else {
    const n = spec.volume.salesTaxInvoice > 0 ? jitterCount(rng, spec.volume.salesTaxInvoice, 0.2) : 0;
    for (let i = 0; i < n; i++) {
      const supply = Math.round(rng.amount(prof.median, prof.sigma, prof.min, prof.max, 10_000) / 10_000) * 10_000;
      drafts.push(
        buildSale(ctx, { ...base, date: pickDate(rng, mode.period, 'never'), evidence: 'tax_invoice', customer: rng.pick(pools.customers), supply, itemName: rng.pick(prof.items) }),
      );
    }
  }
  const nEx = spec.volume.salesExemptInvoice > 0 ? jitterCount(rng, spec.volume.salesExemptInvoice, 0.2) : 0;
  for (let i = 0; i < nEx; i++) {
    const supply = Math.round(rng.amount(2_500_000, 0.5, 300_000, 12_000_000, 10_000) / 10_000) * 10_000;
    drafts.push(buildSale(ctx, { ...base, date: pickDate(rng, mode.period, 'never'), evidence: 'invoice_exempt', customer: rng.pick(pools.customers), supply, itemName: '온라인 교육 서비스' }));
  }
  const cs = CARD_SALES[client.code];
  if (spec.volume.cardSales && cs) {
    const n = jitterCount(rng, cs.count, 0.08);
    for (let i = 0; i < n; i++) {
      drafts.push(
        buildSale(ctx, {
          ...base,
          date: pickDate(rng, mode.period, spec.volume.weekendActive ? 'any' : 'rare'),
          evidence: 'card',
          total: rng.amount(cs.median, cs.sigma, cs.min, cs.max, 100),
          cardCompany: rng.pick(['신한카드', 'KB국민카드', '삼성카드', '현대카드', '비씨카드', '롯데카드', '하나카드']),
        }),
      );
    }
    const nCash = spec.volume.cashSales > 0 ? jitterCount(rng, spec.volume.cashSales, 0.2) : 0;
    for (let i = 0; i < nCash; i++) {
      drafts.push(buildSale(ctx, { ...base, date: pickDate(rng, mode.period, 'any'), evidence: 'cash_receipt', total: rng.amount(cs.median * 0.8, cs.sigma, cs.min, cs.max, 100) }));
    }
  }
  return drafts;
}

// ────────────────────────────── 접대비 급증 거래처 (C004) ──────────────────────────────

/**
 * 접대비(813) 월 합계 — 3개월(06~08) 평균 2,400,000원 → 2026-09 8,900,000원.
 * 합계는 부가세 포함 총액 (불공제 접대비는 부가세까지 비용).
 */
export const SPIKE_PLAN = {
  clientCode: SPIKE_CLIENT_CODE,
  accountCode: '813',
  historyTotals: { '2026-03': 2_380_000, '2026-04': 2_450_000, '2026-05': 2_310_000, '2026-06': 2_350_000, '2026-07': 2_420_000, '2026-08': 2_430_000 } as Record<YearMonth, Won>,
  baseline3m: 2_400_000,
  current: [
    { day: 3, merchant: '가상컨트리클럽 (용인)', total: 1_850_000 },
    { day: 8, merchant: '한정식 수라원', total: 1_320_000 },
    { day: 11, merchant: '가상컨트리클럽 (용인)', total: 2_100_000 },
    { day: 16, merchant: '더플레이트 스테이크하우스', total: 980_000 },
    { day: 22, merchant: '한정식 수라원', total: 1_450_000 },
    { day: 24, merchant: '더플레이트 스테이크하우스', total: 1_200_000 },
  ],
  currentTotal: 8_900_000,
} as const;

function generateSpikeHistory(ctx: TxContext, client: SyntheticClient, mode: MonthMode): TxDraft[] {
  const target = SPIKE_PLAN.historyTotals[mode.period];
  if (target === undefined) return [];
  const rng = rngFor(ctx.seed, 'spike', client.code, mode.period);
  const golf = rng.chance(0.5) ? Math.round((target * 0.45) / 10_000) * 10_000 : 0;
  const dining1 = Math.round(((target - golf) * 0.55) / 10_000) * 10_000;
  const dining2 = target - golf - dining1;
  const parts: Array<[string, Won]> = [
    ['가상컨트리클럽 (용인)', golf],
    ['한정식 수라원', dining1],
    ['더플레이트 스테이크하우스', dining2],
  ];
  return parts
    .filter(([, amt]) => amt > 0)
    .map(([name, total]) =>
      buildPurchase(ctx, {
        client,
        period: mode.period,
        date: pickDate(rng, mode.period, 'never'),
        evidence: 'card',
        merchant: merchantNamed(ctx, name),
        total,
        card: client.cards[0],
        channel: mode.channel,
        status: mode.status,
        accountCode: '813',
        withRaw: mode.current,
        rng,
      }),
    );
}

// ────────────────────────────── 시나리오상사 (C002) ──────────────────────────────

/** 시나리오상사 정규 가맹점 (이력 반복, 계정 일관) */
export const SCENARIO1_REGULAR: ReadonlyArray<{ name: string; weight: number }> = [
  { name: '스타벅스 역삼점', weight: 9 }, { name: '이디야커피 선릉점', weight: 5 }, { name: '메가MGC커피 역삼2호점', weight: 4 }, { name: '투썸플레이스 삼성점', weight: 3 },
  { name: '김밥천국 역삼점', weight: 5 }, { name: '본죽 선릉점', weight: 4 }, { name: '한솥도시락 가산점', weight: 5 }, { name: '명동칼국수 본점', weight: 4 },
  { name: '큰맘할매순대국 문래점', weight: 4 }, { name: '서브웨이 강남역점', weight: 3 }, { name: '홍콩반점0410 삼성점', weight: 3 }, { name: '역전우동 가산점', weight: 3 },
  { name: 'GS25 역삼점', weight: 5 }, { name: 'CU 선릉역점', weight: 4 }, { name: '세븐일레븐 판교점', weight: 2 },
  { name: '오피스플러스 역삼점', weight: 3 }, { name: '알파문구 선릉점', weight: 2 }, { name: 'CJ대한통운', weight: 3 }, { name: '한진택배', weight: 2 },
  { name: '프린트샵 역삼점', weight: 2 }, { name: '배달의민족', weight: 3 }, { name: '요기요', weight: 2 }, { name: '다이소 역삼점', weight: 3 },
  { name: '교보문고 광화문점', weight: 1 },
];

/** 2026-09 에만 처음 등장하는 가맹점 (신규 거래처 10) */
export const SCENARIO1_NEW_MERCHANTS = [
  '스타벅스 강남R점', '스타벅스 성수점', '스타벅스 판교점', '이디야커피 문래점', '메가MGC커피 가산점',
  '빽다방 논현점', '고봉민김밥 판교점', '맘스터치 성수점', 'GS25 가산디지털점', 'CU 성수점',
] as const;

/** 이력에 1회(2026-05)만 있는 가맹점 (저신뢰도 6). 마지막 다이소는 9월 정답이 이력과 다르다 (정정 대상). */
export const SCENARIO1_LOW_CONFIDENCE = [
  { name: '가비아', total: 33_000 },
  { name: '공구나라 구로점', total: 48_000 },
  { name: '호텔 가상스테이 부산', total: 132_000 },
  { name: '모닝글로리 판교점', total: 27_500 },
  { name: '샘플타워 주차장', total: 12_000 },
  { name: '다이소 가산점', total: 23_000, currentAccount: '811' },
] as const;

/** 세액이 표시된 간이과세자 (공제/불공제 검토 5) — 이력에 월 2회씩 */
export const SCENARIO1_VAT_REVIEW = ['소반식당', '들꽃밥상', '모퉁이국수', '작은부엌', '오늘카페'] as const;

/** 쿠팡 이력 계정 (830 7회, 829 5회 → 계정 충돌). 9월 정답은 829 사무용품비 (3건 정정) */
const SCENARIO1_COUPANG_HISTORY_ACCOUNTS = ['830', '830', '829', '830', '829', '830', '830', '829', '830', '829', '830', '829'];

function generateScenario1Month(ctx: TxContext, client: SyntheticClient, pools: ClientPools, mode: MonthMode): TxDraft[] {
  const rng = rngFor(ctx.seed, 'tx', client.code, mode.period);
  const base = { client, period: mode.period, channel: mode.channel, status: mode.status, withRaw: mode.current, rng };
  const regular = SCENARIO1_REGULAR.map((r) => ({ merchant: merchantNamed(ctx, r.name), weight: r.weight }));
  const drafts: TxDraft[] = [];
  const card = (merchant: SyntheticMerchant, total: Won, extra: Partial<PurchaseParams> = {}): TxDraft =>
    buildPurchase(ctx, { ...base, date: pickDate(rng, mode.period, 'never'), evidence: 'card', merchant, total, card: pickCard(rng, client), ...extra });

  const cardRecurring = pools.recurring.filter((r) => r.evidence === 'card');
  const exceptions: TxDraft[] = [];
  if (mode.current) {
    const tag = (bucket: string) => [`scenario1:${bucket}`];
    for (const name of SCENARIO1_NEW_MERCHANTS) {
      const m = merchantNamed(ctx, name);
      exceptions.push(card(m, amountFor(rng, m, client.industry), { scenarioTags: tag('new_merchant'), truthExtra: { expectedBuckets: ['new_merchant'] } }));
    }
    for (const lc of SCENARIO1_LOW_CONFIDENCE) {
      const m = merchantNamed(ctx, lc.name);
      const correction = 'currentAccount' in lc;
      exceptions.push(
        card(m, lc.total, {
          accountCode: correction ? lc.currentAccount : undefined,
          scenarioTags: correction ? [...tag('low_confidence'), 'scenario1:correction'] : tag('low_confidence'),
          anomalies: correction ? ['correction_target'] : [],
          truthExtra: { expectedBuckets: ['low_confidence'], ...(correction ? { note: '이력(830 소모품비)과 달리 직원 간식 구매 — 811 복리후생비로 정정' } : {}) },
        }),
      );
    }
    for (const name of SCENARIO1_VAT_REVIEW) {
      const m = merchantNamed(ctx, name);
      exceptions.push(card(m, amountFor(rng, m, client.industry), { scenarioTags: tag('vat_review'), truthExtra: { expectedBuckets: ['vat_review'] } }));
    }
    const highs: Array<[string, Won]> = [['명동칼국수 본점', 1_280_000], ['홍콩반점0410 삼성점', 1_150_000], ['큰맘할매순대국 문래점', 1_420_000]];
    for (const [name, total] of highs) {
      exceptions.push(card(merchantNamed(ctx, name), total, { scenarioTags: tag('high_amount'), truthExtra: { expectedBuckets: ['high_amount'], note: '부서 회식' } }));
    }
    for (let i = 0; i < 3; i++) {
      exceptions.push(
        card(merchantNamed(ctx, '쿠팡'), rng.amount(52_000, 0.4, 18_000, 120_000, 100), {
          accountCode: '829',
          anomalies: ['correction_target'],
          scenarioTags: [...tag('account_conflict'), 'scenario1:correction'],
          truthExtra: { expectedBuckets: ['account_conflict'], note: '쿠팡 이력이 소모품비/사무용품비로 갈림 — 정답 829 사무용품비' },
        }),
      );
    }
    for (const total of [1_150_000, 1_380_000]) {
      exceptions.push(
        card(merchantNamed(ctx, '롯데하이마트 역삼점'), total, { scenarioTags: tag('possible_asset'), truthExtra: { expectedBuckets: ['possible_asset', 'high_amount'] } }),
      );
    }
  } else {
    for (const name of SCENARIO1_VAT_REVIEW) {
      const m = merchantNamed(ctx, name);
      drafts.push(card(m, amountFor(rng, m, client.industry)), card(m, amountFor(rng, m, client.industry)));
    }
    const monthIdx = HISTORY_MONTHS.indexOf(mode.period);
    for (let i = 0; i < 2; i++) {
      drafts.push(card(merchantNamed(ctx, '쿠팡'), rng.amount(48_000, 0.5, 9_000, 150_000, 100), { accountCode: SCENARIO1_COUPANG_HISTORY_ACCOUNTS[monthIdx * 2 + i]! }));
    }
    if (mode.period === '2026-05') for (const lc of SCENARIO1_LOW_CONFIDENCE) drafts.push(card(merchantNamed(ctx, lc.name), lc.total));
    if (monthIdx % 2 === 0) drafts.push(card(merchantNamed(ctx, '롯데하이마트 역삼점'), rng.amount(35_000, 0.4, 9_000, 90_000, 1000)));
  }

  // 정기 카드 (통신비, Adobe). 9월 Adobe 는 해외결제 예외 1건.
  for (const r of cardRecurring) {
    const foreign = r.merchant.foreign && mode.current;
    const d = buildPurchase(ctx, {
      ...base,
      date: nextWeekday(dateOf(mode.period, r.day)),
      evidence: 'card',
      merchant: r.merchant,
      total: recurringAmount(rng, r),
      card: client.cards[0],
      ...(foreign ? { scenarioTags: ['scenario1:foreign'], truthExtra: { expectedBuckets: ['foreign'] } } : {}),
    });
    (foreign ? exceptions : drafts).push(d);
  }

  const cardSoFar = drafts.filter((d) => d.evidenceType === 'card').length;
  const nRegular = mode.current ? SCENARIO1_CARD_COUNT - exceptions.length - cardSoFar : jitterCount(rng, 470 - cardSoFar, 0.03);
  for (let i = 0; i < nRegular; i++) {
    const { merchant } = rng.weighted(regular, (e) => e.weight);
    drafts.push(card(merchant, Math.min(amountFor(rng, merchant, client.industry), 250_000)));
  }
  drafts.push(...exceptions);

  // 정기 세금계산서 (임대료·기장료) + 매출
  for (const r of pools.recurring.filter((x) => x.evidence !== 'card')) {
    drafts.push(buildPurchase(ctx, { ...base, date: nextWeekday(dateOf(mode.period, r.day)), evidence: r.evidence, merchant: r.merchant, supply: r.amount, description: r.merchant.items[0] }));
  }
  drafts.push(...generateSales(ctx, client, pools, mode, rng));
  return drafts;
}

// ────────────────────────────── 공개 API ──────────────────────────────

export interface GeneratedTransactions {
  history: SyntheticTransaction[];
  /** 이상치 주입 전 당월 거래 */
  currentBase: SyntheticTransaction[];
}

export function generateTransactions(ctx: TxContext): GeneratedTransactions {
  const history: SyntheticTransaction[] = [];
  const currentBase: SyntheticTransaction[] = [];
  for (const client of ctx.clients) {
    const pools = poolsFor(ctx, client);
    for (const period of [...HISTORY_MONTHS, CURRENT_MONTH]) {
      const mode = modeOf(period);
      const drafts =
        client.code === SCENARIO_PAYROLL_CODE ? generateScenario1Month(ctx, client, pools, mode) : generateRegularMonth(ctx, client, pools, mode);
      if (client.code === SPIKE_CLIENT_CODE && !mode.current) drafts.push(...generateSpikeHistory(ctx, client, mode));
      const finalized = finalizeDrafts(drafts, client.code, period);
      if (mode.current) currentBase.push(...finalized);
      else history.push(...markCorrections(ctx, finalized));
    }
  }
  return { history, currentBase };
}

/** 이력의 약 2% 는 사람이 엔진 추천을 고쳐 확정한 거래로 표시 (HistoryEntry.corrected) */
function markCorrections(ctx: TxContext, txs: SyntheticTransaction[]): SyntheticTransaction[] {
  return txs.map((t) => {
    if (t.direction !== 'purchase') return t;
    const r = rngFor(ctx.seed, 'corrected', t.id).next();
    return r < 0.02 ? { ...t, truth: { ...t.truth, corrected: true } } : t;
  });
}

// ────────────────────────────── 로더용 변환 ──────────────────────────────

/** 합성 거래 → NormalizedTransaction (clientId 주입 + fingerprint 재계산) */
export function toNormalizedTransaction(tx: SyntheticTransaction, clientId: string): NormalizedTransaction {
  const {
    id: _id,
    clientCode: _code,
    period: _period,
    status: _status,
    merchantId: _mid,
    truth: _truth,
    anomalies: _anomalies,
    scenarioTags: _tags,
    fingerprint: _fp,
    ...rest
  } = tx;
  const n: NormalizedTransaction = { ...rest, clientId, fingerprint: '' };
  n.fingerprint = computeFingerprint(n);
  return n;
}

/** 확정 이력 → 분류 엔진 HistoryEntry */
export function toHistoryEntry(tx: SyntheticTransaction, clientId: string, industry: IndustryKey): HistoryEntry {
  return {
    clientId,
    merchantKey: tx.merchantKey,
    merchantBusinessNumber: tx.merchantBusinessNumber,
    accountCode: tx.truth.accountCode,
    accountName: tx.truth.accountName,
    transactionDate: tx.transactionDate,
    totalAmount: tx.totalAmount,
    corrected: !!tx.truth.corrected,
    industry,
  };
}
