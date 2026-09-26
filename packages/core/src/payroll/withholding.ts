import type { IncomeType, LocalDate, PayrollLine, RiskSeverity, Won } from '../types';
import { assertWon, formatWon } from '../money';
import { deepFreeze } from './internal';

/**
 * 원천징수 세액 계산·검증 (순수 함수).
 *
 * 근거 자료: docs/research/03-hometax-wetax-filing.md 2.5.4 (G1~G8), 3장 U12.
 * - 사업소득·일용근로는 법정 산식으로 계산한다.
 * - 근로소득(상용)은 국세청 근로소득 간이세액표(소득세법 시행령 별표2)를 내장하지 않는다.
 *   소득세는 WEHAGO 계산값/수입값을 사용하고, 여기서는 정합성만 검증한다.
 * - 끝수 처리 단계(일별 원 미만 절사 → 합계 10원 미만 절사)는 검증필요(U12): WEHAGO 결과와 대조해 확정한다.
 */

// ────────────────────────────── 파라미터 ──────────────────────────────

export interface TaxBracket {
  /** 과세표준 상한 (이하). 마지막 구간은 null = 무한대 */
  upTo: Won | null;
  rate: number;
  /** 누진공제액 */
  progressiveDeduction: Won;
}

export interface EarnedDeductionStep {
  /** 총급여 상한 (이하). 마지막 구간은 null */
  upTo: Won | null;
  /** 구간 기본 공제액 */
  base: Won;
  rate: number;
  /** 이 금액 초과분에 rate 적용 */
  over: Won;
}

export interface WithholdingParams {
  /** 지방소득세 특별징수 = 원천징수 소득세의 10% — 지방세법 제103조의13 ① */
  localIncomeTaxRate: number;
  /** 소액부징수: 원천징수세액이 이 금액 "미만"이면 징수하지 않음 — 소득세법 제86조 제1호 */
  smallAmountThreshold: Won;
  /** 소득세 합계 절사 단위: 국고금관리법 제47조 ① (10원 미만 끝수 계산하지 않음) */
  incomeTaxTruncateUnit: Won;
  /** 지방소득세 절사 단위: 지방회계법 제55조 (10원 미만 계산하지 아니할 수 있음) — 검증필요(U12) */
  localTaxTruncateUnit: Won;
  business: {
    /** 원천징수대상 사업소득 3% — 소득세법 제129조 ① 3호 */
    incomeTaxRate: number;
    /**
     * 인적용역 사업소득은 이 날짜 이후 지급분부터 소액부징수 배제
     * — 소득세법 제86조 제1호, 시행령 제149조의3, 부칙<제34265호> (2024-07-01)
     */
    personalServiceNoExemptionFrom: LocalDate;
  };
  daily: {
    /** 일용근로 근로소득공제 1일 15만원 — 소득세법 제47조 ② */
    dailyDeduction: Won;
    /** 일용근로 원천징수세율 6% — 소득세법 제129조 ① 4호 */
    incomeTaxRate: number;
    /** 근로소득세액공제 산출세액의 55% — 소득세법 제59조 ③, 제134조 ③ */
    taxCreditRatio: number;
    /**
     * 일별 세액 끝수 처리: 'won' = 일별 원 미만 절사 후 합산(기본), 'none' = 합산 후 절사.
     * 합산 세액은 incomeTaxTruncateUnit 로 절사 (국세청 원천세과-240). 검증필요(U12)
     */
    perDayRounding: 'won' | 'none';
  };
  earned: {
    /** 과세급여가 이 금액 이상 변했는데 소득세가 그대로면 경고 (간이세액표 구간폭 기준 설정값, 검증필요) */
    minPayDeltaForTaxChange: Won;
    /** 검증용 추정(간이세액표 아님) 파라미터 */
    rough: EarnedRoughParams;
  };
}

export interface EarnedRoughParams {
  /** 근로소득공제 — 소득세법 제47조 ① */
  earnedIncomeDeduction: EarnedDeductionStep[];
  /** 근로소득공제 한도 2천만원 — 소득세법 제47조 ① 단서 */
  earnedIncomeDeductionCap: Won;
  /** 기본공제 1인당 150만원 — 소득세법 제50조 */
  personalDeductionPerDependent: Won;
  /** 국민연금 근로자 부담률 (2026년 9.5%의 1/2) — 국민연금법, 검증필요 */
  pensionRate: number;
  /** 국민연금 기준소득월액 상한 — 검증필요 (매년 7월 변경) */
  pensionMonthlyCap: Won;
  /** 건강·장기요양·고용보험 근로자 부담 합계 근사치 — 검증필요 */
  socialInsuranceRate: number;
  /** 종합소득 기본세율 — 소득세법 제55조 ① (2023년 귀속~) */
  brackets: TaxBracket[];
  /** 근로소득세액공제 — 소득세법 제59조 ① */
  earnedTaxCredit: {
    threshold: Won;
    lowRate: number;
    base: Won;
    highRate: number;
    /** 총급여 구간별 공제한도 — 제59조 ② */
    limits: Array<{ upTo: Won | null; base: Won; reduceRate: number; over: Won; floor: Won }>;
  };
  /** 표준세액공제(근로소득자) 13만원 — 소득세법 제59조의4 ⑨ */
  standardTaxCredit: Won;
}

/** 법정 기본값. 동결되어 있으므로 변경은 resolveWithholdingParams(override) 로만 한다 */
export const WITHHOLDING_PARAMS: WithholdingParams = deepFreeze({
  localIncomeTaxRate: 0.1,
  smallAmountThreshold: 1_000,
  incomeTaxTruncateUnit: 10,
  localTaxTruncateUnit: 10,
  business: {
    incomeTaxRate: 0.03,
    personalServiceNoExemptionFrom: '2024-07-01',
  },
  daily: {
    dailyDeduction: 150_000,
    incomeTaxRate: 0.06,
    taxCreditRatio: 0.55,
    perDayRounding: 'won',
  },
  earned: {
    minPayDeltaForTaxChange: 20_000,
    rough: {
      earnedIncomeDeduction: [
        { upTo: 5_000_000, base: 0, rate: 0.7, over: 0 },
        { upTo: 15_000_000, base: 3_500_000, rate: 0.4, over: 5_000_000 },
        { upTo: 45_000_000, base: 7_500_000, rate: 0.15, over: 15_000_000 },
        { upTo: 100_000_000, base: 12_000_000, rate: 0.05, over: 45_000_000 },
        { upTo: null, base: 14_750_000, rate: 0.02, over: 100_000_000 },
      ],
      earnedIncomeDeductionCap: 20_000_000,
      personalDeductionPerDependent: 1_500_000,
      pensionRate: 0.0475,
      pensionMonthlyCap: 6_370_000,
      socialInsuranceRate: 0.049,
      brackets: [
        { upTo: 14_000_000, rate: 0.06, progressiveDeduction: 0 },
        { upTo: 50_000_000, rate: 0.15, progressiveDeduction: 1_260_000 },
        { upTo: 88_000_000, rate: 0.24, progressiveDeduction: 5_760_000 },
        { upTo: 150_000_000, rate: 0.35, progressiveDeduction: 15_440_000 },
        { upTo: 300_000_000, rate: 0.38, progressiveDeduction: 19_940_000 },
        { upTo: 500_000_000, rate: 0.4, progressiveDeduction: 25_940_000 },
        { upTo: 1_000_000_000, rate: 0.42, progressiveDeduction: 35_940_000 },
        { upTo: null, rate: 0.45, progressiveDeduction: 65_940_000 },
      ],
      earnedTaxCredit: {
        threshold: 1_300_000,
        lowRate: 0.55,
        base: 715_000,
        highRate: 0.3,
        limits: [
          { upTo: 33_000_000, base: 740_000, reduceRate: 0, over: 0, floor: 740_000 },
          { upTo: 70_000_000, base: 740_000, reduceRate: 0.008, over: 33_000_000, floor: 660_000 },
          { upTo: 120_000_000, base: 660_000, reduceRate: 0.5, over: 70_000_000, floor: 500_000 },
          { upTo: null, base: 500_000, reduceRate: 0.5, over: 120_000_000, floor: 200_000 },
        ],
      },
      standardTaxCredit: 130_000,
    },
  },
});

/** 부분 덮어쓰기용 (DB settings 등) */
export type WithholdingParamsOverride = {
  [K in keyof WithholdingParams]?: WithholdingParams[K] extends object ? Partial<WithholdingParams[K]> : WithholdingParams[K];
};

export function resolveWithholdingParams(override?: WithholdingParamsOverride): WithholdingParams {
  if (!override) return WITHHOLDING_PARAMS;
  const base = WITHHOLDING_PARAMS;
  return {
    ...base,
    ...(override as Partial<WithholdingParams>),
    business: { ...base.business, ...override.business },
    daily: { ...base.daily, ...override.daily },
    earned: {
      ...base.earned,
      ...override.earned,
      rough: { ...base.earned.rough, ...(override.earned?.rough ?? {}) },
    },
  };
}

// ────────────────────────────── 산술 헬퍼 ──────────────────────────────

const PPM = 1_000_000n;

function toPpm(rate: number): bigint {
  return BigInt(Math.round(rate * 1_000_000));
}

/** amount × rate 를 원 미만 절사 (부동소수 오차 없이 BigInt 로 계산). 정수가 아닌 금액은 오류 */
export function applyRate(amount: Won, rate: number): Won {
  return Number((BigInt(assertWon(amount, '금액')) * toPpm(rate)) / PPM);
}

/** unit 미만 절사 (0 방향). unit 1 이면 그대로 */
export function truncateToUnit(value: Won, unit: Won): Won {
  if (unit <= 1) return Math.trunc(value);
  return Math.trunc(value / unit) * unit;
}

/** 지방소득세(특별징수분) = 소득세 × 10%, 절사 */
export function localIncomeTaxOf(incomeTax: Won, override?: WithholdingParamsOverride): Won {
  const p = resolveWithholdingParams(override);
  return truncateToUnit(applyRate(incomeTax, p.localIncomeTaxRate), p.localTaxTruncateUnit);
}

// ────────────────────────────── 결과 타입 ──────────────────────────────

export interface WithholdingResult {
  incomeTax: Won;
  localIncomeTax: Won;
  /** 소액부징수 적용 전 세액 (절사 후) */
  computedIncomeTax: Won;
  smallAmountExempted: boolean;
  /** 사람이 읽는 계산 근거 */
  basis: string[];
}

export interface DailyWithholdingResult extends WithholdingResult {
  workDays: number;
  totalWage: Won;
  /** 일별 과세대상 금액/세액 (일당이 같으면 1건으로 묶어 표시) */
  perDay: Array<{ dailyWage: Won; days: number; taxablePerDay: Won; taxPerDay: number }>;
}

// ────────────────────────────── 사업소득 ──────────────────────────────

export interface BusinessWithholdingOptions {
  /**
   * 인적용역(부가가치세법 제26조 ① 15호) 여부. 기본 true.
   * false = 의료보건용역(같은 항 5호) 등 → 소액부징수 적용 가능.
   */
  personalService?: boolean;
  /** 지급일 — 인적용역 소액부징수 배제 시행일(2024-07-01) 판단용 */
  paymentDate?: LocalDate | null;
  params?: WithholdingParamsOverride;
}

/** 사업소득 원천징수 3% + 지방소득세 0.3% */
export function computeBusinessWithholding(amount: Won, opts: BusinessWithholdingOptions = {}): WithholdingResult {
  const p = resolveWithholdingParams(opts.params);
  const personalService = opts.personalService ?? true;
  const basis: string[] = [];
  if (amount <= 0) {
    return { incomeTax: 0, localIncomeTax: 0, computedIncomeTax: 0, smallAmountExempted: false, basis: ['지급액 0원 이하 — 원천징수 없음'] };
  }
  const computed = truncateToUnit(applyRate(amount, p.business.incomeTaxRate), p.incomeTaxTruncateUnit);
  basis.push(`${formatWon(amount)} × ${pct(p.business.incomeTaxRate)} = ${formatWon(computed)} (${p.incomeTaxTruncateUnit}원 미만 절사)`);

  // 인적용역 사업소득은 2024-07-01 지급분부터 소액부징수 배제 (지급일 미상이면 배제로 본다)
  const noExemption =
    personalService && (!opts.paymentDate || opts.paymentDate >= p.business.personalServiceNoExemptionFrom);
  let incomeTax = computed;
  let exempted = false;
  if (computed > 0 && computed < p.smallAmountThreshold) {
    if (noExemption) {
      basis.push('인적용역 사업소득 — 소액부징수 배제 (소득세법 시행령 제149조의3)');
    } else {
      incomeTax = 0;
      exempted = true;
      basis.push(`소액부징수: 세액 ${formatWon(computed)} < ${formatWon(p.smallAmountThreshold)} → 0원 (소득세법 제86조)`);
    }
  }
  const localIncomeTax = localIncomeTaxOf(incomeTax, opts.params);
  basis.push(`지방소득세 ${formatWon(incomeTax)} × ${pct(p.localIncomeTaxRate)} = ${formatWon(localIncomeTax)}`);
  return { incomeTax, localIncomeTax, computedIncomeTax: computed, smallAmountExempted: exempted, basis };
}

// ────────────────────────────── 일용근로 ──────────────────────────────

/** 일당별 근무일수 묶음 (같은 일당이 여러 날이면 1건으로) */
export interface DailyWageGroup {
  dailyWage: Won;
  days: number;
}

export type DailyWageInput = { dailyWages: Won[] } | { dailyWage: Won; workDays: number } | { wageGroups: DailyWageGroup[] };

/** 1일분 원천징수세액 정확값 (단위: 1e-12원, BigInt — 부동소수 오차 없음) */
function dailyTaxExactPpm2(taxable: Won, p: WithholdingParams): bigint {
  // taxable × rate × (1 − credit), 단위: ppm² (1e12)
  return BigInt(taxable) * toPpm(p.daily.incomeTaxRate) * (PPM - toPpm(p.daily.taxCreditRatio));
}

function assertWorkDays(days: number): number {
  if (!Number.isSafeInteger(days) || days < 0) {
    throw new Error(`근무일수는 0 이상의 정수여야 합니다: ${days}`);
  }
  return days;
}

/** 입력 형태를 일당별 묶음으로 정규화 (근무일수만큼 배열을 만들지 않는다) */
function toWageGroups(input: DailyWageInput): DailyWageGroup[] {
  const groups = new Map<Won, number>();
  const add = (wage: Won, days: number) => {
    assertWon(wage, '일당');
    assertWorkDays(days);
    if (days > 0) groups.set(wage, (groups.get(wage) ?? 0) + days);
  };
  if ('dailyWages' in input) for (const w of input.dailyWages) add(w, 1);
  else if ('wageGroups' in input) for (const g of input.wageGroups) add(g.dailyWage, g.days);
  else add(input.dailyWage, input.workDays);
  return [...groups].map(([dailyWage, days]) => ({ dailyWage, days }));
}

/**
 * 일용근로소득 원천징수.
 * 일별: (일당 − 150,000) × 6% × (1 − 55%) = 2.7% → 일별 합산 → 소액부징수(합계 1,000원 미만) → 10원 미만 절사.
 * 일괄지급 시 일별 세액 합계로 소액부징수 판단 (국세청 해석 법인46013-343).
 * 근무일수는 0 이상의 정수만 허용한다 (소수 입력은 조용히 버리지 않고 오류).
 */
export function computeDailyWorkerWithholding(input: DailyWageInput, override?: WithholdingParamsOverride): DailyWithholdingResult {
  const p = resolveWithholdingParams(override);
  const groups = toWageGroups(input);

  const SCALE = PPM * PPM;
  let sumExact = 0n; // ppm² 단위
  let workDays = 0;
  let totalWage = 0;
  const perDay: DailyWithholdingResult['perDay'] = [];
  for (const { dailyWage, days } of groups) {
    const taxable = Math.max(0, dailyWage - p.daily.dailyDeduction);
    const exact = dailyTaxExactPpm2(taxable, p);
    const perDayScaled = p.daily.perDayRounding === 'won' ? (exact / SCALE) * SCALE : exact;
    sumExact += perDayScaled * BigInt(days);
    workDays += days;
    totalWage += dailyWage * days;
    // 표시용 1일 세액 (소수 2자리까지; 'won' 설정이면 정수)
    perDay.push({ dailyWage, days, taxablePerDay: taxable, taxPerDay: Number((perDayScaled * 100n) / SCALE) / 100 });
  }
  const summed = Number(sumExact / SCALE);
  const computed = truncateToUnit(summed, p.incomeTaxTruncateUnit);

  const basis: string[] = perDay.map(
    (d) =>
      `일당 ${formatWon(d.dailyWage)} × ${d.days}일: (일당 − ${formatWon(p.daily.dailyDeduction)}) × ${pct(p.daily.incomeTaxRate)} × (1 − ${pct(p.daily.taxCreditRatio)}) = 1일 ${formatWon(Math.trunc(d.taxPerDay))}`,
  );
  basis.push(`소득세 합계 ${formatWon(computed)} (${p.incomeTaxTruncateUnit}원 미만 절사)`);

  let incomeTax = computed;
  let exempted = false;
  if (summed > 0 && computed < p.smallAmountThreshold) {
    incomeTax = 0;
    exempted = true;
    basis.push(`소액부징수: 합계 ${formatWon(summed)} < ${formatWon(p.smallAmountThreshold)} → 0원 (소득세법 제86조)`);
  }
  const localIncomeTax = localIncomeTaxOf(incomeTax, override);
  basis.push(`지방소득세 ${formatWon(localIncomeTax)}`);
  return {
    incomeTax,
    localIncomeTax,
    computedIncomeTax: computed,
    smallAmountExempted: exempted,
    basis,
    workDays,
    totalWage,
    perDay,
  };
}

// ────────────────────────────── 급여행 단위 계산 ──────────────────────────────

export interface WithholdingIssue {
  code:
    | 'local_tax_mismatch'
    | 'local_tax_rounding'
    | 'tax_mismatch'
    | 'pay_same_tax_changed'
    | 'pay_changed_tax_same'
    | 'pay_tax_direction'
    | 'tax_without_pay'
    | 'negative_tax'
    | 'daily_missing_days'
    | 'daily_invalid_days'
    | 'daily_days_exceed_month'
    | 'daily_uneven_wage'
    | 'gross_mismatch'
    | 'business_non_taxable'
    | 'invalid_amount'
    | 'earned_tax_zero'
    | 'rough_estimate_gap';
  severity: RiskSeverity;
  message: string;
}

export interface LineWithholding {
  incomeTax: Won;
  localIncomeTax: Won;
  /** calculated: 법정 산식 계산 / imported: 근로소득(간이세액표) — 입력값 유지 / unavailable: 계산 불가 */
  source: 'calculated' | 'imported' | 'unavailable';
  basis: string[];
  issues: WithholdingIssue[];
}

export interface LineWithholdingOptions {
  /** 사업소득 인적용역 여부 (기본 true) */
  personalService?: boolean;
  params?: WithholdingParamsOverride;
}

/**
 * 일용직 급여행에서 일당별 근무일수 묶음을 복원한다 (근무일수만큼 배열을 만들지 않음).
 * 과세급여가 근무일수로 나누어떨어지지 않으면 1원 차이로 배분(근사)하고 even=false.
 * 한계: 급여행에는 일별 지급내역이 없으므로 "매일 같은 일당"으로 가정한다.
 *       일당이 15만원 미만인 날과 초과인 날이 섞이면 실제 세액보다 적게 계산될 수 있다 → WEHAGO 값과 대조.
 */
export function dailyWageGroupsOfLine(line: Pick<PayrollLine, 'taxablePay' | 'workDays'>): { groups: DailyWageGroup[]; even: boolean } | null {
  const days = line.workDays ?? 0;
  if (!Number.isSafeInteger(days) || days <= 0 || !Number.isSafeInteger(line.taxablePay)) return null;
  const q = Math.floor(line.taxablePay / days);
  const r = line.taxablePay - q * days;
  const groups: DailyWageGroup[] = [];
  if (r > 0) groups.push({ dailyWage: q + 1, days: r });
  if (days - r > 0) groups.push({ dailyWage: q, days: days - r });
  return { groups, even: r === 0 };
}

/** 일용직 급여행의 일별 일당 배열 (표시·테스트용). 계산에는 dailyWageGroupsOfLine 사용 */
export function dailyWagesOfLine(line: Pick<PayrollLine, 'taxablePay' | 'workDays'>): { wages: Won[]; even: boolean } | null {
  const g = dailyWageGroupsOfLine(line);
  if (!g) return null;
  const wages: Won[] = [];
  for (const { dailyWage, days } of g.groups) for (let i = 0; i < days; i++) wages.push(dailyWage);
  return { wages, even: g.even };
}

/** 한 달 최대 근무일수 — 이를 넘으면 지급기간·입력 오류 의심 */
const MAX_DAYS_PER_MONTH = 31;

const MONEY_FIELDS = ['taxablePay', 'nonTaxablePay', 'grossPay', 'incomeTax', 'localIncomeTax'] as const;

/** 원 단위 정수가 아닌 금액 필드 목록 */
export function invalidMoneyFields(line: PayrollLine): string[] {
  return MONEY_FIELDS.filter((f) => !Number.isSafeInteger(line[f]));
}

/** 급여행 1건의 원천세 계산 (사업·일용: 계산, 근로: 입력값 유지 + 지방세 재계산) */
export function computeLineWithholding(line: PayrollLine, opts: LineWithholdingOptions = {}): LineWithholding {
  const issues: WithholdingIssue[] = [];
  const bad = invalidMoneyFields(line);
  if (bad.length) {
    // 계산하지 않고 입력값 유지 + high (예외로 전체 배치를 중단시키지 않는다)
    issues.push({ code: 'invalid_amount', severity: 'high', message: `원 단위 정수가 아닌 금액: ${bad.join(', ')} — 원천 데이터 확인` });
    return { incomeTax: line.incomeTax, localIncomeTax: line.localIncomeTax, source: 'unavailable', basis: [], issues };
  }
  if (line.taxablePay + line.nonTaxablePay !== line.grossPay) {
    issues.push({
      code: 'gross_mismatch',
      severity: 'warning',
      message: `지급총액 ${formatWon(line.grossPay)} ≠ 과세 ${formatWon(line.taxablePay)} + 비과세 ${formatWon(line.nonTaxablePay)}`,
    });
  }
  switch (line.incomeType) {
    case 'business': {
      if (line.nonTaxablePay !== 0) {
        issues.push({ code: 'business_non_taxable', severity: 'warning', message: `사업소득에 비과세 ${formatWon(line.nonTaxablePay)} 입력 — 확인 필요` });
      }
      const r = computeBusinessWithholding(line.taxablePay, {
        personalService: opts.personalService,
        paymentDate: line.paymentDate,
        params: opts.params,
      });
      return { incomeTax: r.incomeTax, localIncomeTax: r.localIncomeTax, source: 'calculated', basis: r.basis, issues };
    }
    case 'daily': {
      const days = line.workDays;
      if (days !== undefined && days !== null && (!Number.isSafeInteger(days) || days < 0)) {
        issues.push({ code: 'daily_invalid_days', severity: 'high', message: `일용직 근무일수(${days})가 0 이상의 정수가 아님 — 세액 계산 불가` });
        return { incomeTax: line.incomeTax, localIncomeTax: line.localIncomeTax, source: 'unavailable', basis: [], issues };
      }
      const d = dailyWageGroupsOfLine(line);
      if (!d) {
        if (line.taxablePay > 0) {
          issues.push({ code: 'daily_missing_days', severity: 'high', message: '일용직 근무일수가 없어 세액을 계산할 수 없습니다' });
          return { incomeTax: line.incomeTax, localIncomeTax: line.localIncomeTax, source: 'unavailable', basis: [], issues };
        }
        return { incomeTax: 0, localIncomeTax: 0, source: 'calculated', basis: ['지급액 0원 — 원천징수 없음'], issues };
      }
      if (days! > MAX_DAYS_PER_MONTH) {
        issues.push({
          code: 'daily_days_exceed_month',
          severity: 'warning',
          message: `근무일수 ${days}일 — 한 달 ${MAX_DAYS_PER_MONTH}일 초과, 지급기간·입력값 확인`,
        });
      }
      if (!d.even) {
        issues.push({
          code: 'daily_uneven_wage',
          severity: 'warning',
          message: `과세급여 ${formatWon(line.taxablePay)}가 근무일수 ${line.workDays}일로 나누어떨어지지 않음 — 일별 지급내역 확인`,
        });
      }
      const r = computeDailyWorkerWithholding({ wageGroups: d.groups }, opts.params);
      return {
        incomeTax: r.incomeTax,
        localIncomeTax: r.localIncomeTax,
        source: 'calculated',
        basis: [...r.basis, '가정: 근무일마다 같은 일당 (일별 지급내역이 다르면 WEHAGO 값과 대조)'],
        issues,
      };
    }
    case 'earned':
    default: {
      const local = localIncomeTaxOf(line.incomeTax, opts.params);
      return {
        incomeTax: line.incomeTax,
        localIncomeTax: local,
        source: 'imported',
        basis: ['근로소득 소득세는 간이세액표 기준 WEHAGO/수입값 사용', `지방소득세 = ${formatWon(line.incomeTax)} × 10% = ${formatWon(local)}`],
        issues,
      };
    }
  }
}

/**
 * 급여행에 입력된 세액이 산식과 맞는지 점검한다 (사업·일용: 재계산 비교, 근로: validateEarnedWithholding).
 */
export function checkLineWithholding(
  line: PayrollLine,
  prevLine?: PayrollLine | null,
  opts: LineWithholdingOptions & { useRoughEstimate?: boolean; dependents?: number } = {},
): WithholdingIssue[] {
  if (line.incomeType === 'earned') return validateEarnedWithholding(line, prevLine, opts);
  const calc = computeLineWithholding(line, opts);
  const issues = [...calc.issues];
  if (calc.source !== 'calculated') return issues;
  if (calc.incomeTax !== line.incomeTax) {
    issues.push({
      code: 'tax_mismatch',
      severity: 'warning',
      message: `소득세 불일치: 계산 ${formatWon(calc.incomeTax)}, 입력 ${formatWon(line.incomeTax)}`,
    });
  }
  issues.push(...checkLocalTax(line.incomeTax, line.localIncomeTax, opts.params));
  return issues;
}

function checkLocalTax(incomeTax: Won, localIncomeTax: Won, override?: WithholdingParamsOverride): WithholdingIssue[] {
  const p = resolveWithholdingParams(override);
  const expected = localIncomeTaxOf(incomeTax, override);
  if (expected === localIncomeTax) return [];
  // 끝수 처리 방식 차이(10원 절사 vs 원 단위)로 설명되는 경우만 info
  const rawExpected = applyRate(incomeTax, p.localIncomeTaxRate);
  if (localIncomeTax === rawExpected || localIncomeTax === truncateToUnit(rawExpected, 10)) {
    return [
      {
        code: 'local_tax_rounding',
        severity: 'info',
        message: `지방소득세 끝수 차이: 기대 ${formatWon(expected)}, 입력 ${formatWon(localIncomeTax)}`,
      },
    ];
  }
  return [
    {
      code: 'local_tax_mismatch',
      severity: 'warning',
      message: `지방소득세 불일치: 소득세 ${formatWon(incomeTax)}의 10% = ${formatWon(expected)}, 입력 ${formatWon(localIncomeTax)}`,
    },
  ];
}

// ────────────────────────────── 근로소득 검증 ──────────────────────────────

/**
 * 근로소득(간이세액) 원천세 정합성 검증.
 * - 과세급여 동일인데 소득세 변경 / 과세급여 변경인데 소득세 동일 / 증감 방향 불일치
 * - 지방소득세 = 소득세 × 10% 일치 여부
 * - (선택) 검증용 추정(간이세액표 아님)과의 큰 차이 — info
 */
export function validateEarnedWithholding(
  line: PayrollLine,
  prevLine?: PayrollLine | null,
  opts: { params?: WithholdingParamsOverride; useRoughEstimate?: boolean; dependents?: number } = {},
): WithholdingIssue[] {
  if (line.incomeType !== 'earned') return [];
  const p = resolveWithholdingParams(opts.params);
  const issues: WithholdingIssue[] = [];
  const bad = invalidMoneyFields(line);
  if (bad.length) {
    return [{ code: 'invalid_amount', severity: 'high', message: `원 단위 정수가 아닌 금액: ${bad.join(', ')} — 원천 데이터 확인` }];
  }

  if (line.incomeTax < 0) {
    issues.push({ code: 'negative_tax', severity: 'warning', message: `소득세가 음수(${formatWon(line.incomeTax)}) — 환급/정산분 여부 확인` });
  }
  if (line.taxablePay <= 0 && line.incomeTax > 0) {
    issues.push({ code: 'tax_without_pay', severity: 'high', message: `과세급여 0원인데 소득세 ${formatWon(line.incomeTax)} 입력됨` });
  }
  issues.push(...checkLocalTax(line.incomeTax, line.localIncomeTax, opts.params));

  // 과세급여가 있는데 소득세 0원 (신규입사자 초안 등 간이세액 미반영 가능) — 검증용 추정이 소액부징수 기준 이상일 때만
  const zeroTaxIssue = earnedZeroTaxIssue(line, { dependents: opts.dependents, params: opts.params });
  if (zeroTaxIssue) issues.push(zeroTaxIssue);

  if (prevLine && prevLine.incomeType === 'earned' && invalidMoneyFields(prevLine).length === 0) {
    const payDelta = line.taxablePay - prevLine.taxablePay;
    const taxDelta = line.incomeTax - prevLine.incomeTax;
    const payText = `과세급여 ${formatWon(prevLine.taxablePay)} → ${formatWon(line.taxablePay)}`;
    const taxText = `소득세 ${formatWon(prevLine.incomeTax)} → ${formatWon(line.incomeTax)}`;
    if (payDelta === 0 && taxDelta !== 0) {
      issues.push({
        code: 'pay_same_tax_changed',
        severity: 'warning',
        message: `과세급여 동일(${formatWon(line.taxablePay)})인데 ${taxText} — 부양가족수·원천징수 비율 변경 여부 확인`,
      });
    } else if (payDelta !== 0 && taxDelta === 0) {
      if (Math.abs(payDelta) >= p.earned.minPayDeltaForTaxChange && line.incomeTax > 0) {
        issues.push({
          code: 'pay_changed_tax_same',
          severity: 'warning',
          message: `${payText}인데 소득세 동일(${formatWon(line.incomeTax)}) — 간이세액표 재적용 확인`,
        });
      }
    } else if (payDelta !== 0 && taxDelta !== 0 && Math.sign(payDelta) !== Math.sign(taxDelta)) {
      issues.push({
        code: 'pay_tax_direction',
        severity: 'warning',
        message: `${payText}, ${taxText} — 급여와 세액 증감 방향이 반대`,
      });
    }
  }

  if (opts.useRoughEstimate && line.taxablePay > 0 && !zeroTaxIssue) {
    const est = estimateEarnedIncomeTaxRough(line.taxablePay, { dependents: opts.dependents, params: opts.params });
    const gap = Math.abs(est.incomeTax - line.incomeTax);
    const base = Math.max(est.incomeTax, line.incomeTax);
    if (base >= 10_000 && gap / base > 0.5) {
      issues.push({
        code: 'rough_estimate_gap',
        severity: 'info',
        message: `${est.label} ${formatWon(est.incomeTax)} 대비 입력 소득세 ${formatWon(line.incomeTax)} — 차이가 큼 (참고용)`,
      });
    }
  }
  return issues;
}

// ────────────────────────────── 검증용 추정 (간이세액표 아님) ──────────────────────────────

export const ROUGH_ESTIMATE_LABEL = '검증용 추정(간이세액표 아님)';

export interface EarnedRoughEstimate {
  label: typeof ROUGH_ESTIMATE_LABEL;
  incomeTax: Won;
  localIncomeTax: Won;
  breakdown: {
    annualGross: Won;
    earnedIncomeDeduction: Won;
    personalDeduction: Won;
    insuranceDeduction: Won;
    taxBase: Won;
    calculatedTax: Won;
    earnedTaxCredit: Won;
    standardTaxCredit: Won;
    annualTax: Won;
  };
}

/**
 * 월 과세급여 → 월 소득세 "대략치". 연환산 후 근로소득공제·기본공제·보험료공제·기본세율·근로소득세액공제를 적용한다.
 * 국세청 간이세액표(특별공제 반영 산식, 원천징수 비율 선택 등)와 다르므로 실제 원천징수에 절대 사용하지 않는다.
 * 용도: 수입값이 비정상적으로 크거나 0인지 대략 점검.
 */
export function estimateEarnedIncomeTaxRough(
  monthlyTaxablePay: Won,
  opts: { dependents?: number; params?: WithholdingParamsOverride } = {},
): EarnedRoughEstimate {
  const p = resolveWithholdingParams(opts.params);
  const r = p.earned.rough;
  const dependents = Math.max(1, Math.trunc(opts.dependents ?? 1));
  const monthly = Math.max(0, monthlyTaxablePay);
  const annualGross = monthly * 12;

  let eid = 0;
  for (const step of r.earnedIncomeDeduction) {
    if (step.upTo === null || annualGross <= step.upTo) {
      eid = step.base + applyRate(annualGross - step.over, step.rate);
      break;
    }
  }
  eid = Math.min(eid, r.earnedIncomeDeductionCap, annualGross);
  const personalDeduction = r.personalDeductionPerDependent * dependents;
  const pension = applyRate(Math.min(monthly, r.pensionMonthlyCap), r.pensionRate) * 12;
  const social = applyRate(monthly, r.socialInsuranceRate) * 12;
  const insuranceDeduction = pension + social;
  const taxBase = Math.max(0, annualGross - eid - personalDeduction - insuranceDeduction);

  let calculatedTax = 0;
  for (const b of r.brackets) {
    if (b.upTo === null || taxBase <= b.upTo) {
      calculatedTax = Math.max(0, applyRate(taxBase, b.rate) - b.progressiveDeduction);
      break;
    }
  }
  const c = r.earnedTaxCredit;
  let credit =
    calculatedTax <= c.threshold
      ? applyRate(calculatedTax, c.lowRate)
      : c.base + applyRate(calculatedTax - c.threshold, c.highRate);
  for (const l of c.limits) {
    if (l.upTo === null || annualGross <= l.upTo) {
      const limit = Math.max(l.floor, l.base - applyRate(Math.max(0, annualGross - l.over), l.reduceRate));
      credit = Math.min(credit, limit);
      break;
    }
  }
  credit = Math.min(credit, calculatedTax);
  const standard = Math.min(r.standardTaxCredit, calculatedTax - credit);
  const annualTax = Math.max(0, calculatedTax - credit - standard);
  const incomeTax = truncateToUnit(Math.trunc(annualTax / 12), p.incomeTaxTruncateUnit);
  return {
    label: ROUGH_ESTIMATE_LABEL,
    incomeTax,
    localIncomeTax: localIncomeTaxOf(incomeTax, opts.params),
    breakdown: {
      annualGross,
      earnedIncomeDeduction: eid,
      personalDeduction,
      insuranceDeduction,
      taxBase,
      calculatedTax,
      earnedTaxCredit: credit,
      standardTaxCredit: standard,
      annualTax,
    },
  };
}

/**
 * 근로소득 과세급여 > 0 인데 소득세 0원이고, 검증용 추정 세액이 소액부징수 기준(1,000원) 이상이면 warning.
 * 부양가족이 많으면 실제 간이세액이 0원일 수 있으므로 dependents 를 넘기면 오탐이 줄어든다.
 */
export function earnedZeroTaxIssue(
  line: Pick<PayrollLine, 'incomeType' | 'taxablePay' | 'incomeTax'>,
  opts: { dependents?: number; params?: WithholdingParamsOverride } = {},
): WithholdingIssue | null {
  if (line.incomeType !== 'earned' || line.incomeTax !== 0 || !(line.taxablePay > 0) || !Number.isSafeInteger(line.taxablePay)) return null;
  const p = resolveWithholdingParams(opts.params);
  const est = estimateEarnedIncomeTaxRough(line.taxablePay, opts);
  if (est.incomeTax < p.smallAmountThreshold) return null;
  const dependents = Math.max(1, Math.trunc(opts.dependents ?? 1));
  return {
    code: 'earned_tax_zero',
    severity: 'warning',
    message: `과세급여 ${formatWon(line.taxablePay)}인데 소득세 0원 — WEHAGO 간이세액 반영 여부 확인 (${est.label} ${formatWon(est.incomeTax)}, 부양가족 ${dependents}명 기준)`,
  };
}

// ────────────────────────────── 기타 ──────────────────────────────

/** 소득구분 한국어 라벨 */
export const INCOME_TYPE_LABELS: Record<IncomeType, string> = {
  earned: '근로소득',
  business: '사업소득',
  daily: '일용근로',
};

function pct(rate: number): string {
  const v = Math.round(rate * 10000) / 100;
  return `${v}%`;
}
