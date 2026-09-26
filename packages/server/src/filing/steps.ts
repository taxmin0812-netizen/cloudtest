/**
 * 원천세 Control Tower — 신고 단계(FilingStep 10단계) 판정. 순수 함수 (DB 없음, 단위 테스트 대상).
 * 단계는 기한 목록이 아니라 실제 데이터(급여 월·신고 작업·접수증/납부서)에서 계산한다.
 */
import type { FilingStep, IncomeType } from '@mintax/core';
import { dDayLabel, daysBetween } from '../payroll/helpers';

export const FILING_STEPS: readonly FilingStep[] = [
  'payroll_input',
  'earned_confirmed',
  'business_confirmed',
  'daily_confirmed',
  'withholding_ready',
  'simplified_statement_ready',
  'local_tax_ready',
  'filed',
  'receipt_collected',
  'payment_slip_collected',
];

export const FILING_STEP_LABELS: Record<FilingStep, string> = {
  payroll_input: '인건비 입력',
  earned_confirmed: '급여확정',
  business_confirmed: '사업소득확정',
  daily_confirmed: '일용직확정',
  withholding_ready: '원천세 준비',
  simplified_statement_ready: '간이지급명세서 준비',
  local_tax_ready: '지방소득세 준비',
  filed: '신고완료',
  receipt_collected: '접수증 수집',
  payment_slip_collected: '납부서 수집',
};

export type FilingKind = 'withholding' | 'local_income_tax' | 'simplified_statement_earned' | 'simplified_statement_business' | 'daily_statement';

export const FILING_KINDS: readonly FilingKind[] = ['withholding', 'local_income_tax', 'simplified_statement_earned', 'simplified_statement_business', 'daily_statement'];

export const FILING_KIND_LABELS: Record<FilingKind, string> = {
  withholding: '원천세(원천징수이행상황신고)',
  local_income_tax: '지방소득세 특별징수',
  simplified_statement_earned: '근로소득 간이지급명세서',
  simplified_statement_business: '사업소득 간이지급명세서',
  daily_statement: '일용근로소득 지급명세서',
};

/** 신고 작업 종류별 "준비" 단계 */
export const READY_STEP_OF: Record<FilingKind, FilingStep> = {
  withholding: 'withholding_ready',
  local_income_tax: 'local_tax_ready',
  simplified_statement_earned: 'simplified_statement_ready',
  simplified_statement_business: 'simplified_statement_ready',
  daily_statement: 'simplified_statement_ready',
};

export const STATEMENT_KIND_OF: Record<IncomeType, FilingKind> = {
  earned: 'simplified_statement_earned',
  business: 'simplified_statement_business',
  daily: 'daily_statement',
};

export function isFilingKind(v: unknown): v is FilingKind {
  return typeof v === 'string' && (FILING_KINDS as readonly string[]).includes(v);
}

/** steps 에 기록된 마지막 단계 (없으면 payroll_input) */
export function currentStepOf(steps: Record<string, string | null | undefined>): FilingStep {
  let cur: FilingStep = 'payroll_input';
  for (const s of FILING_STEPS) if (steps[s]) cur = s;
  return cur;
}

export type StepStatus = 'done' | 'pending' | 'overdue' | 'na' | 'attention';

export interface BoardStep {
  step: FilingStep;
  label: string;
  status: StepStatus;
  at: string | null;
  detail: string | null;
}

export interface BoardJobInput {
  id: string;
  kind: FilingKind;
  period: string;
  dueDate: string | null;
  steps: Record<string, string | null>;
  /** payload.months 의 지급월 목록 */
  monthsIncluded: string[];
  incomeTax: number;
  localIncomeTax: number;
  receipts: number;
  paymentSlips: number;
}

export interface BoardMonthInput {
  id: string;
  period: string;
  status: string;
  wizardStep: number;
  pendingReview: number;
  validationBlocking: number | null;
  missingId: number;
  createdAt: string;
  confirmedAt: string | null;
  headcountByType: Record<IncomeType, number>;
}

export interface BoardClientInput {
  clientId: string;
  clientName: string;
  semiannual: boolean;
  /** 이 지급월에 재직 중인 소득구분별 인원 (급여 월이 아직 없을 때 해당 여부 판단) */
  activeEmployees: Record<IncomeType, number>;
  months: BoardMonthInput[];
  jobs: BoardJobInput[];
  /** 이 지급월(P)에 신고해야 하는 작업 종류 → 신고 기간 */
  expected: Array<{ kind: FilingKind; period: string; dueDate: string }>;
  /** P 의 지급분이 들어갈 작업 (종류 → 작업 기간) */
  includeTargets: Partial<Record<FilingKind, string>>;
  exportWarnings: string[];
}

export interface BoardAction {
  label: string;
  href: string;
  step: FilingStep;
}

export interface BoardRowResult {
  steps: BoardStep[];
  dueDate: string | null;
  dDay: number | null;
  dDayLabel: string | null;
  blockers: string[];
  nextAction: BoardAction | null;
  complete: boolean;
  overdue: boolean;
  /** 이 지급월에 신고할 작업이 있는가 (반기납부 중간 달이면 false) */
  filingDueThisPeriod: boolean;
}

const CONFIRMED = new Set(['confirmed', 'exported', 'filed']);
const INCOME_STEP: Record<IncomeType, FilingStep> = { earned: 'earned_confirmed', business: 'business_confirmed', daily: 'daily_confirmed' };

/**
 * 수임처 1곳의 10단계 상태.
 * @param period 지급월 P
 * @param today KST 'YYYY-MM-DD'
 */
export function deriveBoardRow(c: BoardClientInput, period: string, today: string): BoardRowResult {
  const steps: BoardStep[] = [];
  const blockers: string[] = [];
  const push = (step: FilingStep, status: StepStatus, at: string | null = null, detail: string | null = null) =>
    steps.push({ step, label: FILING_STEP_LABELS[step], status, at, detail });

  const headcount: Record<IncomeType, number> = { earned: 0, business: 0, daily: 0 };
  for (const m of c.months) for (const t of ['earned', 'business', 'daily'] as const) headcount[t] += m.headcountByType[t];
  const hasMonth = c.months.length > 0;
  const present = (t: IncomeType) => (hasMonth ? headcount[t] > 0 : c.activeEmployees[t] > 0);
  const anyPresent = present('earned') || present('business') || present('daily');
  const pendingReview = c.months.reduce((s, m) => s + m.pendingReview, 0);
  const missingId = c.months.reduce((s, m) => s + m.missingId, 0);
  const validationBlocking = c.months.reduce((s, m) => s + (m.validationBlocking ?? 0), 0);
  const allConfirmed = hasMonth && c.months.every((m) => CONFIRMED.has(m.status));
  const confirmedAt = allConfirmed ? c.months.map((m) => m.confirmedAt).filter(Boolean).sort().at(-1) ?? null : null;
  const jobBy = (kind: FilingKind, jobPeriod: string | undefined) => (jobPeriod ? c.jobs.find((j) => j.kind === kind && j.period === jobPeriod) : undefined);

  // 1 인건비 입력
  if (!anyPresent && !hasMonth) push('payroll_input', 'na', null, '이 지급월 급여 대상 없음');
  else if (hasMonth && headcount.earned + headcount.business + headcount.daily > 0) {
    push('payroll_input', 'done', c.months[0]!.createdAt, pendingReview > 0 ? `변경 ${pendingReview}명 검토 대기` : null);
  } else push('payroll_input', 'pending', null, hasMonth ? '급여 행 없음' : '이번 달 급여 시작 전');

  // 2~4 소득구분별 확정
  for (const t of ['earned', 'business', 'daily'] as const) {
    const step = INCOME_STEP[t];
    if (!present(t)) push(step, 'na');
    else if (allConfirmed) push(step, 'done', confirmedAt);
    else {
      const detail = pendingReview > 0 ? `변경 ${pendingReview}명 검토 대기` : validationBlocking > 0 ? `검산 차단 ${validationBlocking}건` : hasMonth ? '확정 전' : '급여 시작 전';
      push(step, 'pending', null, detail);
    }
  }

  // 5~7 준비 (이 지급월 지급분이 작업에 들어갔는가)
  const readyStatus = (kinds: FilingKind[]): { status: StepStatus; at: string | null } => {
    if (kinds.length === 0) return { status: 'na', at: null };
    let at: string | null = null;
    for (const k of kinds) {
      const j = jobBy(k, c.includeTargets[k]);
      if (!j || !j.monthsIncluded.includes(period) || !j.steps[READY_STEP_OF[k]]) return { status: 'pending', at: null };
      const a = j.steps[READY_STEP_OF[k]] ?? null;
      if (a && (!at || a > at)) at = a;
    }
    return { status: 'done', at };
  };
  const whKinds: FilingKind[] = anyPresent ? ['withholding'] : [];
  const stKinds: FilingKind[] = (['earned', 'business', 'daily'] as const).filter(present).map((t) => STATEMENT_KIND_OF[t]);
  const lcKinds: FilingKind[] = anyPresent ? ['local_income_tax'] : [];
  const w = readyStatus(whKinds);
  push('withholding_ready', w.status, w.at);
  const s = readyStatus(stKinds);
  const earnedTarget = c.includeTargets.simplified_statement_earned;
  push('simplified_statement_ready', s.status, s.at, present('earned') && earnedTarget && earnedTarget !== period ? `근로 간이지급명세서는 ${earnedTarget} 묶음 제출` : null);
  const l = readyStatus(lcKinds);
  push('local_tax_ready', l.status, l.at);

  // 8~10 신고·증빙 (이 지급월이 신고 기간인 작업만)
  const expectedJobs = c.expected.map((e) => ({ e, j: jobBy(e.kind, e.period) }));
  const filingDueThisPeriod = expectedJobs.length > 0;
  let complete = false;
  if (!filingDueThisPeriod) {
    const detail = c.semiannual && anyPresent ? `반기납부 — ${c.includeTargets.withholding ?? ''} 반기 신고에 포함` : null;
    push('filed', 'na', null, detail);
    push('receipt_collected', 'na');
    push('payment_slip_collected', 'na');
    complete = steps.filter((x) => x.step !== 'filed').every((x) => x.status === 'done' || x.status === 'na');
  } else {
    const filed = expectedJobs.filter((x) => x.j?.steps.filed);
    const allFiled = filed.length === expectedJobs.length;
    const withReceipt = expectedJobs.filter((x) => (x.j?.receipts ?? 0) > 0);
    const allReceipts = withReceipt.length === expectedJobs.length;
    const lastFiled = filed.map((x) => x.j!.steps.filed!).sort().at(-1) ?? null;
    if (allFiled && allReceipts) push('filed', 'done', lastFiled);
    else if (allFiled) push('filed', 'attention', lastFiled, `신고 완료 표시됨 · 접수증 ${expectedJobs.length - withReceipt.length}건 미수집 (홈택스 이용 규정 제13조: 접수증 보관)`);
    else push('filed', 'pending', null, `${expectedJobs.length - filed.length}건 신고 전 (${expectedJobs.filter((x) => !x.j?.steps.filed).map((x) => FILING_KIND_LABELS[x.e.kind]).join(', ')})`);
    push('receipt_collected', allReceipts ? 'done' : 'pending', null, allReceipts ? null : `${expectedJobs.length - withReceipt.length}건 미수집`);
    const payJobs = expectedJobs.filter((x) => (x.e.kind === 'withholding' ? (x.j?.incomeTax ?? 1) : x.e.kind === 'local_income_tax' ? (x.j?.localIncomeTax ?? 1) : 0) > 0);
    if (payJobs.length === 0) push('payment_slip_collected', 'na', null, '납부할 세액 없음');
    else {
      const withSlip = payJobs.filter((x) => (x.j?.paymentSlips ?? 0) > 0).length;
      push('payment_slip_collected', withSlip === payJobs.length ? 'done' : 'pending', null, withSlip === payJobs.length ? null : `${payJobs.length - withSlip}건 미수집`);
    }
    complete = steps.every((x) => x.status === 'done' || x.status === 'na');
  }

  // 기한 · 기한 경과
  const dueCandidates = (filingDueThisPeriod ? c.expected : []).map((e) => e.dueDate).sort();
  const dueDate = dueCandidates[0] ?? null;
  const dDay = dueDate ? daysBetween(today, dueDate) : null;
  let overdue = false;
  if (dDay !== null && dDay < 0 && !complete) {
    for (const st of steps) {
      if (st.status === 'pending' && FILING_STEPS.indexOf(st.step) <= FILING_STEPS.indexOf('filed')) {
        st.status = 'overdue';
        overdue = true;
      }
    }
  }

  if (pendingReview > 0) blockers.push(`인건비 변경 ${pendingReview}명 미검토`);
  if (missingId > 0) blockers.push(`주민번호 없는 직원 ${missingId}명 — 신고 불가`);
  if (validationBlocking > 0 && pendingReview === 0) blockers.push(`검산 차단 ${validationBlocking}건`);
  for (const w2 of c.exportWarnings) blockers.push(w2);
  if (overdue) blockers.push(`신고 기한 경과 (${dueDate}, ${dDayLabel(dDay!)})`);
  const filedStep = steps.find((x) => x.step === 'filed');
  if (filedStep?.status === 'attention') blockers.push('접수증 미수집 — 신고 완료로 인정되지 않습니다');

  return {
    steps,
    dueDate,
    dDay,
    dDayLabel: dDay === null ? null : dDayLabel(dDay),
    blockers,
    nextAction: nextActionOf(c, steps, period),
    complete,
    overdue,
    filingDueThisPeriod,
  };
}

function nextActionOf(c: BoardClientInput, steps: BoardStep[], period: string): BoardAction | null {
  const first = steps.find((s) => s.status !== 'done' && s.status !== 'na');
  if (!first) return null;
  const m = c.months[0];
  const payrollPeriod = m?.period ?? period;
  const wizard = `/payroll/${c.clientId}/${payrollPeriod}`;
  switch (first.step) {
    case 'payroll_input':
      return { step: first.step, label: m ? '급여 자료 반영' : '이번 달 급여 시작', href: wizard };
    case 'earned_confirmed':
    case 'business_confirmed':
    case 'daily_confirmed': {
      const pending = c.months.reduce((s, x) => s + x.pendingReview, 0);
      return { step: first.step, label: pending > 0 ? `변경 ${pending}명 검토` : '급여 확정', href: wizard };
    }
    case 'withholding_ready':
    case 'simplified_statement_ready':
    case 'local_tax_ready':
      return { step: first.step, label: '신고 준비(급여 확정)', href: wizard };
    case 'filed':
      return { step: first.step, label: first.status === 'attention' ? '접수증 올리기' : '신고 완료 표시', href: `/filing?period=${period}&client=${c.clientId}` };
    case 'receipt_collected':
      return { step: first.step, label: '접수증 올리기', href: `/filing?period=${period}&client=${c.clientId}` };
    case 'payment_slip_collected':
      return { step: first.step, label: '납부서 올리기', href: `/filing?period=${period}&client=${c.clientId}` };
    default:
      return null;
  }
}
