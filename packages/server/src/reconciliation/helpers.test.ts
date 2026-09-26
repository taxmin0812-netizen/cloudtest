import { describe, expect, it } from 'vitest';
import { reconcile } from '@mintax/core/engine/vat-risk-index';
import { discrepancyDTOs, mismatchBody, stageLine, wehagoMatched } from './helpers';

const tx = (id: string, status: string, total: number, extra: Record<string, unknown> = {}) => ({
  id,
  status: status as never,
  evidenceType: 'card',
  accountCode: '830',
  accountName: '소모품비',
  supplyAmount: total - Math.trunc(total / 11),
  vatAmount: Math.trunc(total / 11),
  totalAmount: total,
  transactionDate: '2026-09-12',
  merchantName: 'ABC마트',
  ...extra,
});

describe('대사 보고서 도우미', () => {
  it('단계 요약 문장', () => {
    const t = (count: number) => ({ count, supplyAmount: 0, vatAmount: 0, totalAmount: 0 });
    expect(stageLine({ source: t(512), processed: t(505), export: t(500) }, 'ready')).toBe('위멤버스(원본) 512건 / MIN TAX OPS 505건 / 전송준비 500건');
    expect(stageLine({ source: t(512), processed: t(505), export: t(500), wehago: t(498) }, 'file')).toBe('위멤버스(원본) 512건 / MIN TAX OPS 505건 / 전송파일 500건 / WEHAGO 498건');
    expect(stageLine({ source: t(1234) }, 'ready')).toBe('위멤버스(원본) 1,234건');
  });

  it('core reconcile 결과 → 차이 DTO(링크 포함) · WEHAGO 일치 판정', () => {
    const r = reconcile({
      source: {
        rows: [
          { rowNumber: 1, outcome: 'ok', transactionId: 't1', supplyAmount: 29546, vatAmount: 2954, totalAmount: 32500 },
          { rowNumber: 2, outcome: 'duplicate', transactionId: 't2', supplyAmount: 29546, vatAmount: 2954, totalAmount: 32500 },
        ],
      },
      transactions: [tx('t1', 'exported', 32500), tx('t2', 'duplicate', 32500)],
      exportRows: [{ transactionId: 't1', supplyAmount: 29546, vatAmount: 2954, totalAmount: 32500, accountCode: '830' }],
      wehagoRows: [{ date: '2026-09-12', merchantName: 'ABC마트', supplyAmount: 29546, vatAmount: 2954, totalAmount: 32500, accountCode: '830' }],
      scope: { period: '2026-09', clientName: '테스트' },
    });
    const d = discrepancyDTOs(r.discrepancies, 'c1', '2026-09');
    expect(d[0]).toMatchObject({ kind: 'duplicate_excluded', kindLabel: '중복 제외', blocking: false, href: '/transactions/t2' });
    expect(d[0]!.message).toBe('2026-09-12 ABC마트 32,500원 거래가 중복판정으로 제외되었습니다.');
    expect(wehagoMatched(r, [], true)).toBe(true);
    const extra = [{ kind: 'unexplained' as const, blocking: true, message: 'WEHAGO 매입매출장 3행을 읽을 수 없어 대사하지 못했습니다: x' }];
    expect(wehagoMatched(r, extra, true)).toBe(false);
    expect(mismatchBody(extra)).toBe('• WEHAGO 매입매출장 3행을 읽을 수 없어 대사하지 못했습니다: x');

    const miss = reconcile({
      source: { rows: [{ rowNumber: 1, outcome: 'ok', transactionId: 't1', supplyAmount: 29546, vatAmount: 2954, totalAmount: 32500 }] },
      transactions: [tx('t1', 'exported', 32500)],
      exportRows: [{ transactionId: 't1', supplyAmount: 29546, vatAmount: 2954, totalAmount: 32500, accountCode: '830' }],
      wehagoRows: [],
      scope: { period: '2026-09', clientName: '테스트' },
    });
    expect(wehagoMatched(miss, [], true)).toBe(false);
    expect(miss.discrepancies.map((x) => x.message)).toContain('2026-09-12 ABC마트 32,500원 거래가 WEHAGO에 반영되지 않았습니다.');
  });
});
