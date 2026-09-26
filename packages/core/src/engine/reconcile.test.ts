import { describe, expect, it } from 'vitest';
import type { TransactionStatus } from '../types';
import { reconcile, type ReconExportRow, type ReconSourceRow, type ReconTransaction, type ReconcileInput } from './reconcile';

const scope = { period: '2026-09', clientName: '테스트상사' };

function tx(id: string, total: number, o: Partial<ReconTransaction> = {}): ReconTransaction {
  const supply = Math.round(total / 1.1);
  return {
    id,
    status: 'approved' as TransactionStatus,
    evidenceType: 'card',
    accountCode: '830',
    accountName: '소모품비',
    supplyAmount: supply,
    vatAmount: total - supply,
    totalAmount: total,
    transactionDate: '2026-09-10',
    merchantName: `상점${id}`,
    ...o,
  };
}
function row(rowNumber: number, t: ReconTransaction | null, o: Partial<ReconSourceRow> = {}): ReconSourceRow {
  return {
    rowNumber,
    outcome: 'ok',
    transactionId: t?.id ?? null,
    date: t?.transactionDate ?? null,
    merchantName: t?.merchantName ?? null,
    supplyAmount: t?.supplyAmount ?? null,
    vatAmount: t?.vatAmount ?? null,
    totalAmount: t?.totalAmount ?? null,
    ...o,
  };
}
const exp = (t: ReconTransaction, o: Partial<ReconExportRow> = {}): ReconExportRow => ({
  transactionId: t.id,
  supplyAmount: t.supplyAmount,
  vatAmount: t.vatAmount,
  totalAmount: t.totalAmount,
  accountCode: t.accountCode,
  ...o,
});

/** 기본 시나리오: 승인 3건 + 중복 1건 (ABC마트 32,500원) */
function base(): { txs: ReconTransaction[]; rows: ReconSourceRow[]; dup: ReconTransaction } {
  const a = tx('t1', 11000);
  const b = tx('t2', 55000, { evidenceType: 'tax_invoice', accountCode: '811', accountName: '복리후생비' });
  const c = tx('t3', 220000);
  const dup = tx('t4', 32500, { status: 'duplicate', transactionDate: '2026-09-12', merchantName: 'ABC마트', accountCode: null, accountName: null });
  return { txs: [a, b, c, dup], rows: [row(1, a), row(2, b), row(3, c), row(4, dup, { outcome: 'duplicate' })], dup };
}

describe('reconcile — 균형', () => {
  it('원본 = 전송 + 중복: 1원 단위 일치, 전송 가능, 중복 설명 문구', () => {
    const { txs, rows } = base();
    const r = reconcile({ source: { rows }, transactions: txs, exportRows: txs.slice(0, 3).map((t) => exp(t)), scope });
    expect(r.balanced).toBe(true);
    expect(r.exportAllowed).toBe(true);
    expect(r.equation.residual).toEqual({ count: 0, supplyAmount: 0, vatAmount: 0, totalAmount: 0 });
    expect(r.equation.terms.export).toMatchObject({ count: 3, totalAmount: 286000 });
    expect(r.equation.terms.duplicate).toMatchObject({ count: 1, totalAmount: 32500 });
    expect(r.stages.source).toMatchObject({ count: 4, totalAmount: 318500 });
    expect(r.stages.processed).toMatchObject({ count: 3, totalAmount: 286000 });
    const d = r.discrepancies.find((x) => x.kind === 'duplicate_excluded');
    expect(d?.message).toBe('2026-09-12 ABC마트 32,500원 거래가 중복판정으로 제외되었습니다.');
    expect(d?.blocking).toBe(false);
    expect(r.summary).toContain('1원 단위까지 일치');
    expect(r.summary).toContain('전송 가능');
    // 소계
    expect(r.byEvidenceType.card!.export).toMatchObject({ count: 2, totalAmount: 231000 });
    expect(r.byEvidenceType.tax_invoice!.source).toMatchObject({ count: 1, totalAmount: 55000 });
    expect(r.byAccount['811']!.export).toMatchObject({ count: 1 });
    expect(r.byAccount['미분류']!.source).toMatchObject({ count: 1, totalAmount: 32500 });
    expect(r.accountNames['830']).toBe('소모품비');
  });

  it('중복 사유가 있으면 이어서 설명', () => {
    const { txs, rows, dup } = base();
    dup.duplicateReason = '승인번호 30012345 동일';
    const r = reconcile({ source: { rows }, transactions: txs, exportRows: txs.slice(0, 3).map((t) => exp(t)), scope });
    expect(r.discrepancies.find((x) => x.kind === 'duplicate_excluded')?.message).toBe(
      '2026-09-12 ABC마트 32,500원 거래가 중복판정으로 제외되었습니다. 사유: 승인번호 30012345 동일',
    );
  });

  it('전송 전(전송파일 없음): 승인분을 전송준비로 보고 균형 확인', () => {
    const { txs, rows } = base();
    const r = reconcile({ source: { rows }, transactions: txs, scope });
    expect(r.equation.exportBasis).toBe('ready');
    expect(r.balanced).toBe(true);
    expect(r.exportAllowed).toBe(true);
    expect(r.summary).toContain('전송준비 3건');
  });

  it('사용자 제외: 사유와 함께 설명, 차단하지 않음', () => {
    const { txs, rows } = base();
    txs[2]!.status = 'excluded';
    txs[2]!.excludedReason = '대표자 개인 사용분';
    const r = reconcile({ source: { rows }, transactions: txs, exportRows: txs.slice(0, 2).map((t) => exp(t)), scope });
    expect(r.balanced).toBe(true);
    expect(r.exportAllowed).toBe(true);
    const d = r.discrepancies.find((x) => x.kind === 'user_excluded')!;
    expect(d.message).toBe('2026-09-10 상점t3 220,000원 거래가 사용자에 의해 제외되었습니다. 사유: 대표자 개인 사용분');
    expect(d.blocking).toBe(false);
  });

  it('여러 원본 행이 한 거래로 묶이면 거래 단위로 센다', () => {
    const t = tx('m1', 110000, { evidenceType: 'tax_invoice' });
    const rows = [
      row(1, t, { supplyAmount: 60000, vatAmount: 6000, totalAmount: 66000 }),
      row(2, t, { supplyAmount: 40000, vatAmount: 4000, totalAmount: 44000 }),
    ];
    const r = reconcile({ source: { rows }, transactions: [t], exportRows: [exp(t)], scope });
    expect(r.stages.source).toMatchObject({ count: 1, totalAmount: 110000 });
    expect(r.balanced).toBe(true);
    expect(r.exportAllowed).toBe(true);
  });

  it('원본 행이 없는 거래(수기 입력)는 거래 자체를 원본으로 본다', () => {
    const { txs, rows } = base();
    const manual = tx('m9', 5000, { evidenceType: 'other' });
    const r = reconcile({ source: { rows }, transactions: [...txs, manual], exportRows: [...txs.slice(0, 3), manual].map((t) => exp(t)), scope });
    expect(r.balanced).toBe(true);
    expect(r.stages.source).toMatchObject({ count: 5 });
  });
});

describe('reconcile — 차단', () => {
  it('전송파일 1원 차이 → 불균형, 전송 불가', () => {
    const { txs, rows } = base();
    const ex = txs.slice(0, 3).map((t) => exp(t));
    ex[1] = { ...ex[1]!, supplyAmount: ex[1]!.supplyAmount + 1, totalAmount: ex[1]!.totalAmount + 1 };
    const r = reconcile({ source: { rows }, transactions: txs, exportRows: ex, scope });
    expect(r.balanced).toBe(false);
    expect(r.exportAllowed).toBe(false);
    expect(r.equation.residual).toEqual({ count: 0, supplyAmount: -1, vatAmount: 0, totalAmount: -1 });
    const d = r.discrepancies.find((x) => x.kind === 'amount_mismatch')!;
    expect(d.blocking).toBe(true);
    expect(d.message).toBe('2026-09-10 상점t2 55,000원: 전송파일 금액이 거래 금액과 다릅니다 (공급가액 50,001원 ≠ 50,000원, 차이 1원 / 합계 55,001원 ≠ 55,000원, 차이 1원).');
    expect(r.summary).toContain('설명되지 않은 차이');
    expect(r.summary).toContain('전송할 수 없습니다');
  });

  it('검토 대기 → 균형이어도 전송 불가, 정확한 문구', () => {
    const a = tx('a', 11000);
    const p1 = tx('p1', 100000, { status: 'needs_review' });
    const p2 = tx('p2', 45000, { status: 'classified' });
    const r = reconcile({ source: { rows: [row(1, a), row(2, p1), row(3, p2)] }, transactions: [a, p1, p2], exportRows: [exp(a)], scope });
    expect(r.balanced).toBe(true);
    expect(r.exportAllowed).toBe(false);
    expect(r.pendingReview).toMatchObject({ count: 2, totalAmount: 145000 });
    const d = r.discrepancies.find((x) => x.kind === 'pending_review')!;
    expect(d.message).toBe('검토 대기 2건(합계 145,000원)이 남아 있어 전송할 수 없습니다.');
    expect(d.blocking).toBe(true);
    expect(r.summary).toContain('검토 대기 2건');
  });

  it('승인됐는데 전송파일에 없음 → 정확한 문구로 설명, 전송 불가', () => {
    const { txs, rows } = base();
    const x = tx('t5', 110000, { transactionDate: '2026-09-20', merchantName: 'XYZ상사' });
    const r = reconcile({
      source: { rows: [...rows, row(5, x)] },
      transactions: [...txs, x],
      exportRows: txs.slice(0, 3).map((t) => exp(t)),
      scope,
    });
    expect(r.balanced).toBe(true); // 대기 항으로 설명됨
    expect(r.exportAllowed).toBe(false);
    const d = r.discrepancies.find((k) => k.kind === 'missing_in_export')!;
    expect(d.message).toBe('2026-09-20 XYZ상사 110,000원 거래가 승인되었으나 전송파일에 없습니다.');
    expect(d.blocking).toBe(true);
    expect(d.transactionId).toBe('t5');
    expect(r.expected.count).toBe(4);
  });

  it('금액 해석 실패 행 → 행 번호와 원문으로 설명, 차단', () => {
    const { txs, rows } = base();
    const failed: ReconSourceRow = { rowNumber: 3, outcome: 'failed', errorReason: "금액을 해석할 수 없어 수집 실패 (원본: '3,2OO')" };
    const r = reconcile({ source: { rows: [...rows, failed] }, transactions: txs, exportRows: txs.slice(0, 3).map((t) => exp(t)), scope });
    const d = r.discrepancies.find((x) => x.kind === 'parse_failed')!;
    expect(d.message).toBe("3행: 금액을 해석할 수 없어 수집 실패 (원본: '3,2OO')");
    expect(d.blocking).toBe(true);
    expect(r.equation.terms.failed.count).toBe(1);
    expect(r.balanced).toBe(true);
    expect(r.exportAllowed).toBe(false);
  });

  it('금액이 있는 실패 행은 금액도 함께, 사유에 "실패"가 없으면 보충', () => {
    const r = reconcile({ source: { rows: [{ rowNumber: 9, outcome: 'failed', errorReason: '일자를 해석할 수 없습니다', supplyAmount: 1000, vatAmount: 100, totalAmount: 1100 }] }, transactions: [], scope });
    expect(r.discrepancies[0]!.message).toBe('9행: 일자를 해석할 수 없습니다 (수집 실패) — 합계 1,100원');
    expect(r.equation.terms.failed).toMatchObject({ count: 1, totalAmount: 1100 });
    expect(r.balanced).toBe(true);
  });

  it('원본에 없는 거래가 전송파일에 있음 → 차단, 불균형', () => {
    const { txs, rows } = base();
    const r = reconcile({
      source: { rows },
      transactions: txs,
      exportRows: [...txs.slice(0, 3).map((t) => exp(t)), { transactionId: null, supplyAmount: 1000, vatAmount: 100, totalAmount: 1100, accountCode: '830', rowNumber: 4 }],
      scope,
    });
    expect(r.balanced).toBe(false);
    expect(r.exportAllowed).toBe(false);
    expect(r.discrepancies.find((x) => x.kind === 'extra_in_export')!.message).toBe('전송파일 4행(합계 1,100원)은 원본 자료에 없는 거래입니다.');
  });

  it('중복 거래가 전송파일에 포함 / 같은 거래 두 번 → 차단', () => {
    const { txs, rows, dup } = base();
    const r = reconcile({ source: { rows }, transactions: txs, exportRows: [...txs.slice(0, 3).map((t) => exp(t)), exp(dup), exp(txs[0]!)], scope });
    const msgs = r.discrepancies.filter((x) => x.kind === 'extra_in_export').map((x) => x.message);
    expect(msgs).toContain('2026-09-12 ABC마트 32,500원 거래는 중복판정 상태인데 전송파일에 포함되어 있습니다.');
    expect(msgs).toContain('2026-09-10 상점t1 11,000원 거래가 전송파일에 2번 들어 있습니다.');
    expect(r.exportAllowed).toBe(false);
  });

  it('검토 전 거래가 전송파일에 들어감 → 차단', () => {
    const a = tx('a', 11000, { status: 'needs_review' });
    const r = reconcile({ source: { rows: [row(1, a)] }, transactions: [a], exportRows: [exp(a)], scope });
    expect(r.discrepancies.some((x) => x.message.includes('검토가 끝나지 않았는데'))).toBe(true);
    expect(r.exportAllowed).toBe(false);
  });

  it('원본 행에 연결된 거래가 없음 → 설명되지 않은 차이', () => {
    const a = tx('a', 11000);
    const r = reconcile({ source: { rows: [row(1, a), { rowNumber: 2, outcome: 'ok', transactionId: 'ghost', totalAmount: 5000, supplyAmount: 4545, vatAmount: 455 }] }, transactions: [a], exportRows: [exp(a)], scope });
    expect(r.balanced).toBe(false);
    expect(r.discrepancies.find((x) => x.kind === 'unexplained')!.message).toBe('2행: 원본 행에 연결된 거래를 찾을 수 없어 처리 결과를 확인할 수 없습니다.');
    expect(r.equation.residual).toMatchObject({ count: 1, totalAmount: 5000 });
  });

  it('원본 금액 ≠ 처리된 거래 금액 → 차단', () => {
    const a = tx('a', 11000);
    const r = reconcile({ source: { rows: [row(1, a, { totalAmount: 11100, supplyAmount: 10100 })] }, transactions: [a], exportRows: [exp(a)], scope });
    expect(r.discrepancies.find((x) => x.kind === 'amount_mismatch')!.message).toContain('원본 금액과 처리된 거래 금액이 다릅니다');
    expect(r.exportAllowed).toBe(false);
  });

  it('전송 계정이 거래 계정과 다르면 계정 소계 불일치로 차단', () => {
    const { txs, rows } = base();
    const ex = txs.slice(0, 3).map((t) => exp(t));
    ex[0] = { ...ex[0]!, accountCode: '829' };
    const r = reconcile({ source: { rows }, transactions: txs, exportRows: ex, scope });
    expect(r.equation.residual).toEqual({ count: 0, supplyAmount: 0, vatAmount: 0, totalAmount: 0 });
    expect(r.balanced).toBe(false);
    expect(r.exportAllowed).toBe(false);
    const msgs = r.discrepancies.map((d) => d.message);
    expect(msgs.some((m) => m.includes('전송파일 계정(829)이 거래 계정(830 소모품비)과 다릅니다'))).toBe(true);
    expect(msgs.some((m) => m.includes("계정 '829' 소계가 맞지 않습니다"))).toBe(true);
    expect(r.byAccount['829']!.export).toMatchObject({ count: 1 });
  });

  it('전송할 승인 거래가 없으면 전송 불가', () => {
    const r = reconcile({ source: { rows: [] }, transactions: [], scope });
    expect(r.balanced).toBe(true);
    expect(r.exportAllowed).toBe(false);
    expect(r.summary).toContain('전송할 승인 거래가 없습니다');
  });

  it('원 단위 정수가 아닌 금액 → 차단', () => {
    const a = tx('a', 11000);
    a.vatAmount = 1000.5;
    const r = reconcile({ source: { rows: [row(1, a, { vatAmount: 1000.5 })] }, transactions: [a], exportRows: [exp(a)], scope });
    expect(r.balanced).toBe(false);
    expect(r.discrepancies.some((d) => d.message.includes('원 단위 정수가 아닌 금액'))).toBe(true);
  });
});

describe('reconcile — WEHAGO 역수입 비교', () => {
  function withExport(): ReconcileInput {
    const { txs, rows } = base();
    return { source: { rows }, transactions: txs, exportRows: txs.slice(0, 3).map((t) => exp(t)), scope };
  }

  it('모두 반영되면 추가 차이 없음 (상호 표기가 달라도 일자+금액으로 매칭)', () => {
    const input = withExport();
    const [a, b, c] = input.transactions;
    input.wehagoRows = [
      { date: a!.transactionDate, merchantName: '(주)상점t1', supplyAmount: a!.supplyAmount, vatAmount: a!.vatAmount, totalAmount: a!.totalAmount, accountCode: '830' },
      { date: b!.transactionDate, merchantName: '전혀다른표기', supplyAmount: b!.supplyAmount, vatAmount: b!.vatAmount, totalAmount: b!.totalAmount },
      { date: c!.transactionDate, merchantName: c!.merchantName, supplyAmount: c!.supplyAmount, vatAmount: c!.vatAmount, totalAmount: c!.totalAmount },
    ];
    const r = reconcile(input);
    expect(r.stages.wehago).toMatchObject({ count: 3, totalAmount: 286000 });
    expect(r.discrepancies.filter((d) => d.kind.includes('wehago'))).toEqual([]);
    expect(r.exportAllowed).toBe(true);
    expect(r.byAccount['830']!.wehago).toMatchObject({ count: 1 });
  });

  it('누락·초과·금액 차이 보고', () => {
    const input = withExport();
    const [a, b] = input.transactions;
    input.wehagoRows = [
      { date: a!.transactionDate, merchantName: a!.merchantName, supplyAmount: a!.supplyAmount, vatAmount: a!.vatAmount, totalAmount: a!.totalAmount },
      { date: b!.transactionDate, merchantName: b!.merchantName, supplyAmount: b!.supplyAmount - 1, vatAmount: b!.vatAmount + 1, totalAmount: b!.totalAmount },
      { date: '2026-09-30', merchantName: '직접입력전표', supplyAmount: 1000, vatAmount: 100, totalAmount: 1100 },
    ];
    const r = reconcile(input);
    const missing = r.discrepancies.find((d) => d.kind === 'missing_in_wehago')!;
    expect(missing.message).toBe('2026-09-10 상점t3 220,000원 거래가 WEHAGO에 반영되지 않았습니다.');
    expect(missing.blocking).toBe(true);
    const extra = r.discrepancies.find((d) => d.kind === 'extra_in_wehago')!;
    expect(extra.blocking).toBe(false);
    expect(extra.message).toContain('WEHAGO에만 있는 전표입니다: 2026-09-30 직접입력전표 1,100원');
    expect(r.discrepancies.find((d) => d.kind === 'amount_mismatch')!.message).toContain('WEHAGO 금액이 전송 금액과 다릅니다');
  });
});

describe('reconcile — 리뷰 보강 (행·거래 연결)', () => {
  it('중복 행이 이전 자료의 원래 거래를 가리켜도 원래 거래는 전송 대상으로 남는다', () => {
    // 원래 거래 t1 은 지난 수집(원본 행 없음)에서 들어와 승인됨, 이번 파일 5행이 그 중복
    const t1 = tx('t1', 11000, { transactionDate: '2026-09-12', merchantName: 'ABC마트' });
    const rows = [row(5, t1, { outcome: 'duplicate' })];
    const r = reconcile({ source: { rows }, transactions: [t1], exportRows: [exp(t1)], scope });
    expect(r.expected).toMatchObject({ count: 1, totalAmount: 11000 });
    expect(r.equation.terms.duplicate).toMatchObject({ count: 1, totalAmount: 11000 });
    expect(r.equation.terms.export).toMatchObject({ count: 1, totalAmount: 11000 });
    expect(r.balanced).toBe(true);
    expect(r.exportAllowed).toBe(true);
    expect(r.discrepancies.map((d) => d.message)).toEqual(['2026-09-12 ABC마트 11,000원 거래가 중복판정으로 제외되었습니다.']);
  });

  it('같은 파일의 정상 행과 그 중복 행이 같은 거래를 가리켜도 합쳐 세지 않는다 (금액 불일치 오보 없음)', () => {
    const t1 = tx('t1', 55000);
    const rows = [row(1, t1), row(2, t1, { outcome: 'duplicate' })];
    const r = reconcile({ source: { rows }, transactions: [t1], exportRows: [exp(t1)], scope });
    expect(r.stages.source).toMatchObject({ count: 2, totalAmount: 110000 });
    expect(r.equation.terms.duplicate).toMatchObject({ count: 1, totalAmount: 55000 });
    expect(r.balanced).toBe(true);
    expect(r.exportAllowed).toBe(true);
    expect(r.discrepancies.some((d) => d.kind === 'amount_mismatch')).toBe(false);
    expect(r.discrepancies.some((d) => d.kind === 'extra_in_export')).toBe(false);
  });

  it('실패 행과 실패 상태 거래가 연결되어 있어도 한 번만 센다', () => {
    const a = tx('t1', 11000);
    const f = tx('tf', 0, { status: 'failed', accountCode: null, accountName: null, supplyAmount: 0, vatAmount: 0, totalAmount: 0 });
    const rows = [row(1, a), { rowNumber: 3, outcome: 'failed' as const, transactionId: 'tf', errorReason: "금액을 해석할 수 없어 수집 실패 (원본: '3,2OO')" }];
    const r = reconcile({ source: { rows }, transactions: [a, f], exportRows: [exp(a)], scope });
    expect(r.stages.source!.count).toBe(2);
    expect(r.equation.terms.failed.count).toBe(1);
    expect(r.balanced).toBe(true);
    expect(r.discrepancies.filter((d) => d.kind === 'parse_failed').map((d) => d.message)).toEqual([
      "3행: 금액을 해석할 수 없어 수집 실패 (원본: '3,2OO')",
    ]);
    expect(r.exportAllowed).toBe(false);
  });

  it('실패 거래가 전송파일에 들어가면 "원본에 없음"이 아니라 수집 실패로 설명', () => {
    const a = tx('t1', 11000);
    const f = tx('tf', 5000, { status: 'failed' });
    const rows = [row(1, a), { rowNumber: 2, outcome: 'failed' as const, transactionId: 'tf', errorReason: '일자 오류' }];
    const r = reconcile({ source: { rows }, transactions: [a, f], exportRows: [exp(a), exp(f)], scope });
    const x = r.discrepancies.find((d) => d.kind === 'extra_in_export')!;
    expect(x.message).toContain('수집 실패 상태인데 전송파일에 포함되어 있습니다');
    expect(r.exportAllowed).toBe(false);
  });

  it('사유 문구의 카드번호·주민번호는 가려서 보여준다', () => {
    const a = tx('t1', 11000);
    const rows = [row(1, a), { rowNumber: 2, outcome: 'failed' as const, errorReason: "카드번호 형식 오류 (원본: '1234-5678-9012-3456')" }];
    const ex = tx('t2', 3000, { status: 'excluded', excludedReason: '대표 개인카드 900101-1234567 사용분' });
    const r = reconcile({ source: { rows: [...rows, row(3, ex)] }, transactions: [a, ex], exportRows: [exp(a)], scope });
    const msgs = r.discrepancies.map((d) => d.message).join('\n');
    expect(msgs).not.toContain('5678-9012');
    expect(msgs).toContain('1234-****-****-3456');
    expect(msgs).not.toContain('1234567');
    expect(msgs).toContain('900101-1******');
  });

  it('검토 전 거래가 전송파일에 들어가도 검토 대기 건수에 포함한다', () => {
    const a = tx('t1', 11000);
    const b = tx('t2', 22000, { status: 'needs_review' });
    const r = reconcile({ source: { rows: [row(1, a), row(2, b)] }, transactions: [a, b], exportRows: [exp(a), exp(b)], scope });
    expect(r.pendingReview).toMatchObject({ count: 1, totalAmount: 22000 });
    expect(r.discrepancies.find((d) => d.kind === 'pending_review')!.message).toBe('검토 대기 1건(합계 22,000원)이 남아 있어 전송할 수 없습니다.');
    expect(r.exportAllowed).toBe(false);
  });

  it('WEHAGO 매칭: 상호 일치 매칭을 먼저 끝내 다른 거래의 짝을 가로채지 않는다', () => {
    // 같은 날 같은 합계 두 건. A 는 WEHAGO 상호 표기가 달라 2차 매칭, B 는 상호 일치
    const a = tx('ta', 10000, { merchantName: 'X상사', supplyAmount: 9091, vatAmount: 909 });
    const b = tx('tb', 10000, { merchantName: 'Y마트', supplyAmount: 10000, vatAmount: 0, evidenceType: 'invoice_exempt' });
    const input: ReconcileInput = {
      source: { rows: [row(1, a), row(2, b)] },
      transactions: [a, b],
      exportRows: [exp(a), exp(b)],
      wehagoRows: [
        { date: '2026-09-10', merchantName: 'Y마트', supplyAmount: 10000, vatAmount: 0, totalAmount: 10000 },
        { date: '2026-09-10', merchantName: '(주)엑스상사', supplyAmount: 9091, vatAmount: 909, totalAmount: 10000 },
      ],
      scope,
    };
    const r = reconcile(input);
    expect(r.discrepancies).toEqual([]);
    expect(r.exportAllowed).toBe(true);
  });
});
