import type { EvidenceType, JournalEntry, JournalLine, NormalizedTransaction, VatClassification, Won } from '../types';

export interface JournalAccountRef {
  code: string;
  name: string;
}

/** 분개에 필요한 판단 결과 (TransactionDecision 에서 뽑거나 사람이 확정한 값) */
export interface JournalDecision {
  accountCode: string | null;
  accountName: string | null;
  deductible: boolean | null;
  vatType?: VatClassification['vatType'] | null;
}

export interface JournalOptions {
  transactionId?: string;
  /** 매입 상대계정 덮어쓰기 (증빙별) */
  payableAccounts?: Partial<Record<EvidenceType, JournalAccountRef>>;
  /** 매출 상대계정 덮어쓰기 (증빙별) */
  receivableAccounts?: Partial<Record<EvidenceType, JournalAccountRef>>;
  /** 현금영수증 매입 대변: 'cash'(101 현금, 기본) | 'payable'(253 미지급금) */
  cashReceiptCredit?: 'cash' | 'payable';
  vatReceivable?: JournalAccountRef; // 135 부가세대급금
  vatPayable?: JournalAccountRef; // 255 부가세예수금
  /** 매출 봉사료 계정 (기본: 매출 계정에 합산) */
  salesServiceChargeAccount?: JournalAccountRef;
  /** 매출 계정이 비었을 때 기본 (401 상품매출) */
  defaultRevenueAccount?: JournalAccountRef;
}

// 계정코드는 data/accounts.ts 기본표 기준 (101·103·108·135·251·253·255·401 은 [공식/커뮤니티], 나머지 검증필요)
const CASH: JournalAccountRef = { code: '101', name: '현금' };
const BANK: JournalAccountRef = { code: '103', name: '보통예금' };
const AR: JournalAccountRef = { code: '108', name: '외상매출금' };
const AP_TRADE: JournalAccountRef = { code: '251', name: '외상매입금' };
const AP_OTHER: JournalAccountRef = { code: '253', name: '미지급금' };
const VAT_IN: JournalAccountRef = { code: '135', name: '부가세대급금' };
const VAT_OUT: JournalAccountRef = { code: '255', name: '부가세예수금' };
const REVENUE: JournalAccountRef = { code: '401', name: '상품매출' };

/** 매입 대변(지급) 계정 기본값 */
export function defaultPayableAccount(evidence: EvidenceType, cashReceiptCredit: 'cash' | 'payable' = 'cash'): JournalAccountRef {
  switch (evidence) {
    case 'card':
      return AP_OTHER;
    case 'cash_receipt':
      return cashReceiptCredit === 'payable' ? AP_OTHER : CASH;
    case 'tax_invoice':
    case 'invoice_exempt':
      return AP_TRADE;
    case 'bank':
      return BANK;
    default:
      return CASH;
  }
}

/** 매출 차변(수취) 계정 기본값 */
export function defaultReceivableAccount(evidence: EvidenceType): JournalAccountRef {
  switch (evidence) {
    case 'cash_receipt':
      return CASH;
    case 'bank':
      return BANK;
    default:
      return AR;
  }
}

/**
 * 거래 → 분개.
 * 매입
 * - 공제: 차) 비용(공급가액+봉사료) / 차) 135 부가세대급금(세액) / 대) 지급계정(합계)
 * - 불공제: 차) 비용(공급가액+세액+봉사료) / 대) 지급계정(합계) — 불공제 세액은 비용·원가에 합산 (법인세법 시행령 제22조①)
 * - 공제여부 미확정(null): 공제 기준 잠정 분개 + 메모
 * 매출: 차) 수취계정(합계) / 대) 매출(공급가액[+봉사료]) / 대) 255 부가세예수금(세액)
 * 합계가 구성요소와 다르면 억지로 맞추지 않는다 → validateBalanced() 가 차이를 보여준다.
 */
export function buildJournalEntry(tx: NormalizedTransaction, decision: JournalDecision, opts: JournalOptions = {}): JournalEntry {
  if (!decision.accountCode) throw new Error('계정과목이 지정되지 않아 분개를 만들 수 없습니다.');
  const main: JournalAccountRef = { code: decision.accountCode, name: decision.accountName ?? decision.accountCode };
  const party = { counterpartyName: tx.merchantName, counterpartyBusinessNumber: tx.merchantBusinessNumber };
  const memo = tx.description || tx.merchantName;
  const lines: JournalLine[] = [];
  const add = (side: JournalLine['side'], acc: JournalAccountRef, amount: Won, lineMemo = memo) => {
    if (amount !== 0) lines.push({ side, accountCode: acc.code, accountName: acc.name, amount, ...party, memo: lineMemo });
  };

  if (tx.direction === 'purchase') {
    const payable = opts.payableAccounts?.[tx.evidenceType] ?? defaultPayableAccount(tx.evidenceType, opts.cashReceiptCredit);
    const splitVat = decision.deductible !== false;
    if (splitVat) {
      add('debit', main, tx.supplyAmount + tx.serviceCharge);
      add('debit', opts.vatReceivable ?? VAT_IN, tx.vatAmount, decision.deductible === null ? `${memo} (공제여부 검토 필요)` : memo);
    } else {
      add('debit', main, tx.supplyAmount + tx.vatAmount + tx.serviceCharge, tx.vatAmount !== 0 ? `${memo} (불공제 세액 포함)` : memo);
    }
    add('credit', payable, tx.totalAmount);
  } else {
    const receivable = opts.receivableAccounts?.[tx.evidenceType] ?? defaultReceivableAccount(tx.evidenceType);
    add('debit', receivable, tx.totalAmount);
    if (opts.salesServiceChargeAccount) {
      add('credit', main, tx.supplyAmount);
      add('credit', opts.salesServiceChargeAccount, tx.serviceCharge);
    } else {
      add('credit', main, tx.supplyAmount + tx.serviceCharge);
    }
    add('credit', opts.vatPayable ?? VAT_OUT, tx.vatAmount);
  }

  return {
    transactionId: opts.transactionId ?? tx.originalSourceId ?? tx.fingerprint,
    date: tx.transactionDate,
    lines,
  };
}

/** 매출 계정이 없을 때 쓰는 기본 매출 계정으로 분개 */
export function buildSalesJournalWithDefault(tx: NormalizedTransaction, decision: JournalDecision, opts: JournalOptions = {}): JournalEntry {
  const rev = opts.defaultRevenueAccount ?? REVENUE;
  return buildJournalEntry(
    tx,
    { ...decision, accountCode: decision.accountCode ?? rev.code, accountName: decision.accountName ?? rev.name },
    opts,
  );
}

export interface BalanceCheck {
  balanced: boolean;
  debit: Won;
  credit: Won;
  /** 차변 − 대변 */
  diff: Won;
  /** 원 단위 정수가 아닌 금액이 있는 줄 번호 (0-base) */
  invalidLines: number[];
}

/** 차대 균형 검증 (1원도 허용하지 않음) */
export function validateBalanced(entry: Pick<JournalEntry, 'lines'>): BalanceCheck {
  let debit = 0;
  let credit = 0;
  const invalidLines: number[] = [];
  entry.lines.forEach((l, i) => {
    if (!Number.isSafeInteger(l.amount)) invalidLines.push(i);
    if (l.side === 'debit') debit += l.amount;
    else credit += l.amount;
  });
  const diff = debit - credit;
  return { balanced: diff === 0 && invalidLines.length === 0, debit, credit, diff, invalidLines };
}
