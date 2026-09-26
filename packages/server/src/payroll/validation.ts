/**
 * 4단계 세액 계산·검산 — 사업소득 3%(+0.3%)·일용근로 산식 재계산, 근로소득 정합성(validateEarnedWithholding),
 * 지방소득세 10%, 지급총액·차인지급액 검산, 0원 지급, 주민번호 누락, 지급일.
 * blocking 이슈가 하나라도 있으면 파일 생성·확정을 막는다.
 */
import { yearMonthOf, type RiskSeverity } from '@mintax/core';
import { checkLineWithholding } from '@mintax/core/payroll/index';
import type { ServiceContext } from '../context';
import { itemToLine, sumLines } from './helpers';
import { computeMonthState, nameOf } from './month-engine';
import { patchTotals, totalsOf, type MonthContext } from './store';
import type { PayrollValidationDTO, PayrollValidationIssue } from './types';

/** severity 와 무관하게 확정을 막는 코드 */
const BLOCKING_CODES = new Set([
  'pending_review',
  'missing_id',
  'no_items',
  'net_mismatch',
  'gross_mismatch',
  'tax_mismatch',
  'local_tax_mismatch',
  'missing_payment_date',
  'missing_business_code',
  'invalid_amount',
  'daily_missing_days',
  'daily_invalid_days',
  'negative_pay',
]);

export interface ValidationRun extends PayrollValidationDTO {
  missingIdCount: number;
}

export async function runPayrollValidation(ctx: ServiceContext, payrollMonthId: string, opts: { persist: boolean; mc?: MonthContext }): Promise<ValidationRun> {
  const s = await computeMonthState(ctx, payrollMonthId, opts.mc);
  const m = s.mc.month;
  const issues: PayrollValidationIssue[] = [];
  const add = (i: Omit<PayrollValidationIssue, 'blocking'> & { blocking?: boolean }) =>
    issues.push({ ...i, blocking: i.blocking ?? (i.severity === 'high' || BLOCKING_CODES.has(i.code)) });

  if (s.items.length === 0) {
    add({ itemId: null, employeeId: null, name: null, code: 'no_items', severity: 'high', message: '이번 달 급여 행이 없습니다. 전월 복사나 자료 반영을 먼저 하세요.' });
  }

  // 검토 대기 (3단계 미완료)
  for (const c of s.diff.changes) {
    if (!c.needsReview || s.reviewedOf(c.employeeId).reviewed) continue;
    add({
      itemId: s.itemByEmp.get(c.employeeId)?.id ?? null,
      employeeId: c.employeeId,
      name: c.name,
      code: 'pending_review',
      severity: 'warning',
      message: `${c.name}: 변경 확인 대기 (${c.messages[0] ?? c.kinds.join(', ')})`,
    });
  }

  const prevByEmp = new Map(s.prevLines.map((l) => [l.employeeId, l]));
  let missingIdCount = 0;
  for (const item of s.items) {
    const emp = s.empById.get(item.employeeId);
    const name = nameOf(s.empById, item.employeeId);
    const line = itemToLine(item, name);
    const base = { itemId: item.id, employeeId: item.employeeId, name };
    if (!emp?.idNumberEnc) {
      missingIdCount++;
      add({ ...base, code: 'missing_id', severity: 'high', message: `${name}: 주민(외국인)등록번호 미등록 — 원천세·지급명세서 신고 불가. 직원 설정에서 등록하세요.` });
    }
    if (line.grossPay < 0 || line.taxablePay < 0 || line.nonTaxablePay < 0) {
      add({ ...base, code: 'negative_pay', severity: 'high', message: `${name}: 음수 금액 — 환수/정정은 WEHAGO 에서 처리하세요.` });
    } else if (line.grossPay === 0) {
      add({ ...base, code: 'zero_pay', severity: 'warning', message: `${name}: 지급액 0원 — 휴직·무급이면 3단계에서 '휴직' 으로 처리하세요.` });
    }
    if (line.incomeType === 'earned' && line.taxablePay + line.nonTaxablePay !== line.grossPay) {
      add({ ...base, code: 'gross_mismatch', severity: 'high', message: `${name}: 지급총액 ${line.grossPay.toLocaleString('ko-KR')}원 ≠ 과세 ${line.taxablePay.toLocaleString('ko-KR')}원 + 비과세 ${line.nonTaxablePay.toLocaleString('ko-KR')}원` });
    }
    const net = line.grossPay - line.incomeTax - line.localIncomeTax - line.otherDeductions;
    if (net !== line.netPay) {
      add({ ...base, code: 'net_mismatch', severity: 'high', message: `${name}: 차인지급액 ${line.netPay.toLocaleString('ko-KR')}원 ≠ 지급총액 − 공제 ${net.toLocaleString('ko-KR')}원` });
    }
    if (!line.paymentDate) {
      add({ ...base, code: 'missing_payment_date', severity: 'high', message: `${name}: 지급일 미입력 — 원천세는 지급일 기준으로 신고합니다.` });
    } else if (yearMonthOf(line.paymentDate) !== m.paymentPeriod) {
      add({ ...base, code: 'payment_period_mismatch', severity: 'warning', message: `${name}: 지급일 ${line.paymentDate} 이 지급월(${m.paymentPeriod})과 다릅니다.` });
    }
    if (line.incomeType === 'business' && !emp?.businessIncomeCode) {
      add({ ...base, code: 'missing_business_code', severity: 'high', message: `${name}: 사업소득 업종코드 미등록 — WEHAGO 사업소득 파일·간이지급명세서를 만들 수 없습니다.` });
    }
    for (const w of checkLineWithholding(line, prevByEmp.get(item.employeeId) ?? null, { dependents: emp?.dependents ?? 1 })) {
      // 사업·일용 세액은 저장 시 자동 계산되므로 불일치는 데이터 오류 → 차단
      let severity: RiskSeverity = w.severity;
      if ((w.code === 'tax_mismatch' || w.code === 'local_tax_mismatch' || w.code === 'gross_mismatch') && severity !== 'high') severity = 'high';
      const fix = w.code === 'tax_mismatch' ? ' — 급여 행을 다시 저장하면 법정 산식으로 다시 계산합니다.' : '';
      add({ ...base, code: w.code, severity, message: `${name}: ${w.message}${fix}` });
    }
  }

  const counts = { high: 0, warning: 0, info: 0, blocking: 0 };
  for (const i of issues) {
    counts[i.severity]++;
    if (i.blocking) counts.blocking++;
  }
  issues.sort((a, b) => Number(b.blocking) - Number(a.blocking) || rank(b.severity) - rank(a.severity) || (a.name ?? '').localeCompare(b.name ?? '', 'ko'));
  const ok = counts.blocking === 0;
  const checkedAt = ctx.now().toISOString();
  const totals = sumLines(s.currLines);
  const summary = ok
    ? `검산 통과: ${totals.headcount}명 · 지급총액 ${totals.grossPay.toLocaleString('ko-KR')}원 · 소득세 ${totals.incomeTax.toLocaleString('ko-KR')}원 · 지방소득세 ${totals.localIncomeTax.toLocaleString('ko-KR')}원${counts.warning ? ` (확인 권장 ${counts.warning}건)` : ''}`
    : `확정 불가: 차단 ${counts.blocking}건${missingIdCount ? ` (주민번호가 없는 직원 ${missingIdCount}명)` : ''}`;

  if (opts.persist && !['confirmed', 'exported', 'filed'].includes(m.status)) {
    const step = ok ? Math.max(m.wizardStep, 5) : Math.min(m.wizardStep, (totalsOf(m).pendingReview ?? 0) > 0 ? 3 : 4);
    await patchTotals(ctx, m.id, { validation: { ok, checkedAt, blocking: counts.blocking, high: counts.high, warning: counts.warning, info: counts.info, missingId: missingIdCount } }, { wizardStep: step });
    m.wizardStep = step;
  }
  return { payrollMonthId: m.id, ok, checkedAt, counts, issues, totals, summary, missingIdCount };
}

function rank(s: RiskSeverity): number {
  return s === 'high' ? 2 : s === 'warning' ? 1 : 0;
}
