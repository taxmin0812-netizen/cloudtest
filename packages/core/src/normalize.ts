/**
 * 정규화 유틸 — 상호, 사업자번호, 카드번호, 일자.
 */

/** 법인 표기·공백·괄호·특수문자를 제거하고 대문자화한 상호 키 */
export function normalizeMerchantName(name: string | null | undefined): string {
  if (!name) return '';
  let s = String(name).normalize('NFKC').toUpperCase();
  s = s.replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\(사\)|사단법인|\(재\)|재단법인|\(합\)|합자회사|CO\.,?\s*LTD\.?|INC\.?|CORP\.?|LTD\.?/g, ' ');
  // 지점/점포 표기는 유지하되 공백·특수문자 제거
  s = s.replace(/[\s\-_.,·'"`~!@#$%^&*()[\]{}<>/\\|+=:;?]/g, '');
  return s;
}

/** 사업자번호 숫자 10자리. 형식 불일치 시 null */
export function normalizeBusinessNumber(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const digits = String(input).replace(/\D/g, '');
  if (digits.length !== 10) return null;
  return digits;
}

/** 사업자등록번호 검증 (국세청 체크섬) */
export function isValidBusinessNumber(bizno: string | null | undefined): boolean {
  if (!bizno || !/^\d{10}$/.test(bizno)) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(bizno[i]) * w[i]!;
  sum += Math.floor((Number(bizno[8]) * 5) / 10);
  const check = (10 - (sum % 10)) % 10;
  return check === Number(bizno[9]);
}

export function formatBusinessNumber(bizno: string | null | undefined): string {
  if (!bizno || bizno.length !== 10) return bizno ?? '';
  return `${bizno.slice(0, 3)}-${bizno.slice(3, 5)}-${bizno.slice(5)}`;
}

/** 카드번호 마스킹: 앞 4 + 뒤 4 외 '*' */
export function maskCardNumber(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const raw = String(input).replace(/[\s-]/g, '');
  if (raw === '') return null;
  const digits = raw.replace(/\*/g, '#');
  if (digits.length < 8) return raw.replace(/\d/g, '*');
  const head = digits.slice(0, 4).replace(/#/g, '*');
  const tail = digits.slice(-4).replace(/#/g, '*');
  return `${head}-****-****-${tail}`;
}

/** 주민(외국인)등록번호 마스킹: 900101-1****** */
export function maskResidentNumber(input: string | null | undefined): string | null {
  if (!input) return null;
  const d = input.replace(/\D/g, '');
  if (d.length !== 13) return '******-*******';
  return `${d.slice(0, 6)}-${d[6]}******`;
}

/**
 * 다양한 일자 표기 → 'YYYY-MM-DD'.
 * 허용: 2026-09-12, 2026.09.12, 2026/9/12, 20260912, 2026-09-12 13:22:10, Excel serial(number), Date
 */
export function normalizeDate(input: unknown): string | null {
  if (input === null || input === undefined || input === '') return null;
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    // exceljs 는 날짜를 UTC 자정 Date 로 준다 → UTC 기준으로 읽는다
    return `${input.getUTCFullYear()}-${pad(input.getUTCMonth() + 1)}-${pad(input.getUTCDate())}`;
  }
  if (typeof input === 'number') {
    // Excel serial date (1900 system)
    if (input > 20000 && input < 80000) {
      const ms = Math.round((input - 25569) * 86400 * 1000);
      const d = new Date(ms);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    input = String(input);
  }
  const s = String(input).trim();
  let m = s.match(/^(\d{4})[-./년\s]*(\d{1,2})[-./월\s]*(\d{1,2})/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function yearMonthOf(date: string): string {
  return date.slice(0, 7);
}

/** 'YYYY-MM' 의 이전 달 */
export function previousYearMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

export function nextYearMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

/** 0(일)~6(토) */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 로그/화면 출력용 민감정보 스크럽: 주민번호, 카드번호 전체, 이메일 비번 패턴 */
export function scrubSensitive(text: string): string {
  return text
    .replace(/\b(\d{6})[-\s]?([1-8])\d{6}\b/g, '$1-$2******')
    .replace(/\b(\d{4})[-\s]?\d{4}[-\s]?\d{4}[-\s]?(\d{4})\b/g, '$1-****-****-$2')
    .replace(/(password|passwd|pwd|secret|token)(["'\s:=]+)[^"'\s,}]+/gi, '$1$2[REDACTED]');
}
