import { describe, expect, it } from 'vitest';
import { computeTransferStage, type ExportFact, type StageFacts } from './stage';

const T0 = new Date('2026-09-26T00:00:00Z');
const later = (min: number) => new Date(T0.getTime() + min * 60_000);

function facts(over: Partial<StageFacts> = {}): StageFacts {
  return {
    clientId: 'c1',
    period: '2026-09',
    txCount: 10,
    imports: 1,
    unclassified: 0,
    pending: 0,
    approved: 10,
    humanReviewed: 0,
    stale: 10,
    failedRows: 0,
    latestAttempts: [],
    validExports: [],
    latestRecon: null,
    latestPostRecon: null,
    ...over,
  };
}

function exp(over: Partial<ExportFact> = {}): ExportFact {
  return {
    id: 'e1',
    kind: 'wehago_purchase_sales',
    status: 'ready',
    createdAt: T0,
    version: 1,
    templateVerified: false,
    rowCount: 10,
    totalAmount: 1000,
    blockedReason: null,
    hasFile: true,
    superseded: false,
    downloadedAt: null,
    uploadConfirmedAt: null,
    ...over,
  };
}

describe('computeTransferStage', () => {
  it('자료 없음 → 수집완료 → 예외검토 → 자동분개완료/검토완료', () => {
    expect(computeTransferStage(facts({ txCount: 0, imports: 0, approved: 0, stale: 0 })).stage).toBe('no_data');
    expect(computeTransferStage(facts({ unclassified: 3 })).stage).toBe('collected');
    const nr = computeTransferStage(facts({ pending: 2 }));
    expect(nr.stage).toBe('needs_review');
    expect(nr.nextAction).toEqual({ code: 'review', label: '2건 검토하기', href: '/inbox?client=c1&period=2026-09' });
    expect(nr.blockers.map((b) => b.code)).toEqual(['pending_review']);
    expect(computeTransferStage(facts()).stage).toBe('auto_classified');
    const rv = computeTransferStage(facts({ humanReviewed: 1 }));
    expect(rv.stage).toBe('reviewed');
    expect(rv.eligibleForPrepare).toBe(true);
    expect(rv.nextAction.code).toBe('prepare');
  });

  it('수집 실패 행이 있으면 전송 준비 대상이 아니다', () => {
    const r = computeTransferStage(facts({ failedRows: 2 }));
    expect(r.eligibleForPrepare).toBe(false);
    expect(r.blockers[0]!.message).toBe('수집 실패 행 2건');
  });

  it('전송준비 → 전송 → 대사완료 (대사가 최신 파일 이후여야)', () => {
    expect(computeTransferStage(facts({ stale: 0, validExports: [exp()] })).stage).toBe('export_ready');
    const down = exp({ status: 'downloaded' });
    const ex = computeTransferStage(facts({ stale: 0, validExports: [down] }));
    expect(ex.stage).toBe('exported');
    expect(ex.nextAction.code).toBe('confirm_upload');
    expect(ex.blockers.map((b) => b.code)).toContain('wehago_unverified');
    const up = exp({ status: 'uploaded_confirmed', templateVerified: true });
    const post = { id: 'r1', phase: 'post_export' as const, exportAllowed: true, createdAt: later(5), mismatch: 0, exportJobId: 'e1' };
    const rc = computeTransferStage(facts({ stale: 0, validExports: [up], latestRecon: post, latestPostRecon: post }));
    expect(rc.stage).toBe('reconciled');
    expect(rc.reconStatus).toBe('reconciled');
    expect(rc.nextAction.code).toBe('none');
    const oldPost = { ...post, createdAt: later(-5) };
    expect(computeTransferStage(facts({ stale: 0, validExports: [up], latestRecon: oldPost, latestPostRecon: oldPost })).stage).toBe('exported');
  });

  it('파일 뒤에 승인 거래가 늘면 다시 검토완료 단계 + 다시 만들기 안내', () => {
    const r = computeTransferStage(facts({ stale: 2, validExports: [exp({ status: 'uploaded_confirmed' })] }));
    expect(r.stage).toBe('auto_classified');
    expect(r.blockers.find((b) => b.code === 'export_stale')!.message).toBe('전송파일에 없는 승인 거래 2건 — 파일을 다시 만드세요');
  });

  it('최신 시도가 차단이면 사유를 보여주고, 대사 불일치도 차단 사유로', () => {
    const r = computeTransferStage(
      facts({
        latestAttempts: [exp({ id: 'b1', status: 'blocked', hasFile: false, blockedReason: '검토 대기 3건이 남아 있습니다.' })],
        latestRecon: { id: 'r9', phase: 'pre_export', exportAllowed: false, createdAt: T0, mismatch: 2, exportJobId: null },
      }),
    );
    expect(r.blockers.map((b) => b.message)).toEqual(['매입매출 전송 차단: 검토 대기 3건이 남아 있습니다.', '대사 불일치 2건']);
    expect(r.reconStatus).toBe('mismatch');
  });
});
