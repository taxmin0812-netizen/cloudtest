# 01. WEHAGO(더존비즈온) 연동 리서치

- 작성일: 2026-09-26
- 대상: MIN TAX OPS (위멤버스 → MIN TAX OPS → WEHAGO/WEHAGO T)
- 조사 범위: (a) 전표 등록 API 존재 여부·접근 조건, (b) 일반전표/매입매출전표 엑셀 업로드 형식·유형코드·계정과목·거래처코드, (c) 급여/사업소득/일용직 엑셀 업로드

## 0. 조사 방법과 한계 (먼저 읽을 것)

- 이번 조사 환경에서는 **WebFetch(본문 직접 열람)가 모든 핵심 도메인에서 차단**되었다(egress proxy가 `wehagohelp.zendesk.com`, `wehagothelp.zendesk.com`, `www.douzone.com`, `www.wehago.com`, `wu.wehago.com`, `douzoneon.com`, `newzensolution.co.kr`, 블로그·카페 등을 막았다). `developer.wehago.com`은 DNS 조회에 실패했다(`ENOTFOUND`).
- 따라서 아래 "확인된 사실"은 **검색엔진이 해당 URL에서 뽑아 보여 준 발췌·요약(snippet)** 에 근거한다. 공식 도움말 URL에 붙은 발췌라도 본문 전체를 열어 본 것은 아니다. 검색 요약기는 질의어를 되풀이하는 경향이 있어서, **질의어에 넣지 않았는데도 발췌에 나온 내용만 신뢰도 높음으로 표시**했다.
- 신뢰도 표기:
  - **[공식]**: 더존/WEHAGO 공식 도메인(고객센터 zendesk, douzone.com, wehago.com)의 발췌에서 확인
  - **[커뮤니티]**: 제3자 벤더 문서, 블로그, 카페, AI Q&A 사이트, 수험용 프로그램(KcLep) 관례에서 확인
  - **[추론]**: 위 사실을 바탕으로 한 작성자 추론
  - **미확인(UNVERIFIED)**: 근거를 찾지 못했거나 근거가 약함

---

## 1. 요약

1. **WEHAGO에 공개된 "전표 등록 API"는 확인되지 않았다 (미확인).** 공식 도움말·제품 페이지에서 외부 시스템이 전표를 POST하는 Open API 문서를 찾지 못했다. `developer.wehago.com/api`라는 URL은 검색에 잡히지만 접속(DNS)이 되지 않았다. 더존 Open API가 언급되는 것은 **Amaranth 10(대기업용 ERP)** 쪽이며, 커뮤니티에 따르면 계약 옵션으로 기능별 유상 제공된다. 스팬딧·고위드 같은 비용관리 SaaS도 WEHAGO와는 **엑셀 업로드 양식**으로 연동한다. → **전표 반영은 FILE BASED가 현실적인 주 경로다.**
2. **일반전표 엑셀 업로드 [공식]**: "지정된 양식 없음". 업로드할 때 엑셀 제목줄을 선택하고, 엑셀 열과 데이터 항목을 숫자키로 매칭한다. 필수 매칭 항목은 **월 / 일 / 구분 / 계정과목코드 / 계정과목명 / 차변(출금) / 대변(입금)** 이다.
3. **매입매출전표 [공식]**: "더보기 > 엑셀서식 내려받기 → 작성 → 엑셀서식 불러오기" 방식이다. 거래처코드는 반드시 입력해야 한다. 상단(유형·공급가액·세액 등)은 부가세 신고서류에, 하단(분개)은 재무회계에 반영된다. **엑셀서식의 정확한 열 이름·순서는 공개 문서로 확인하지 못했다(미확인).** 실제 WEHAGO 계정에서 서식을 내려받아 확정해야 한다.
4. **매입매출 유형코드 [공식, 스니펫]**:
   - 매출: 11 과세 ~ 24 현영
   - 매입: 51 과세 ~ 62 현면 (54 불공 선택 시 불공제사유 팝업)
   - 분개유형: 0 분개없음 / 1 현금 / 2 외상 / 3 혼합 / 4 카드 / 5~7 외상추가
   - 일반전표 구분: 1 출금 / 2 입금 / 3 차변 / 4 대변 / 5 결차 / 6 결대
5. **계정과목 코드 체계 [공식]**: 3자리(세목 미사용) 또는 5자리(세목 사용, 세목 99개까지)이고 **회사마다 설정·추가·수정할 수 있다.**
   - `135 부가세대급금`: 공식 발췌에서 확인
   - `811 복리후생비`, `813 접대비`, `830 소모품비`, `831 지급수수료` 등 800번대 판관비 코드: 커뮤니티·수험용 관례 수준으로만 확인. **하드코딩하지 말고 수임처별로 계정과목표를 수집해야 한다.**
   - `접대비`는 2024-01-01부터 `접대비(기업업무추진비)`로 이름이 바뀌었다 [공식].
6. **거래처코드 [공식]**: 자리수를 6~10자리로 설정할 수 있다. 일반/금융/카드 탭으로 나뉜다. 자동전표처리에서 등록되지 않은 사업자번호가 나오면 코드를 자동 채번해 거래처로 등록한다.
7. **자동전표처리 [공식]**: WEHAGO T는 홈택스에서 전자(세금)계산서·카드·현금영수증을 자체 수집하고, 통장은 T edge와 연동한다. **중복전표 판정 기준은 "일자, 사업자번호, 금액, 과세유형"** 이다. 위멤버스 자료를 그대로 밀어 넣으면 이중 기장될 위험이 크다.
8. **급여 [공식/커뮤니티]**:
   - 사원등록, 급여자료입력, 사업소득자등록, 일용직사원등록에 "엑셀서식 내려받기/불러오기"가 있다.
   - 급여자료입력 엑셀업로드는 1줄/2줄 서식이 있다(영상 제목 기준).
   - 주민번호·전화번호는 숫자만 입력하고, 첫 행 샘플은 반영되지 않는다.
   - 각 서식의 열 구성은 미확인이다.

---

## 2. 확인된 사실 (출처)

### 2.1 제품 구분

| 제품 | 설명 | 근거 |
|---|---|---|
| WEHAGO | 더존 클라우드 비즈니스 플랫폼. 회계 모듈 이름은 **Smart A 10** | [공식] https://wehagohelp.zendesk.com/hc/ko/sections/7320295288089 (Smart A 10 회계관리 섹션) |
| WEHAGO T | 세무회계사무소용. 수임처관리, 기장업무, 자동전표처리, 증빙전표입력, 수임처 급여관리 | [공식] https://wehagothelp.zendesk.com/hc/ko/articles/360000309481 , https://wehagothelp.zendesk.com/hc/ko/articles/4413975033113 |
| WEHAGO T edge | 수임처(고객사)용. 증빙/영수증 전송, 통장정리 메모 | [공식] https://wehagothelp.zendesk.com/hc/ko/articles/360000309402 , https://wehagothelp.zendesk.com/hc/ko/articles/360000309422 |
| Smart A (설치형) | 기존 PC용 회계프로그램. 백업 데이터를 WEHAGO로 올릴 수 있음 | [공식] https://wehagohelp.zendesk.com/hc/ko/articles/900000198446 |
| Amaranth 10 | 중견·대기업용 ERP/그룹웨어. Open API 이야기가 나오는 제품은 이쪽 | [커뮤니티] https://www.sharedit.co.kr/qnaboards/27429 |

### 2.2 (a) 전표 등록 API / 파트너 접근 조건

- **공개 전표 API 문서: 찾지 못함 → 미확인(UNVERIFIED).**
  - 검색엔진에 `https://developer.wehago.com/api`(제목 "WEHAGO")가 잡히지만, 2026-09-26 이 환경에서 DNS 해석에 실패해 내용을 볼 수 없었다.
  - WEHAGO 고객센터(일반/T/T edge) 검색에서도 "전표 API", "Open API" 관련 문서는 나오지 않았다.
- **Amaranth 10 Open API [커뮤니티]**: 외부 연동용 오픈 API가 있지만 계약 옵션·버전·설정에 따라 다르다. "기능 하나당 500만원 정도"라는 사용자 증언이 있다. 모두 WEHAGO가 아닌 Amaranth 10 이야기다.
  - https://www.sharedit.co.kr/qnaboards/27429
- **제3자 SaaS의 WEHAGO 연동 방식 [커뮤니티/벤더 문서]**:
  - **스팬딧**: 내보내기 양식에 "더존 Smart A", "더존 Wehago"가 있다. "더존 회계프로그램 WEHAGO에 업로드할 수 있는 엑셀 양식"이며 "부가세 신고 양식 - 매입 전표 메뉴를 통하여 내역을 업로드"한다고 설명한다. 이 회사는 ERP 연동을 API 직접 연동 / 맞춤 엑셀 템플릿 / 기본 양식 다운로드 세 가지로 나눈다.
    - https://docs.spendit.kr/ko/articles/1107959 , https://docs.spendit.kr/ko/articles/669327 , https://www.spendit.kr/blog/더존-erp-종류와-스팬딧-연동-방식-구분-57905
  - **고위드**: "더존i-CUBE 간소화 양식 자동화, 더존-WEHAGO 업로드 양식 자동화, 더존 AMARANTH 업로드 자동화"를 제공한다. 양식 생성에는 용도별 불공제 여부와 계정코드 설정이 필수이고, "관리번호"는 더존에서 카드별 거래처코드를 매칭하는 번호다.
    - https://docs.channel.io/gowid-guide/ko/articles/회계-ERP-설정-9af43573 , https://gowid-help.oopy.io/ca356845-0a4e-4026-b3e0-e424a00eaafe
- **더존의 개방 행보 [공식 뉴스/파트너 사이트]**:
  - OmniEsol 출시에 맞춘 "비즈니스 파트너" 공개 모집: https://www.douzone.com/media/media_room_read.jsp?id=2538&page=3
  - AI 에이전트 마켓플레이스 공개. ONE AI CUBE가 WEHAGO 서비스와 금융·물류·커머스 API를 연계한다: https://www.douzone.site/post/douzonenews20251001
  - 두 발표 모두 외부 개발자가 WEHAGO에 전표를 쓰는 API를 공개한다는 내용은 아니다 [추론].
- **WEHAGO T가 데이터를 받아들이는 공식 경로 [공식]**:
  - 홈택스 자동 수집: 세무대리인 인증서 등록 후 수임처 자료를 조회·수집한다.
    - https://wehagothelp.zendesk.com/hc/ko/articles/360000309701 , https://wehagothelp.zendesk.com/hc/ko/articles/360000309502
  - 수임처 T edge 증빙 전송 → 증빙전표입력 → [전표반영]: https://wehagothelp.zendesk.com/hc/ko/articles/360000309402
  - **S마이그레이션**: 세무사랑 전표·거래처 데이터를 WEHAGO T로 자동 업로드한다.
    - https://wehagothelp.zendesk.com/hc/ko/articles/900000598863 , 기사 https://www.taxtimes.co.kr/news/article.html?no=242121
  - Smart A 회계데이터(백업) 업로드: https://wehagothelp.zendesk.com/hc/ko/articles/900005325786
  - 백업 파일 형식 `sdb`, `whg`, `nsz`가 언급된다: https://wehagothelp.zendesk.com/hc/ko/articles/20360091660441
- **"더존 파트너"의 의미 [커뮤니티/추론]**: 검색에 나온 "더존 비즈니스파트너"(다인정보 `douzone.ldad.co.kr`, 더존지니어스, 비아이 등)는 **판매·교육 대리점**이다. API 파트너 프로그램이 공개되어 있다는 근거는 찾지 못했다.

### 2.3 (b-1) 일반전표 엑셀 업로드

- [공식] 사용자가 작성한 엑셀파일을 [일반전표입력] 메뉴로 업로드하는 기능이다. **지정된 양식은 없다.** 업로드할 때 양식 설정 기능으로 엑셀제목과 데이터 제목을 매칭한다.
  - 절차: 엑셀 열기 → 제목줄로 쓸 라인 클릭 → 엑셀제목 설정 → 엑셀제목과 데이터 제목의 항목을 **키보드 숫자키로 매칭**
  - **필수 매칭 항목: 월, 일, 구분, 계정과목코드, 계정과목명, 차변(출금), 대변(입금)**
  - 출처: https://wehagohelp.zendesk.com/hc/ko/articles/7362165430553 (일반전표입력)
  - 같은 절차가 통장 엑셀 업로드 문서에도 나온다: https://wehagothelp.zendesk.com/hc/ko/articles/360000339242
- [공식] 구분 코드: 현금전표(**1.출금, 2.입금**), 대체전표(**3.차변, 4.대변**), 결산전표(**5.결차, 6.결대**).
  - 출처: 일반전표입력 / 통장 엑셀 업로드 문서 발췌 (위 URL)
- [공식, 출처 문서 특정 불가] "거래처코드를 입력하지 않을 경우 거래처명만 반영되며, 거래처 기준은 [거래처등록]의 거래처코드 및 거래처명으로 업로드됩니다."
  - WEHAGO 도메인 한정 검색 결과였으나 어느 문서 발췌인지 특정하지 못했다. 일반전표입력 문서로 추정한다.
- [공식] 통장 엑셀 업로드 후 적요는 하단 분개 적요에도 똑같이 적용되고, 일괄 반영 기능으로 바꿀 수 있다.
  - https://wehagothelp.zendesk.com/hc/ko/articles/360000339242 , https://wehagohelp.zendesk.com/hc/ko/articles/900001793866

### 2.4 (b-2) 매입매출전표 입력 구조와 엑셀 업로드

- [공식] 매입매출전표입력은 부가세 신고와 관련된 매입매출 거래를 입력하는 메뉴다.
  - **상단**(유형·거래처·공급가액·세액 등)은 부가가치세신고서, 세금계산서합계표, 매입매출장에 반영된다.
  - **하단 분개**는 계정별원장, 재무제표에 반영된다.
  - 출처: https://wehagohelp.zendesk.com/hc/ko/articles/7362360128665 , https://wehagothelp.zendesk.com/hc/ko/articles/7870004069017
- [공식] "매입매출전표를 입력할 때에는 **거래처코드를 반드시 입력**해야합니다."
- [공식] 품명·수량·단가 등이 2개 이상이면 복수 품목으로 입력하며, **99개까지** 입력할 수 있다.
- [공식] 엑셀 서식 절차: 우측 상단 **더보기 > '엑셀서식 내려받기'** → 작성 → **더보기 > '엑셀서식 불러오기'**. 검색엔진이 이 절차를 매입매출전표 엑셀 업로드 질의에 대한 답으로 보여 주었지만, 같은 문구가 급여 문서에도 나오므로 메뉴별로 공통 UI일 수 있다.
- [커뮤니티, 벤더 블로그] Smart A 10(WEHAGO) 경로: "전표관리 > 자동전표처리 > 매입매출전표입력 → 우측 상단 주사위(4점) 버튼 → 엑셀자료반영 → 엑셀서식 내려받기 → 작성 → 업로드"
  - 출처(더존 비즈니스파트너 다인정보 블로그): https://douzone.ldad.co.kr/89 . WEHAGO 공식 카카오 채널 소식도 참고: https://pf.kakao.com/_SQxkzK/108846740
- [커뮤니티] 설치형 Smart A 경로: "회계 > 매입매출전표입력 > 기능모음(F11) > 엑셀 올리기(Ctrl+U) > 엑셀자료 반영 → 전표전송". 엑셀로 올린 전표는 우측 상단에 '엑셀 업로드'로 구분된다(검색 발췌. 출처는 스팬딧 도움말로 추정).
- [공식] 매입매출장 결과는 엑셀로 변환(export)할 수 있다: https://wehagothelp.zendesk.com/hc/ko/articles/360000666002
  - 변환 항목(발췌): 일자, 거래처, 유형, 품명, 공급가액, 부가세, 합계, 차변계정, 대변계정, 관리, 전표상태
  - **이것은 export 항목이지 import 서식이 아니다.**
- [공식] 매입매출전표입력에서 거래처·계정과목을 일괄 변경할 수 있다: https://wehagothelp.zendesk.com/hc/ko/articles/900000185906
- **미확인(UNVERIFIED)**: 매입매출 **엑셀 업로드 서식의 열 이름, 순서, 필수 여부, 유형 입력 방식**(코드 "57"인지 "카과"인지)

### 2.5 매입매출 유형 코드표 (더존 WEHAGO/Smart A 계열)

출처는 모두 [공식] WEHAGO/WEHAGO T 고객센터 발췌다.
- (3) 증빙전표입력: https://wehagothelp.zendesk.com/hc/ko/articles/360000309402
- 매입매출전표입력: https://wehagohelp.zendesk.com/hc/ko/articles/7362360128665 , https://wehagothelp.zendesk.com/hc/ko/articles/7870004069017

"확인" 열의 뜻:
- **◎**: 질의어에 넣지 않았는데 발췌에 나오거나, 증빙전표입력 문서에 전체 목록이 나와서 확인한 코드
- **○**: 질의어와 겹쳐 발췌가 확인됐거나, 설명 문장이 일부만 발췌된 코드

**매출 (11~24)**

| 코드 | 약칭 | 의미(요지) | 확인 |
|---|---|---|---|
| 11 | 과세 | 세금계산서 발행분 (전자세금계산서 발행 가능 유형) | ◎ |
| 12 | 영세 | 영세율 세금계산서 (내국신용장·구매확인서 등) | ◎ |
| 13 | 면세 | 계산서 (면세) | ◎ |
| 14 | 건별 | 증빙 없는(무증빙) 과세 매출 | ◎ |
| 15 | 간이 | 간이과세 관련 | ○ |
| 16 | 수출 | 직수출 등 영세 (영수증 등) | ○ |
| 17 | 카과 | 신용카드 과세 매출 | ◎ |
| 18 | 카면 | 신용카드 면세 매출 | ○ |
| 19 | 카영 | 신용카드 영세 매출 | ○ |
| 20 | 면건 | 무증빙 면세 매출 | ○ |
| 21 | 전자 | 전자적 결제수단 매출 | ○ |
| 22 | 현과 | 현금영수증 과세 매출 (공급가액+세액) | ◎ |
| 23 | 현면 | 현금영수증 면세 매출 (세액 0) | ◎ |
| 24 | 현영 | 현금영수증 영세 매출 (세액 0) | ◎ |

**매입 (51~62)**. 증빙전표입력 문서 발췌에 51~62 전체 목록이 있다.

| 코드 | 약칭 | 의미(요지) |
|---|---|---|
| 51 | 과세 | 세금계산서 수취 과세 매입 (공제) |
| 52 | 영세 | 영세율 세금계산서 수취 |
| 53 | 면세 | 계산서 수취 |
| 54 | 불공 | 매입세액 불공제. 51→54로 바꾸면 **불공제사유 선택 팝업**이 뜨고, 공제받지못할매입세액명세서에 반영된다 |
| 55 | 수입 | 세관장 발행 수입세금계산서 |
| 56 | 금전 | 금전등록기 영수증 등 (의미는 [추론]) |
| 57 | 카과 | 신용카드 과세 매입 (공제) |
| 58 | 카면 | 신용카드 면세 매입 |
| 59 | 카영 | 신용카드 영세 매입 |
| 60 | 면건 | 무증빙 면세 매입 |
| 61 | 현과 | 현금영수증 과세 매입 (공제) |
| 62 | 현면 | 현금영수증 면세 매입 |

- [공식] 54 불공 관련 발췌 (공제받지못할매입세액명세서 https://wehagohelp.zendesk.com/hc/ko/articles/7468973692697 , 신용카드 https://wehagohelp.zendesk.com/hc/ko/articles/7424025254169):
  - 차량유지 계정을 "예"로 설정하면 [54.불공, 불공제사유 3. 비영업용 소형승용자동차 구입·유지 및 임차]로 수집된다.
  - 접대비 계정은 설정값과 관계없이 [54.불공]으로 수집된다.
  - 51→54로 바꾸면 하단 분개의 [135.부가세대급금] 금액은 금액이 큰 계정과목에 합산된다. 54→51로 바꾸면 부가세대급금이 자동 생성된다.
- 불공제사유 번호표(1~n) 전체: **미확인**. 위 발췌에서 확인된 것은 "3. 비영업용 소형승용자동차 구입·유지 및 임차"뿐이다.

### 2.6 분개유형 / 구분 코드

- [공식] 매입매출전표 분개유형(WEHAGO T 증빙전표입력·매입매출전표입력 발췌): **0.분개없음, 1.현금, 2.외상, 3.혼합, 4.카드, 5.외상추가, 6.외상추가2, 7.외상추가3**
  - '2.외상'을 선택하면 외상매출금 또는 외상매입금으로 자동분개되며, 이 계정은 바꿀 수 없다. 바꾸려면 '3.혼합'을 선택해야 한다.
  - 기본계정은 [분개계정과목설정]에서 설정한다.
- [공식] 일반전표 구분: 1.출금, 2.입금, 3.차변, 4.대변, 5.결차, 6.결대 (2.3 참고)

### 2.7 계정과목 코드 체계

- [공식] [환경설정] > [공통] 탭 > [계정과목코드체계]에서 **'0.세목미사용(3자리)' 또는 '1.세목사용(5자리)'** 를 고른다. 세목을 사용하면 계정 아래에 세목을 **99개까지** 등록할 수 있다.
  - https://wehagohelp.zendesk.com/hc/ko/articles/7349070228249 (환경설정), https://wehagohelp.zendesk.com/hc/ko/articles/7310815438873 (계정과목 및 적요등록)
- [공식] 계정과목 및 적요등록은 장부 관리에 필요한 기본 계정코드를 제공한다. 사용자는 코드체계 범위 안에서 계정을 추가할 수 있고, [계정과목명 수정] 버튼으로 이름을 고칠 수 있다(검은색 계정). 모든 재무제표는 계정코드를 기준으로 만들어진다.
- [공식] **2024-01-01부터 [접대비 → 접대비(기업업무추진비)]로 계정과목이 바뀌었다.** 바꾸는 방법은 [전년도 계정과목 불러오기] 또는 [접대비 일괄변경] 기능키다.
  - https://wehagohelp.zendesk.com/hc/ko/articles/26952918009369
- [공식] WEHAGO T 손익계산서항목검토: 접대비 계정은 카드계정 선택 기준을 쓰지 않으므로, 3만원 이하 금액이 '3만원 이하'란이 아니라 '기타'란에 반영된다.
  - https://wehagothelp.zendesk.com/hc/ko/articles/59039608290713

**표준 계정코드 (검증 수준 표기)**. 이 표는 "더존 기본값일 가능성이 높은 값"이다. **수임처마다 다를 수 있으므로 매핑의 최종 근거로 쓰면 안 된다.**

| 코드 | 계정 | 검증 수준 | 근거 |
|---|---|---|---|
| 101 | 현금 | 커뮤니티 | KcLep 수험 자료 검색 발췌 (https://www.epasskorea.com/Images/Submain/KcLep_guide.pdf) |
| 103 | 보통예금 | 커뮤니티 | 위와 같음 |
| 108 | 외상매출금 | 커뮤니티 | 위와 같음 |
| 135 | 부가세대급금 | **공식** | WEHAGO 매입매출전표입력 발췌에 "[135.부가세대급금]"이 그대로 나옴 |
| 146 | 상품 | 커뮤니티 | 전산회계 커뮤니티 발췌 |
| 251 | 외상매입금 | 커뮤니티(+공식 요약) | KcLep 자료. WEHAGO 전자세금계산서 분개 예시에 나온다는 검색 요약이 있으나 본문은 미열람 |
| 253 | 미지급금 | 커뮤니티 | KcLep 자료 |
| 255 | 부가세예수금 | 커뮤니티 | KcLep 자료 |
| 401 | 상품매출 | 커뮤니티 | 전산회계 커뮤니티 발췌 |
| 451 | 상품매출원가 | 커뮤니티 | 위와 같음 |
| 811 | 복리후생비 | 커뮤니티 | 비즈넵 AI Q&A(https://ai.bznav.com/contents/1497817), 전산회계 카페 |
| 812 | 여비교통비 | 커뮤니티 | 위와 같음 |
| 813 | 접대비(기업업무추진비) | 커뮤니티 | 위와 같음. 이름 변경은 공식 확인, **코드 813은 공식 미확인** |
| 814 | 통신비 | 커뮤니티 | 위와 같음 |
| 815 | 수도광열비 | 커뮤니티 | 위와 같음 |
| 816 | 전력비 | 커뮤니티 | 위와 같음 |
| 817 | 세금과공과(금) | 커뮤니티 | 위와 같음 |
| 819 | (지급)임차료 | 커뮤니티 | 위와 같음. 이름 표기가 자료마다 다름 |
| 820 | 수선비 | 커뮤니티 | 위와 같음 |
| 821 | 보험료 | 커뮤니티 | 위와 같음 |
| 822 | 차량유지비 | 커뮤니티 | 위와 같음. 경리코리아 코드체계(82200-xxx)도 같은 번호 |
| 824 | 운반비 | 커뮤니티 | 위와 같음 |
| 825 | 교육훈련비 | 커뮤니티 | 위와 같음 |
| 826 | 도서인쇄비 | 커뮤니티 | 위와 같음 |
| 829 | 사무용품비 | 커뮤니티 | 위와 같음 |
| 830 | 소모품비 | 커뮤니티 | 위와 같음 |
| 831 | 지급수수료 | 커뮤니티 | 위와 같음. 택슬리 Q&A 발췌 |
| 848 | 잡비 | 커뮤니티(약함) | 비즈넵 AI 답변만 있음 |
| 801~806 (급여·상여 등), 833 (광고선전비) | — | **미확인** | 검색으로 확인하지 못함 |

- [추론] 제조원가(5xx)·도급원가(6xx)·분양원가(7xx)는 800번대 판관비와 끝 두 자리가 같은 병렬 구조로 알려져 있다(예: 511 복리후생비(제조)). 공식 확인은 없다. 비즈넵 질문 제목("건축업 인테리어 업종의 판관비 계정과목 번호가 800번대가 아닌 600번대인지")이 간접 근거일 뿐이다.

### 2.8 거래처 코드

- [공식] [환경설정] > [전체] 탭의 "관리코드 사용여부 및 자리수 관리"에서 **거래처코드 자리수를 6~10자리**로 설정한다. 거래처는 **[일반] / [금융] / [카드]** 탭으로 나눠 관리한다. 일반거래처는 사업자등록번호를, 개인은 주민등록번호를, 외국인은 외국인번호를 입력한다.
  - https://wehagohelp.zendesk.com/hc/ko/articles/7362041815193 (거래처등록), https://wehagohelp.zendesk.com/hc/ko/articles/7349070228249
- [공식] 자동전표처리에서 조회된 사업자번호가 거래처등록에 없으면 **거래처코드를 자동 채번**해 거래처등록에 자동 등록한다. 등록된 사업자번호는 가장 최근에 입력한 것이 표시되고, 거래처코드가 주황색으로 강조된다.
- [공식] WEHAGO T [거래처관리] 거래처 가져오기: 엑셀 거래처는 **지정된 양식으로 작성한 데이터만** 올릴 수 있다.
  - https://wehagothelp.zendesk.com/hc/ko/articles/4412295171609
- [공식] 거래처 정보(거래처명, 사업자번호)를 바꾼 뒤 전표입력 메뉴로 전송할 수 있다: https://wehagothelp.zendesk.com/hc/ko/articles/58905310546329
- [커뮤니티] 설치형 Smart A 거래처 코드 범위(예: 일반 00101~97999, 금융 98000~99599, 카드 99600~99999): **미확인**. WEHAGO에서는 자리수를 설정할 수 있어서 이 범위가 그대로 적용된다고 볼 수 없다.
- [공식, 위멤버스] 위멤버스는 더존 Smart A [거래처등록]의 출력 양식 "거래처등록(일반탭) LIST (엑셀용)" 엑셀을 거래처 일괄 등록에 받는다. 이는 더존 → 위멤버스 방향의 거래처 동기화 근거다.
  - https://docs.channel.io/wemembers/ko/articles/거래처-정보-등록수정하기-6016d76d

### 2.9 자동전표처리 (WEHAGO T)

- [공식] 수임처별로 **전자세금계산서, 전자계산서, 신용카드, 현금영수증, 통장**의 최근 3개월 수집 건수와 마지막 수집일을 보여 준다. 각 메뉴는 수집 → 분개 추천 → 확인/변경 → 전표 전송 순서로 동작한다.
  - https://wehagothelp.zendesk.com/hc/ko/articles/360000309481
  - 전자세금계산서: 홈택스 수집 → 매입매출전표입력으로 전송 (https://wehagothelp.zendesk.com/hc/ko/articles/7870260729113)
  - 신용카드: 매출은 여신금융협회, 매입은 국세청·카드사 홈페이지에서 수집. 수집 구분은 매출 "여신금융협회/엑셀", 매입 "국세청/카드사/화물복지/엑셀/엑셀(국세청)/엑셀(화물복지)"
    - https://wehagothelp.zendesk.com/hc/ko/articles/7870198440217 , https://wehagothelp.zendesk.com/hc/ko/articles/360000336922
  - 현금영수증: 홈택스 수집. 홈택스에서 받은 엑셀을 불러올 수도 있다: https://wehagothelp.zendesk.com/hc/ko/articles/7870195545241
  - 통장: 수임처 T edge 통장정리와 연동: https://wehagothelp.zendesk.com/hc/ko/articles/360000309422
- [공식] 신용카드 엑셀 업로드: 전표관리/자동전표처리 > 신용카드 > 구분(매입/매출) 선택 > **엑셀서식내려받기** > 작성 > 기능모음 "**서식불러오기**" > 엑셀서식불러오기
  - https://wehagothelp.zendesk.com/hc/ko/articles/360000336922
  - 서식 열 구성은 미확인
- [공식] **중복전표**: 전표전송은 하지 않았는데 매입매출전표입력에 이미 있는 것으로 의심되는 전표는 전송되지 않는다. **의심 기준은 일자, 사업자번호, 금액, 과세유형이다.**
  - 전자세금계산서/전자계산서 자동전표처리 발췌: https://wehagohelp.zendesk.com/hc/ko/articles/7465287362585
- [공식] 증빙수집은 매일 0시 자동 또는 지정 시각 수동 수집이다. 과거 회계처리 이력과 빅데이터 AI로 자동 기장한다(douzone WEHAGO T 제품 소개 발췌): https://www.douzone.com/product/wehagot.jsp
- [공식] AI합계잔액시산표: 수집한 적격증빙을 AI로 분석한 가상전표로 시산표를 보여 주고, 그 화면에서 계정 처리와 전표 전송을 한 번에 할 수 있다.
  - https://wehagothelp.zendesk.com/hc/ko/articles/900000597766

### 2.10 (c) 급여 / 사업소득 / 일용직

| 메뉴 | 엑셀 업로드 | 확인된 규칙 | 근거 |
|---|---|---|---|
| 사원등록 | [공식] 엑셀서식 내려받기 → 불러오기 | 필수(*) 항목은 **사원코드, 성명, 내/외국인, 주민등록번호, 직종, 직위, 입사일**로 발췌에 나옴(원문 표기는 확인 필요). 주민번호·휴대폰은 `-,:,/,?` 등 특수문자 없이 숫자만. **첫 행 샘플은 반영 안 됨**(순번 1부터 작성). 사원코드 중복 시 오류가 나고 해당 행은 제외. 서식 파일명 `SA10_신규사원등록양식.xlsx`(다운로드 폴더에 저장). 이 파일명은 일용직사원등록 질의 결과에 나왔으며, 사원등록과 일용직사원등록 중 어느 문서의 내용인지 특정하지 못함 | https://wehagohelp.zendesk.com/hc/ko/articles/7365897634073 , https://wehagohelp.zendesk.com/hc/ko/articles/7538024920601 |
| 급여자료입력 | [공식 영상 제목/커뮤니티] **급여자료입력 엑셀업로드** 있음. "엑셀양식 **1줄** 업로드 방법 / **2줄** 업로드 방법" | 사원번호 열 필수(중복 불가) [커뮤니티]. 설치형 Smart A 팁: `.xls`로 저장, 맨 위 사원 행을 복사해 제목으로 적용, 지급합계·공제계·차인지급액·부서·직급 열은 삭제 | 영상 https://www.youtube.com/watch?v=vFfSsEQ70I0 , 카페 https://m.cafe.daum.net/transtax/QIlt/26 , 공식 메뉴 https://wehagohelp.zendesk.com/hc/ko/articles/7426905746585 |
| 급여자료입력 (일괄/복사) | — | [공식] 임금명세서 기재사항 일괄 복사, 전월 급여 복사(지급일이 같을 때) | https://wehagothelp.zendesk.com/hc/ko/articles/58876020536857 |
| 수임처 급여관리 (WEHAGO T) | — | [공식] 수임처 급여내역 → [급여계산이동] → 계산 → [급여계산내역 전송] | https://wehagothelp.zendesk.com/hc/ko/articles/4413975033113 |
| 사업소득자등록 | [공식, 발췌] 엑셀서식 내려받기/불러오기 | 소득구분 코드는 F2 코드도움으로 선택. 94로 시작하는 업종코드(미등록 사업자)는 사업자번호 000-00-00000~29 규칙 | https://wehagohelp.zendesk.com/hc/ko/articles/7441224010009 |
| 사업소득자료입력 | 미확인 (엑셀 업로드 여부 불명) | [공식, 발췌] 반영 항목: 소득자명, 주민(외국인)등록번호, 소득구분, 귀속년월, 지급년월일, 지급액, 세율(%), 학자금상환액, 소득세, 지방소득세, 차인지급액, 소액/연말 구분. 원단위 절사 옵션(기본 미적용). 마감하면 수정할 수 없음 | https://wehagohelp.zendesk.com/hc/ko/articles/7440703802905 |
| 일용직사원등록 | [공식, 발췌] 엑셀서식 내려받기/불러오기 | 주민번호·휴대폰은 숫자만 | https://wehagohelp.zendesk.com/hc/ko/articles/7430470705177 |
| 일용직급여자료입력 / 일용직급여일괄입력 | 미확인 | [공식] 일용직사원등록 기준으로 급여를 입력한다. 일괄입력 메뉴의 지급명세서(제출집계표) 탭에서 마감한 뒤 전자신고. 귀속년월/지급년월 입력. 근로내용확인신고는 엑셀로 내려받아 근로복지공단 토탈서비스에 올린다(**반출 방향**) | https://wehagohelp.zendesk.com/hc/ko/articles/7430712701337 , https://wehagohelp.zendesk.com/hc/ko/articles/7434497930521 , https://wehagohelp.zendesk.com/hc/ko/articles/7743359616921 |

- 참고 [공식, T edge]: 엑셀 대량발행(전자세금계산서) 문서에 "업로드 가능 파일형식 **Excel(97~2003)**, 용량 **2MB**, 특수문자가 들어가면 업로드 실패" 규칙이 있다. **세금계산서 발행 기능의 규칙이며, 전표·급여 업로드에도 똑같이 적용되는지는 미확인이다.**
  - https://wehagotedgehelp.zendesk.com/hc/ko/articles/13273782355993

---

## 3. 미확인 / 추정 항목과 현실적 대안

| # | 항목 | 상태 | 현실적 대안 |
|---|---|---|---|
| U1 | WEHAGO 공개/파트너 전표 등록 API | 미확인. `developer.wehago.com` 접속 불가 | 더존비즈온 제휴 창구에 공식 문의(서면 회신 확보). 회신 전에는 API가 없다고 가정한다 |
| U2 | 매입매출전표 엑셀 서식의 열 이름·순서·필수값·유형 입력값 형식 | 미확인 | 실제 WEHAGO T 계정에서 "엑셀서식 내려받기" 파일을 받아 `templates/wehago/매입매출_v{날짜}.xls(x)`로 버전 관리한다. 서식 해시를 저장해 변경을 감지한다 |
| U3 | 일반전표 업로드의 선택(비필수) 항목 전체 목록(거래처코드, 거래처명, 적요, 부서 등) | 부분 확인 | 일반전표는 양식이 자유이므로 **필수 7항목 + 거래처코드/거래처명/적요**로 MIN TAX OPS 표준 출력 포맷을 정하고, WEHAGO에서 한 번 매칭한 설정을 재사용할 수 있는지 실사용으로 확인한다 |
| U4 | 계정코드 800번대 판관비 등 기본 코드의 공식 목록 | 커뮤니티 수준 | 수임처별로 [계정과목 및 적요등록] 조회 결과를 엑셀로 변환하거나 화면 export해서 `chart_of_accounts` 테이블에 넣는다. 매핑 키는 **코드+계정명**으로 둔다(이름 변경 대응) |
| U5 | 3자리/5자리 코드체계 판별 | 규칙은 공식 확인, 수임처별 값은 미지 | 수임처 온보딩 체크리스트에 "계정과목코드체계(0/1)"를 넣는다 |
| U6 | 불공제사유 번호표 전체 | 미확인 (3번만 확인) | 54 불공 전표는 MIN TAX OPS에서 사유 텍스트만 기록하고, WEHAGO에서 사람이 사유를 선택하도록 한다 |
| U7 | 급여 1줄/2줄 서식, 사업소득·일용직 급여 업로드 서식 | 미확인 | 실제 서식을 내려받아 고정한다. 그 전에는 MOCK 서식으로 개발한다 |
| U8 | 업로드 파일 형식(xls vs xlsx), 용량, 인코딩 | 전표 업로드에 대해서는 미확인 | 기본 출력은 **xls(97-2003)** 로 하고 xlsx도 선택할 수 있게 한다. 파일당 행 수를 제한해 분할 출력한다 |
| U9 | 매입매출 엑셀 업로드 검증 규칙(사업자번호 유효성, 공급가액·세액·합계 일치, 회계기간) | 검색에 나왔으나 **출처가 뉴젠(세무사랑) 문서일 가능성**이 있어 더존 규칙으로 확정할 수 없음 | MIN TAX OPS가 사전 검증을 자체 구현한다(사업자번호 체크섬, 합계 일치, 유형별 세액 0 규칙, 회계기간) |
| U10 | Smart A(설치형) 거래처코드 범위 | 미확인 | WEHAGO는 자리수를 설정할 수 있으므로 코드 범위를 가정하지 않는다. 거래처 마스터를 수임처별로 수집한다 |

---

## 4. MIN TAX OPS 설계 시사점

### 4.1 통합 상태 권고 (Integration Status)

| 기능 | 권고 상태 | 근거 / 비고 |
|---|---|---|
| 전표(일반/매입매출) 실시간 등록 API | **NOT AVAILABLE** | 공개 API 미확인(U1). 공식 확인 전에는 설계에 넣지 않는다 |
| 일반전표 반영 | **FILE BASED** | 공식: 양식 자유 + 필수 7항목 매칭. MIN TAX OPS는 표준 엑셀을 만들고, 사람이 WEHAGO에서 업로드한다 |
| 매입매출전표 반영 | **FILE BASED** (서식 확보 전에는 **MOCK**) | 공식: 엑셀서식 내려받기/불러오기. 열 구성 미확인(U2) |
| 신용카드/통장/현금영수증 원천자료 | **FILE BASED**(엑셀) 또는 **사용 안 함** 권장 | WEHAGO T가 홈택스·카드사·T edge에서 **직접 수집**한다. 같은 자료를 위멤버스에서 다시 넣으면 이중 기장 위험이 있다 |
| 거래처 마스터 | **FILE BASED** (양방향) | WEHAGO 거래처 가져오기는 지정 양식만 받는다. 위멤버스는 더존 거래처 LIST 엑셀을 받는다 |
| 계정과목표 수집 | **FILE BASED** (수임처별 export) | 코드는 회사별로 가변이다(3/5자리, 사용자 추가) |
| 급여/사원/사업소득/일용직 | **FILE BASED** (서식 확보 전에는 **MOCK**) | 공식: 엑셀서식 내려받기/불러오기 |
| 반영 결과 확인·대사 | **FILE BASED** (매입매출장·계정별원장 엑셀 변환 export 재수집) | 매입매출장 엑셀 변환은 공식 확인 |
| 브라우저 자동화로 업로드·조회 | **RPA** (선택. 기본 비활성) | 약관, 인증서/2FA, UI 변경 리스크가 있다. 파일 생성까지만 자동화하고 업로드는 사람이 하는 것을 기본값으로 둔다 |

### 4.2 아키텍처 권고 [추론]

1. **역할 분리: "WEHAGO가 이미 수집하는 것은 넣지 않는다."**
   - WEHAGO T 자동전표처리가 이미 수집하는 자료가 있다: 전자세금계산서, 전자계산서, 카드, 현금영수증, 통장.
   - MIN TAX OPS는 이 자료에 대해 **분류·계정 추천·검토 큐·예외 탐지·대사**를 맡는다.
   - 전표로 파일 출력하는 대상은 WEHAGO가 수집하지 못하는 자료(수기 증빙, 위멤버스에만 있는 자료, 조정 분개)로 제한한다.
2. **중복 방지 키**: WEHAGO 중복전표 기준(**일자 + 사업자번호 + 금액 + 과세유형**)과 **같은 키**를 MIN TAX OPS의 idempotency key로 쓴다. 파일을 만들기 전에 WEHAGO에서 export한 매입매출장과 비교해 이미 있는 건은 빼 둔다.
3. **코드 매핑 계층**: 아래 네 가지를 모두 **수임처(tenant)별 테이블**로 둔다. 코드는 상수로 박아 두지 않는다.
   - `vat_type`: 11~24 / 51~62 매핑
   - `journal_type`: 0~7 분개유형
   - `slip_side`: 1~6 구분
   - `account_code`: 수임처별 계정과목표
4. **계정 이름 변경 대응**: `813 접대비` ↔ `접대비(기업업무추진비)`처럼 이름이 바뀌는 경우가 있다. 계정 매칭은 코드를 우선하고, 이름은 검증용으로만 쓴다.
5. **서식 버전 관리**: WEHAGO에서 내려받은 엑셀서식을 `templates/wehago/<메뉴>/<YYYYMMDD>` 아래에 저장한다. 제목행 해시를 비교해 서식 변경을 감지하고, 달라지면 출력을 막는다.
6. **사전 검증(pre-flight)**: 업로드 실패를 줄이기 위해 MIN TAX OPS가 아래 항목을 직접 검사한다.
   - 사업자번호 체크섬
   - 공급가액 + 세액 = 합계
   - 유형별 세액 규칙(예: 현면·현영·면세는 세액 0)
   - 회계기간 안의 날짜인지
   - 거래처코드가 있는지(매입매출은 필수)
   - 특수문자 제거
   - 주민번호·전화번호는 숫자만
7. **54 불공·54↔51 전환**: 불공제사유를 선택해야 하고, 부가세대급금 합산 로직이 있으므로 불공 전표는 **"사람 검토 필수" 플래그**를 붙인다.
8. **개인정보**: 급여·사업소득·일용직 파일에는 주민등록번호가 들어간다.
   - 생성 파일은 암호화해 저장하고, 보존 기간을 정해 두고, 다운로드 감사로그를 남긴다.
   - MOCK 데이터에는 실제 주민번호를 쓰지 않는다.
9. **API 재확인 트리거**: 더존에서 공식 회신을 받거나 `developer.wehago.com`에 접속할 수 있게 되면, 이 문서의 U1을 다시 조사하고 상태를 NOT AVAILABLE에서 다시 평가한다.

### 4.3 수임처 온보딩 체크리스트 (제안) [추론]

1. WEHAGO T에서 수임처 연결을 확인하고, 세무대리인 홈택스 인증서를 등록한다.
2. 계정과목코드체계(3자리/5자리)를 확인하고 계정과목표를 export한다.
3. 거래처코드 자리수를 확인하고 거래처 마스터를 export한다.
4. 매입매출·급여·사원·사업소득 엑셀서식을 내려받아 버전을 등록한다.
5. 자동전표처리 수집 범위(카드사/통장 연동 여부)를 확인해, MIN TAX OPS가 파일로 만들 대상을 확정한다.

---

## 5. 참고 URL

### 공식 (WEHAGO / WEHAGO T / T edge 고객센터, 더존)

- 일반전표입력: https://wehagohelp.zendesk.com/hc/ko/articles/7362165430553
- 매입매출전표입력 (WEHAGO): https://wehagohelp.zendesk.com/hc/ko/articles/7362360128665
- 매입매출전표입력 (WEHAGO T): https://wehagothelp.zendesk.com/hc/ko/articles/7870004069017
- (3) 증빙전표입력: https://wehagothelp.zendesk.com/hc/ko/articles/360000309402
- (2) 자동전표처리: https://wehagothelp.zendesk.com/hc/ko/articles/360000309481
- (4) 통장정리: https://wehagothelp.zendesk.com/hc/ko/articles/360000309422
- 통장 엑셀 업로드 방법: https://wehagothelp.zendesk.com/hc/ko/articles/360000339242
- 통장 적요→거래처명: https://wehagohelp.zendesk.com/hc/ko/articles/900001793866
- 신용카드 엑셀 업로드 방법: https://wehagothelp.zendesk.com/hc/ko/articles/360000336922
- 신용카드 (WEHAGO T): https://wehagothelp.zendesk.com/hc/ko/articles/7870198440217
- 신용카드 (WEHAGO): https://wehagohelp.zendesk.com/hc/ko/articles/7424025254169
- 현금영수증 (WEHAGO T): https://wehagothelp.zendesk.com/hc/ko/articles/7870195545241
- 전자세금계산서 (WEHAGO T): https://wehagothelp.zendesk.com/hc/ko/articles/7870260729113
- 전자계산서 (WEHAGO): https://wehagohelp.zendesk.com/hc/ko/articles/7465287362585
- 매입매출장 엑셀 변환: https://wehagothelp.zendesk.com/hc/ko/articles/360000666002
- 거래처·계정과목 일괄 변경: https://wehagothelp.zendesk.com/hc/ko/articles/900000185906
- 거래처등록: https://wehagohelp.zendesk.com/hc/ko/articles/7362041815193
- 거래처 가져오기: https://wehagothelp.zendesk.com/hc/ko/articles/4412295171609
- 변경 거래처정보 전표 전송: https://wehagothelp.zendesk.com/hc/ko/articles/58905310546329
- 환경설정: https://wehagohelp.zendesk.com/hc/ko/articles/7349070228249
- 계정과목 및 적요등록: https://wehagohelp.zendesk.com/hc/ko/articles/7310815438873
- 2024 계정과목 변경 (접대비→기업업무추진비): https://wehagohelp.zendesk.com/hc/ko/articles/26952918009369
- 손익계산서항목검토 접대비: https://wehagothelp.zendesk.com/hc/ko/articles/59039608290713
- 공제받지못할매입세액명세서: https://wehagohelp.zendesk.com/hc/ko/articles/7468973692697
- AI합계잔액시산표: https://wehagothelp.zendesk.com/hc/ko/articles/900000597766
- 홈택스 인증서 관리: https://wehagothelp.zendesk.com/hc/ko/articles/360000309701
- 수집정보등록: https://wehagothelp.zendesk.com/hc/ko/articles/360000309502
- 사원등록(회계): https://wehagohelp.zendesk.com/hc/ko/articles/7365897634073
- 사원등록(인사): https://wehagohelp.zendesk.com/hc/ko/articles/7538024920601
- 급여자료입력: https://wehagohelp.zendesk.com/hc/ko/articles/7426905746585
- 임금명세서 일괄 입력/복사: https://wehagothelp.zendesk.com/hc/ko/articles/58876020536857
- 수임처 급여관리: https://wehagothelp.zendesk.com/hc/ko/articles/4413975033113
- 사업소득자등록: https://wehagohelp.zendesk.com/hc/ko/articles/7441224010009
- 사업소득자료입력: https://wehagohelp.zendesk.com/hc/ko/articles/7440703802905
- 일용직사원등록: https://wehagohelp.zendesk.com/hc/ko/articles/7430470705177
- 일용직급여자료입력: https://wehagohelp.zendesk.com/hc/ko/articles/7430712701337
- 일용직급여일괄입력: https://wehagohelp.zendesk.com/hc/ko/articles/7434497930521
- 근로내용확인신고서: https://wehagohelp.zendesk.com/hc/ko/articles/7743359616921
- 엑셀 대량발행 (T edge, xls 97-2003/2MB): https://wehagotedgehelp.zendesk.com/hc/ko/articles/13273782355993
- Smart A 백업 → WEHAGO: https://wehagohelp.zendesk.com/hc/ko/articles/900000198446
- SmartA 회계데이터 업로드 (세무대리인 기장): https://wehagothelp.zendesk.com/hc/ko/articles/900005325786
- 회계데이터 백업 파일 (sdb/whg/nsz): https://wehagothelp.zendesk.com/hc/ko/articles/20360091660441
- S마이그레이션: https://wehagothelp.zendesk.com/hc/ko/articles/900000598863
- WEHAGO T 제품 소개: https://www.douzone.com/product/wehagot.jsp
- WEHAGO 개발자 페이지 (접속 불가, 검색 목록만 존재): https://developer.wehago.com/api
- 더존 비즈니스 파트너 모집 (OmniEsol): https://www.douzone.com/media/media_room_read.jsp?id=2538&page=3
- WEHAGO 공식 카카오 채널 (SmartA10 엑셀 업로드): https://pf.kakao.com/_SQxkzK/108846740

### 커뮤니티 / 제3자

- 다인정보(더존 비즈니스파트너) – Smart A 10 회계자료 엑셀 업로드: https://douzone.ldad.co.kr/89
- 스팬딧 Export 설정: https://docs.spendit.kr/ko/articles/1107959
- 스팬딧 내보내기 기능: https://docs.spendit.kr/ko/articles/669327
- 스팬딧 블로그 – 더존 ERP 종류와 연동 방식: https://www.spendit.kr/blog/더존-erp-종류와-스팬딧-연동-방식-구분-57905
- 고위드 회계 ERP 설정: https://docs.channel.io/gowid-guide/ko/articles/회계-ERP-설정-9af43573
- 고위드 더존 양식 업로드: https://gowid-help.oopy.io/ca356845-0a4e-4026-b3e0-e424a00eaafe
- SharedIT – 아마란스 오픈 API: https://www.sharedit.co.kr/qnaboards/27429
- 더존비즈온 AI 에이전트 마켓플레이스 (파트너사 게시): https://www.douzone.site/post/douzonenews20251001
- 한국세정신문 – WEHAGO T 세무사랑 데이터 자동 변환: https://www.taxtimes.co.kr/news/article.html?no=242121
- YouTube – [WEHAGO | Smart A 10] 급여자료입력 엑셀업로드: https://www.youtube.com/watch?v=vFfSsEQ70I0
- 선우회계법인 카페 – 급여자료입력 엑셀업로드 팁 (Smart A): https://m.cafe.daum.net/transtax/QIlt/26
- 비즈넵 AI – 복리후생비와 판관비 코드: https://ai.bznav.com/contents/1497817
- KcLep 가이드 (수험용): https://www.epasskorea.com/Images/Submain/KcLep_guide.pdf
- 경리코리아 계정과목 분류표: http://www.klkorea.net/sa_sub/sub_page.php?menu=a201020
- 위멤버스 거래처 정보 등록/수정: https://docs.channel.io/wemembers/ko/articles/거래처-정보-등록수정하기-6016d76d
