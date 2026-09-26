import { describe, expect, it } from 'vitest';
import {
  addDays,
  findCadenceRule,
  isBusinessDay,
  KR_HOLIDAYS,
  lastDayOfMonth,
  localIncomeTaxDueDate,
  shiftToBusinessDay,
  simplifiedStatementDueDate,
  simplifiedStatementDueDetail,
  SUBMISSION_CADENCE_RULES,
  weekdayLabel,
  withholdingDueDate,
  withholdingDueDetail,
  type CadenceRule,
} from './calendar';

describe('날짜 유틸', () => {
  it('말일·일자 가산', () => {
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
    expect(lastDayOfMonth('2026-12')).toBe('2026-12-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekdayLabel('2026-10-10')).toBe('토');
  });
  it('공휴일 목록: 날짜 중복 없음, 2026 노동절·제헌절 포함', () => {
    const dates = KR_HOLIDAYS.map((h) => h.date);
    expect(new Set(dates).size).toBe(dates.length);
    expect(isBusinessDay('2026-05-01')).toBe(false);
    expect(isBusinessDay('2026-07-17')).toBe(false);
    expect(isBusinessDay('2026-06-03')).toBe(false); // 지방선거
    expect(isBusinessDay('2026-10-12')).toBe(true);
    expect(isBusinessDay('2026-10-10')).toBe(false); // 토
  });
  it('휴일 연쇄 보정', () => {
    // 10-03(토 개천절) → 10-04(일) → 10-05(대체공휴일) → 10-06(화)
    expect(shiftToBusinessDay('2026-10-03').date).toBe('2026-10-06');
    // 설 연휴: 02-14(토) → 15(일) → 16~18(설) → 19(목)
    const r = shiftToBusinessDay('2026-02-14');
    expect(r.date).toBe('2026-02-19');
    expect(r.skipped).toHaveLength(5);
    expect(shiftToBusinessDay('2026-10-12').date).toBe('2026-10-12');
  });
});

describe('원천세 기한 (다음 달 10일 / 반기납부)', () => {
  it('매월: 2026-09 지급분 → 10-10(토) → 10-12(월)', () => {
    const d = withholdingDueDetail('2026-09');
    expect(d.statutoryDate).toBe('2026-10-10');
    expect(d.dueDate).toBe('2026-10-12');
    expect(d.shifted).toBe(true);
    expect(d.shiftNote).toContain('2026-10-10(토)');
    expect(d.basis).toContain('제128조');
    expect(d.outsideHolidayCoverage).toBe(false);
  });
  it('매월: 보정 불필요한 달', () => {
    expect(withholdingDueDate('2026-10')).toBe('2026-11-10');
    expect(withholdingDueDate('2026-02')).toBe('2026-03-10');
    expect(withholdingDueDetail('2026-10').shiftNote).toBeNull();
  });
  it('매월: 12월 지급분 → 다음 해 1월 10일(일) → 1월 11일', () => {
    expect(withholdingDueDate('2026-12')).toBe('2027-01-11');
  });
  it('반기납부: 1~6월 → 7월 10일, 7~12월 → 다음 해 1월 10일', () => {
    expect(withholdingDueDate('2026-01', true)).toBe('2026-07-10');
    expect(withholdingDueDate('2026-06', true)).toBe('2026-07-10');
    expect(withholdingDueDate('2026-07', true)).toBe('2027-01-11');
    expect(withholdingDueDate('2026-12', true)).toBe('2027-01-11');
    expect(withholdingDueDetail('2026-03', true).basis).toContain('반기납부');
  });
  it('지방소득세 특별징수 기한 = 원천세 기한', () => {
    expect(localIncomeTaxDueDate('2026-09')).toBe('2026-10-12');
    expect(localIncomeTaxDueDate('2026-09', true)).toBe('2027-01-11');
  });
  it('임시공휴일 등 사용자 공휴일 목록', () => {
    expect(withholdingDueDate('2026-09', false, { holidays: ['2026-10-12'] })).toBe('2026-10-13');
  });
  it('공휴일 목록 범위 밖 → 경고 플래그', () => {
    expect(withholdingDueDetail('2028-04').outsideHolidayCoverage).toBe(true);
  });
  it('잘못된 연월 → 오류', () => {
    expect(() => withholdingDueDate('2026-13')).toThrow('YYYY-MM');
    expect(() => withholdingDueDate('202609')).toThrow();
  });
});

describe('지급명세서 제출기한 (데이터 기반 주기)', () => {
  it('사업소득 간이지급명세서: 매월, 다음 달 말일 (10-31 토 → 11-02 월)', () => {
    const d = simplifiedStatementDueDetail('business', '2026-09');
    expect(d.cycle).toBe('monthly');
    expect(d.statutoryDate).toBe('2026-10-31');
    expect(d.dueDate).toBe('2026-11-02');
    expect(d.submissionPeriod).toEqual({ from: '2026-09', to: '2026-09' });
  });
  it('일용근로소득 지급명세서: 매월', () => {
    expect(simplifiedStatementDueDate('daily', '2026-05')).toBe('2026-06-30');
    expect(simplifiedStatementDueDate('daily', '2026-09')).toBe('2026-11-02');
  });
  it('근로소득 간이지급명세서 2026년: 반기 (상반기 7/31, 하반기 다음 해 1/31)', () => {
    const h1 = simplifiedStatementDueDetail('earned', '2026-03');
    expect(h1.cycle).toBe('semiannual');
    expect(h1.submissionPeriod).toEqual({ from: '2026-01', to: '2026-06' });
    expect(h1.dueDate).toBe('2026-07-31');
    const h2 = simplifiedStatementDueDetail('earned', '2026-09');
    expect(h2.statutoryDate).toBe('2027-01-31');
    expect(h2.dueDate).toBe('2027-02-01'); // 일요일 보정
    expect(h2.status).toBe('confirmed');
  });
  it('근로소득 간이지급명세서 2027년~: 매월 (재확인 필요 상태) — 2/28(일)→3/1(공휴일)→3/2', () => {
    const d = simplifiedStatementDueDetail('earned', '2027-01');
    expect(d.cycle).toBe('monthly');
    expect(d.status).toBe('enacted_recheck');
    expect(d.dueDate).toBe('2027-03-02');
    expect(d.note).toContain('재확인');
  });
  it('인적용역 기타소득: 2024-01 이후 매월, 이전은 규칙 없음 → 오류', () => {
    expect(simplifiedStatementDueDate('other_personal_service', '2026-08')).toBe('2026-09-30');
    expect(() => simplifiedStatementDueDate('other_personal_service', '2023-06')).toThrow('제출주기 규칙');
  });
  it('주기 규칙은 데이터로 교체 가능 (예: 근로 월별 전환 시점 변경)', () => {
    const rules: CadenceRule[] = SUBMISSION_CADENCE_RULES.map((r) =>
      r.kind !== 'earned'
        ? r
        : r.cycle === 'semiannual'
          ? { ...r, effectiveTo: '2026-06' }
          : { ...r, effectiveFrom: '2026-07' },
    );
    expect(simplifiedStatementDueDate('earned', '2026-09', { rules })).toBe('2026-11-02');
    expect(findCadenceRule('earned', '2026-03', rules)?.cycle).toBe('semiannual');
    expect(findCadenceRule('earned', '2026-12')?.id).toBe('earned_semiannual_until_2026');
  });
});

describe('설정 데이터 보호', () => {
  it('공휴일·제출주기 기본 데이터는 동결 — 추가·변경은 옵션으로 전체 목록을 넘긴다', () => {
    expect(Object.isFrozen(KR_HOLIDAYS)).toBe(true);
    expect(Object.isFrozen(SUBMISSION_CADENCE_RULES[0])).toBe(true);
    expect(() => (KR_HOLIDAYS as unknown as unknown[]).push({ date: '2026-10-13', name: '임시' })).toThrow(TypeError);
    expect(withholdingDueDate('2026-09', false, { holidays: [...KR_HOLIDAYS, { date: '2026-10-12', name: '임시공휴일' }] })).toBe('2026-10-13');
  });
  it('2026·2027 음력 명절 날짜 (ICU dangi 대조)', () => {
    const names = new Map(KR_HOLIDAYS.map((h) => [h.date, h.name]));
    expect(names.get('2026-02-17')).toBe('설날');
    expect(names.get('2026-09-25')).toBe('추석');
    expect(names.get('2027-02-07')).toBe('설날');
    expect(names.get('2027-09-15')).toBe('추석');
  });
});
