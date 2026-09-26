import type { AccountCode, Condition, ConditionLeaf, MappingRule } from '../types';
import { buildAccountMap, DEFAULT_ACCOUNT_CODES } from './accounts';

/**
 * 시스템 기본 사전 (전 거래처 공통, origin 'system_default').
 *
 * - 매칭 대상은 주로 merchantKey(normalizeMerchantName 결과: 대문자·공백/특수문자·법인표기 제거)이므로
 *   키워드도 같은 형태(공백 없음, 대문자)로 적는다.
 * - 신뢰도는 90 이하. 사전은 "거래처 이력이 없을 때"의 기본값일 뿐이며 거래처별 이력·규칙이 항상 우선한다.
 * - 계정 매핑은 세무 실무 관행에 따른 기본값이다. 사무소 관행이 다르면 DB의 system_default 규칙(같은 id)으로
 *   덮어쓰거나 status 'disabled' 로 끈다. 관행이 갈리는 항목은 note 에 "검증필요"를 적었다.
 * - 정규식 대신 contains / starts_with / eq 만 써서 엔진의 키워드 사전필터가 적용되도록 한다(성능).
 */
export interface SystemDictionaryEntry {
  /** 안정 ID — DB system_default 규칙이 같은 id 로 덮어쓴다 */
  id: string;
  name: string;
  matcher: Condition;
  accountCode: string;
  /** 0~90 */
  confidence: number;
  /** 높을수록 먼저 평가 (구체적 키워드 > 일반 키워드 > 업종 텍스트) */
  priority: number;
  note: string;
}

export const SYSTEM_RULE_MAX_CONFIDENCE = 90;

const key = (...words: string[]): ConditionLeaf => ({ field: 'merchantKey', op: 'contains', value: words });
const keyStarts = (word: string): ConditionLeaf => ({ field: 'merchantKey', op: 'starts_with', value: word });
const keyEq = (word: string): ConditionLeaf => ({ field: 'merchantKey', op: 'eq', value: word });
const desc = (...words: string[]): ConditionLeaf => ({ field: 'description', op: 'contains', value: words });
const cat = (...words: string[]): ConditionLeaf => ({ field: 'merchantCategory', op: 'contains', value: words });
const any = (...conds: Condition[]): Condition => (conds.length === 1 ? conds[0]! : { any: conds });
const except = (cond: Condition, ...words: string[]): Condition => ({ all: [cond, { not: key(...words) }] });

/** 사전은 매입 거래 전용 */
const purchaseOnly = (cond: Condition): Condition => ({
  all: [{ field: 'direction', op: 'eq', value: 'purchase' }, cond],
});

const P_SPECIFIC = 300;
const P_NORMAL = 200;
const P_GENERIC = 100;
const P_CATEGORY = 50;

type RawEntry = Omit<SystemDictionaryEntry, 'matcher'> & { match: Condition };

const RAW: RawEntry[] = [
  // ── 통신비 814 ──
  {
    id: 'SYS-TEL-01',
    name: '통신사 (KT·SKT·LGU+)',
    match: any(
      except(any(keyStarts('KT'), keyStarts('케이티')), 'KTX', 'KTG', '케이티앤지'),
      keyStarts('SKT'),
      key('SK텔레콤', 'SKTELECOM', '에스케이텔레콤', 'SK브로드밴드', 'SKBROADBAND', '에스케이브로드밴드'),
      key('LG유플러스', 'LGU', '엘지유플러스', '유플러스', 'LG헬로비전', '헬로비전', '스카이라이프'),
      desc('통신요금', '전화요금', '인터넷요금', '휴대폰요금'),
    ),
    accountCode: '814',
    confidence: 88,
    priority: P_NORMAL,
    note: '통신사 요금. 단말기 할부대금이 포함되면 비품 여부 검토',
  },
  {
    id: 'SYS-TEL-02',
    name: '통신업 (업종)',
    match: cat('전기통신', '이동통신', '유선통신'),
    accountCode: '814',
    confidence: 70,
    priority: P_CATEGORY,
    note: '가맹점 업종 텍스트 기반',
  },
  // ── 수도광열비 815 ──
  {
    id: 'SYS-UTL-01',
    name: '한국전력 (전기요금)',
    match: any(key('한국전력'), keyEq('한전'), keyStarts('한전전기'), desc('전기요금', '전기료')),
    accountCode: '815',
    confidence: 88,
    priority: P_NORMAL,
    note: '제조업 등 전력비(816)를 따로 쓰는 사무소는 규칙으로 변경 (검증필요)',
  },
  {
    id: 'SYS-UTL-02',
    name: '도시가스',
    match: any(key('도시가스'), desc('가스요금', '도시가스')),
    accountCode: '815',
    confidence: 88,
    priority: P_NORMAL,
    note: '난방·취사용 가스',
  },
  {
    id: 'SYS-UTL-03',
    name: '수도요금',
    match: any(key('상수도', '수도사업', '수자원공사'), desc('수도요금', '상하수도')),
    accountCode: '815',
    confidence: 85,
    priority: P_NORMAL,
    note: '상하수도 요금',
  },
  // ── 지급수수료 831 ──
  {
    id: 'SYS-SAAS-01',
    name: 'Adobe·AWS·Google Workspace·Microsoft',
    match: any(
      key('ADOBE', '어도비', 'AMAZONWEBSERVICES', 'AWSAMAZON', 'GOOGLEWORKSPACE', 'GSUITE', 'GOOGLECLOUD'),
      key('MICROSOFT', 'MSFT', '마이크로소프트'),
      keyStarts('AWS'),
    ),
    accountCode: '831',
    confidence: 85,
    priority: P_NORMAL,
    note: '소프트웨어 구독료. 해외결제는 대리납부 검토 (통신비·소프트웨어로 처리하는 사무소도 있음)',
  },
  {
    id: 'SYS-SAAS-02',
    name: '협업·개발 SaaS',
    match: key('NOTION', 'SLACK', 'ZOOMUS', 'ZOOMVIDEO', 'DROPBOX', 'GITHUB', 'ATLASSIAN', 'FIGMA', 'CANVA', 'OPENAI', 'CHATGPT', 'ANTHROPIC', 'CLAUDEAI'),
    accountCode: '831',
    confidence: 80,
    priority: P_NORMAL,
    note: '소프트웨어 구독료',
  },
  {
    id: 'SYS-HOST-01',
    name: '호스팅·도메인',
    match: key('가비아', 'GABIA', '카페24', 'CAFE24', '후이즈', 'WHOIS', '호스팅', 'HOSTING'),
    accountCode: '831',
    confidence: 80,
    priority: P_SPECIFIC,
    note: '"카페24"가 카페(복리후생비)로 잡히지 않도록 우선 평가',
  },
  {
    id: 'SYS-FEE-01',
    name: '세무·법무·노무 전문가 보수',
    match: key('세무회계', '세무사', '회계법인', '회계사무소', '법무법인', '법무사', '노무법인', '노무사', '변리사', '특허법인', '감정평가'),
    accountCode: '831',
    confidence: 85,
    priority: P_NORMAL,
    note: '기장·신고대리·자문 수수료',
  },
  {
    id: 'SYS-FEE-02',
    name: '보안·경비',
    match: any(key('에스원', 'ADT캡스', 'ADTCAPS', '캡스', 'KT텔레캅', '텔레캅', '세콤', 'SECOM', 'SK쉴더스', 'SKSHIELDUS', '쉴더스'), keyEq('S1')),
    accountCode: '831',
    confidence: 85,
    priority: P_SPECIFIC,
    note: '"KT텔레캅"이 통신비로 잡히지 않도록 우선 평가',
  },
  {
    id: 'SYS-FEE-03',
    name: '금융·결제 수수료 (적요)',
    match: desc('이체수수료', '송금수수료', '카드연회비', '연회비', '수수료'),
    accountCode: '831',
    confidence: 70,
    priority: P_GENERIC,
    note: '통장 적요 기반',
  },
  // ── 소모품비 830 ──
  {
    id: 'SYS-SUP-01',
    name: '쿠팡',
    match: key('쿠팡', 'COUPANG'),
    accountCode: '830',
    confidence: 75,
    priority: P_NORMAL,
    note: '업종에 따라 상품(146)·원재료(153) 매입일 수 있음 — 거래처 이력이 항상 우선',
  },
  {
    id: 'SYS-SUP-02',
    name: '다이소',
    match: key('다이소', 'DAISO'),
    accountCode: '830',
    confidence: 85,
    priority: P_NORMAL,
    note: '생활·사무 소모품',
  },
  {
    id: 'SYS-SUP-03',
    name: '문구·사무용품점',
    match: key('오피스디포', 'OFFICEDEPOT', '알파문구', '모닝글로리', '오피스넥스', '오피스플러스', '문구'),
    accountCode: '830',
    confidence: 75,
    priority: P_NORMAL,
    note: '사무용품비(829)를 따로 쓰는 사무소는 규칙으로 변경 (검증필요)',
  },
  {
    id: 'SYS-SUP-04',
    name: '대형마트',
    match: key('이마트', 'EMART', '홈플러스', 'HOMEPLUS', '롯데마트', 'LOTTEMART', '코스트코', 'COSTCO', '하나로마트', '트레이더스', '노브랜드'),
    accountCode: '830',
    confidence: 60,
    priority: P_GENERIC,
    note: '개인 생활용품 구입 가능성 — 반드시 확인',
  },
  {
    id: 'SYS-SUP-05',
    name: '가전양판점',
    match: key('하이마트', '전자랜드', '일렉트로마트'),
    accountCode: '830',
    confidence: 55,
    priority: P_GENERIC,
    note: '거래단위 100만원 초과 시 비품(212) 등 자산 검토',
  },
  // ── 복리후생비 811 ──
  {
    id: 'SYS-MEAL-01',
    name: '배달앱',
    match: key('쿠팡이츠', 'COUPANGEATS', '배달의민족', '배민', '우아한형제들', '요기요', '위대한상상'),
    accountCode: '811',
    confidence: 75,
    priority: P_SPECIFIC,
    note: '직원 식대. "쿠팡"(소모품비)보다 우선 평가. 접대 목적이면 접대비(813)',
  },
  {
    id: 'SYS-CAFE-01',
    name: '커피전문점',
    match: key('스타벅스', 'STARBUCKS', '투썸', '이디야', 'EDIYA', '메가커피', '메가MGC', 'MGC커피', '빽다방', '커피빈', 'COFFEEBEAN', '할리스', 'HOLLYS', '폴바셋', '컴포즈커피', '파스쿠찌', '엔제리너스', '탐앤탐스', '커피'),
    accountCode: '811',
    confidence: 80,
    priority: P_NORMAL,
    note: '직원 음료. 거래처 접대 목적이면 접대비(813)',
  },
  {
    id: 'SYS-CAFE-02',
    name: '카페 (일반)',
    match: key('카페', 'CAFE'),
    accountCode: '811',
    confidence: 70,
    priority: P_GENERIC,
    note: '접대 목적이면 접대비(813)',
  },
  {
    id: 'SYS-CVS-01',
    name: '편의점',
    match: any(key('GS25', '지에스25', '세븐일레븐', '7ELEVEN', '미니스톱', '이마트24', 'EMART24', 'BGF리테일'), keyStarts('씨유')),
    accountCode: '811',
    confidence: 60,
    priority: P_NORMAL,
    note: '음료·간식은 복리후생비, 생활용품은 소모품비 — 확인 필요',
  },
  {
    id: 'SYS-MEAL-02',
    name: '음식점 (일반)',
    match: any(
      cat('음식', '한식', '중식', '일식', '양식', '분식', '식당', '제과', '치킨', '피자', '패스트푸드', '뷔페'),
      key('식당', '김밥', '분식', '국밥', '치킨', '피자', '반점', '가든', '칼국수', '냉면', '갈비', '삼겹', '횟집', '초밥', '돈까스', '버거', '맥도날드', '롯데리아', '맘스터치', '교촌', '파리바게뜨', '뚜레쥬르', '베이커리', '떡볶이'),
    ),
    accountCode: '811',
    confidence: 60,
    priority: P_CATEGORY,
    note: '직원 식대 기본값(낮은 신뢰도). 거래처 접대 목적이면 접대비(813) — 반드시 확인',
  },
  // ── 차량유지비 822 ──
  {
    id: 'SYS-CAR-01',
    name: '주유소·충전소',
    match: any(
      key('주유소', 'GS칼텍스', 'GSCALTEX', 'SK에너지', 'SKENERGY', '에스케이에너지', 'SOIL', '에쓰오일', '에스오일', '오일뱅크', 'OILBANK', '알뜰주유', '충전소', 'LPG'),
      cat('주유', '충전소'),
    ),
    accountCode: '822',
    confidence: 85,
    priority: P_NORMAL,
    note: '비영업용 소형승용차면 부가세 불공제(부가세 엔진 판단)',
  },
  {
    id: 'SYS-CAR-02',
    name: '통행료·하이패스',
    match: any(key('한국도로공사', '하이패스', 'HIPASS', '통행료'), desc('통행료', '하이패스')),
    accountCode: '822',
    confidence: 75,
    priority: P_NORMAL,
    note: '여비교통비(812)로 처리하는 사무소도 있음 (검증필요)',
  },
  {
    id: 'SYS-CAR-03',
    name: '주차·세차·정비',
    match: key('주차', 'PARKING', '세차', '카센터', '타이어', '오토큐', '스피드메이트', '블루핸즈', '자동차정비'),
    accountCode: '822',
    confidence: 70,
    priority: P_GENERIC,
    note: '업무용 차량 관련 여부 확인',
  },
  // ── 여비교통비 812 ──
  {
    id: 'SYS-TRV-01',
    name: '택시·카카오T',
    match: any(key('택시', 'TAXI', '카카오T', 'KAKAOT', '카카오모빌리티'), cat('택시')),
    accountCode: '812',
    confidence: 85,
    priority: P_NORMAL,
    note: '택시비는 매입세액 불공제(부가세 엔진 판단)',
  },
  {
    id: 'SYS-TRV-02',
    name: '철도·버스·항공',
    match: any(
      key('KTX', '코레일', 'KORAIL', '한국철도', 'SRT', '고속버스', '시외버스', '버스터미널', '티머니', 'TMONEY', '캐시비'),
      key('대한항공', 'KOREANAIR', '아시아나', 'ASIANA', '제주항공', '진에어', '티웨이', '에어부산', '에어서울', '이스타항공'),
      keyEq('에스알'),
    ),
    accountCode: '812',
    confidence: 88,
    priority: P_SPECIFIC,
    note: '"KTX"가 통신사(KT)로 잡히지 않도록 우선 평가. 여객운송은 매입세액 불공제',
  },
  {
    id: 'SYS-TRV-03',
    name: '숙박',
    match: any(key('호텔', 'HOTEL', '모텔', '리조트', 'RESORT', '게스트하우스', '여기어때', '야놀자', 'AGODA', 'BOOKINGCOM', '에어비앤비', 'AIRBNB'), cat('숙박')),
    accountCode: '812',
    confidence: 70,
    priority: P_GENERIC,
    note: '출장 숙박 기본값 — 개인 여행 여부 확인',
  },
  // ── 운반비 824 ──
  {
    id: 'SYS-SHIP-01',
    name: '우체국·택배사',
    match: key('우체국', '우정사업본부', 'CJ대한통운', '대한통운', '한진택배', '롯데택배', '롯데글로벌로지스', '로젠택배', '경동택배', 'GS포스트박스'),
    accountCode: '824',
    confidence: 85,
    priority: P_NORMAL,
    note: '택배·우편 발송비',
  },
  {
    id: 'SYS-SHIP-02',
    name: '퀵·용달·화물 (일반)',
    match: key('택배', '퀵서비스', '용달', '화물'),
    accountCode: '824',
    confidence: 75,
    priority: P_GENERIC,
    note: '운송 대가',
  },
  // ── 도서인쇄비 826 ──
  {
    id: 'SYS-BOOK-01',
    name: '서점',
    match: key('교보문고', 'YES24', '예스24', '알라딘', 'ALADIN', '영풍문고', '반디앤루니스', '서점', '문고'),
    accountCode: '826',
    confidence: 85,
    priority: P_NORMAL,
    note: '도서 구입',
  },
  {
    id: 'SYS-BOOK-02',
    name: '인쇄·복사·신문',
    match: key('인쇄', '복사', '킨코스', 'KINKOS', '신문', '일보'),
    accountCode: '826',
    confidence: 70,
    priority: P_GENERIC,
    note: '인쇄물·구독료. 홍보물 인쇄는 광고선전비(833)',
  },
  // ── 광고선전비 833 ──
  {
    id: 'SYS-AD-01',
    name: '온라인 광고 (네이버·구글·메타 등)',
    match: any(
      key('네이버광고', '네이버검색광고', 'NAVERAD', '검색광고', 'GOOGLEADS', 'GOOGLEADWORDS', '구글광고'),
      key('FACEBK', 'FACEBOOK', 'INSTAGRAM', 'METAPLATFORM', '메타플랫폼', '카카오모먼트', 'KAKAOMOMENT', '당근마켓광고', '당근비즈', 'TIKTOKADS'),
      keyEq('메타'),
      desc('광고비', '검색광고'),
    ),
    accountCode: '833',
    confidence: 88,
    priority: P_SPECIFIC,
    note: '광고비 충전·집행. 해외결제는 대리납부 검토',
  },
  {
    id: 'SYS-AD-02',
    name: '광고·현수막 (일반)',
    match: key('광고', '현수막', '전단지', '배너'),
    accountCode: '833',
    confidence: 70,
    priority: P_GENERIC,
    note: '광고 대행·인쇄 홍보물',
  },
  // ── 세금과공과 817 ──
  {
    id: 'SYS-TAX-01',
    name: '4대보험 공단',
    match: any(
      key('국민건강보험', '건강보험공단', '국민연금', '근로복지공단', '고용보험', '산재보험', '4대보험', '사회보험'),
      desc('건강보험', '국민연금', '고용보험', '산재보험', '4대보험'),
    ),
    accountCode: '817',
    confidence: 75,
    priority: P_NORMAL,
    note: '근로자 부담분은 예수금(254). 사업자 부담분은 사무소 관행(건강보험→복리후생비, 고용·산재→보험료)에 따라 다름 — 검증필요',
  },
  {
    id: 'SYS-TAX-02',
    name: '국세·지방세·공과금',
    match: any(
      key('국세청', '세무서', '국세', '지방세', '위택스', 'WETAX', '구청', '시청', '군청', '국고'),
      desc('국세', '지방세', '자동차세', '재산세', '주민세', '면허세', '인지세', '과태료'),
    ),
    accountCode: '817',
    confidence: 70,
    priority: P_NORMAL,
    note: '부가세·원천세·법인세·종합소득세 납부는 817이 아님(미지급세금·예수금·법인세등·인출금) — 반드시 확인',
  },
  // ── 보험료 821 ──
  {
    id: 'SYS-INS-01',
    name: '손해보험사',
    match: key('화재해상', '손해보험', '해상보험', '삼성화재', '현대해상', 'DB손해', 'DB손보', 'KB손해', '메리츠화재', '한화손해', '흥국화재', '롯데손해', '악사손해', '캐롯손해', '하나손해', 'MG손해', '화재보험', '자동차보험'),
    accountCode: '821',
    confidence: 80,
    priority: P_NORMAL,
    note: '저축성 보험은 자산 처리 — 확인',
  },
  {
    id: 'SYS-INS-02',
    name: '생명보험사',
    match: key('생명보험', '생명'),
    accountCode: '821',
    confidence: 55,
    priority: P_GENERIC,
    note: '대표자 개인 보험 가능성 — 반드시 확인',
  },
  // ── 지급임차료 819 / 건물관리비 837 ──
  {
    id: 'SYS-RENT-01',
    name: '렌탈 (정수기·비데 등)',
    match: key('코웨이', 'COWAY', '청호나이스', 'SK매직', '쿠쿠홈시스', '교원웰스', '렌탈'),
    accountCode: '819',
    confidence: 70,
    priority: P_NORMAL,
    note: '렌탈료. 지급수수료(831)로 처리하는 사무소도 있음 (검증필요)',
  },
  {
    id: 'SYS-RENT-02',
    name: '임대료·월세 (적요)',
    match: desc('임대료', '월세', '임차료'),
    accountCode: '819',
    confidence: 70,
    priority: P_GENERIC,
    note: '사업장 임차료. 보증금은 임차보증금(962)',
  },
  {
    id: 'SYS-RENT-03',
    name: '관리비',
    match: any(key('관리사무소', '관리단', '관리소'), desc('관리비')),
    accountCode: '837',
    confidence: 70,
    priority: P_GENERIC,
    note: '사업장 건물 관리비',
  },
  // ── 교육훈련비 825 ──
  {
    id: 'SYS-EDU-01',
    name: '교육·연수',
    match: key('휴넷', '멀티캠퍼스', '패스트캠퍼스', 'FASTCAMPUS', '인프런', 'INFLEARN', '클래스101', 'CLASS101', 'UDEMY', '유데미', '교육원', '연수원', '직업전문학교'),
    accountCode: '825',
    confidence: 75,
    priority: P_NORMAL,
    note: '직원 교육. 대표자·가족 개인 교육비는 인출금',
  },
  // ── 접대비 813 ──
  {
    id: 'SYS-ENT-01',
    name: '꽃집·화환 (경조사)',
    match: key('꽃집', '플라워', 'FLOWER', '화원', '화환', '근조'),
    accountCode: '813',
    confidence: 70,
    priority: P_NORMAL,
    note: '거래처 경조사 기본값. 직원 경조사면 복리후생비(811)',
  },
  {
    id: 'SYS-ENT-02',
    name: '골프장',
    match: key('골프', 'GOLF', '컨트리클럽'),
    accountCode: '813',
    confidence: 55,
    priority: P_NORMAL,
    note: '접대·개인사용 여부 반드시 확인',
  },
];

export const SYSTEM_DICTIONARY: readonly SystemDictionaryEntry[] = Object.freeze(
  RAW.map(({ match, ...rest }) => ({
    ...rest,
    confidence: Math.min(rest.confidence, SYSTEM_RULE_MAX_CONFIDENCE),
    matcher: purchaseOnly(match),
  })),
);

/**
 * 사전을 MappingRule(system_default, 전 거래처 공통)로 변환한다.
 * 시드(packages/seed)가 DB에 넣을 때와 엔진이 DB 규칙이 없을 때 내장 기본값으로 쓸 때 모두 사용.
 */
export function systemDictionaryRules(
  accounts: readonly AccountCode[] | ReadonlyMap<string, AccountCode> = DEFAULT_ACCOUNT_CODES,
): MappingRule[] {
  const map = accounts instanceof Map ? accounts : buildAccountMap(accounts as readonly AccountCode[]);
  const fallback = buildAccountMap(DEFAULT_ACCOUNT_CODES);
  return SYSTEM_DICTIONARY.map((e) => ({
    id: e.id,
    clientId: null,
    name: e.name,
    condition: e.matcher,
    accountCode: e.accountCode,
    accountName: map.get(e.accountCode)?.name ?? fallback.get(e.accountCode)?.name ?? e.accountCode,
    vatOverride: null,
    confidence: e.confidence,
    priority: e.priority,
    status: 'active',
    origin: 'system_default',
  }));
}

/** id → 사전 항목 (설명 패널의 note 표시용) */
export const SYSTEM_DICTIONARY_BY_ID: ReadonlyMap<string, SystemDictionaryEntry> = new Map(
  SYSTEM_DICTIONARY.map((e) => [e.id, e]),
);
