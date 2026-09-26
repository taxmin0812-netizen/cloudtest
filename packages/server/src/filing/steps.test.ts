import { describe, expect, it } from 'vitest';
import { currentStepOf, deriveBoardRow, type BoardClientInput, type BoardJobInput, type BoardMonthInput } from './steps';
import { parseAmountHint, parseReceiptNumberHint } from './results';

const P = '2026-09';
const TODAY = '2026-09-26';

const month = (over: Partial<BoardMonthInput> = {}): BoardMonthInput => ({
  id: 'm1',
  period: P,
  status: 'reviewing',
  wizardStep: 3,
  pendingReview: 0,
  validationBlocking: null,
  missingId: 0,
  createdAt: '2026-09-20T00:00:00.000Z',
  confirmedAt: null,
  headcountByType: { earned: 9, business: 0, daily: 0 },
  ...over,
});

const job = (over: Partial<BoardJobInput>): BoardJobInput => ({
  id: 'j',
  kind: 'withholding',
  period: P,
  dueDate: '2026-10-12',
  steps: {},
  monthsIncluded: [P],
  incomeTax: 500_000,
  localIncomeTax: 50_000,
  receipts: 0,
  paymentSlips: 0,
  ...over,
});

const client = (over: Partial<BoardClientInput> = {}): BoardClientInput => ({
  clientId: 'c1',
  clientName: '시나리오상사',
  semiannual: false,
  activeEmployees: { earned: 9, business: 0, daily: 0 },
  months: [month()],
  jobs: [],
  expected: [
    { kind: 'withholding', period: P, dueDate: '2026-10-12' },
    { kind: 'local_income_tax', period: P, dueDate: '2026-10-12' },
  ],
  includeTargets: { withholding: P, local_income_tax: P, simplified_statement_earned: '2026-12' },
  exportWarnings: [],
  ...over,
});

const status = (r: ReturnType<typeof deriveBoardRow>, step: string) => r.steps.find((s) => s.step === step)?.status;

describe('Control Tower 단계 판정', () => {
  it('검토 대기 → 급여확정 pending, 다음 행동 = 변경 검토', () => {
    const r = deriveBoardRow(client({ months: [month({ pendingReview: 2 })] }), P, TODAY);
    expect(status(r, 'payroll_input')).toBe('done');
    expect(status(r, 'earned_confirmed')).toBe('pending');
    expect(status(r, 'business_confirmed')).toBe('na');
    expect(status(r, 'daily_confirmed')).toBe('na');
    expect(r.nextAction?.label).toBe('변경 2명 검토');
    expect(r.blockers).toContain('인건비 변경 2명 미검토');
    expect(r.dueDate).toBe('2026-10-12');
    expect(r.dDay).toBe(16);
  });

  it('확정 + 신고 작업 준비 → 원천세 준비 done, 신고완료 pending', () => {
    const steps = { withholding_ready: '2026-09-26T00:00:00.000Z', local_tax_ready: '2026-09-26T00:00:00.000Z', simplified_statement_ready: '2026-09-26T00:00:00.000Z' };
    const r = deriveBoardRow(
      client({
        months: [month({ status: 'confirmed', confirmedAt: '2026-09-26T00:00:00.000Z' })],
        jobs: [
          job({ id: 'w', kind: 'withholding', steps }),
          job({ id: 'l', kind: 'local_income_tax', steps }),
          job({ id: 'e', kind: 'simplified_statement_earned', period: '2026-12', dueDate: '2027-02-01', steps }),
        ],
      }),
      P,
      TODAY,
    );
    expect(status(r, 'earned_confirmed')).toBe('done');
    expect(status(r, 'withholding_ready')).toBe('done');
    expect(status(r, 'simplified_statement_ready')).toBe('done');
    expect(status(r, 'local_tax_ready')).toBe('done');
    expect(status(r, 'filed')).toBe('pending');
    expect(r.nextAction?.label).toBe('신고 완료 표시');
    expect(r.complete).toBe(false);
  });

  it('신고 표시만 하고 접수증이 없으면 attention (접수증 보관 의무)', () => {
    const steps = { withholding_ready: 'x', local_tax_ready: 'x', simplified_statement_ready: 'x', filed: '2026-10-08T00:00:00.000Z' };
    const r = deriveBoardRow(
      client({
        months: [month({ status: 'confirmed' })],
        jobs: [job({ id: 'w', kind: 'withholding', steps }), job({ id: 'l', kind: 'local_income_tax', steps }), job({ id: 'e', kind: 'simplified_statement_earned', period: '2026-12', steps })],
      }),
      P,
      TODAY,
    );
    expect(status(r, 'filed')).toBe('attention');
    expect(status(r, 'receipt_collected')).toBe('pending');
    expect(r.blockers.some((b) => b.includes('접수증'))).toBe(true);
    expect(r.nextAction?.label).toBe('접수증 올리기');
  });

  it('모두 완료', () => {
    const steps = { withholding_ready: 'x', local_tax_ready: 'x', simplified_statement_ready: 'x', filed: 'y' };
    const r = deriveBoardRow(
      client({
        months: [month({ status: 'filed' })],
        jobs: [
          job({ id: 'w', kind: 'withholding', steps, receipts: 1, paymentSlips: 1 }),
          job({ id: 'l', kind: 'local_income_tax', steps, receipts: 1, paymentSlips: 1 }),
          job({ id: 'e', kind: 'simplified_statement_earned', period: '2026-12', steps }),
        ],
      }),
      P,
      TODAY,
    );
    expect(r.complete).toBe(true);
    expect(r.nextAction).toBeNull();
  });

  it('기한 경과 미완료는 overdue', () => {
    const r = deriveBoardRow(client({ months: [month({ pendingReview: 1 })] }), P, '2026-10-13');
    expect(r.overdue).toBe(true);
    expect(status(r, 'earned_confirmed')).toBe('overdue');
    expect(r.blockers.some((b) => b.includes('기한 경과'))).toBe(true);
  });

  it('반기납부 중간 달은 신고 단계 해당 없음', () => {
    const r = deriveBoardRow(client({ semiannual: true, expected: [], includeTargets: { withholding: '2026-12', local_income_tax: '2026-12' } }), P, TODAY);
    expect(r.filingDueThisPeriod).toBe(false);
    expect(status(r, 'filed')).toBe('na');
    expect(r.steps.find((s) => s.step === 'filed')?.detail).toContain('반기납부');
  });

  it('급여 시작 전 / 대상 없음', () => {
    const r = deriveBoardRow(client({ months: [] }), P, TODAY);
    expect(status(r, 'payroll_input')).toBe('pending');
    expect(r.nextAction?.label).toBe('이번 달 급여 시작');
    const none = deriveBoardRow(client({ months: [], activeEmployees: { earned: 0, business: 0, daily: 0 }, expected: [], includeTargets: {} }), P, TODAY);
    expect(status(none, 'payroll_input')).toBe('na');
  });

  it('currentStepOf', () => {
    expect(currentStepOf({})).toBe('payroll_input');
    expect(currentStepOf({ payroll_input: 'a', earned_confirmed: 'b', withholding_ready: 'c' })).toBe('withholding_ready');
    expect(currentStepOf({ withholding_ready: 'c', filed: null })).toBe('withholding_ready');
  });
});

describe('접수증·납부서 힌트', () => {
  it('파일명·본문에서 금액·접수번호', () => {
    expect(parseAmountHint('납부서_원천세_123,450원.pdf', null)).toEqual({ amount: 123_450, source: 'file_name' });
    expect(parseAmountHint('scan.pdf', null)).toEqual({ amount: null, source: null });
    expect(parseAmountHint('slip.html', '<td>납부할세액</td><td>98,760</td>')).toEqual({ amount: 98_760, source: 'file_text' });
    expect(parseReceiptNumberHint('접수증_접수번호 120-2026-10-123456.pdf', null)).toBe('120-2026-10-123456');
  });
});
