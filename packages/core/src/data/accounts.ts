import type { AccountCode, Direction } from '../types';

/**
 * 기본 계정과목표 (더존 Smart A / WEHAGO 3자리 체계 기준 추정값).
 *
 * 근거: docs/research/01-wehago.md §2.7
 * - [공식] 135 부가세대급금, 813 이름 변경(접대비 → 접대비(기업업무추진비), 2024-01-01)
 * - [커뮤니티] 101·103·108·146·251·253·255·401·451·801~805·811~833·848 (KcLep·전산세무 수험자료 관례)
 * - 그 외 코드는 표준표 관례에 따른 추정값이다. `// 검증필요` 표시.
 *
 * 계정코드 체계는 수임처마다 다르다(3자리/5자리, 사용자 추가 계정). 이 표는 DB(account_codes)가
 * 비어 있을 때의 기본값일 뿐이며, 사무소는 DB로 덮어쓴다. 매칭은 항상 코드 기준, 이름은 표시·검증용.
 */
const A = (
  code: string,
  name: string,
  category: AccountCode['category'],
  extra: Partial<Pick<AccountCode, 'isFixedAsset' | 'vatNonDeductibleHint'>> = {},
): AccountCode => ({ code, name, category, active: true, ...extra });

export const DEFAULT_ACCOUNT_CODES: readonly AccountCode[] = Object.freeze([
  // ── 유동자산 ──
  A('101', '현금', 'asset'),
  A('102', '당좌예금', 'asset'), // 검증필요
  A('103', '보통예금', 'asset'),
  A('104', '기타제예금', 'asset'), // 검증필요
  A('105', '정기예금', 'asset'), // 검증필요
  A('106', '정기적금', 'asset'), // 검증필요
  A('107', '단기매매증권', 'asset'), // 검증필요
  A('108', '외상매출금', 'asset'),
  A('110', '받을어음', 'asset'), // 검증필요
  A('114', '단기대여금', 'asset'), // 검증필요
  A('116', '미수수익', 'asset'), // 검증필요
  A('120', '미수금', 'asset'), // 검증필요
  A('131', '선급금', 'asset'), // 검증필요
  A('133', '선급비용', 'asset'), // 검증필요
  A('134', '가지급금', 'asset'), // 검증필요
  A('135', '부가세대급금', 'asset'),
  A('136', '선납세금', 'asset'), // 검증필요
  A('146', '상품', 'asset'),
  A('150', '제품', 'asset'), // 검증필요
  A('153', '원재료', 'asset'), // 검증필요
  A('169', '재공품', 'asset'), // 검증필요
  // ── 유형·무형·기타비유동자산 ──
  A('201', '토지', 'asset', { isFixedAsset: true }), // 검증필요
  A('202', '건물', 'asset', { isFixedAsset: true }), // 검증필요
  A('204', '구축물', 'asset', { isFixedAsset: true }), // 검증필요
  A('206', '기계장치', 'asset', { isFixedAsset: true }), // 검증필요
  A('208', '차량운반구', 'asset', { isFixedAsset: true }), // 검증필요
  A('210', '공구와기구', 'asset', { isFixedAsset: true }), // 검증필요
  A('212', '비품', 'asset', { isFixedAsset: true }), // 검증필요
  A('214', '건설중인자산', 'asset', { isFixedAsset: true }), // 검증필요
  A('219', '특허권', 'asset', { isFixedAsset: true }), // 검증필요
  A('226', '개발비', 'asset', { isFixedAsset: true }), // 검증필요
  A('227', '소프트웨어', 'asset', { isFixedAsset: true }), // 검증필요
  A('962', '임차보증금', 'asset'), // 검증필요
  // ── 부채 ──
  A('251', '외상매입금', 'liability'),
  A('252', '지급어음', 'liability'), // 검증필요
  A('253', '미지급금', 'liability'),
  A('254', '예수금', 'liability'), // 검증필요
  A('255', '부가세예수금', 'liability'),
  A('257', '가수금', 'liability'), // 검증필요
  A('259', '선수금', 'liability'), // 검증필요
  A('260', '단기차입금', 'liability'), // 검증필요
  A('261', '미지급세금', 'liability'), // 검증필요
  A('262', '미지급비용', 'liability'), // 검증필요
  A('293', '장기차입금', 'liability'), // 검증필요
  A('295', '퇴직급여충당부채', 'liability'), // 검증필요
  // ── 자본 ──
  A('331', '자본금', 'equity'), // 검증필요
  A('338', '인출금', 'equity'), // 검증필요 (개인사업자)
  // ── 매출 ──
  A('401', '상품매출', 'revenue'),
  A('404', '제품매출', 'revenue'), // 검증필요
  // ── 매출원가 ──
  A('451', '상품매출원가', 'cogs'),
  A('455', '제품매출원가', 'cogs'), // 검증필요
  // ── 판매비와관리비 (800번대) ──
  // 801: 전산회계 표준표는 '급여', Smart A 계열 일부 자료는 801 임원급여 / 802 직원급여(급료)로 나눔 — 검증필요
  A('801', '급여', 'expense'),
  A('803', '상여금', 'expense'),
  A('804', '제수당', 'expense'),
  A('805', '잡급', 'expense'),
  A('806', '퇴직급여', 'expense'), // 검증필요
  A('811', '복리후생비', 'expense'),
  A('812', '여비교통비', 'expense'),
  // [공식] 2024-01-01부터 WEHAGO 계정명 '접대비(기업업무추진비)'. 코드 813 자체는 커뮤니티 수준.
  A('813', '접대비(기업업무추진비)', 'expense', { vatNonDeductibleHint: true }),
  A('814', '통신비', 'expense'),
  A('815', '수도광열비', 'expense'),
  A('816', '전력비', 'expense'),
  A('817', '세금과공과', 'expense'),
  A('818', '감가상각비', 'expense'), // 검증필요
  A('819', '지급임차료', 'expense'),
  A('820', '수선비', 'expense'),
  A('821', '보험료', 'expense'),
  A('822', '차량유지비', 'expense'),
  A('823', '경상연구개발비', 'expense'), // 검증필요
  A('824', '운반비', 'expense'),
  A('825', '교육훈련비', 'expense'),
  A('826', '도서인쇄비', 'expense'),
  A('827', '회의비', 'expense'), // 검증필요
  A('828', '포장비', 'expense'), // 검증필요
  A('829', '사무용품비', 'expense'),
  A('830', '소모품비', 'expense'),
  A('831', '지급수수료', 'expense'),
  A('832', '보관료', 'expense'), // 검증필요
  A('833', '광고선전비', 'expense'),
  A('834', '판매촉진비', 'expense'), // 검증필요
  A('835', '대손상각비', 'expense'), // 검증필요
  A('837', '건물관리비', 'expense'), // 검증필요
  A('848', '잡비', 'expense'),
  // ── 영업외손익 (900번대) ── 전부 검증필요
  A('901', '이자수익', 'revenue'),
  A('904', '임대료', 'revenue'),
  A('930', '잡이익', 'revenue'),
  A('951', '이자비용', 'expense'),
  A('953', '기부금', 'expense'),
  A('980', '잡손실', 'expense'),
  A('998', '법인세등', 'expense'),
]);

/** 코드 → 계정 Map. 같은 코드가 여러 번 오면 뒤의 값(사무소 설정)이 이긴다. */
export function buildAccountMap(accounts: readonly AccountCode[]): Map<string, AccountCode> {
  const m = new Map<string, AccountCode>();
  for (const a of accounts) m.set(String(a.code).trim(), a);
  return m;
}

/**
 * 거래 방향과 계정 성격이 양립하는가.
 * - 매입 거래에 매출(revenue) 계정 불가, 매출 거래에 비용·원가 계정 불가.
 * - 계정표에 없는 코드는 판단 불가이므로 true (별도 경고로 처리).
 */
export function isAccountCompatible(
  code: string,
  direction: Direction,
  accounts: ReadonlyMap<string, AccountCode>,
): boolean {
  const acc = accounts.get(code);
  if (!acc) return true;
  if (direction === 'purchase') return acc.category !== 'revenue';
  return acc.category !== 'expense' && acc.category !== 'cogs';
}
