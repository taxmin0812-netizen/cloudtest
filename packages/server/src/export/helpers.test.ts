import { describe, expect, it } from 'vitest';
import { WEHAGO_GENERAL_JOURNAL_TEMPLATE, WEHAGO_PURCHASE_SALES_TEMPLATE } from '@mintax/adapters';
import {
  blockedSummary,
  checkCandidates,
  emptyPartnerStore,
  exportFileName,
  lookupPartnerCode,
  parseExportScope,
  reasonsFromAdapterIssues,
  routeForExport,
  scopeWarning,
  totalsMatch,
  warningsFromAdapterIssues,
  wehagoDuplicateGroups,
  type CandidateTx,
  type CheckContext,
} from './helpers';

const BIZ_A = '1208100031';
const BIZ_B = '2018100044';

function tx(over: Partial<CandidateTx> = {}): CandidateTx {
  return {
    id: over.id ?? 'tx-1',
    status: 'auto_approved',
    direction: 'purchase',
    transactionDate: '2026-09-12',
    evidenceType: 'card',
    merchantName: 'ABC마트',
    merchantBusinessNumber: BIZ_A,
    description: '',
    supplyAmount: 29546,
    vatAmount: 2954,
    serviceCharge: 0,
    totalAmount: 32500,
    accountCode: '830',
    accountName: '소모품비',
    vatType: 'purchase_card',
    deductible: true,
    vatReasonCode: null,
    approvalNumber: null,
    cardCompany: null,
    exportJobId: null,
    ...over,
  };
}

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  const partners = emptyPartnerStore();
  partners.byBizNo[BIZ_A] = { code: '00101', name: 'ABC마트', source: 'manual', updatedAt: '' };
  return {
    kind: 'wehago_purchase_sales',
    clientId: 'c1',
    period: '2026-09',
    template: WEHAGO_PURCHASE_SALES_TEMPLATE,
    psTemplate: WEHAGO_PURCHASE_SALES_TEMPLATE,
    accounts: new Map([
      ['830', '소모품비'],
      ['831', '지급수수료'],
      ['401', '상품매출'],
    ]),
    partners,
    ...over,
  };
}

describe('parseExportScope / scopeWarning', () => {
  it('명시적 wehago_collects 만 제외, 알 수 없는 값은 무시', () => {
    const s = parseExportScope({ 'export_scope.card': 'mintax_exports', 'export_scope.cash_receipt': 'wehago_collects', 'export_scope.bank': 'bogus', other: 1 });
    expect(s.configured).toBe(true);
    expect(s.excludedEvidenceTypes).toEqual(['cash_receipt']);
    expect(s.byEvidence.bank).toBeUndefined();
    expect(parseExportScope(null)).toEqual({ byEvidence: {}, configured: false, excludedEvidenceTypes: [] });
  });
  it('설정 안 된 원천이 파일에 들어가면 이중 기장 경고', () => {
    const s = parseExportScope({ 'export_scope.card': 'mintax_exports' });
    expect(scopeWarning(s, ['card'])).toBeNull();
    expect(scopeWarning(s, ['card', 'tax_invoice'])).toContain('이중 기장 주의: 전송 범위가 설정되지 않은 원천(세금계산서)');
  });
});

describe('routeForExport', () => {
  const t = WEHAGO_PURCHASE_SALES_TEMPLATE;
  it('유형코드가 있으면 매입매출, 적격증빙 없음·세액 0 불공제는 일반전표', () => {
    expect(routeForExport({ direction: 'purchase', evidenceType: 'card', vatType: 'purchase_card', deductible: true, vatAmount: 909 }, t).route).toBe('wehago_purchase_sales');
    expect(routeForExport({ direction: 'purchase', evidenceType: 'other', vatType: 'purchase_no_evidence', deductible: false, vatAmount: 0 }, t).route).toBe('wehago_general_journal');
    expect(routeForExport({ direction: 'purchase', evidenceType: 'card', vatType: 'purchase_card', deductible: false, vatAmount: 0 }, t).route).toBe('wehago_general_journal');
    // 세액 있는 불공제 → 54 불공 (매입매출)
    expect(routeForExport({ direction: 'purchase', evidenceType: 'card', vatType: 'purchase_card', deductible: false, vatAmount: 909 }, t).route).toBe('wehago_purchase_sales');
  });
  it('유형 없음 / 매핑 없음은 조용히 일반전표로 돌리지 않는다', () => {
    expect(routeForExport({ direction: 'purchase', evidenceType: 'card', vatType: null, deductible: true, vatAmount: 1 }, t)).toMatchObject({ route: 'unroutable', problem: 'vat_type_missing' });
    const noExempt = { ...t, vatTypeCodes: { ...t.vatTypeCodes, purchase_card_exempt: null } };
    expect(routeForExport({ direction: 'purchase', evidenceType: 'card', vatType: 'purchase_card_exempt', deductible: true, vatAmount: 0 }, noExempt)).toMatchObject({
      route: 'unroutable',
      problem: 'vat_code_unmapped',
      reason: 'WEHAGO 유형코드 매핑 없음: purchase_card_exempt',
    });
  });
});

describe('checkCandidates', () => {
  it('정상 거래 → 전송 행 (거래처코드·계정·불공제 사유)', () => {
    const r = checkCandidates([tx()], ctx());
    expect(r.reasons).toEqual([]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ counterpartyCode: '00101', accountCode: '830', vatType: 'purchase_card', totalAmount: 32500 });
    expect(r.rows[0]!.journalLines).toBeUndefined();
  });

  it('계정코드 없음 · 차대 불일치 · 매핑 없음 · 거래처코드 없음 · 공제 미확정 → 사유별 한국어 문구', () => {
    const r = checkCandidates(
      [
        tx({ id: 'a', accountCode: null }),
        tx({ id: 'b', accountCode: '999' }),
        tx({ id: 'c', totalAmount: 32501 }),
        tx({ id: 'd', vatType: 'purchase_foo' }),
        tx({ id: 'e', merchantBusinessNumber: BIZ_B, merchantName: '새가게' }),
        tx({ id: 'f', deductible: null }),
        tx({ id: 'g', vatType: null }),
      ],
      ctx(),
    );
    const m = new Map(r.reasons.map((x) => [x.code, x]));
    expect(m.get('missing_account')).toMatchObject({ message: 'WEHAGO 파일 생성 중 2건의 계정코드를 찾지 못했습니다.', count: 2, actionLabel: '2건 검토하기', href: '/inbox?client=c1&period=2026-09&filter=account_missing' });
    expect(m.get('unbalanced')!.message).toBe('차대 불일치 1건 (예: 2026-09-12 ABC마트 32,501원 차변 32,500원 ≠ 대변 32,501원).');
    expect(m.get('vat_code_unmapped')!.message).toContain('WEHAGO 유형코드 매핑 없음: purchase_foo (1건)');
    expect(m.get('missing_counterparty_code')!.message).toContain('거래처 1곳(1건)');
    expect(m.get('deductible_undecided')!.transactionIds).toEqual(['f']);
    expect(m.get('vat_type_missing')!.count).toBe(1);
    expect(r.rows).toHaveLength(0);
  });

  it('일반전표 종류: 분개 줄을 싣고, 매입매출 대상은 다른 종류로 센다', () => {
    const r = checkCandidates(
      [tx({ id: 'ps' }), tx({ id: 'gj', evidenceType: 'other', vatType: 'purchase_no_evidence', deductible: false, vatAmount: 0, supplyAmount: 15000, totalAmount: 15000, accountCode: '831', accountName: '지급수수료' })],
      ctx({ kind: 'wehago_general_journal', template: WEHAGO_GENERAL_JOURNAL_TEMPLATE }),
    );
    expect(r.reasons).toEqual([]);
    expect(r.otherKind.map((t) => t.id)).toEqual(['ps']);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.journalLines!.map((l) => [l.side, l.accountCode, l.amount])).toEqual([
      ['debit', '831', 15000],
      ['credit', '101', 15000],
    ]);
  });
});

describe('어댑터 사전검증 결과 → 사유/경고', () => {
  it('코드별로 묶는다', () => {
    const reasons = reasonsFromAdapterIssues(
      [
        { rowIndex: 0, transactionId: 't1', code: 'bizno_checksum', message: '사업자번호 123-45-67890 의 검증번호가 맞지 않습니다.' },
        { rowIndex: 1, transactionId: 't2', code: 'bizno_checksum', message: 'x' },
        { rowIndex: null, transactionId: null, code: 'template_invalid', message: '서식 오류: 열이 없습니다.' },
      ],
      'c1',
      '2026-09',
    );
    expect(reasons[0]).toMatchObject({ code: 'adapter_bizno_checksum', count: 2, transactionIds: ['t1', 't2'] });
    expect(reasons[0]!.message).toContain('상대방 사업자번호 오류 2건');
    expect(reasons[1]).toMatchObject({ code: 'adapter_template_invalid', href: '/settings/templates' });
    expect(
      warningsFromAdapterIssues([
        { rowIndex: null, transactionId: null, code: 'unverified_template', message: 'x' },
        { rowIndex: 0, transactionId: 't', code: 'needs_reason', message: 'y' },
      ]),
    ).toEqual(['불공제(54) 1건 — WEHAGO에서 불공제사유 번호를 선택해야 합니다.']);
  });
});

describe('기타', () => {
  it('파일명: 코드_상호_기간_종류(_vN).xlsx', () => {
    expect(exportFileName({ code: 'C001', name: '에이플러스디자인' }, '2026-09', 'wehago_purchase_sales', 1)).toBe('C001_에이플러스디자인_2026-09_매입매출.xlsx');
    expect(exportFileName({ code: 'C001', name: '(주)에이 플러스/디자인' }, '2026-09', 'wehago_general_journal', 3)).toBe('C001_(주)에이플러스_디자인_2026-09_일반전표_v3.xlsx');
  });
  it('WEHAGO 중복전표 기준(일자·사업자번호·금액·과세유형)이 같은 묶음', () => {
    const base = { date: '2026-09-01', counterpartyBusinessNumber: BIZ_A, totalAmount: 5000, vatType: 'purchase_card' as const, direction: 'purchase' as const, counterpartyName: 'A' };
    const g = wehagoDuplicateGroups([
      { ...base, transactionId: '1' },
      { ...base, transactionId: '2' },
      { ...base, transactionId: '3', totalAmount: 5001 },
      { ...base, transactionId: '4', counterpartyBusinessNumber: null },
      { ...base, transactionId: '5', counterpartyBusinessNumber: null },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]!.ids).toEqual(['1', '2']);
  });
  it('거래처코드: 사업자번호 우선, 없으면 상호', () => {
    const s = emptyPartnerStore();
    s.byName['스타벅스강남점'] = { code: '009', name: '스타벅스 강남점', source: 'manual', updatedAt: '' };
    expect(lookupPartnerCode(s, null, '스타벅스 강남점')).toBe('009');
    expect(lookupPartnerCode(s, BIZ_A, '모름')).toBeNull();
  });
  it('차단 요약', () => {
    expect(blockedSummary('미소카페', '2026-09', 'wehago_purchase_sales', [])).toBe('미소카페 2026-09 매입매출 전송 차단');
    expect(
      blockedSummary('미소카페', '2026-09', 'wehago_purchase_sales', [
        { code: 'a', message: '검토 대기 3건이 남아 있습니다.', count: 3, href: null, actionLabel: null },
        { code: 'b', message: 'x', count: 1, href: null, actionLabel: null },
      ]),
    ).toBe('미소카페 2026-09 매입매출 전송 차단: 검토 대기 3건이 남아 있습니다. 외 1건');
    expect(totalsMatch({ count: 1, supplyAmount: 1, vatAmount: 0, totalAmount: 1 }, { count: 1, supplyAmount: 1, vatAmount: 0, totalAmount: 2 })).toBe(false);
  });
});
