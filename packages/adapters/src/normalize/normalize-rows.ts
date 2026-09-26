/**
 * Accounting Data Normalizer — 원본 행 → NormalizedTransaction / 실패.
 *
 * 원칙
 * - 데이터 행(헤더 아래 빈 행 제외)은 정확히 하나의 결과를 낸다: 거래 / 실패 / (세금계산서 품목행) 병합.
 *   transactions + failures + mergedRows === stats.dataRows (조용한 유실 금지)
 * - 금액 검산: 공급가액 + 세액 (+ 봉사료/비과세) = 합계. 불일치는 실패. 합계만 있으면 역산하고 rawData.__derived 에 기록.
 * - 취소(음수) 거래는 음수 그대로 두고 적요에 '취소'.
 * - 카드번호 전체·주민번호는 rawData 에 남기기 전에 마스킹한다.
 */
import {
  computeFingerprint,
  formatBusinessNumber,
  formatWon,
  isValidBusinessNumber,
  normalizeBusinessNumber,
  normalizeDate,
  normalizeMerchantName,
  parseWon,
  splitVatInclusive,
  type AmountTotals,
  type Direction,
  type EvidenceType,
  type IngestChannel,
  type NormalizationFailure,
  type NormalizedTransaction,
  type TransactionSource,
  type UUID,
  type VatTaxpayerType,
  type Won,
} from '@mintax/core';
import { AdapterError } from '../errors';
import { resolveColumns, type ColumnMap, type FormatDetection } from '../format/detect';
import { AMOUNT_FIELDS, fieldLabel, IDENTIFIER_FIELDS, type CanonicalField } from '../format/fields';
import type { FormatProfile } from '../format/profiles';
import { isMasked, looksLikeFullCardNumber, looksLikeResidentNumber, maskCard, maskResidentLike, scrubFreeText } from '../util/sensitive';
import { cellText, isBlankRow, normalizeHeader } from '../util/text';
import { parseVatTypeCell, type DouzoneVatTypeEntry } from '../wehago/codes';

// ────────────────────────────── 타입 ──────────────────────────────

export interface NormalizeContext {
  clientId: UUID;
  /** 수임처 사업자번호 (하이픈 허용) */
  businessNumber: string;
  channel: IngestChannel;
  /** 프로필 기본값 대신 쓸 원천 */
  source?: TransactionSource;
  /** 방향이 정해지지 않은 형식(generic·역수입 약칭)에 사용 */
  direction?: Direction;
  /** generic 형식의 증빙유형 */
  evidenceType?: EvidenceType;
  /** 헤더 행 위치 (없으면 판정 결과 또는 프로필로 탐지) */
  headerRowIndex?: number;
  /** 사용자가 확인한 열 매핑 (generic 필수) */
  columnMap?: ColumnMap;
  /** 수임처 부가세 과세유형 — 카드매출 합계 역산 시 면세사업자 판단 */
  clientVatType?: VatTaxpayerType;
  /** rawData.__sheet 에 기록 */
  sheetName?: string;
}

export type FailureCode =
  | 'invalid_date'
  | 'invalid_amount'
  | 'missing_amount'
  | 'amount_mismatch'
  | 'sign_mismatch'
  | 'exempt_vat_nonzero'
  | 'foreign_amount_not_won'
  | 'missing_counterparty'
  | 'client_mismatch'
  | 'direction_unknown'
  | 'vat_type_unknown'
  | 'invoice_group_conflict'
  | 'non_data_row';

export interface RowAmounts {
  supplyAmount: Won;
  vatAmount: Won;
  totalAmount: Won;
}

/** NormalizationFailure 확장 — 사유 코드와 (파싱 가능했던) 원본 금액 */
export interface RowFailure extends NormalizationFailure {
  code: FailureCode;
  /** 대사 source 단계 합계용. 합계행·금액 불명 행은 null */
  amounts: RowAmounts | null;
}

/** 세금계산서 품목 행처럼 다른 거래에 병합된 행 */
export interface MergedRow {
  sourceRowNumber: number;
  intoSourceRowNumber: number;
  reason: string;
}

export interface NormalizationWarning {
  sourceRowNumber: number | null;
  code: string;
  message: string;
}

export interface DerivationRecord {
  fields: string[];
  method:
    | 'vat_inclusive_10pct'
    | 'exempt_total_as_supply'
    | 'simplified_total_as_supply'
    | 'total_minus_supply'
    | 'total_minus_vat'
    | 'sum_of_components'
    | 'cancel_negated';
  note: string;
}

export interface NormalizeStats {
  dataRows: number;
  blankRows: number;
  transactions: number;
  failures: number;
  mergedRows: number;
  nonDataRows: number;
  derivedRows: number;
  cancelledRows: number;
  foreignRows: number;
}

export interface NormalizeResult {
  profileId: string;
  headerRowIndex: number;
  transactions: NormalizedTransaction[];
  failures: RowFailure[];
  mergedRows: MergedRow[];
  warnings: NormalizationWarning[];
  /** 파싱 가능한 모든 데이터 행(거래 + 금액이 읽힌 실패 행)의 합. 병합 행·합계 행 제외 */
  sourceTotals: AmountTotals;
  /** 파일 안 합계 행에 적힌 금액 (있을 때) */
  declaredTotals: AmountTotals | null;
  stats: NormalizeStats;
}

// ────────────────────────────── 진입점 ──────────────────────────────

function isDetection(x: FormatProfile | FormatDetection): x is FormatDetection {
  return 'profile' in x && 'columnMap' in x;
}

export function normalizeRows(
  profileOrDetection: FormatProfile | FormatDetection,
  rows: readonly (readonly unknown[])[],
  ctx: NormalizeContext,
): NormalizeResult {
  const detection = isDetection(profileOrDetection) ? profileOrDetection : null;
  const profile = detection ? detection.profile : (profileOrDetection as FormatProfile);

  if (!ctx.clientId) throw new AdapterError('INVALID_CONTEXT', '거래처(수임처)가 지정되지 않았습니다.');
  const clientBizNo = normalizeBusinessNumber(ctx.businessNumber);
  if (!clientBizNo) {
    throw new AdapterError('INVALID_CONTEXT', '수임처 사업자번호(10자리)가 필요합니다. 거래처 정보를 확인해 주세요.');
  }
  if (profile.purpose === 'transactions' && profile.direction === null && !ctx.direction) {
    throw new AdapterError('INVALID_CONTEXT', '이 형식은 매입/매출 구분을 직접 지정해야 합니다.');
  }

  // 헤더 위치·열 매핑 결정
  let headerRowIndex: number;
  let columnMap: ColumnMap;
  if (ctx.columnMap) {
    headerRowIndex = ctx.headerRowIndex ?? detection?.headerRowIndex ?? -1;
    columnMap = ctx.columnMap;
  } else if (detection) {
    if (detection.requiresUserMapping && !detection.userConfirmed) {
      throw new AdapterError('COLUMN_MAPPING_REQUIRED', `열 확인이 필요합니다 (${profile.name}). 누락: ${detection.missingColumns.join(', ') || '없음'} — 열 매핑을 지정해 주세요.`, {
        profileId: profile.id,
        missingColumns: detection.missingColumns,
      });
    }
    headerRowIndex = ctx.headerRowIndex ?? detection.headerRowIndex;
    columnMap = detection.columnMap;
  } else {
    if (profile.requiresUserMapping) {
      throw new AdapterError('COLUMN_MAPPING_REQUIRED', '이 형식은 열 매핑을 직접 지정해야 합니다.', { profileId: profile.id });
    }
    headerRowIndex = ctx.headerRowIndex ?? findHeaderRow(profile, rows);
    columnMap = headerRowIndex >= 0 ? resolveColumns(profile, rows[headerRowIndex] ?? []) : {};
  }
  if (headerRowIndex < 0 || headerRowIndex >= rows.length) {
    throw new AdapterError('HEADER_NOT_FOUND', `제목(헤더) 행을 찾지 못했습니다 (${profile.name}). 파일 형식을 확인해 주세요.`, { profileId: profile.id });
  }
  const missing = profile.columns.filter((c) => c.required && columnMap[c.field] === undefined).map((c) => c.field);
  if (missing.length > 0) {
    throw new AdapterError('COLUMN_MAPPING_REQUIRED', `필수 열이 없습니다: ${missing.map(fieldLabel).join(', ')}`, { missing });
  }

  return new RowNormalizer(profile, rows, headerRowIndex, columnMap, ctx, clientBizNo).run();
}

function findHeaderRow(profile: FormatProfile, rows: readonly (readonly unknown[])[]): number {
  const limit = Math.min(rows.length, profile.headerScanRows);
  for (let r = 0; r < limit; r++) {
    const row = rows[r];
    if (!row || isBlankRow(row)) continue;
    const map = resolveColumns(profile, row);
    if (profile.anchors.some((combo) => combo.every((f) => map[f] !== undefined))) return r;
  }
  return -1;
}

// ────────────────────────────── 구현 ──────────────────────────────

type Outcome =
  | { kind: 'tx'; tx: NormalizedTransaction; row: readonly unknown[] }
  | { kind: 'fail'; failure: RowFailure }
  | { kind: 'continuation'; sourceRowNumber: number; approvalKey: string; row: readonly unknown[]; raw: Record<string, unknown> };

class RowFailureSignal {
  constructor(
    readonly code: FailureCode,
    readonly reason: string,
    readonly field: string | undefined,
    readonly amounts: RowAmounts | null = null,
  ) {}
}

const NON_DATA_FIRST_CELL = /^(합\s*계|총\s*계|소\s*계|누\s*계|총\s*합\s*계|계|total|subtotal)(\s|\(|:|$)/i;

class RowNormalizer {
  private readonly headerKeys: string[];
  private readonly fieldAt = new Map<number, CanonicalField>();
  private readonly warnings: NormalizationWarning[] = [];
  private readonly cardSeq = new Map<string, number>();
  private readonly isInvoice: boolean;
  private readonly headerNorm: string;
  private declaredTotals: AmountTotals | null = null;
  private stats: NormalizeStats = {
    dataRows: 0,
    blankRows: 0,
    transactions: 0,
    failures: 0,
    mergedRows: 0,
    nonDataRows: 0,
    derivedRows: 0,
    cancelledRows: 0,
    foreignRows: 0,
  };

  constructor(
    private readonly profile: FormatProfile,
    private readonly rows: readonly (readonly unknown[])[],
    private readonly headerRowIndex: number,
    private readonly map: ColumnMap,
    private readonly ctx: NormalizeContext,
    private readonly clientBizNo: string,
  ) {
    const header = rows[headerRowIndex] ?? [];
    this.headerKeys = buildHeaderKeys(header, rows, headerRowIndex);
    for (const [f, i] of Object.entries(map) as Array<[CanonicalField, number]>) this.fieldAt.set(i, f);
    this.isInvoice = profile.evidenceType === 'tax_invoice' || profile.evidenceType === 'invoice_exempt';
    this.headerNorm = headerKeyOf(header);
  }

  run(): NormalizeResult {
    const outcomes: Outcome[] = [];
    for (let r = this.headerRowIndex + 1; r < this.rows.length; r++) {
      const row = this.rows[r] ?? [];
      if (isBlankRow(row)) {
        this.stats.blankRows++;
        continue;
      }
      this.stats.dataRows++;
      const sourceRowNumber = r - this.headerRowIndex;
      const raw = this.buildRaw(row, r);
      const nonData = this.nonDataReason(row);
      if (nonData) {
        this.stats.nonDataRows++;
        outcomes.push({ kind: 'fail', failure: { sourceRowNumber, rawData: raw, reason: nonData, code: 'non_data_row', amounts: null } });
        continue;
      }
      try {
        outcomes.push(this.normalizeOne(row, raw, sourceRowNumber));
      } catch (e) {
        if (!(e instanceof RowFailureSignal)) throw e;
        const failure: RowFailure = { sourceRowNumber, rawData: raw, reason: e.reason, code: e.code, amounts: e.amounts };
        if (e.field) failure.field = e.field;
        outcomes.push({ kind: 'fail', failure });
      }
    }

    const { transactions, failures, mergedRows } = this.isInvoice ? this.groupInvoiceItems(outcomes) : this.flatten(outcomes);

    for (const tx of transactions) tx.fingerprint = computeFingerprint(tx);

    const sourceTotals: AmountTotals = { count: 0, supplyAmount: 0, vatAmount: 0, totalAmount: 0 };
    for (const tx of transactions) addAmounts(sourceTotals, tx);
    for (const f of failures) if (f.amounts) addAmounts(sourceTotals, f.amounts);

    if (this.declaredTotals) this.compareDeclared(sourceTotals);

    this.stats.transactions = transactions.length;
    this.stats.failures = failures.length;
    this.stats.mergedRows = mergedRows.length;
    this.stats.derivedRows = transactions.filter((t) => Array.isArray(t.rawData.__derived)).length;
    this.stats.cancelledRows = transactions.filter((t) => t.totalAmount < 0).length;
    this.stats.foreignRows = transactions.filter((t) => t.isForeign).length;

    return {
      profileId: this.profile.id,
      headerRowIndex: this.headerRowIndex,
      transactions,
      failures,
      mergedRows,
      warnings: this.warnings,
      sourceTotals,
      declaredTotals: this.declaredTotals,
      stats: this.stats,
    };
  }

  // ── 행 단위 ──

  private get(row: readonly unknown[], f: CanonicalField): unknown {
    const i = this.map[f];
    return i === undefined ? undefined : row[i];
  }

  private text(row: readonly unknown[], f: CanonicalField): string {
    return cellText(this.get(row, f));
  }

  private normalizeOne(row: readonly unknown[], raw: Record<string, unknown>, sourceRowNumber: number): Outcome {
    const profile = this.profile;
    const derived: DerivationRecord[] = [];

    // 세금계산서 품목 연속행: 승인번호만 있고 금액 칸이 모두 비어 있음 → 같은 승인번호 거래에 병합
    if (this.isInvoice) {
      const apv = this.approvalOf(row, sourceRowNumber, false);
      const amountsBlank = (['supplyAmount', 'vatAmount', 'totalAmount'] as const).every((f) => this.text(row, f) === '');
      if (apv && amountsBlank) return { kind: 'continuation', sourceRowNumber, approvalKey: apv, row, raw };
    }

    // 1) 일자
    const dateRaw = this.get(row, 'transactionDate');
    const transactionDate = normalizeDate(typeof dateRaw === 'string' ? dateRaw.trim() : dateRaw);

    // 2) 방향 / 증빙 / 상대방
    let direction: Direction;
    let evidenceType: EvidenceType;
    let merchantName = '';
    let merchantBizRaw = '';
    let ledger: Record<string, unknown> | null = null;

    if (profile.purpose === 'reconciliation') {
      const dirHint = this.ledgerDirectionHint(row);
      const typeText = this.text(row, 'vatTypeCode');
      const { entry, ambiguous } = parseVatTypeCell(typeText, dirHint);
      if (!entry) {
        throw new RowFailureSignal(
          'vat_type_unknown',
          ambiguous
            ? `유형 "${typeText}"만으로는 매입/매출을 구분할 수 없습니다. 구분 열을 포함하거나 매입/매출을 지정해 주세요.`
            : `매입매출 유형 "${typeText}"을(를) 알 수 없습니다.`,
          'vatTypeCode',
          this.tryAmounts(row),
        );
      }
      direction = entry.direction;
      evidenceType = entry.evidenceType;
      merchantName = this.text(row, 'merchantName');
      merchantBizRaw = this.text(row, 'merchantBusinessNumber');
      ledger = this.ledgerInfo(row, entry);
    } else if (profile.direction === 'auto') {
      const sup = normalizeBusinessNumber(this.text(row, 'supplierBusinessNumber'));
      const buy = normalizeBusinessNumber(this.text(row, 'buyerBusinessNumber'));
      if (buy && buy === this.clientBizNo && sup !== this.clientBizNo) {
        direction = 'purchase';
        merchantName = this.text(row, 'supplierName');
        merchantBizRaw = this.text(row, 'supplierBusinessNumber');
      } else if (sup && sup === this.clientBizNo && buy !== this.clientBizNo) {
        direction = 'sales';
        merchantName = this.text(row, 'buyerName');
        merchantBizRaw = this.text(row, 'buyerBusinessNumber');
      } else if (sup && sup === buy) {
        throw new RowFailureSignal('direction_unknown', '공급자와 공급받는자 사업자번호가 같아 매입/매출을 판단할 수 없습니다.', 'supplierBusinessNumber', this.tryAmounts(row));
      } else {
        throw new RowFailureSignal(
          'client_mismatch',
          `공급자·공급받는자 사업자번호가 수임처(${formatBusinessNumber(this.clientBizNo)})와 일치하지 않습니다. 다른 거래처 자료인지 확인해 주세요.`,
          'buyerBusinessNumber',
          this.tryAmounts(row),
        );
      }
      evidenceType = profile.evidenceType ?? 'tax_invoice';
    } else {
      direction = profile.direction ?? this.ctx.direction!;
      evidenceType = profile.evidenceType ?? this.ctx.evidenceType ?? 'other';
      if (profile.direction === 'sales' && profile.evidenceType === 'card') {
        merchantName = this.text(row, 'cardCompany');
      } else {
        merchantName = this.text(row, 'merchantName');
        merchantBizRaw = this.text(row, 'merchantBusinessNumber');
      }
    }

    if (!transactionDate) {
      const t = cellText(dateRaw);
      throw new RowFailureSignal('invalid_date', t ? `거래일자 형식을 읽을 수 없습니다: "${t}"` : '거래일자가 비어 있습니다.', 'transactionDate', this.tryAmounts(row));
    }

    // 3) 해외/통화
    const curRaw = this.text(row, 'currency').toUpperCase();
    const currency = curRaw && !['KRW', '원', 'WON', '₩', '원화'].includes(curRaw) ? curRaw : 'KRW';
    const overseas = this.text(row, 'overseasFlag');
    const foreignAmt = this.text(row, 'foreignAmount');
    const isForeign =
      currency !== 'KRW' || /해외|국외|foreign|overseas|^y$/i.test(overseas) || (foreignAmt !== '' && foreignAmt !== '0' && parseWon(foreignAmt) !== 0);
    // 통화가 원화가 아닌데 외화금액 열이 따로 없으면, 금액 열이 원화 환산액인지 알 수 없다 → 원화로 가정하지 않는다
    if (currency !== 'KRW' && this.map.foreignAmount === undefined) {
      throw new RowFailureSignal(
        'foreign_amount_not_won',
        `통화가 ${currency}인데 외화금액 열이 따로 없어 금액이 원화 환산액인지 확인할 수 없습니다 — 원화 환산 금액이 있는 파일로 받아 주세요.`,
        'currency',
        null,
      );
    }

    // 4) 금액
    const amounts = this.resolveAmounts(row, { direction, evidenceType, isForeign, derived });

    // 5) 취소 거래
    const kind = this.text(row, 'transactionKind');
    const isCancelKind = /취소|반품|환불/.test(kind);
    if (isCancelKind && amounts.totalAmount > 0) {
      amounts.supplyAmount = -amounts.supplyAmount;
      amounts.vatAmount = -amounts.vatAmount;
      amounts.serviceCharge = -amounts.serviceCharge;
      amounts.totalAmount = -amounts.totalAmount;
      derived.push({ fields: ['supplyAmount', 'vatAmount', 'serviceCharge', 'totalAmount'], method: 'cancel_negated', note: `거래구분 "${kind}" → 음수 처리` });
    }
    const cancelled = amounts.totalAmount < 0;

    // 6) 상대방
    const merchantBusinessNumber = normalizeBusinessNumber(merchantBizRaw);
    if (merchantBizRaw && !merchantBusinessNumber && !looksLikeResidentNumber(merchantBizRaw)) {
      this.warn(sourceRowNumber, 'invalid_business_number', `상대방 사업자번호 형식이 올바르지 않습니다 (10자리 아님) — 사업자번호 없이 처리했습니다.`);
    } else if (merchantBusinessNumber && !isValidBusinessNumber(merchantBusinessNumber)) {
      this.warn(sourceRowNumber, 'business_number_checksum', `상대방 사업자번호 ${formatBusinessNumber(merchantBusinessNumber)} 의 검증번호가 맞지 않습니다.`);
    }
    merchantName = scrubFreeText(merchantName);
    if (!merchantName && !merchantBusinessNumber) {
      throw new RowFailureSignal(
        'missing_counterparty',
        profile.direction === 'sales' && profile.evidenceType === 'card' ? '카드사명이 비어 있습니다.' : '상호와 사업자번호가 모두 비어 있습니다.',
        profile.direction === 'sales' && profile.evidenceType === 'card' ? 'cardCompany' : 'merchantName',
        { supplyAmount: amounts.supplyAmount, vatAmount: amounts.vatAmount, totalAmount: amounts.totalAmount },
      );
    }

    // 7) 부가 정보
    const bizType = this.text(row, 'merchantBizType');
    const category = this.text(row, 'merchantCategory');
    const merchantCategory = [bizType, category].filter(Boolean).join(' / ') || null;
    const cardNumberMasked = maskCard(this.get(row, 'cardNumber'));
    const approvalNumber = this.approvalOf(row, sourceRowNumber, true);
    let originalSourceId: string | null = null;
    if (ledger && !approvalNumber) {
      const mgmt = this.text(row, 'managementNumber');
      originalSourceId = mgmt ? `wehago|${mgmt}` : null;
    }

    const baseDesc = scrubFreeText(this.text(row, 'itemName') || this.text(row, 'description'));
    const description = cancelled ? (baseDesc ? `취소 · ${baseDesc}` : '취소') : baseDesc;

    if (derived.length > 0) raw.__derived = derived;
    if (ledger) raw.__ledger = ledger;

    const tx: NormalizedTransaction = {
      clientId: this.ctx.clientId,
      businessNumber: this.clientBizNo,
      source: this.ctx.source ?? profile.source,
      channel: this.ctx.channel,
      direction,
      transactionDate,
      evidenceType,
      merchantName,
      merchantKey: normalizeMerchantName(merchantName),
      merchantBusinessNumber,
      merchantCategory,
      merchantTaxType: taxTypeOf(this.text(row, 'merchantTaxType')),
      description,
      supplyAmount: amounts.supplyAmount,
      vatAmount: amounts.vatAmount,
      serviceCharge: amounts.serviceCharge,
      totalAmount: amounts.totalAmount,
      cardNumberMasked,
      approvalNumber,
      originalSourceId,
      currency,
      isForeign,
      sourceDeductibleHint: deductibleHintOf(this.text(row, 'deductibleDecision')),
      rawData: raw,
      sourceRowNumber,
      fingerprint: '',
    };

    // 승인번호 없는 카드 매입: 같은 날·카드·가맹점·금액 반복 결제를 구분하는 원천ID (integration-architecture §4.2)
    if (evidenceType === 'card' && !approvalNumber && !originalSourceId) {
      const key = ['card', transactionDate, cardNumberMasked ?? '', merchantBusinessNumber ?? tx.merchantKey, amounts.totalAmount].join('|');
      const seq = (this.cardSeq.get(key) ?? 0) + 1;
      this.cardSeq.set(key, seq);
      tx.originalSourceId = `${key}#${seq}`;
      if (seq > 1) this.warn(sourceRowNumber, 'possible_duplicate', `같은 날 같은 가맹점·카드·금액 결제가 ${seq}번째입니다 — 중복 여부를 확인해 주세요.`);
    }
    return { kind: 'tx', tx, row };
  }

  /**
   * 승인번호. 엑셀이 숫자로 저장한 15자리 이상 값은 유효숫자 15자리 이후가 이미 손실되었을 수 있어
   * 식별자로 쓰지 않는다 (다른 계산서끼리 병합·중복 판정되는 사고 방지).
   */
  private approvalOf(row: readonly unknown[], sourceRowNumber: number, warn: boolean): string | null {
    const v = this.get(row, 'approvalNumber');
    if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) >= 1e15) {
      if (warn) {
        this.warn(sourceRowNumber, 'approval_number_precision', `승인번호가 숫자 셀(${cellText(v)})로 저장되어 뒷자리가 손실되었을 수 있습니다 — 승인번호 없이 처리했습니다. 원본을 텍스트 형식으로 내려받아 주세요.`);
      }
      return null;
    }
    return cellText(v).replace(/\s+/g, '') || null;
  }

  /** 금액 확정 (검산·역산). 실패 시 RowFailureSignal */
  private resolveAmounts(
    row: readonly unknown[],
    info: { direction: Direction; evidenceType: EvidenceType; isForeign: boolean; derived: DerivationRecord[] },
  ): { supplyAmount: Won; vatAmount: Won; serviceCharge: Won; totalAmount: Won } {
    const rule = this.profile.amountRule;
    const parse = (f: CanonicalField): Won | undefined => {
      if (this.map[f] === undefined) return undefined;
      const v = this.get(row, f);
      const t = cellText(v);
      if (t === '') return undefined;
      const n = parseWon(typeof v === 'number' ? v : t);
      if (n === null) {
        if (info.isForeign && /^-?[\d,]*\.\d+$/.test(t.replace(/\s/g, ''))) {
          throw new RowFailureSignal('foreign_amount_not_won', `해외결제 금액이 원 단위가 아닙니다 (${fieldLabel(f)}: "${t}") — 원화 환산 금액으로 받아 주세요.`, f, this.tryAmounts(row));
        }
        throw new RowFailureSignal('invalid_amount', `${fieldLabel(f)} 금액 형식 오류: "${t}"`, f, this.tryAmounts(row));
      }
      return n;
    };

    let supply = parse('supplyAmount');
    // 면세 형식: 세액 열이 없거나 비어 있으면 0, 있으면 읽어서 0 인지 검사한다 (세금계산서 오판정 방지)
    let vat = parse('vatAmount');
    if (vat === undefined && rule.vatAlwaysZero) vat = 0;
    const svc = rule.components.includes('serviceCharge') ? (parse('serviceCharge') ?? 0) : 0;
    const taxFree = rule.components.includes('taxFreeAmount') ? (parse('taxFreeAmount') ?? 0) : 0;
    const service = svc + taxFree;
    let total = parse('totalAmount');
    const snapshot = (): RowAmounts | null =>
      total === undefined && supply === undefined ? null : { supplyAmount: supply ?? 0, vatAmount: vat ?? 0, totalAmount: total ?? (supply ?? 0) + (vat ?? 0) + service };

    if (info.evidenceType === 'invoice_exempt' && vat !== undefined && vat !== 0) {
      throw new RowFailureSignal('exempt_vat_nonzero', `면세 계산서인데 세액이 ${formatWon(vat)}입니다. 원본을 확인해 주세요.`, 'vatAmount', snapshot());
    }

    if (supply !== undefined && total !== undefined) {
      if (vat === undefined) {
        vat = total - supply - service;
        info.derived.push({ fields: ['vatAmount'], method: 'total_minus_supply', note: `세액 없음 → 합계 ${formatWon(total)} − 공급가액 ${formatWon(supply)}${service ? ` − 봉사료/비과세 ${formatWon(service)}` : ''}` });
      }
    } else if (supply !== undefined) {
      if (vat === undefined) {
        throw new RowFailureSignal('missing_amount', '세액과 합계가 없어 금액을 확정할 수 없습니다.', 'totalAmount', snapshot());
      }
      total = supply + vat + service;
      info.derived.push({ fields: ['totalAmount'], method: 'sum_of_components', note: '합계 없음 → 공급가액 + 세액 (+ 봉사료/비과세)' });
    } else if (total !== undefined) {
      if (vat !== undefined) {
        supply = total - vat - service;
        info.derived.push({ fields: ['supplyAmount'], method: 'total_minus_vat', note: `공급가액 없음 → 합계 − 세액` });
      } else {
        const base = total - service;
        const mode = rule.totalOnly === 'by_tax_type' ? this.natureForDerivation(row, info.direction) : rule.totalOnly;
        if (mode === 'fail') {
          throw new RowFailureSignal('missing_amount', '공급가액·세액이 없습니다. 원본 파일의 금액 열을 확인해 주세요.', 'supplyAmount', {
            supplyAmount: 0,
            vatAmount: 0,
            totalAmount: total,
          });
        }
        if (mode === 'taxable') {
          const s = splitVatInclusive(base);
          supply = s.supplyAmount;
          vat = s.vatAmount;
          info.derived.push({ fields: ['supplyAmount', 'vatAmount'], method: 'vat_inclusive_10pct', note: `합계 ${formatWon(total)}만 있음 → 부가세 10% 포함가로 역산 (검토 필요)` });
        } else {
          supply = base;
          vat = 0;
          info.derived.push({
            fields: ['supplyAmount', 'vatAmount'],
            method: mode === 'simplified' ? 'simplified_total_as_supply' : 'exempt_total_as_supply',
            note: mode === 'simplified' ? '간이과세자 거래 — 합계를 공급가액으로, 세액 0' : '면세 — 합계를 공급가액으로, 세액 0',
          });
        }
      }
    } else {
      throw new RowFailureSignal('missing_amount', '금액이 비어 있습니다.', 'totalAmount', null);
    }

    const s = supply!;
    const v = vat ?? 0;
    const t = total!;
    const amounts = { supplyAmount: s, vatAmount: v, serviceCharge: service, totalAmount: t };
    const snap: RowAmounts = { supplyAmount: s, vatAmount: v, totalAmount: t };

    if (s + v + service !== t) {
      const diff = t - (s + v + service);
      throw new RowFailureSignal(
        'amount_mismatch',
        `금액 불일치: 공급가액 ${formatWon(s)} + 세액 ${formatWon(v)}${service ? ` + 봉사료/비과세 ${formatWon(service)}` : ''} ≠ 합계 ${formatWon(t)} (차이 ${formatWon(diff)})`,
        'totalAmount',
        snap,
      );
    }
    const nonZero = [s, v, service, t].filter((x) => x !== 0);
    if (nonZero.some((x) => x > 0) && nonZero.some((x) => x < 0)) {
      throw new RowFailureSignal('sign_mismatch', '금액의 부호(+/−)가 서로 다릅니다. 원본을 확인해 주세요.', 'totalAmount', snap);
    }
    return amounts;
  }

  /** 합계만 있을 때 과세/면세 판단 */
  private natureForDerivation(row: readonly unknown[], direction: Direction): 'taxable' | 'exempt' | 'simplified' {
    if (direction === 'sales') return this.ctx.clientVatType === 'exempt' ? 'exempt' : 'taxable';
    const t = taxTypeOf(this.text(row, 'merchantTaxType'));
    if (t === 'exempt') return 'exempt';
    if (t === 'simplified') return 'simplified';
    return 'taxable';
  }

  private tryAmounts(row: readonly unknown[]): RowAmounts | null {
    const p = (f: CanonicalField): Won | null => (this.map[f] === undefined ? null : parseWon(this.get(row, f) ?? null));
    const total = p('totalAmount');
    const supply = p('supplyAmount');
    const vat = p('vatAmount');
    if (total === null && supply === null) return null;
    return { supplyAmount: supply ?? 0, vatAmount: vat ?? 0, totalAmount: total ?? (supply ?? 0) + (vat ?? 0) };
  }

  // ── WEHAGO 역수입 ──

  private ledgerDirectionHint(row: readonly unknown[]): Direction | null {
    const label = this.text(row, 'directionLabel');
    if (/매입/.test(label)) return 'purchase';
    if (/매출/.test(label)) return 'sales';
    return this.ctx.direction ?? null;
  }

  private ledgerInfo(row: readonly unknown[], entry: DouzoneVatTypeEntry): Record<string, unknown> {
    const debit = parseAccountCell(this.text(row, 'debitAccount'));
    const credit = parseAccountCell(this.text(row, 'creditAccount'));
    const main = entry.direction === 'purchase' ? debit : credit;
    return {
      vatTypeCode: entry.code,
      vatTypeLabel: entry.label,
      debitAccount: debit,
      creditAccount: credit,
      accountCode: main?.code ?? null,
      accountName: main?.name ?? null,
      counterpartyCode: this.text(row, 'counterpartyCode') || null,
      voucherStatus: this.text(row, 'voucherStatus') || null,
      managementNumber: this.text(row, 'managementNumber') || null,
    };
  }

  // ── 합계/안내 행 ──

  private nonDataReason(row: readonly unknown[]): string | null {
    const cells = row.map(cellText).filter((t) => t !== '');
    if (cells.length === 0) return null;
    if (headerKeyOf(row) === this.headerNorm) return '제목 행이 반복되었습니다 (거래 아님).';
    const first = cells[0]!;
    const dateCell = this.text(row, 'transactionDate');
    if (NON_DATA_FIRST_CELL.test(first) || NON_DATA_FIRST_CELL.test(dateCell)) {
      const amounts = this.tryAmounts(row);
      if (amounts) {
        const t = this.declaredTotals ?? { count: 0, supplyAmount: 0, vatAmount: 0, totalAmount: 0 };
        // 여러 합계 행이 있으면 마지막(총계)을 쓴다
        this.declaredTotals = { count: t.count, ...amounts };
      }
      return '합계/소계 행입니다 (거래가 아니므로 적재하지 않음).';
    }
    if (cells.length === 1 && /^[※*\[(<]|조회|기준|출력/.test(first) && !normalizeDate(first)) {
      return '안내 문구 행입니다 (거래 아님).';
    }
    return null;
  }

  private compareDeclared(source: AmountTotals): void {
    const d = this.declaredTotals!;
    const diffs: string[] = [];
    if (d.totalAmount !== source.totalAmount) diffs.push(`합계 ${formatWon(d.totalAmount)} vs 행 합산 ${formatWon(source.totalAmount)}`);
    if (d.supplyAmount !== 0 && d.supplyAmount !== source.supplyAmount) diffs.push(`공급가액 ${formatWon(d.supplyAmount)} vs ${formatWon(source.supplyAmount)}`);
    if (d.vatAmount !== 0 && d.vatAmount !== source.vatAmount) diffs.push(`세액 ${formatWon(d.vatAmount)} vs ${formatWon(source.vatAmount)}`);
    if (diffs.length > 0) {
      this.warn(null, 'declared_total_mismatch', `파일 합계행과 행 합산이 다릅니다: ${diffs.join(', ')} — 누락·중복 행이 없는지 확인해 주세요.`);
    }
  }

  // ── 세금계산서 품목행 묶기 ──

  private flatten(outcomes: Outcome[]): { transactions: NormalizedTransaction[]; failures: RowFailure[]; mergedRows: MergedRow[] } {
    const transactions: NormalizedTransaction[] = [];
    const failures: RowFailure[] = [];
    for (const o of outcomes) {
      if (o.kind === 'tx') transactions.push(o.tx);
      else if (o.kind === 'fail') failures.push(o.failure);
      else failures.push(this.orphanContinuation(o));
    }
    return { transactions, failures, mergedRows: [] };
  }

  private orphanContinuation(o: Extract<Outcome, { kind: 'continuation' }>): RowFailure {
    return {
      sourceRowNumber: o.sourceRowNumber,
      rawData: o.raw,
      reason: '금액이 비어 있습니다 (같은 승인번호의 거래 행을 찾지 못함).',
      field: 'totalAmount',
      code: 'missing_amount',
      amounts: null,
    };
  }

  private groupInvoiceItems(outcomes: Outcome[]): { transactions: NormalizedTransaction[]; failures: RowFailure[]; mergedRows: MergedRow[] } {
    const groups = new Map<string, Array<Extract<Outcome, { kind: 'tx' }>>>();
    for (const o of outcomes) {
      if (o.kind !== 'tx' || !o.tx.approvalNumber) continue;
      const key = `${o.tx.direction}|${o.tx.approvalNumber}`;
      const g = groups.get(key);
      if (g) g.push(o);
      else groups.set(key, [o]);
    }
    const drop = new Set<Outcome>();
    const conflictFailures = new Map<Outcome, RowFailure>();
    const mergedRows: MergedRow[] = [];

    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const head = g[0]!;
      const same = g.every(
        (o) => o.tx.supplyAmount === head.tx.supplyAmount && o.tx.vatAmount === head.tx.vatAmount && o.tx.totalAmount === head.tx.totalAmount,
      );
      if (same) {
        const items = [this.itemOf(head.row, head.tx.sourceRowNumber!)];
        for (const o of g.slice(1)) {
          items.push(this.itemOf(o.row, o.tx.sourceRowNumber!));
          drop.add(o);
          mergedRows.push({ sourceRowNumber: o.tx.sourceRowNumber!, intoSourceRowNumber: head.tx.sourceRowNumber!, reason: `승인번호 ${head.tx.approvalNumber} 의 품목 행` });
        }
        head.tx.rawData.__items = items;
      } else {
        for (const o of g) {
          conflictFailures.set(o, {
            sourceRowNumber: o.tx.sourceRowNumber!,
            rawData: o.tx.rawData,
            reason: `같은 승인번호(${o.tx.approvalNumber})의 행 ${g.length}개가 서로 다른 금액입니다. 수정세금계산서·품목행 여부를 원본에서 확인해 주세요.`,
            field: 'approvalNumber',
            code: 'invoice_group_conflict',
            amounts: { supplyAmount: o.tx.supplyAmount, vatAmount: o.tx.vatAmount, totalAmount: o.tx.totalAmount },
          });
        }
      }
    }

    // 품목 연속행(금액 빈칸) → 같은 승인번호 거래에 병합
    const parentByApproval = new Map<string, Extract<Outcome, { kind: 'tx' }>>();
    for (const o of outcomes) {
      if (o.kind === 'tx' && o.tx.approvalNumber && !drop.has(o) && !conflictFailures.has(o) && !parentByApproval.has(o.tx.approvalNumber)) {
        parentByApproval.set(o.tx.approvalNumber, o);
      }
    }

    const transactions: NormalizedTransaction[] = [];
    const failures: RowFailure[] = [];
    for (const o of outcomes) {
      if (o.kind === 'fail') failures.push(o.failure);
      else if (o.kind === 'tx') {
        const cf = conflictFailures.get(o);
        if (cf) failures.push(cf);
        else if (!drop.has(o)) transactions.push(o.tx);
      } else {
        const parent = parentByApproval.get(o.approvalKey);
        if (!parent) {
          failures.push(this.orphanContinuation(o));
          continue;
        }
        const ptx = parent.tx;
        const items = (ptx.rawData.__items as Array<Record<string, unknown>> | undefined) ?? [this.itemOf(parent.row, ptx.sourceRowNumber!)];
        items.push(this.itemOf(o.row, o.sourceRowNumber));
        ptx.rawData.__items = items;
        mergedRows.push({ sourceRowNumber: o.sourceRowNumber, intoSourceRowNumber: ptx.sourceRowNumber!, reason: `승인번호 ${ptx.approvalNumber} 의 품목 행 (금액 빈칸)` });
      }
    }
    for (const tx of transactions) {
      const items = tx.rawData.__items as Array<Record<string, unknown>> | undefined;
      if (items) this.checkItemSum(tx, items);
    }
    mergedRows.sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);
    return { transactions, failures, mergedRows };
  }

  private itemOf(row: readonly unknown[], sourceRowNumber: number): Record<string, unknown> {
    const pick = (f: CanonicalField) => {
      const t = this.text(row, f);
      return t === '' ? null : t;
    };
    return {
      sourceRowNumber,
      itemDate: pick('itemDate'),
      itemName: pick('itemName') ? scrubFreeText(pick('itemName')!) : null,
      itemSpec: pick('itemSpec'),
      itemQuantity: pick('itemQuantity'),
      itemUnitPrice: pick('itemUnitPrice'),
      itemSupplyAmount: pick('itemSupplyAmount'),
      itemVatAmount: pick('itemVatAmount'),
    };
  }

  private checkItemSum(tx: NormalizedTransaction, items: Array<Record<string, unknown>>): void {
    const vals = items.map((i) => parseWon(i.itemSupplyAmount ?? null));
    if (vals.some((v) => v === null)) return;
    const sum = (vals as number[]).reduce((a, b) => a + b, 0);
    if (sum !== tx.supplyAmount) {
      this.warn(tx.sourceRowNumber, 'item_sum_mismatch', `승인번호 ${tx.approvalNumber}: 품목 공급가액 합 ${formatWon(sum)} ≠ 공급가액 ${formatWon(tx.supplyAmount)}`);
    }
  }

  // ── rawData ──

  private buildRaw(row: readonly unknown[], rowIndex: number): Record<string, unknown> {
    const raw: Record<string, unknown> = {};
    const n = Math.max(row.length, this.headerKeys.length);
    for (let i = 0; i < n; i++) {
      const v = row[i];
      if (v === null || v === undefined || v === '') continue;
      const key = this.headerKeys[i] ?? `열${i + 1}`;
      raw[key] = this.scrubCell(i, key, v);
    }
    raw.__row = rowIndex + 1;
    if (this.ctx.sheetName) raw.__sheet = this.ctx.sheetName;
    return raw;
  }

  /** 열별 마스킹 방식 (행마다 헤더 정규식을 돌리지 않도록 캐시) */
  private readonly colKind = new Map<number, 'card' | 'rrn' | 'identifier' | 'free'>();

  private kindOf(col: number, header: string): 'card' | 'rrn' | 'identifier' | 'free' {
    let k = this.colKind.get(col);
    if (!k) {
      const field = this.fieldAt.get(col);
      if (field === 'cardNumber' || /카드번호/.test(header)) k = 'card';
      else if (/주민|외국인등록|생년월일/.test(header)) k = 'rrn';
      else if (field && (IDENTIFIER_FIELDS.has(field) || AMOUNT_FIELDS.has(field) || field === 'transactionDate')) k = 'identifier';
      else k = 'free';
      this.colKind.set(col, k);
    }
    return k;
  }

  private scrubCell(col: number, header: string, v: unknown): unknown {
    const kind = this.kindOf(col, header);
    const value: unknown = v instanceof Date ? (Number.isNaN(v.getTime()) ? null : v.toISOString()) : v;
    if (kind === 'card') return maskCard(value);
    // 정수 셀은 2^53 을 넘어도 자릿수 그대로 문자열화한다 (cellText 는 BigInt 경로)
    const s = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isInteger(value) ? cellText(value) : null;
    if (s === null) return value;
    if (kind === 'rrn') return looksLikeResidentNumber(s) ? maskResidentLike(s) : s.replace(/\d/g, '*');
    // 공급받는자 등록번호 자리에 주민번호가 오는 경우(개인 발급분)까지 마스킹
    if (s.length >= 13 && looksLikeResidentNumber(s)) return maskResidentLike(s);
    if (kind === 'identifier') return value;
    // 2^53 을 넘는 숫자 셀은 이미 정밀도가 깨져 Luhn 확인이 무의미하다 → 13~19자리면 카드번호로 보고 마스킹
    if (typeof value === 'number' && !Number.isSafeInteger(value) && s.length >= 13 && s.length <= 19) return maskCard(s);
    if (s.length >= 13 && !isMasked(s) && looksLikeFullCardNumber(s)) return maskCard(s);
    // 숫자가 13개 미만이면 카드번호·주민번호가 들어 있을 수 없다
    return typeof value === 'string' && digitCount(value) >= 13 ? scrubFreeText(value) : value;
  }

  private warn(sourceRowNumber: number | null, code: string, message: string): void {
    this.warnings.push({ sourceRowNumber, code, message });
  }
}

// ────────────────────────────── 헬퍼 ──────────────────────────────

function digitCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) n++;
  }
  return n;
}

function headerKeyOf(row: readonly unknown[]): string {
  const cells = row.map(normalizeHeader);
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells.join('|');
}

function buildHeaderKeys(header: readonly unknown[], rows: readonly (readonly unknown[])[], headerRowIndex: number): string[] {
  let width = header.length;
  for (let r = headerRowIndex + 1; r < rows.length; r++) width = Math.max(width, rows[r]?.length ?? 0);
  const seen = new Map<string, number>();
  const keys: string[] = [];
  for (let i = 0; i < width; i++) {
    const base = cellText(header[i]).replace(/\s+/g, ' ') || `열${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    keys.push(n === 1 ? base : `${base}(${n})`);
  }
  return keys;
}

function addAmounts(t: AmountTotals, a: { supplyAmount: Won; vatAmount: Won; totalAmount: Won }): void {
  t.count += 1;
  t.supplyAmount += a.supplyAmount;
  t.vatAmount += a.vatAmount;
  t.totalAmount += a.totalAmount;
}

export function taxTypeOf(label: string): NormalizedTransaction['merchantTaxType'] {
  if (!label) return 'unknown';
  if (/간이/.test(label)) return 'simplified';
  if (/면세/.test(label)) return 'exempt';
  if (/일반|법인|과세/.test(label)) return 'general';
  return 'unknown';
}

export function deductibleHintOf(label: string): boolean | null {
  const s = label.replace(/\s+/g, '');
  if (!s) return null;
  if (/불공제|불공|^N$|^n$|아니오/.test(s)) return false;
  if (/공제|^Y$|^y$|예/.test(s)) return true;
  return null;
}

/** "830 소모품비", "83000.소모품비", "소모품비" → { code, name } */
export function parseAccountCell(text: string): { code: string | null; name: string } | null {
  const s = text.trim();
  if (!s) return null;
  const m = /^(\d{3,5})\s*[.\-:)]?\s*(.*)$/.exec(s);
  if (m) return { code: m[1]!, name: m[2]!.trim() };
  return { code: null, name: s };
}

/** WEHAGO 역수입 행 → core 대사 입력(ReconWehagoRow 호환) */
export interface WehagoLedgerRow {
  date: string;
  merchantName: string;
  supplyAmount: Won;
  vatAmount: Won;
  totalAmount: Won;
  accountCode?: string | null;
}

export function toWehagoLedgerRows(transactions: readonly NormalizedTransaction[]): WehagoLedgerRow[] {
  return transactions.map((t) => {
    const ledger = t.rawData.__ledger as { accountCode?: string | null } | undefined;
    return {
      date: t.transactionDate,
      merchantName: t.merchantName,
      supplyAmount: t.supplyAmount,
      vatAmount: t.vatAmount,
      totalAmount: t.totalAmount,
      accountCode: ledger?.accountCode ?? null,
    };
  });
}
