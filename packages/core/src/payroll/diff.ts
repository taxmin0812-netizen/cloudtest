import type {
  EmployeeSnapshot,
  IncomeType,
  LocalDate,
  PayrollChange,
  PayrollChangeKind,
  PayrollLine,
  RiskSeverity,
  UUID,
  YearMonth,
} from '../types';
import { formatWon } from '../money';
import { yearMonthOf } from '../normalize';
import { INCOME_TYPE_LABELS } from './withholding';

/**
 * 인건비 변동분 확인 (전월 대비 diff).
 *
 * 목표: 전월 8명·이번달 8명이면 "변동 없음 6명 / 급여변경 1명 / 신규입사 1명" 처럼
 * 직원이 실제로 확인해야 할 사람만 needsReview 로 남긴다.
 *
 * needsReview=false 인 경우 (의도적으로 계약 주석보다 좁힘):
 * - unchanged (일용직은 일당 동일 + 근무일수만 변동도 unchanged)
 * - 전월 이전에 퇴사가 확정되어 이번달 지급이 없는 사람 (kinds=['resigned'], severity info) — 정상 소멸
 */

export interface PayrollMonthData {
  employees: EmployeeSnapshot[];
  lines: PayrollLine[];
}

export interface DiffOptions {
  /** 급여 증감률 경고 임계치 (%) — 기본 20. 경계값 포함(≥) */
  largeChangePct?: number;
  /** 이번달 귀속연월 'YYYY-MM'. 퇴사일 판단에 사용 (없으면 이번달 지급일의 최빈 연월로 추정) */
  period?: YearMonth;
}

export interface PayrollDiffSummary {
  unchanged: number;
  /** pay_changed (pay_changed_large 포함) */
  payChanged: number;
  payChangedLarge: number;
  newHire: number;
  missing: number;
  resigned: number;
  zeroPay: number;
  missingId: number;
  incomeTypeChanged: number;
  needsReview: number;
  total: number;
}

export interface PayrollDiffResult {
  changes: PayrollChange[];
  summary: PayrollDiffSummary;
  /** 판단에 사용한 귀속연월 (추정 포함) */
  period: YearMonth | null;
}

const SEVERITY_RANK: Record<RiskSeverity, number> = { info: 0, warning: 1, high: 2 };

const KIND_SEVERITY: Record<PayrollChangeKind, RiskSeverity> = {
  unchanged: 'info',
  pay_changed: 'info',
  pay_changed_large: 'warning',
  new_hire: 'info',
  missing_this_month: 'warning',
  resigned: 'warning',
  zero_pay: 'warning',
  missing_id: 'high',
  income_type_changed: 'high',
};

/** 금액 라벨 (일용직 일당 비교는 comparePay 에서 별도 표기) */
const PAY_LABEL: Record<IncomeType, string> = { earned: '급여', business: '지급액', daily: '지급액' };

function maxSeverity(a: RiskSeverity, b: RiskSeverity): RiskSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** 같은 직원의 지급행이 여러 건이면 합산 (상여 별도 지급 등) */
function mergeLines(lines: PayrollLine[]): Map<string, { line: PayrollLine; count: number }> {
  const map = new Map<string, { line: PayrollLine; count: number }>();
  lines.forEach((l, idx) => {
    const key = l.employeeId ? `id:${l.employeeId}` : `noid:${idx}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { line: { ...l, allowances: { ...l.allowances } }, count: 1 });
      return;
    }
    const a = prev.line;
    const allowances = { ...a.allowances };
    for (const [k, v] of Object.entries(l.allowances)) allowances[k] = (allowances[k] ?? 0) + v;
    prev.line = {
      ...a,
      taxablePay: a.taxablePay + l.taxablePay,
      nonTaxablePay: a.nonTaxablePay + l.nonTaxablePay,
      grossPay: a.grossPay + l.grossPay,
      allowances,
      workDays: a.workDays !== undefined || l.workDays !== undefined ? (a.workDays ?? 0) + (l.workDays ?? 0) : undefined,
      incomeTax: a.incomeTax + l.incomeTax,
      localIncomeTax: a.localIncomeTax + l.localIncomeTax,
      otherDeductions: a.otherDeductions + l.otherDeductions,
      netPay: a.netPay + l.netPay,
      paymentDate: maxDate(a.paymentDate, l.paymentDate),
    };
    prev.count += 1;
  });
  return map;
}

function maxDate(a: LocalDate | null, b: LocalDate | null): LocalDate | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function inferPeriod(lines: PayrollLine[]): YearMonth | null {
  const counts = new Map<string, number>();
  for (const l of lines) if (l.paymentDate) counts.set(yearMonthOf(l.paymentDate), (counts.get(yearMonthOf(l.paymentDate)) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [ym, n] of counts) if (n > bestN) [best, bestN] = [ym, n];
  return best;
}

/** 증감률(%) 소수 1자리. 전월 0 이면 null */
export function changeRatePct(prev: number, curr: number): number | null {
  if (prev === 0) return null;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

function formatRate(rate: number | null): string {
  if (rate === null) return '';
  const sign = rate > 0 ? '+' : rate < 0 ? '' : '±';
  return ` (${sign}${rate.toFixed(1)}%)`;
}

/** |curr − prev| ≥ pct% × prev — 정수 비교로 경계값 오차 없음 */
function isLargeChange(prev: number, curr: number, pct: number): boolean {
  if (prev === 0) return curr !== 0;
  return Math.abs(curr - prev) * 100 >= pct * Math.abs(prev);
}

interface PayCompare {
  changed: boolean;
  large: boolean;
  rate: number | null;
  messages: string[];
}

function comparePay(prev: PayrollLine, curr: PayrollLine, largePct: number): PayCompare {
  const messages: string[] = [];
  const pd = prev.workDays ?? 0;
  const cd = curr.workDays ?? 0;
  if (curr.incomeType === 'daily' && prev.incomeType === 'daily' && pd > 0 && cd > 0) {
    // 일용직: 일당 비교 (근무일수 변동은 정상)
    const sameWage = prev.grossPay * cd === curr.grossPay * pd;
    const prevWage = Math.round(prev.grossPay / pd);
    const currWage = Math.round(curr.grossPay / cd);
    if (sameWage) {
      const rate = changeRatePct(prev.grossPay, curr.grossPay);
      if (pd !== cd) {
        messages.push(`근무일수 ${pd}일 → ${cd}일 (일당 ${formatWon(currWage)} 동일), 지급액 ${formatWon(prev.grossPay)} → ${formatWon(curr.grossPay)}`);
      }
      return { changed: false, large: false, rate, messages };
    }
    // 일당 증감률은 정확한 분수로 계산
    const rate = prev.grossPay === 0 ? null : Math.round(((curr.grossPay * pd - prev.grossPay * cd) / (prev.grossPay * cd)) * 1000) / 10;
    const large = prev.grossPay === 0 ? true : Math.abs(curr.grossPay * pd - prev.grossPay * cd) * 100 >= largePct * prev.grossPay * cd;
    messages.push(`일당 ${formatWon(prevWage)} → ${formatWon(currWage)}${formatRate(rate)}`);
    if (pd !== cd) messages.push(`근무일수 ${pd}일 → ${cd}일`);
    return { changed: true, large, rate, messages };
  }

  const label = PAY_LABEL[curr.incomeType];
  const rate = changeRatePct(prev.grossPay, curr.grossPay);
  if (prev.grossPay !== curr.grossPay) {
    messages.push(`${label} ${formatWon(prev.grossPay)} → ${formatWon(curr.grossPay)}${formatRate(rate)}`);
    const itemDiff = describeAllowanceDiff(prev.allowances, curr.allowances);
    if (itemDiff) messages.push(itemDiff);
    return { changed: true, large: isLargeChange(prev.grossPay, curr.grossPay, largePct), rate, messages };
  }
  if (prev.taxablePay !== curr.taxablePay) {
    messages.push(
      `지급총액 동일, 과세/비과세 구성 변경: 과세 ${formatWon(prev.taxablePay)} → ${formatWon(curr.taxablePay)}, 비과세 ${formatWon(prev.nonTaxablePay)} → ${formatWon(curr.nonTaxablePay)}`,
    );
    return { changed: true, large: false, rate: 0, messages };
  }
  return { changed: false, large: false, rate: 0, messages };
}

function describeAllowanceDiff(prev: Record<string, number>, curr: Record<string, number>): string | null {
  const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  const parts: string[] = [];
  for (const k of keys) {
    const a = prev[k] ?? 0;
    const b = curr[k] ?? 0;
    if (a === b) continue;
    if (a === 0) parts.push(`${k} 신규 ${formatWon(b)}`);
    else if (b === 0) parts.push(`${k} 삭제(전월 ${formatWon(a)})`);
    else parts.push(`${k} ${formatWon(a)} → ${formatWon(b)}`);
  }
  return parts.length ? `항목 변동: ${parts.join(', ')}` : null;
}

/**
 * 전월 대비 인건비 변동 분류.
 */
export function diffPayroll(prev: PayrollMonthData, curr: PayrollMonthData, opts: DiffOptions = {}): PayrollDiffResult {
  const largePct = opts.largeChangePct ?? 20;
  const period = opts.period ?? inferPeriod(curr.lines);
  const periodStart = period ? `${period}-01` : null;
  const periodEnd = period ? `${period}-31` : null; // 문자열 비교용 상한

  const empById = new Map<UUID, EmployeeSnapshot>();
  for (const e of prev.employees) empById.set(e.employeeId, e);
  for (const e of curr.employees) empById.set(e.employeeId, e); // 이번달 마스터 우선

  const prevMap = mergeLines(prev.lines);
  const currMap = mergeLines(curr.lines);
  const changes: PayrollChange[] = [];

  // 이번달 지급행 기준
  for (const [key, { line: c, count }] of currMap) {
    const p = key.startsWith('id:') ? prevMap.get(key)?.line ?? null : null;
    const emp = c.employeeId ? empById.get(c.employeeId) : undefined;
    const kinds: PayrollChangeKind[] = [];
    const messages: string[] = [];
    let severity: RiskSeverity = 'info';
    let changeRate: number | null = null;
    const add = (k: PayrollChangeKind, msg?: string) => {
      if (!kinds.includes(k)) kinds.push(k);
      severity = maxSeverity(severity, KIND_SEVERITY[k]);
      if (msg) messages.push(msg);
    };

    if (count > 1) messages.push(`동일 직원 지급내역 ${count}건 합산`);

    // 식별정보
    if (!c.employeeId) add('missing_id', '직원 ID 없음 — 직원 마스터와 연결 필요');
    else if (!emp) add('missing_id', '직원 마스터에 없는 직원 — 등록 필요');
    else if (!emp.hasIdNumber) add('missing_id', '주민(외국인)등록번호 미등록 — 신고 불가');

    // 신규/재지급
    if (!p) {
      const hire = emp?.hireDate ?? null;
      if (hire && period && yearMonthOf(hire) === period) add('new_hire', `신규입사 (입사일 ${hire})`);
      else if (hire) add('new_hire', `전월 지급내역 없음 (입사일 ${hire}) — 재입사/복귀 여부 확인`);
      else add('new_hire', '전월 지급내역 없음 — 신규 여부 확인');
      messages.push(`${PAY_LABEL[c.incomeType]} ${formatWon(c.grossPay)}${c.incomeType === 'daily' && c.workDays ? ` (${c.workDays}일)` : ''}`);
    } else {
      if (p.incomeType !== c.incomeType) {
        add('income_type_changed', `소득구분 변경: ${INCOME_TYPE_LABELS[p.incomeType]} → ${INCOME_TYPE_LABELS[c.incomeType]} — 원천징수 방식 확인`);
      }
      const cmp = comparePay(p, c, largePct);
      changeRate = cmp.rate;
      if (cmp.changed) {
        add('pay_changed');
        if (cmp.large) add('pay_changed_large', `증감률 ±${largePct}% 이상`);
      }
      messages.unshift(...cmp.messages);
    }

    // 무급
    if (c.grossPay === 0) add('zero_pay', '지급액 0원 — 휴직/무급 여부 확인');

    // 퇴사
    const resign = emp?.resignDate ?? null;
    if (resign) {
      if (!period || resign <= periodEnd!) {
        if (periodStart && resign < periodStart) add('resigned', `퇴사일(${resign}) 이후 급여 지급 — 확인 필요`);
        else add('resigned', `퇴사월 (퇴사일 ${resign}) — 퇴사월 급여·4대보험 상실 확인`);
      } else {
        messages.push(`퇴사 예정 (퇴사일 ${resign})`);
      }
    }

    if (kinds.length === 0) kinds.push('unchanged');
    const needsReview = !(kinds.length === 1 && kinds[0] === 'unchanged');
    changes.push({
      employeeId: c.employeeId,
      name: c.name,
      incomeType: c.incomeType,
      kinds,
      previous: p,
      current: c,
      changeRate,
      needsReview,
      severity,
      messages,
    });
  }

  // 전월에는 있었는데 이번달 없는 직원
  for (const [key, { line: p }] of prevMap) {
    // ID 없는 전월행은 매칭 불가 — 전월 검토에서 처리
    if (!key.startsWith('id:') || currMap.has(key)) continue;
    const emp = empById.get(p.employeeId);
    const resign = emp?.resignDate ?? null;
    const base: Omit<PayrollChange, 'kinds' | 'needsReview' | 'severity' | 'messages'> = {
      employeeId: p.employeeId,
      name: p.name,
      incomeType: p.incomeType,
      previous: p,
      current: null,
      changeRate: -100,
    };
    if (resign && periodStart && resign < periodStart) {
      // 전월 이전 퇴사 확정 — 이번달 지급 없음이 정상
      changes.push({
        ...base,
        kinds: ['resigned'],
        needsReview: false,
        severity: 'info',
        messages: [`전월 퇴사 (퇴사일 ${resign}) — 이번달 지급 없음 정상`],
      });
    } else if (resign && (!periodEnd || resign <= periodEnd)) {
      changes.push({
        ...base,
        kinds: ['resigned'],
        needsReview: true,
        severity: 'warning',
        messages: [`퇴사월 (퇴사일 ${resign}) 지급내역 없음 — 퇴사월 급여 누락 여부 확인`],
      });
    } else {
      changes.push({
        ...base,
        kinds: ['missing_this_month'],
        needsReview: true,
        severity: 'warning',
        messages: [`전월 ${PAY_LABEL[p.incomeType]} ${formatWon(p.grossPay)} → 이번달 지급내역 없음 — 퇴사 여부 확인`],
      });
    }
  }

  changes.sort(
    (a, b) =>
      Number(b.needsReview) - Number(a.needsReview) ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.name.localeCompare(b.name, 'ko'),
  );

  return { changes, summary: summarizeChanges(changes), period };
}

export function summarizeChanges(changes: PayrollChange[]): PayrollDiffSummary {
  const s: PayrollDiffSummary = {
    unchanged: 0,
    payChanged: 0,
    payChangedLarge: 0,
    newHire: 0,
    missing: 0,
    resigned: 0,
    zeroPay: 0,
    missingId: 0,
    incomeTypeChanged: 0,
    needsReview: 0,
    total: changes.length,
  };
  for (const c of changes) {
    const k = new Set(c.kinds);
    if (k.has('unchanged')) s.unchanged++;
    if (k.has('pay_changed') || k.has('pay_changed_large')) s.payChanged++;
    if (k.has('pay_changed_large')) s.payChangedLarge++;
    if (k.has('new_hire')) s.newHire++;
    if (k.has('missing_this_month')) s.missing++;
    if (k.has('resigned')) s.resigned++;
    if (k.has('zero_pay')) s.zeroPay++;
    if (k.has('missing_id')) s.missingId++;
    if (k.has('income_type_changed')) s.incomeTypeChanged++;
    if (c.needsReview) s.needsReview++;
  }
  return s;
}

/** "변동 없음 6명 / 급여변경 1명 / 신규입사 1명" — 0명 항목은 생략 */
export function formatDiffSummary(s: PayrollDiffSummary): string {
  const parts: Array<[string, number]> = [
    ['변동 없음', s.unchanged],
    ['급여변경', s.payChanged],
    ['신규입사', s.newHire],
    ['퇴사', s.resigned],
    ['이번달 누락', s.missing],
    ['무급', s.zeroPay],
    ['식별정보 누락', s.missingId],
    ['소득구분 변경', s.incomeTypeChanged],
  ];
  const text = parts
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}명`)
    .join(' / ');
  return text || '대상 없음';
}
