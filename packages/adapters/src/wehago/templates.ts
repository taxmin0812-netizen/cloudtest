/**
 * WEHAGO 업로드 서식 (데이터, 버전 관리).
 *
 * 근거: docs/research/01-wehago.md
 *  - 일반전표: "지정된 양식 없음" — 업로드 시 엑셀 제목과 데이터 항목을 사람이 매칭. 필수 7항목 월·일·구분·계정과목코드·계정과목명·차변(출금)·대변(입금) [공식 발췌]
 *  - 매입매출전표: "엑셀서식 내려받기 → 작성 → 불러오기" [공식], 열 이름·순서·유형 입력 형식(57 vs 카과) 미확인(U2) → MIN TAX OPS 표준 레이아웃(verified=false)
 *  - 급여/사업소득/일용직: 서식 기능 [공식], 열 구성 미확인(U7) → mock
 * 사무소가 실제 WEHAGO 서식 파일을 올리면 buildTemplateFromSample() 로 열을 다시 매핑한 템플릿을 만든다.
 */
import { sha256Hex, type VatType } from '@mintax/core';
import { normalizeHeader } from '../util/text';
import { DOUZONE_JOURNAL_TYPE_CODES, DOUZONE_SLIP_SIDE_CODES, DOUZONE_VAT_TYPE_TABLE, type DouzoneVatTypeEntry, type JournalTypeKey } from './codes';

export type WehagoTemplateKind = 'purchase_sales' | 'general_journal' | 'payroll_earned' | 'payroll_business' | 'payroll_daily';

export const EXPORT_FIELDS = [
  // 전표
  'date',
  'month',
  'day',
  'voucherNo',
  'vatTypeCode',
  'vatTypeLabel',
  'description',
  'supplyAmount',
  'vatAmount',
  'serviceCharge',
  'totalAmount',
  'counterpartyCode',
  'counterpartyName',
  'counterpartyBusinessNumber',
  'electronic',
  'journalTypeCode',
  'accountCode',
  'accountName',
  'cardCompany',
  'approvalNumber',
  'nonDeductibleReason',
  'slipSideCode',
  'debit',
  'credit',
  'memo',
  // 급여
  'employeeCode',
  'employeeName',
  'idNumber',
  'attributionMonth',
  'paymentDate',
  'taxablePay',
  'nonTaxablePay',
  'grossPay',
  'incomeTax',
  'localIncomeTax',
  'otherDeductions',
  'netPay',
  'workDays',
  'dailyWage',
  'incomeCategoryCode',
  'taxRate',
  'studentLoanRepayment',
  // 사무소 서식에 있지만 MIN TAX OPS 가 채우지 않는 열 (빈칸으로 출력)
  'blank',
] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];

export type ColumnValueType = 'text' | 'code' | 'date' | 'amount' | 'integer' | 'percent';

export interface TemplateColumn {
  /** 엑셀 제목 (사무소 서식이면 원문 그대로) */
  header: string;
  field: ExportField;
  type: ColumnValueType;
  required?: boolean;
  width?: number;
  /** buildTemplateFromSample 매칭용 별칭 */
  aliases?: string[];
}

export interface VatTypeCodeMapping {
  code: string;
  label: string;
}

export interface WehagoTemplate {
  key: string;
  /** 서식 버전 (사무소 서식이면 내려받은 날짜 YYYYMMDD 권장) */
  version: string;
  kind: WehagoTemplateKind;
  name: string;
  sheetName: string;
  columns: TemplateColumn[];
  /** 제목행 위에 둘 행 (사무소 서식의 안내문 등) */
  preambleRows: string[][];
  /** 제목행 바로 아래 샘플 행 (WEHAGO 가 첫 행 샘플을 반영하지 않는 서식용). null 이면 없음 */
  sampleRow: Array<string | number | null> | null;
  dateFormat: 'YYYY-MM-DD' | 'YYYYMMDD' | 'YYYY.MM.DD';
  businessNumberFormat: 'digits' | 'dashed';
  /** VatType → 매입매출 유형코드. null = 매입매출전표 대상 아님(일반전표) */
  vatTypeCodes: Record<VatType, VatTypeCodeMapping | null>;
  /** 유형코드 성격표 (세액 0 규칙 등) */
  vatTypeTable: readonly DouzoneVatTypeEntry[];
  journalTypeCodes: Record<JournalTypeKey, string>;
  slipSideCodes: typeof DOUZONE_SLIP_SIDE_CODES;
  electronicValues: { yes: string; no: string };
  /** 매입매출전표는 거래처코드 필수 [공식] */
  requireCounterpartyCode: boolean;
  /** 숨김(veryHidden) 추적 시트 포함 — 재검증(verifyExportFile)용 */
  traceSheet: boolean;
  /** 텍스트에서 제거할 문자 (업로드 실패 예방) */
  forbiddenChars: string;
  /** 파일당 최대 행 (초과 시 거부). null = 제한 없음. 한도는 검증필요 */
  maxRows: number | null;
  /** 급여 서식: 수당 항목을 열로 펼침 */
  dynamicAllowanceColumns?: boolean;
  status: 'standard' | 'mock' | 'office_sample';
  verified: boolean;
  note: string;
  docsRef: string;
}

/** VatType → 더존 매입매출 유형코드 기본 매핑 (01 §2.5, 재검증 필요) */
export const DEFAULT_VAT_TYPE_CODES: Record<VatType, VatTypeCodeMapping | null> = {
  purchase_taxable: { code: '51', label: '과세' },
  purchase_exempt: { code: '53', label: '면세' },
  purchase_card: { code: '57', label: '카과' },
  purchase_card_exempt: { code: '58', label: '카면' },
  purchase_cash_receipt: { code: '61', label: '현과' },
  purchase_cash_receipt_exempt: { code: '62', label: '현면' },
  purchase_non_deductible: { code: '54', label: '불공' },
  purchase_no_evidence: null,
  sales_taxable: { code: '11', label: '과세' },
  sales_exempt: { code: '13', label: '면세' },
  sales_card: { code: '17', label: '카과' },
  sales_cash_receipt: { code: '22', label: '현과' },
  sales_other: { code: '14', label: '건별' },
};

const COMMON = {
  preambleRows: [] as string[][],
  sampleRow: null,
  dateFormat: 'YYYY-MM-DD' as const,
  businessNumberFormat: 'digits' as const,
  vatTypeCodes: DEFAULT_VAT_TYPE_CODES,
  vatTypeTable: DOUZONE_VAT_TYPE_TABLE,
  journalTypeCodes: { ...DOUZONE_JOURNAL_TYPE_CODES },
  slipSideCodes: DOUZONE_SLIP_SIDE_CODES,
  electronicValues: { yes: '1', no: '0' },
  traceSheet: true,
  forbiddenChars: '',
  maxRows: null,
};

export const WEHAGO_PURCHASE_SALES_TEMPLATE: WehagoTemplate = {
  ...COMMON,
  key: 'wehago_purchase_sales',
  version: '20260926-standard',
  kind: 'purchase_sales',
  name: 'WEHAGO 매입매출전표 엑셀 업로드 (MIN TAX OPS 표준)',
  sheetName: '매입매출전표',
  columns: [
    { header: '일자', field: 'date', type: 'date', required: true, width: 12, aliases: ['전표일자', '작성일자', '거래일자'] },
    { header: '유형', field: 'vatTypeCode', type: 'code', required: true, width: 6, aliases: ['유형코드', '매입매출유형', '과세유형'] },
    { header: '유형명', field: 'vatTypeLabel', type: 'text', width: 8, aliases: ['유형구분'] },
    { header: '거래처코드', field: 'counterpartyCode', type: 'code', required: true, width: 12, aliases: ['거래처 코드', '코드'] },
    { header: '거래처명', field: 'counterpartyName', type: 'text', required: true, width: 24, aliases: ['거래처', '상호'] },
    { header: '사업자번호', field: 'counterpartyBusinessNumber', type: 'code', width: 14, aliases: ['사업자등록번호', '등록번호'] },
    { header: '품목', field: 'description', type: 'text', width: 24, aliases: ['품명', '적요', '품목명'] },
    { header: '공급가액', field: 'supplyAmount', type: 'amount', required: true, width: 14 },
    { header: '부가세', field: 'vatAmount', type: 'amount', required: true, width: 12, aliases: ['세액', '부가가치세'] },
    { header: '봉사료', field: 'serviceCharge', type: 'amount', width: 10 },
    { header: '합계', field: 'totalAmount', type: 'amount', required: true, width: 14, aliases: ['합계금액'] },
    { header: '전자', field: 'electronic', type: 'code', width: 6, aliases: ['전자여부', '전자세금계산서'] },
    { header: '분개유형', field: 'journalTypeCode', type: 'code', required: true, width: 8, aliases: ['분개', '분개구분'] },
    { header: '계정코드', field: 'accountCode', type: 'code', required: true, width: 10, aliases: ['계정과목코드'] },
    { header: '계정명', field: 'accountName', type: 'text', width: 16, aliases: ['계정과목명', '계정과목'] },
    { header: '카드사', field: 'cardCompany', type: 'text', width: 12, aliases: ['카드거래처', '신용카드사'] },
    { header: '승인번호', field: 'approvalNumber', type: 'code', width: 28 },
    { header: '불공제사유', field: 'nonDeductibleReason', type: 'text', width: 24, aliases: ['불공사유'] },
  ],
  requireCounterpartyCode: true,
  status: 'standard',
  verified: false,
  note:
    '검증필요: WEHAGO 매입매출전표 엑셀서식의 실제 열 이름·순서·유형 입력 형식(숫자 57 vs 약칭 카과)·전자여부 값은 미확인(01 U2). ' +
    '사무소가 WEHAGO 에서 "엑셀서식 내려받기" 한 파일을 등록하면 이 표준 대신 그 서식으로 출력한다. 유형코드 51~62/11~24 는 공식 발췌 기준이며 재검증 필요.',
  docsRef: 'docs/research/01-wehago.md §2.4, §2.5, §2.6, U2',
};

export const WEHAGO_GENERAL_JOURNAL_TEMPLATE: WehagoTemplate = {
  ...COMMON,
  key: 'wehago_general_journal',
  version: '20260926-standard',
  kind: 'general_journal',
  name: 'WEHAGO 일반전표 엑셀 업로드 (열 매칭 방식)',
  sheetName: '일반전표',
  columns: [
    { header: '월', field: 'month', type: 'code', required: true, width: 5 },
    { header: '일', field: 'day', type: 'code', required: true, width: 5 },
    { header: '번호', field: 'voucherNo', type: 'integer', width: 6, aliases: ['전표번호'] },
    { header: '구분', field: 'slipSideCode', type: 'code', required: true, width: 6 },
    { header: '계정과목코드', field: 'accountCode', type: 'code', required: true, width: 12, aliases: ['계정코드'] },
    { header: '계정과목명', field: 'accountName', type: 'text', required: true, width: 16, aliases: ['계정명', '계정과목'] },
    { header: '거래처코드', field: 'counterpartyCode', type: 'code', width: 12 },
    { header: '거래처명', field: 'counterpartyName', type: 'text', width: 24, aliases: ['거래처'] },
    { header: '적요', field: 'memo', type: 'text', width: 30 },
    { header: '차변(출금)', field: 'debit', type: 'amount', required: true, width: 14, aliases: ['차변', '출금'] },
    { header: '대변(입금)', field: 'credit', type: 'amount', required: true, width: 14, aliases: ['대변', '입금'] },
  ],
  requireCounterpartyCode: false,
  status: 'standard',
  verified: false,
  note:
    '일반전표 업로드는 "지정된 양식 없음 + 제목 매칭" 방식 [공식 발췌, 재검증 안 됨]. 필수 7항목(월·일·구분·계정과목코드·계정과목명·차변·대변)을 포함한다. ' +
    '구분은 대체전표 3(차변)/4(대변)으로 출력한다. 한 전표의 여러 줄을 묶는 기준(번호 열 사용 여부)은 검증필요.',
  docsRef: 'docs/research/01-wehago.md §2.3, §2.6',
};

const PAYROLL_COMMON = {
  ...COMMON,
  requireCounterpartyCode: false,
  status: 'mock' as const,
  verified: false,
};

export const WEHAGO_PAYROLL_EARNED_TEMPLATE: WehagoTemplate = {
  ...PAYROLL_COMMON,
  key: 'wehago_payroll_earned',
  version: '20260926-mock',
  kind: 'payroll_earned',
  name: 'WEHAGO 급여자료입력 엑셀 (1줄 서식, MOCK)',
  sheetName: '급여자료',
  columns: [
    { header: '사원코드', field: 'employeeCode', type: 'code', required: true, width: 10, aliases: ['사원번호', '사번'] },
    { header: '성명', field: 'employeeName', type: 'text', required: true, width: 10, aliases: ['사원명', '이름'] },
    { header: '귀속년월', field: 'attributionMonth', type: 'code', required: true, width: 10 },
    { header: '지급일', field: 'paymentDate', type: 'date', required: true, width: 12, aliases: ['지급년월일', '지급일자'] },
    { header: '과세급여', field: 'taxablePay', type: 'amount', width: 14, aliases: ['과세합계'] },
    { header: '비과세', field: 'nonTaxablePay', type: 'amount', width: 12, aliases: ['비과세합계'] },
    { header: '지급총액', field: 'grossPay', type: 'amount', required: true, width: 14, aliases: ['지급합계', '총지급액'] },
    { header: '소득세', field: 'incomeTax', type: 'amount', required: true, width: 12 },
    { header: '지방소득세', field: 'localIncomeTax', type: 'amount', required: true, width: 12 },
    { header: '기타공제', field: 'otherDeductions', type: 'amount', width: 12, aliases: ['공제합계'] },
    { header: '차인지급액', field: 'netPay', type: 'amount', required: true, width: 14, aliases: ['실지급액'] },
  ],
  dynamicAllowanceColumns: true,
  note:
    '검증필요(MOCK): 급여자료입력 엑셀은 1줄/2줄 서식이 있다는 것만 확인(01 U7). 사원번호 필수·중복 불가 [커뮤니티]. ' +
    '커뮤니티 팁상 지급합계·공제계·차인지급액 열을 지워야 하는 서식일 수 있다 → 실서식 등록 전 업로드 금지.',
  docsRef: 'docs/research/01-wehago.md §2.10, U7',
};

export const WEHAGO_PAYROLL_BUSINESS_TEMPLATE: WehagoTemplate = {
  ...PAYROLL_COMMON,
  key: 'wehago_payroll_business',
  version: '20260926-mock',
  kind: 'payroll_business',
  name: 'WEHAGO 사업소득자료 (MOCK)',
  sheetName: '사업소득',
  columns: [
    { header: '소득자코드', field: 'employeeCode', type: 'code', required: true, width: 10, aliases: ['코드', '사원코드'] },
    { header: '소득자명', field: 'employeeName', type: 'text', required: true, width: 10, aliases: ['성명'] },
    { header: '주민(외국인)등록번호', field: 'idNumber', type: 'code', width: 16, aliases: ['주민등록번호', '주민번호'] },
    { header: '소득구분', field: 'incomeCategoryCode', type: 'code', required: true, width: 10, aliases: ['업종코드'] },
    { header: '귀속년월', field: 'attributionMonth', type: 'code', required: true, width: 10 },
    { header: '지급년월일', field: 'paymentDate', type: 'date', required: true, width: 12, aliases: ['지급일'] },
    { header: '지급액', field: 'grossPay', type: 'amount', required: true, width: 14 },
    { header: '세율(%)', field: 'taxRate', type: 'percent', width: 8, aliases: ['세율'] },
    { header: '학자금상환액', field: 'studentLoanRepayment', type: 'amount', width: 12 },
    { header: '소득세', field: 'incomeTax', type: 'amount', required: true, width: 12 },
    { header: '지방소득세', field: 'localIncomeTax', type: 'amount', required: true, width: 12 },
    { header: '차인지급액', field: 'netPay', type: 'amount', required: true, width: 14 },
  ],
  note:
    '검증필요(MOCK): 열 목록은 사업소득자료입력 화면의 반영 항목 발췌 [공식]이며, 이 메뉴의 엑셀 업로드 지원 여부는 미확인(01 §2.10). 주민번호는 숫자만 입력.',
  docsRef: 'docs/research/01-wehago.md §2.10',
};

export const WEHAGO_PAYROLL_DAILY_TEMPLATE: WehagoTemplate = {
  ...PAYROLL_COMMON,
  key: 'wehago_payroll_daily',
  version: '20260926-mock',
  kind: 'payroll_daily',
  name: 'WEHAGO 일용직 급여자료 (MOCK)',
  sheetName: '일용직',
  columns: [
    { header: '사원코드', field: 'employeeCode', type: 'code', required: true, width: 10, aliases: ['사원번호'] },
    { header: '성명', field: 'employeeName', type: 'text', required: true, width: 10 },
    { header: '주민등록번호', field: 'idNumber', type: 'code', width: 16, aliases: ['주민(외국인)등록번호', '주민번호'] },
    { header: '귀속년월', field: 'attributionMonth', type: 'code', required: true, width: 10 },
    { header: '지급년월일', field: 'paymentDate', type: 'date', required: true, width: 12, aliases: ['지급일'] },
    { header: '근무일수', field: 'workDays', type: 'integer', required: true, width: 8 },
    { header: '일당', field: 'dailyWage', type: 'amount', width: 12, aliases: ['일급'] },
    { header: '지급총액', field: 'grossPay', type: 'amount', required: true, width: 14, aliases: ['지급액'] },
    { header: '비과세', field: 'nonTaxablePay', type: 'amount', width: 12 },
    { header: '소득세', field: 'incomeTax', type: 'amount', required: true, width: 12 },
    { header: '지방소득세', field: 'localIncomeTax', type: 'amount', required: true, width: 12 },
    { header: '차인지급액', field: 'netPay', type: 'amount', required: true, width: 14 },
  ],
  note: '검증필요(MOCK): 일용직사원등록 엑셀서식은 [공식], 일용직급여자료 업로드 서식은 미확인(01 §2.10). 주민번호는 숫자만.',
  docsRef: 'docs/research/01-wehago.md §2.10',
};

export const WEHAGO_TEMPLATES: readonly WehagoTemplate[] = [
  WEHAGO_PURCHASE_SALES_TEMPLATE,
  WEHAGO_GENERAL_JOURNAL_TEMPLATE,
  WEHAGO_PAYROLL_EARNED_TEMPLATE,
  WEHAGO_PAYROLL_BUSINESS_TEMPLATE,
  WEHAGO_PAYROLL_DAILY_TEMPLATE,
];

export function getWehagoTemplate(keyOrKind: string): WehagoTemplate | undefined {
  return WEHAGO_TEMPLATES.find((t) => t.key === keyOrKind || t.kind === keyOrKind);
}

/** 제목행 해시 — 생성 파일·등록 서식의 변경 감지용 */
export function templateHeaderHash(template: Pick<WehagoTemplate, 'columns'>): string {
  return sha256Hex(template.columns.map((c) => normalizeHeader(c.header)).join('|'));
}

/** 템플릿 데이터 검증 (등록·수정 시). 오류 메시지 목록 */
export function validateTemplate(t: WehagoTemplate): string[] {
  const errors: string[] = [];
  if (t.columns.length === 0) errors.push('열이 없습니다.');
  const seen = new Set<string>();
  const seenFields = new Set<string>();
  for (const c of t.columns) {
    const h = normalizeHeader(c.header);
    if (!h && c.field !== 'blank') errors.push('제목이 빈 열이 있습니다.');
    if (c.field !== 'blank') {
      if (seen.has(h)) errors.push(`제목 "${c.header}" 이(가) 중복됩니다.`);
      if (seenFields.has(c.field)) errors.push(`항목 ${c.field} 가 두 열에 매핑되었습니다.`);
      seenFields.add(c.field);
    }
    seen.add(h);
    if (!(EXPORT_FIELDS as readonly string[]).includes(c.field)) errors.push(`알 수 없는 필드: ${c.field}`);
  }
  const fields = new Set(t.columns.map((c) => c.field));
  const need: Record<WehagoTemplateKind, ExportField[]> = {
    purchase_sales: ['date', 'vatTypeCode', 'supplyAmount', 'vatAmount', 'totalAmount', 'accountCode'],
    general_journal: ['month', 'day', 'slipSideCode', 'accountCode', 'accountName', 'debit', 'credit'],
    payroll_earned: ['employeeCode', 'grossPay', 'incomeTax', 'localIncomeTax', 'netPay'],
    payroll_business: ['employeeName', 'grossPay', 'incomeTax', 'localIncomeTax', 'netPay'],
    payroll_daily: ['employeeName', 'grossPay', 'incomeTax', 'localIncomeTax', 'netPay'],
  };
  for (const f of need[t.kind]) if (!fields.has(f)) errors.push(`필수 항목 열이 없습니다: ${f}`);
  if (t.kind === 'purchase_sales' && t.requireCounterpartyCode && !fields.has('counterpartyCode')) {
    errors.push('거래처코드 열이 필요합니다 (매입매출전표 필수).');
  }
  return errors;
}
