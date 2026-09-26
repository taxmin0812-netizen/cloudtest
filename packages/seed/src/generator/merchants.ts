import type { IndustryKey, Won } from '@mintax/core';
import { makeAddress, makeBusinessNumber, makeEmail, makePersonName, type BizNoKind } from './ids';
import { rngFor } from './prng';
import type { EvidenceKind, MerchantKind, MerchantTaxType, SyntheticCustomer, SyntheticMerchant } from './types';

/**
 * 가맹점(매입 상대방) 우주 — 약 160곳.
 *
 * - 상호는 실제 브랜드를 닮은 이름을 쓰지만 사업자번호·주소·대표자는 모두 합성값이다 (사업자번호 앞자리 0xx).
 * - 계정 정답(truthAccountFor)은 "같은 가맹점이라도 수임처 업종·금액에 따라 다르게" 처리되는 실무 관행을 흉내 낸다.
 *   예) 쿠팡: 건설 → 830 소모품비 / 전자상거래 → 146 상품 / 디자인 → 100만원 이상 212 비품, 미만 830 소모품비
 * - 계정코드는 core DEFAULT_ACCOUNT_CODES(더존 3자리 추정 체계)에 있는 코드만 쓴다. 사무소 계정표에 따라 바뀔 수 있다(검증필요).
 */

/** 해외결제 합성 환율 (원/USD) — 실제 환율 아님 */
export const SYNTHETIC_USD_KRW = 1385;

interface Amount {
  median: Won;
  sigma: number;
  min: Won;
  max: Won;
  unit?: Won;
}

interface MerchantSpec {
  brand: string;
  names: string[];
  kind: MerchantKind;
  taxType: MerchantTaxType;
  corporate: boolean;
  bizType: string;
  category: string;
  evidence: EvidenceKind;
  amount: Amount;
  items?: string[];
  foreign?: boolean;
  /**
   * true 면 이력 풀에서 제외 — 당월 이상치/시나리오에서만 처음 등장한다.
   */
  reserved?: boolean;
  /** 간이과세자이지만 세금계산서 발급 가능(전표에 세액 표시) */
  vatOnSlip?: boolean;
}

const A = (median: Won, sigma: number, min: Won, max: Won, unit: Won = 100): Amount => ({ median, sigma, min, max, unit });

const card = (
  brand: string,
  names: string[],
  kind: MerchantKind,
  category: string,
  bizType: string,
  amount: Amount,
  opts: Partial<MerchantSpec> = {},
): MerchantSpec => ({ brand, names, kind, category, bizType, amount, taxType: 'general', corporate: false, evidence: 'card', ...opts });

const invoice = (
  brand: string,
  names: string[],
  kind: MerchantKind,
  category: string,
  bizType: string,
  amount: Amount,
  items: string[],
  opts: Partial<MerchantSpec> = {},
): MerchantSpec => ({ brand, names, kind, category, bizType, amount, items, taxType: 'general', corporate: true, evidence: 'tax_invoice', ...opts });

const foreignSaaS = (name: string, usdMedian: number, opts: Partial<MerchantSpec> = {}): MerchantSpec => ({
  brand: name,
  names: [name],
  kind: 'saas_foreign',
  category: '해외 소프트웨어 구독',
  bizType: '해외',
  taxType: 'general',
  corporate: true,
  evidence: 'card',
  foreign: true,
  amount: A(Math.round(usdMedian * SYNTHETIC_USD_KRW), 0.15, Math.round(usdMedian * 0.6 * SYNTHETIC_USD_KRW), Math.round(usdMedian * 3 * SYNTHETIC_USD_KRW), 1),
  ...opts,
});

const CORP = { corporate: true } as const;
const EXEMPT = { taxType: 'exempt' } as const;
const SIMPLE = { taxType: 'simplified' } as const;

export const MERCHANT_SPECS: readonly MerchantSpec[] = [
  // ── 커피 ──
  card('스타벅스', ['스타벅스 역삼점', '스타벅스 강남R점', '스타벅스 성수점', '스타벅스 판교점'], 'coffee', '커피전문점', '음식점업', A(12000, 0.5, 4500, 90000), CORP),
  card('이디야커피', ['이디야커피 선릉점', '이디야커피 문래점'], 'coffee', '커피전문점', '음식점업', A(9000, 0.5, 3000, 60000)),
  card('투썸플레이스', ['투썸플레이스 삼성점'], 'coffee', '커피전문점', '음식점업', A(15000, 0.5, 5000, 90000), CORP),
  card('메가MGC커피', ['메가MGC커피 역삼2호점', '메가MGC커피 가산점'], 'coffee', '커피전문점', '음식점업', A(7000, 0.5, 2000, 50000)),
  card('빽다방', ['빽다방 논현점'], 'coffee', '커피전문점', '음식점업', A(6500, 0.5, 2000, 45000)),
  // ── 식사 (일반 음식점) ──
  card('김밥천국', ['김밥천국 역삼점'], 'restaurant_meal', '분식', '음식점업', A(18000, 0.5, 4000, 120000)),
  card('본죽', ['본죽 선릉점'], 'restaurant_meal', '한식', '음식점업', A(24000, 0.5, 8000, 150000)),
  card('한솥도시락', ['한솥도시락 가산점'], 'restaurant_meal', '도시락', '음식점업', A(22000, 0.6, 4500, 200000)),
  card('명동칼국수', ['명동칼국수 본점'], 'restaurant_meal', '한식', '음식점업', A(36000, 0.5, 9000, 250000)),
  card('큰맘할매순대국', ['큰맘할매순대국 문래점'], 'restaurant_meal', '한식', '음식점업', A(34000, 0.5, 9000, 250000)),
  card('고봉민김밥', ['고봉민김밥 판교점'], 'restaurant_meal', '분식', '음식점업', A(21000, 0.5, 4000, 150000)),
  card('서브웨이', ['서브웨이 강남역점'], 'restaurant_meal', '샌드위치', '음식점업', A(26000, 0.5, 6000, 180000), CORP),
  card('맘스터치', ['맘스터치 성수점'], 'restaurant_meal', '패스트푸드', '음식점업', A(24000, 0.5, 5000, 160000)),
  card('홍콩반점0410', ['홍콩반점0410 삼성점'], 'restaurant_meal', '중식', '음식점업', A(38000, 0.5, 8000, 260000)),
  card('역전우동', ['역전우동 가산점'], 'restaurant_meal', '일식', '음식점업', A(19000, 0.5, 5000, 140000)),
  card('할머니손칼국수', ['할머니손칼국수'], 'restaurant_meal', '한식', '음식점업', A(16000, 0.4, 6000, 90000), SIMPLE),
  card('골목김밥', ['골목김밥 구로점'], 'restaurant_meal', '분식', '음식점업', A(12000, 0.4, 3000, 60000), SIMPLE),
  // 간이과세자이지만 세액이 표시되는 가맹점 (세금계산서 발급 가능 간이) — 시나리오 1 '공제/불공제 검토'
  card('소반식당', ['소반식당'], 'restaurant_meal', '한식', '음식점업', A(28000, 0.4, 8000, 150000), { ...SIMPLE, vatOnSlip: true }),
  card('들꽃밥상', ['들꽃밥상'], 'restaurant_meal', '한식', '음식점업', A(30000, 0.4, 8000, 150000), { ...SIMPLE, vatOnSlip: true }),
  card('모퉁이국수', ['모퉁이국수'], 'restaurant_meal', '한식', '음식점업', A(19000, 0.4, 6000, 100000), { ...SIMPLE, vatOnSlip: true }),
  card('작은부엌', ['작은부엌'], 'restaurant_meal', '한식', '음식점업', A(26000, 0.4, 8000, 150000), { ...SIMPLE, vatOnSlip: true }),
  card('오늘카페', ['오늘카페'], 'coffee', '커피전문점', '음식점업', A(11000, 0.4, 3000, 60000), { ...SIMPLE, vatOnSlip: true }),
  // ── 고급 식당 (접대 가능) ──
  card('수라원', ['한정식 수라원'], 'fine_dining', '한식 일반음식점', '음식점업', A(280000, 0.5, 80000, 1500000, 1000)),
  card('긴자오마카세', ['스시 긴자 오마카세'], 'fine_dining', '일식 일반음식점', '음식점업', A(320000, 0.5, 90000, 1800000, 1000)),
  card('더플레이트', ['더플레이트 스테이크하우스'], 'fine_dining', '양식 일반음식점', '음식점업', A(260000, 0.5, 70000, 1500000, 1000), CORP),
  card('홍연', ['중식당 홍연'], 'fine_dining', '중식 일반음식점', '음식점업', A(240000, 0.5, 60000, 1400000, 1000)),
  // ── 편의점 ──
  card('GS25', ['GS25 역삼점', 'GS25 가산디지털점'], 'convenience', '편의점', '소매업', A(6500, 0.6, 1200, 60000)),
  card('CU', ['CU 선릉역점', 'CU 성수점'], 'convenience', '편의점', '소매업', A(6500, 0.6, 1200, 60000)),
  card('세븐일레븐', ['세븐일레븐 판교점'], 'convenience', '편의점', '소매업', A(6000, 0.6, 1200, 50000)),
  card('이마트24', ['이마트24 문래점'], 'convenience', '편의점', '소매업', A(6000, 0.6, 1200, 50000)),
  // ── 배달앱 ──
  card('배달의민족', ['배달의민족'], 'delivery_app', '통신판매중개', '서비스업', A(28000, 0.5, 9000, 200000), CORP),
  card('쿠팡이츠', ['쿠팡이츠'], 'delivery_app', '통신판매중개', '서비스업', A(27000, 0.5, 9000, 200000), CORP),
  card('요기요', ['요기요'], 'delivery_app', '통신판매중개', '서비스업', A(26000, 0.5, 9000, 200000), CORP),
  // ── 통신 ──
  card('KT', ['KT'], 'telecom', '전기통신업', '통신업', A(88000, 0.3, 20000, 600000, 10), CORP),
  card('SK텔레콤', ['SK텔레콤'], 'telecom', '전기통신업', '통신업', A(92000, 0.3, 20000, 600000, 10), CORP),
  card('LG유플러스', ['LG유플러스'], 'telecom', '전기통신업', '통신업', A(85000, 0.3, 20000, 600000, 10), CORP),
  card('SK브로드밴드', ['SK브로드밴드'], 'telecom', '전기통신업', '통신업', A(45000, 0.2, 20000, 200000, 10), CORP),
  // ── 공과금 ──
  card('한국전력공사', ['한국전력공사'], 'utility_power', '전기업', '전기·가스업', A(180000, 0.5, 30000, 6000000, 10), CORP),
  card('한빛도시가스', ['한빛도시가스'], 'utility_gas', '가스공급업', '전기·가스업', A(120000, 0.5, 20000, 2000000, 10), CORP),
  // ── 차량 ──
  card('GS칼텍스', ['GS칼텍스 역삼주유소'], 'fuel', '주유소', '소매업', A(70000, 0.4, 20000, 250000, 10), CORP),
  card('SK에너지', ['SK에너지 가산셀프주유소'], 'fuel', '주유소', '소매업', A(68000, 0.4, 20000, 250000, 10)),
  card('S-OIL', ['S-OIL 판교주유소'], 'fuel', '주유소', '소매업', A(72000, 0.4, 20000, 250000, 10)),
  card('현대오일뱅크', ['현대오일뱅크 문래주유소'], 'fuel', '주유소', '소매업', A(69000, 0.4, 20000, 250000, 10)),
  card('한국도로공사', ['한국도로공사'], 'toll', '도로운영(통행료)', '운수업', A(3500, 0.6, 800, 40000), CORP),
  card('가상공영주차장', ['가상공영주차장 역삼', '샘플타워 주차장'], 'parking', '주차장운영업', '서비스업', A(6000, 0.6, 1000, 60000)),
  // ── 여객운송·숙박 ──
  card('카카오T', ['카카오T 택시'], 'taxi', '택시운송업', '운수업', A(14000, 0.5, 4800, 90000), CORP),
  card('개인택시', ['개인택시 운송'], 'taxi', '택시운송업', '운수업', A(12000, 0.5, 4800, 70000), SIMPLE),
  card('코레일', ['코레일 (한국철도공사)'], 'train', '철도운송업', '운수업', A(59800, 0.4, 8400, 250000), CORP),
  card('SR', ['SR (SRT)'], 'train', '철도운송업', '운수업', A(52900, 0.4, 8400, 250000), CORP),
  card('한빛항공', ['한빛항공'], 'airline', '항공운송업', '운수업', A(98000, 0.4, 45000, 600000), CORP),
  card('가상스테이', ['호텔 가상스테이 부산', '비즈니스호텔 샘플인 대전'], 'lodging', '호텔업', '숙박업', A(120000, 0.4, 50000, 500000)),
  // ── 온라인몰 ──
  card('쿠팡', ['쿠팡'], 'ecommerce_market', '전자상거래 소매', '소매업', A(38000, 0.9, 3000, 900000), CORP),
  card('11번가', ['11번가'], 'ecommerce_market', '전자상거래 소매', '소매업', A(42000, 0.9, 3000, 900000), CORP),
  card('G마켓', ['G마켓'], 'ecommerce_market', '전자상거래 소매', '소매업', A(40000, 0.9, 3000, 900000), CORP),
  card('네이버페이', ['네이버페이'], 'ecommerce_market', '전자지급결제대행', '서비스업', A(35000, 0.9, 3000, 900000), CORP),
  card('SSG닷컴', ['SSG닷컴'], 'ecommerce_market', '전자상거래 소매', '소매업', A(45000, 0.8, 3000, 900000), CORP),
  // ── 사무·생활용품 ──
  card('오피스플러스', ['오피스플러스 역삼점'], 'office_supply', '문구 소매', '소매업', A(25000, 0.7, 2000, 400000), CORP),
  card('알파문구', ['알파문구 선릉점'], 'office_supply', '문구 소매', '소매업', A(18000, 0.7, 1000, 300000)),
  card('모닝글로리', ['모닝글로리 판교점'], 'office_supply', '문구 소매', '소매업', A(15000, 0.7, 1000, 200000)),
  card('다이소', ['다이소 역삼점', '다이소 가산점', '다이소 성수점'], 'daiso', '생활용품 소매', '소매업', A(12000, 0.7, 1000, 150000), CORP),
  card('이마트', ['이마트 성수점', '이마트 역삼점'], 'mart', '대형마트', '소매업', A(65000, 0.7, 3000, 700000), CORP),
  card('홈플러스', ['홈플러스 가산점'], 'mart', '대형마트', '소매업', A(62000, 0.7, 3000, 700000), CORP),
  card('롯데마트', ['롯데마트 판교점'], 'mart', '대형마트', '소매업', A(60000, 0.7, 3000, 700000), CORP),
  card('코스트코', ['코스트코 양재점'], 'mart', '회원제 창고형 할인점', '소매업', A(150000, 0.6, 10000, 1200000), CORP),
  card('백화점', ['롯데백화점 본점', '신세계백화점 강남점', '현대백화점 판교점'], 'dept_store', '백화점', '소매업', A(150000, 0.7, 20000, 2000000), { ...CORP, reserved: true }),
  // ── 전자·가구 ──
  card('롯데하이마트', ['롯데하이마트 역삼점'], 'electronics', '가전제품 소매', '소매업', A(250000, 0.9, 15000, 3500000, 1000), CORP),
  card('삼성디지털프라자', ['삼성디지털프라자 판교점'], 'electronics', '가전제품 소매', '소매업', A(280000, 0.9, 15000, 3500000, 1000), CORP),
  card('애플스토어', ['애플스토어 가로수길'], 'electronics', '컴퓨터·통신기기 소매', '소매업', A(320000, 0.8, 25000, 4000000, 1000), CORP),
  card('전자랜드', ['전자랜드 가산점'], 'electronics', '가전제품 소매', '소매업', A(200000, 0.9, 15000, 3000000, 1000), CORP),
  card('이케아', ['이케아 광명점'], 'furniture', '가구 소매', '소매업', A(220000, 0.8, 20000, 2500000, 1000), CORP),
  card('한샘', ['한샘 디자인파크 성수'], 'furniture', '가구 소매', '소매업', A(350000, 0.8, 30000, 3000000, 1000), CORP),
  card('데스커', ['데스커 라운지 판교'], 'furniture', '사무용 가구 소매', '소매업', A(300000, 0.7, 30000, 2500000, 1000), CORP),
  // ── 해외 SaaS (USD) ──
  foreignSaaS('ADOBE *CREATIVE CLOUD', 62),
  foreignSaaS('AMAZON WEB SERVICES', 180),
  foreignSaaS('GOOGLE *WORKSPACE', 36),
  foreignSaaS('MICROSOFT 365', 25),
  foreignSaaS('SLACK TECHNOLOGIES', 44),
  foreignSaaS('GITHUB INC', 21),
  foreignSaaS('CANVA PTY LTD', 15),
  foreignSaaS('DROPBOX INC', 20),
  foreignSaaS('FIGMA.COM', 45, { reserved: true }),
  foreignSaaS('NOTION LABS INC', 96, { reserved: true }),
  foreignSaaS('MIDJOURNEY INC', 30, { reserved: true }),
  foreignSaaS('ZOOM.US', 16, { reserved: true }),
  // ── 국내 SaaS·호스팅 ──
  card('가비아', ['가비아'], 'saas_domestic', '호스팅·도메인', '정보통신업', A(55000, 0.6, 5000, 500000, 10), CORP),
  card('카페24', ['카페24'], 'saas_domestic', '호스팅·쇼핑몰 솔루션', '정보통신업', A(66000, 0.6, 5000, 500000, 10), CORP),
  card('네이버클라우드', ['네이버클라우드'], 'saas_domestic', '클라우드 서비스', '정보통신업', A(120000, 0.7, 10000, 1500000, 10), CORP),
  card('두레이', ['NHN두레이'], 'saas_domestic', '협업 소프트웨어', '정보통신업', A(48000, 0.3, 10000, 300000, 10), CORP),
  // ── 광고 ──
  card('네이버광고', ['네이버 검색광고'], 'advertising', '온라인 광고', '서비스업', A(300000, 0.8, 30000, 5000000, 1000), CORP),
  card('카카오광고', ['카카오 비즈보드'], 'advertising', '온라인 광고', '서비스업', A(250000, 0.8, 30000, 4000000, 1000), CORP),
  card('구글애즈', ['구글 애즈 (구글코리아)'], 'advertising', '온라인 광고', '서비스업', A(280000, 0.8, 30000, 4000000, 1000), CORP),
  foreignSaaS('FACEBK *ADS', 180, { kind: 'advertising', category: '해외 온라인 광고' }),
  // ── 운송·포장·인쇄 ──
  card('CJ대한통운', ['CJ대한통운'], 'courier', '택배업', '운수업', A(45000, 0.8, 3000, 600000, 10), CORP),
  card('우체국', ['가상우체국 역삼'], 'courier', '우편업', '운수업', A(12000, 0.7, 2000, 200000, 10), { ...CORP, ...EXEMPT }),
  card('한진택배', ['한진택배'], 'courier', '택배업', '운수업', A(40000, 0.8, 3000, 500000, 10), CORP),
  card('로젠택배', ['로젠택배'], 'courier', '택배업', '운수업', A(38000, 0.8, 3000, 500000, 10), CORP),
  invoice('박스월드', ['박스월드 포장재'], 'packaging', '포장재 도매', '도매업', A(180000, 0.6, 30000, 2500000, 10), ['택배박스 3호 x 500', '에어캡 롤', 'OPP 테이프'], { corporate: false }),
  invoice('대성포장', ['대성포장'], 'packaging', '포장재 제조', '제조업', A(260000, 0.6, 30000, 3000000, 10), ['골판지 박스', '완충재']),
  card('프린트샵', ['프린트샵 역삼점'], 'printing', '인쇄업', '제조업', A(90000, 0.7, 5000, 1500000, 10)),
  invoice('성원인쇄', ['성원인쇄'], 'printing', '인쇄업', '제조업', A(450000, 0.6, 50000, 5000000, 10), ['리플렛 인쇄', '명함 인쇄', '카탈로그 인쇄'], { corporate: false }),
  card('교보문고', ['교보문고 광화문점'], 'bookstore', '서적 소매', '소매업', A(32000, 0.6, 8000, 300000), { ...CORP, ...EXEMPT }),
  card('예스24', ['예스24'], 'bookstore', '서적 소매(온라인)', '소매업', A(28000, 0.6, 8000, 300000), { ...CORP, ...EXEMPT }),
  card('알라딘', ['알라딘'], 'bookstore', '서적 소매(온라인)', '소매업', A(26000, 0.6, 8000, 300000), { ...CORP, ...EXEMPT }),
  // ── 접대·경조 ──
  card('가상컨트리클럽', ['가상컨트리클럽 (용인)'], 'golf', '골프장 운영업', '서비스업', A(1200000, 0.4, 250000, 3500000, 1000), CORP),
  card('샘플힐스', ['샘플힐스 골프클럽'], 'golf', '골프장 운영업', '서비스업', A(1100000, 0.4, 250000, 3500000, 1000), CORP),
  card('레이크사이드', ['레이크사이드CC 가상점'], 'golf', '골프장 운영업', '서비스업', A(1300000, 0.4, 250000, 3500000, 1000), CORP),
  card('로얄', ['로얄 유흥주점'], 'bar', '유흥주점', '음식점업', A(850000, 0.5, 150000, 3000000, 1000), { reserved: true }),
  card('별빛', ['별빛 단란주점'], 'bar', '단란주점', '음식점업', A(600000, 0.5, 100000, 2000000, 1000), { reserved: true }),
  card('샘플가라오케', ['샘플 가라오케'], 'bar', '유흥주점(가라오케)', '음식점업', A(500000, 0.5, 100000, 2000000, 1000), { reserved: true }),
  card('꽃담플라워', ['꽃담플라워 역삼'], 'flowers', '화훼 소매', '소매업', A(80000, 0.4, 30000, 300000, 1000), EXEMPT),
  card('플로라', ['플로라 꽃집'], 'flowers', '화훼 소매', '소매업', A(70000, 0.4, 30000, 250000, 1000), EXEMPT),
  // ── 식자재 (면세) ──
  card('농협하나로마트', ['농협하나로마트 양재점'], 'food_wholesale_exempt', '농산물 소매', '소매업', A(180000, 0.6, 10000, 1500000, 10), { ...CORP, ...EXEMPT }),
  invoice('가락청과', ['가락시장 청과상회'], 'food_wholesale_exempt', '청과물 도매', '도매업', A(420000, 0.6, 30000, 3000000, 10), ['채소류', '과일류', '양파 20kg', '배추 10망'], { ...EXEMPT, corporate: false, evidence: 'invoice_exempt' }),
  invoice('새벽수산', ['새벽수산'], 'food_wholesale_exempt', '수산물 도매', '도매업', A(380000, 0.6, 30000, 2500000, 10), ['고등어', '오징어', '새우'], { ...EXEMPT, corporate: false, evidence: 'invoice_exempt' }),
  invoice('한우명가축산', ['한우명가축산'], 'meat_supplier', '축산물 도매', '도매업', A(1800000, 0.5, 200000, 8000000, 10), ['한우 등심', '한우 갈비', '한우 부채살', '돼지 목살'], { ...EXEMPT, corporate: false, evidence: 'invoice_exempt' }),
  invoice('대성축산유통', ['대성축산유통'], 'meat_supplier', '축산물 도매', '도매업', A(1500000, 0.5, 200000, 7000000, 10), ['한우 차돌박이', '돼지 삼겹살', '소 양지'], { ...EXEMPT, evidence: 'invoice_exempt' }),
  invoice('빈스로스터리', ['빈스로스터리'], 'coffee_beans', '커피 원두 제조', '제조업', A(450000, 0.4, 100000, 2000000, 10), ['원두 블렌드 5kg', '원두 싱글오리진 2kg', '드립백'], { corporate: false }),
  invoice('푸른목장', ['푸른목장 유제품'], 'dairy_supplier', '유제품 도매', '도매업', A(280000, 0.4, 50000, 1200000, 10), ['우유 1L x 40', '우유 1L x 60'], { ...EXEMPT, corporate: false, evidence: 'invoice_exempt' }),
  // ── 건설·제조 자재 ──
  invoice('한빛건자재', ['한빛건자재'], 'building_materials', '건축자재 도매', '도매업', A(2800000, 0.7, 200000, 30000000, 10), ['석고보드', '타일', '방수시트', '단열재']),
  invoice('동양레미콘', ['동양레미콘'], 'building_materials', '레미콘 제조', '제조업', A(4500000, 0.6, 500000, 30000000, 10), ['레미콘 25-24-150']),
  invoice('성진철강', ['성진철강'], 'building_materials', '철강재 도매', '도매업', A(3800000, 0.6, 300000, 30000000, 10), ['철근 HD13', '철근 HD16', 'H빔']),
  invoice('대한건재', ['대한건재'], 'building_materials', '건축자재 도매', '도매업', A(1600000, 0.7, 100000, 15000000, 10), ['시멘트', '몰탈', '합판']),
  card('공구나라', ['공구나라 구로점'], 'hardware_tools', '공구 소매', '소매업', A(85000, 0.7, 5000, 1500000, 100)),
  card('유성공구상사', ['유성공구상사'], 'hardware_tools', '공구 도매', '도매업', A(95000, 0.7, 5000, 1500000, 100)),
  invoice('대성정밀부품', ['대성정밀부품'], 'machine_parts', '기계부품 제조', '제조업', A(1600000, 0.6, 100000, 12000000, 10), ['SUS304 환봉', '볼트·너트 세트', '가공 지그']),
  invoice('한일금속', ['한일금속'], 'machine_parts', '비철금속 도매', '도매업', A(2200000, 0.6, 200000, 15000000, 10), ['알루미늄 판재 A6061', '동 파이프']),
  invoice('세진베어링', ['세진베어링'], 'machine_parts', '베어링 도매', '도매업', A(800000, 0.6, 50000, 6000000, 10), ['베어링 6205', '절삭유 20L']),
  // ── 상품 도매 ──
  invoice('가나상사', ['가나상사'], 'goods_supplier', '생활용품 도매', '도매업', A(2200000, 0.7, 100000, 20000000, 10), ['생활용품 세트', '주방용품', '수납용품']),
  invoice('다온유통', ['다온유통'], 'goods_supplier', '잡화 도매', '도매업', A(1800000, 0.7, 100000, 15000000, 10), ['디자인 문구 소품', '패브릭 소품', '머그컵']),
  invoice('제이앤케이트레이딩', ['제이앤케이트레이딩'], 'goods_supplier', '수입 잡화 도매', '도매업', A(2600000, 0.7, 100000, 20000000, 10), ['수입 주방용품', '캠핑용품']),
  // ── 의료·교육 ──
  invoice('메디팜', ['메디팜 의약품도매'], 'medical_supplies', '의약품 도매', '도매업', A(1200000, 0.6, 100000, 8000000, 10), ['주사제', '소모성 의료재료', '거즈·밴드']),
  invoice('한결의료기', ['한결의료기'], 'medical_supplies', '의료기기 도매', '도매업', A(900000, 0.6, 50000, 6000000, 10), ['일회용 주사기', '검사 키트']),
  invoice('가상출판', ['가상출판 교재'], 'education_materials', '교재 출판', '출판업', A(600000, 0.5, 50000, 3000000, 10), ['수학 교재', '문제집'], { ...EXEMPT, evidence: 'invoice_exempt' }),
  invoice('에듀북스', ['에듀북스'], 'education_materials', '교재 도매', '도매업', A(450000, 0.5, 50000, 2500000, 10), ['교재', '워크북'], { ...EXEMPT, evidence: 'invoice_exempt' }),
  // ── 임대·관리·용역 ──
  invoice('해솔빌딩', ['해솔빌딩'], 'rent', '비주거용 건물 임대', '부동산업', A(2500000, 0.5, 600000, 9000000, 10000), ['임대료'], { corporate: false }),
  invoice('청운타워', ['청운타워'], 'rent', '비주거용 건물 임대', '부동산업', A(3200000, 0.5, 600000, 9000000, 10000), ['임대료']),
  invoice('가람프라자', ['가람프라자'], 'rent', '비주거용 건물 임대', '부동산업', A(1800000, 0.5, 600000, 6000000, 10000), ['임대료'], { corporate: false }),
  invoice('해솔관리', ['해솔빌딩 관리사무소'], 'building_mgmt', '건물관리업', '서비스업', A(450000, 0.4, 100000, 1500000, 10), ['관리비']),
  invoice('청운관리', ['청운타워 관리단'], 'building_mgmt', '건물관리업', '서비스업', A(520000, 0.4, 100000, 1500000, 10), ['관리비']),
  invoice('가람세무회계', ['가람세무회계'], 'professional_fee', '세무사업', '전문서비스업', A(330000, 0.3, 110000, 1100000, 10000), ['기장수수료'], { corporate: false }),
  invoice('한결노무법인', ['한결노무법인'], 'professional_fee', '노무사업', '전문서비스업', A(220000, 0.3, 110000, 880000, 10000), ['노무자문료']),
  invoice('세움법무사', ['세움법무사사무소'], 'professional_fee', '법무사업', '전문서비스업', A(330000, 0.4, 110000, 1100000, 10000), ['등기대행 수수료'], { corporate: false }),
  card('세이프가드', ['세이프가드 보안'], 'security_service', '경비업', '서비스업', A(110000, 0.2, 55000, 330000, 10), CORP),
  card('청정수렌탈', ['청정수렌탈'], 'rental_equipment', '정수기 렌탈', '임대업', A(39900, 0.2, 19900, 99000, 100), CORP),
  card('가상복합기렌탈', ['가상복합기렌탈'], 'rental_equipment', '사무기기 렌탈', '임대업', A(88000, 0.2, 44000, 220000, 100)),
  invoice('그린환경', ['그린환경 폐기물'], 'waste_disposal', '폐기물 수집운반', '하수·폐기물업', A(380000, 0.5, 50000, 3000000, 10), ['건설폐기물 처리', '사업장폐기물 수거'], { corporate: false }),
  card('인터넷등기소', ['인터넷등기소'], 'government_fee', '공공행정', '공공행정', A(2000, 0.6, 700, 30000, 100), { ...CORP, ...EXEMPT }),
  card('정부24', ['정부24 수수료'], 'government_fee', '공공행정', '공공행정', A(1500, 0.6, 500, 20000, 100), { ...CORP, ...EXEMPT }),
  card('한빛화재', ['한빛화재해상보험'], 'insurance', '손해보험업', '금융·보험업', A(180000, 0.4, 30000, 1500000, 10), { ...CORP, ...EXEMPT }),
];

function bizKindOfMerchant(s: MerchantSpec): BizNoKind {
  if (s.corporate) return 'corporation';
  return s.taxType === 'exempt' ? 'individual_exempt' : 'individual';
}

/** 가맹점 우주 생성 (M001…). 해외 가맹점은 사업자번호 없음. */
export function generateMerchants(seed: number, usedBusinessNumbers: Set<string>, usedNames: Set<string>): SyntheticMerchant[] {
  const out: SyntheticMerchant[] = [];
  let n = 0;
  for (const spec of MERCHANT_SPECS) {
    for (const name of spec.names) {
      n += 1;
      const id = `M${String(n).padStart(3, '0')}`;
      const rng = rngFor(seed, 'merchant', name);
      const foreign = !!spec.foreign;
      out.push({
        id,
        name,
        brand: spec.brand,
        kind: spec.kind,
        businessNumber: foreign ? null : makeBusinessNumber(rng, bizKindOfMerchant(spec), usedBusinessNumbers),
        taxType: spec.taxType,
        corporate: spec.corporate,
        bizType: spec.bizType,
        category: spec.category,
        evidence: spec.evidence,
        foreign,
        currency: foreign ? 'USD' : 'KRW',
        amount: { median: spec.amount.median, sigma: spec.amount.sigma, min: spec.amount.min, max: spec.amount.max, unit: spec.amount.unit ?? 100 },
        items: spec.items ? [...spec.items] : [],
        representativeName: foreign ? '' : makePersonName(rng, usedNames),
        address: foreign ? '' : makeAddress(rng),
        email: makeEmail(`billing-${id}`),
      });
    }
  }
  return out;
}

/** 이력 풀에서 제외되는 가맹점 이름 (당월 이상치·시나리오 전용) */
export const RESERVED_MERCHANT_NAMES: ReadonlySet<string> = new Set(
  MERCHANT_SPECS.filter((s) => s.reserved).flatMap((s) => s.names),
);

/** 간이과세자이지만 전표에 세액이 표시되는 가맹점 */
export const VAT_ON_SLIP_SIMPLIFIED_NAMES: ReadonlySet<string> = new Set(
  MERCHANT_SPECS.filter((s) => s.vatOnSlip).flatMap((s) => s.names),
);

// ────────────────────────────── 계정 정답 ──────────────────────────────

const FOOD_SERVICE: readonly IndustryKey[] = ['restaurant', 'meat_restaurant', 'cafe'];
const BUILDERS: readonly IndustryKey[] = ['construction', 'interior'];
const RESELLERS: readonly IndustryKey[] = ['ecommerce', 'wholesale_retail'];
const ENTERTAINING: readonly IndustryKey[] = ['construction', 'interior', 'wholesale_retail', 'manufacturing', 'service'];

/** 즉시상각 가능 한도 — 이 금액 이상이면 비품 등 자산 (법인세법 시행령 제31조④ 100만원 기준, 사무소 관행값) */
export const ASSET_THRESHOLD: Won = 1_000_000;

/**
 * 가맹점 종류 × 수임처 업종 × 금액 → 정답 계정코드.
 * 이력·당월 모두 이 함수로 정답을 만든다 (이상치 거래는 anomalies.ts 에서 개별 지정).
 */
export function truthAccountFor(kind: MerchantKind, industry: IndustryKey, totalAmount: Won): string {
  const amt = Math.abs(totalAmount);
  switch (kind) {
    case 'coffee':
    case 'restaurant_meal':
    case 'convenience':
      return '811';
    case 'fine_dining':
      return ENTERTAINING.includes(industry) ? '813' : '811';
    case 'delivery_app':
      return FOOD_SERVICE.includes(industry) ? '831' : '811';
    case 'telecom':
      return '814';
    case 'utility_power':
      return industry === 'manufacturing' ? '816' : '815';
    case 'utility_gas':
      return '815';
    case 'fuel':
    case 'toll':
    case 'parking':
      return '822';
    case 'taxi':
    case 'train':
    case 'airline':
    case 'lodging':
      return '812';
    case 'ecommerce_market':
      if (BUILDERS.includes(industry)) return '830';
      if (RESELLERS.includes(industry)) return '146';
      if (industry === 'design') return amt >= ASSET_THRESHOLD ? '212' : '830';
      return '830';
    case 'office_supply':
      return industry === 'design' || industry === 'it_service' ? '829' : '830';
    case 'daiso':
      return '830';
    case 'mart':
      if (FOOD_SERVICE.includes(industry)) return '153';
      return amt < 60_000 ? '811' : '830';
    case 'dept_store':
      return '813';
    case 'electronics':
    case 'furniture':
      return amt >= ASSET_THRESHOLD ? '212' : '830';
    case 'saas_foreign':
    case 'saas_domestic':
      return '831';
    case 'advertising':
      return '833';
    case 'courier':
      return '824';
    case 'packaging':
      return RESELLERS.includes(industry) || industry === 'manufacturing' ? '828' : '830';
    case 'printing':
    case 'bookstore':
    case 'education_materials':
      return '826';
    case 'golf':
    case 'bar':
    case 'flowers':
      return '813';
    case 'food_wholesale_exempt':
      return FOOD_SERVICE.includes(industry) || industry === 'manufacturing' ? '153' : '811';
    case 'meat_supplier':
    case 'coffee_beans':
    case 'dairy_supplier':
      return '153';
    case 'building_materials':
      return BUILDERS.includes(industry) ? '153' : '820';
    case 'hardware_tools':
      if (BUILDERS.includes(industry) || industry === 'manufacturing') return amt >= ASSET_THRESHOLD ? '210' : '830';
      return '830';
    case 'machine_parts':
      return industry === 'manufacturing' ? '153' : '820';
    case 'goods_supplier':
      return RESELLERS.includes(industry) || industry === 'design' ? '146' : '830';
    case 'medical_supplies':
      return industry === 'clinic' ? '153' : '811';
    case 'rent':
    case 'rental_equipment':
      return '819';
    case 'building_mgmt':
      return '837';
    case 'professional_fee':
    case 'security_service':
    case 'waste_disposal':
      return '831';
    case 'government_fee':
      return '817';
    case 'insurance':
      return '821';
    case 'unknown':
      return '830';
  }
}

/** 문서·테스트용: 같은 가맹점이 업종별로 달라지는 대표 예 */
export const ACCOUNT_MAPPING_EXAMPLES = [
  { merchant: '쿠팡', industry: 'construction', amount: 45_000, accountCode: '830' },
  { merchant: '쿠팡', industry: 'ecommerce', amount: 45_000, accountCode: '146' },
  { merchant: '쿠팡', industry: 'design', amount: 45_000, accountCode: '830' },
  { merchant: '쿠팡', industry: 'design', amount: 1_450_000, accountCode: '212' },
  { merchant: '한국전력공사', industry: 'manufacturing', amount: 2_400_000, accountCode: '816' },
  { merchant: '한국전력공사', industry: 'service', amount: 180_000, accountCode: '815' },
  { merchant: '이마트 성수점', industry: 'restaurant', amount: 80_000, accountCode: '153' },
  { merchant: '이마트 성수점', industry: 'service', amount: 30_000, accountCode: '811' },
  { merchant: '한정식 수라원', industry: 'construction', amount: 300_000, accountCode: '813' },
  { merchant: '한정식 수라원', industry: 'it_service', amount: 300_000, accountCode: '811' },
  { merchant: '배달의민족', industry: 'restaurant', amount: 30_000, accountCode: '831' },
  { merchant: '배달의민족', industry: 'it_service', amount: 30_000, accountCode: '811' },
] as const;

// ────────────────────────────── 매출 상대방 ──────────────────────────────

const CUSTOMER_NAMES = [
  '(주)가온테크', '(주)나래물산', '(주)다솜건설', '(주)라온미디어', '(주)마루시스템', '(주)바른식품', '(주)새봄에듀', '(주)아라유통',
  '(주)자람바이오', '(주)차오름엔지니어링', '(주)하늘소프트', '(주)한울디자인', '(주)누리커머스', '(주)도담건축', '(주)미르산업',
  '(주)보람푸드', '(주)소망개발', '(주)온새미로', '(주)푸른숲종합', '(주)하람정밀', '누리상회', '다올공방', '미소치과의원', '해랑스튜디오',
];

export function generateCustomers(seed: number, usedBusinessNumbers: Set<string>, usedNames: Set<string>): SyntheticCustomer[] {
  return CUSTOMER_NAMES.map((name, i) => {
    const rng = rngFor(seed, 'customer', name);
    const id = `K${String(i + 1).padStart(3, '0')}`;
    return {
      id,
      name,
      businessNumber: makeBusinessNumber(rng, name.startsWith('(주)') ? 'corporation' : 'individual', usedBusinessNumbers),
      representativeName: makePersonName(rng, usedNames),
      address: makeAddress(rng),
      email: makeEmail(`ap-${id}`),
    };
  });
}
