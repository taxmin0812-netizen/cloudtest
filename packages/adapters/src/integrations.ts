/**
 * 연동 레지스트리 — 정직한 상태 표시 (환각 방지).
 *
 * 근거: docs/research/01-wehago.md §4.1, 02-wemembers.md §4.1, 03-hometax-wetax-filing.md §4.1,
 *       docs/integration-architecture.md §2.3(키 체계)·§7(현실적 상태표).
 * 확인되지 않은 API 는 NOT_AVAILABLE 이다. 환경변수를 넣었다고 API 가 생기지 않는다.
 */
import type { IngestChannel, IntegrationDescriptor, IntegrationStatus } from '@mintax/core';

export type IntegrationGroup = 'wemembers' | 'hometax' | 'wetax' | 'wehago' | 'bridge' | 'cloud' | 'ai' | 'third_party';

export interface AdapterIntegrationDescriptor extends IntegrationDescriptor {
  group: IntegrationGroup;
  /** 이 연동으로 들어온 자료의 IngestChannel (수집 연동만) */
  channel?: IngestChannel;
  /** 상태를 바꾸려면 필요한 조건 */
  upgradeCondition: string;
  /** 사무소(사람)가 해야 할 일 */
  userAction?: string;
}

/**
 * 리서치로 "공식 API 존재 + 사용 권한"이 확인되었는가.
 * 확인 전에는 환경변수가 있어도 NOT_AVAILABLE 로 둔다 (엔드포인트를 추측해 구현하지 않는다).
 */
export const RESEARCH_CONFIRMED_APIS = {
  wemembers: false, // 02 I3·U1: 공개/제휴 API 미확인
  wehagoVoucher: false, // 01 U1: 전표 등록 API 미확인, developer.wehago.com 접속 불가
  hometaxEfiling: false, // 03 A1·U8: 전자신고 제출 API 없음
} as const;

/**
 * 이 저장소에 실제로 구현되어 동작하는 구성요소인가 (2026-09-26 점검).
 * - desktopBridge: apps/bridge 에는 package.json 뿐이고 /api/bridge/* 도 없다 (integration-architecture §7 주의 항목)
 * - cloudFolderWatcher: worker 에 폴더/버킷 폴링 작업이 없다
 * 구현 담당이 동작을 확인한 뒤 true 로 바꾼다. 그 전에는 환경변수가 있어도 FILE_BASED 로 표시하지 않는다.
 */
export const IMPLEMENTED_COMPONENTS = {
  desktopBridge: false,
  cloudFolderWatcher: false,
} as const;

const BRIDGE_NOT_BUILT = '설계 완료·미구현 — Bridge 앱과 서버 연결(/api/bridge/*)이 아직 없어 동작하지 않습니다. 파일은 웹에서 직접 올려 주세요.';

export const INTEGRATIONS: readonly AdapterIntegrationDescriptor[] = [
  {
    key: 'wemembers.api',
    group: 'wemembers',
    name: '위멤버스 자료 API',
    status: 'NOT_AVAILABLE',
    statusReason: '위멤버스(웹케시) 공개·제휴 API 를 확인하지 못했습니다. 자료는 엑셀 다운로드 → 업로드로 받습니다.',
    capabilities: [],
    channel: 'wemembers_api',
    docsRef: 'docs/research/02-wemembers.md I3, U1',
    upgradeCondition: '웹케시 서면 제휴 + 공식 API 문서 확보 + 건별/합계 수준 확인',
    userAction: '웹케시 위멤버스(1670-1211)에 제휴 API 제공 여부를 서면으로 문의',
  },
  {
    key: 'wemembers.file',
    group: 'wemembers',
    name: '위멤버스 통합자료 엑셀',
    status: 'FILE_BASED',
    statusReason: '위멤버스 엑셀 다운로드 파일을 올리면 형식을 판별해 읽습니다. 위멤버스 고유 열 구성은 미확인이라 홈택스 원본 레이아웃 기준으로 판별합니다.',
    capabilities: ['file_upload', 'format_detection', 'normalize'],
    channel: 'wemembers_file',
    docsRef: 'docs/research/02-wemembers.md D1, U2',
    upgradeCondition: '사무소 실계정 샘플 파일로 레이아웃 지문 등록',
    userAction: '위멤버스 통합자료(세금계산서·현금영수증·카드) 엑셀 샘플을 개인정보 마스킹 후 1개씩 제공',
  },
  {
    key: 'wemembers.filing_zip',
    group: 'wemembers',
    name: '위멤버스 신고리스트 일괄 다운로드(접수증·납부서)',
    status: 'FILE_BASED',
    statusReason: '신고리스트 개별·일괄 다운로드 기능은 확인(검색 요약). ZIP 파일명 규칙은 미확인이라 사람이 업로드합니다.',
    capabilities: ['file_upload'],
    channel: 'wemembers_file',
    docsRef: 'docs/research/02-wemembers.md D3, D4, U5',
    upgradeCondition: '샘플 ZIP 으로 파일 매칭 규칙 검증',
  },
  {
    key: 'hometax.file',
    group: 'hometax',
    name: '홈택스 원본 엑셀 (세금계산서·사업용카드·현금영수증)',
    status: 'FILE_BASED',
    statusReason: '홈택스에서 내려받은 엑셀/CSV 를 올리면 헤더를 자동 탐지해 읽습니다. 열 구성은 커뮤니티 관찰값 기준(검증필요).',
    capabilities: ['file_upload', 'format_detection', 'normalize', 'cp949_csv'],
    channel: 'hometax_file',
    docsRef: 'docs/research/02-wemembers.md §2.5',
    upgradeCondition: '실제 다운로드 샘플로 레이아웃 지문 확정',
  },
  {
    key: 'hometax.scrape',
    group: 'hometax',
    name: '홈택스 직접 수집',
    status: 'NOT_AVAILABLE',
    statusReason: '정책상 배제: 2026-08-20 시행 개인정보 보호법 시행령은 대리인의 자동화 도구 전송요구에 "사전 협의한 방식"을 요구합니다(적용 범위 미확인 → 보수적 배제).',
    capabilities: [],
    docsRef: 'docs/research/02-wemembers.md R1~R4',
    upgradeCondition: '국세청 공식 오픈 API 공개',
  },
  {
    key: 'hometax.efiling',
    group: 'hometax',
    name: '원천세·지급명세서 전자신고 제출',
    status: 'FILE_BASED',
    statusReason: '제출 API 는 없습니다(홈택스 이용에 관한 규정: 작성·변환·확인 방식). WEHAGO 가 만든 신고파일을 사람이 홈택스에 변환신고합니다.',
    capabilities: ['filing_tracking'],
    docsRef: 'docs/research/03-hometax-wetax-filing.md §4.1',
    upgradeCondition: '국세청 제출 API 공개',
  },
  {
    key: 'wetax.file',
    group: 'wetax',
    name: '위택스 자료 (지방소득세 납부서 등)',
    status: 'FILE_BASED',
    statusReason: '위택스 납부서는 위멤버스 일괄 수집 또는 사람이 업로드합니다.',
    capabilities: ['file_upload'],
    docsRef: 'docs/research/02-wemembers.md D5',
    upgradeCondition: '-',
  },
  {
    key: 'wetax.local_tax_filing',
    group: 'wetax',
    name: '지방소득세 특별징수 신고',
    status: 'FILE_BASED',
    statusReason: '위택스 한건신고·엑셀파일신고를 사람이 수행하고, MIN TAX OPS 는 지자체별 금액 배분·대사를 준비합니다.',
    capabilities: ['filing_tracking'],
    docsRef: 'docs/research/03-hometax-wetax-filing.md §2.4',
    upgradeCondition: '-',
  },
  {
    key: 'wehago.voucher_api',
    group: 'wehago',
    name: 'WEHAGO 전표 API 등록',
    status: 'NOT_AVAILABLE',
    statusReason: '공개된 전표 등록 API 를 확인하지 못했습니다(developer.wehago.com 접속 불가). 전표는 엑셀 업로드로 반영합니다.',
    capabilities: [],
    docsRef: 'docs/research/01-wehago.md U1',
    upgradeCondition: '더존비즈온 서면 회신 + 공식 API 문서',
    userAction: '더존비즈온 제휴 창구에 WEHAGO T 전표 등록 API 제공 여부 서면 문의',
  },
  {
    key: 'wehago.purchase_sales_file',
    group: 'wehago',
    name: 'WEHAGO 매입매출전표 엑셀 업로드 파일',
    status: 'FILE_BASED',
    statusReason: '매입매출전표 "엑셀서식 불러오기" 기능은 확인(공식 발췌). 실제 서식 열 구성은 미확인 → 사무소 서식 등록 전까지 표준 레이아웃(검증필요)으로 생성합니다.',
    capabilities: ['export_xlsx', 'preflight_validation', 'verify_1won'],
    docsRef: 'docs/research/01-wehago.md §2.4, U2',
    upgradeCondition: '사무소가 WEHAGO 에서 내려받은 매입매출 엑셀서식 등록 + 첫 업로드 성공',
    userAction: 'WEHAGO 매입매출전표입력 > 더보기 > 엑셀서식 내려받기 파일을 MIN TAX OPS 에 등록',
  },
  {
    key: 'wehago.general_journal_file',
    group: 'wehago',
    name: 'WEHAGO 일반전표 엑셀 업로드 파일',
    status: 'FILE_BASED',
    statusReason: '일반전표 업로드는 지정 양식 없이 열을 매칭하는 방식(공식 발췌). 필수 7항목을 포함해 생성합니다.',
    capabilities: ['export_xlsx', 'preflight_validation', 'verify_1won'],
    docsRef: 'docs/research/01-wehago.md §2.3',
    upgradeCondition: '실제 업로드 1회 성공 기록',
  },
  {
    key: 'wehago.payroll_file',
    group: 'wehago',
    name: 'WEHAGO 급여·사업소득·일용직 업로드 파일',
    status: 'MOCK',
    statusReason: '서식 내려받기/불러오기 기능은 확인, 열 구성은 미확인 → 임시(MOCK) 서식입니다. 실서식 등록 전 업로드하지 마세요.',
    capabilities: ['export_xlsx', 'verify_1won'],
    docsRef: 'docs/research/01-wehago.md §2.10, U7',
    upgradeCondition: '급여자료입력·사업소득·일용직 엑셀서식 등록',
    userAction: 'WEHAGO 급여자료입력·사업소득자료·일용직 엑셀서식 파일 제공',
  },
  {
    key: 'wehago.ledger_reimport',
    group: 'wehago',
    name: 'WEHAGO 매입매출장 역수입 (전송 후 대사)',
    status: 'FILE_BASED',
    statusReason: '매입매출장 엑셀 변환 기능은 확인(공식 발췌). 헤더 원문은 샘플로 확정 필요.',
    capabilities: ['file_upload', 'format_detection', 'reconciliation'],
    channel: 'manual_upload',
    docsRef: 'docs/research/01-wehago.md §2.4',
    upgradeCondition: '매입매출장 변환 샘플 등록',
  },
  {
    key: 'wehago.master_file',
    group: 'wehago',
    name: 'WEHAGO 거래처·계정과목표',
    status: 'FILE_BASED',
    statusReason: '계정코드·거래처코드는 수임처마다 다르므로 WEHAGO 에서 내보낸 목록을 올려 연결합니다.',
    capabilities: ['file_upload'],
    docsRef: 'docs/research/01-wehago.md §2.7, §2.8',
    upgradeCondition: '수임처 온보딩',
  },
  {
    key: 'download_watch',
    group: 'bridge',
    name: '다운로드 폴더 자동 감지 (Desktop Bridge)',
    status: 'NOT_AVAILABLE',
    statusReason: BRIDGE_NOT_BUILT,
    capabilities: [],
    channel: 'download_watch',
    docsRef: 'docs/desktop-bridge-design.md, docs/integration-architecture.md §4.3·§7',
    upgradeCondition: 'Bridge 프로토타입 + /api/bridge/* 구현 + 서명 검증 테스트 통과 (구현 후 FILE_BASED)',
  },
  {
    key: 'desktop_bridge',
    group: 'bridge',
    name: 'Desktop Bridge',
    status: 'NOT_AVAILABLE',
    statusReason: BRIDGE_NOT_BUILT,
    capabilities: [],
    channel: 'desktop_bridge',
    docsRef: 'docs/desktop-bridge-design.md, docs/integration-architecture.md §4.5·§7',
    upgradeCondition: 'Bridge 프로토타입 + /api/bridge/* 구현 (구현 후 FILE_BASED)',
  },
  {
    key: 'cloud_folder',
    group: 'cloud',
    name: '클라우드/공유 폴더 감시',
    status: 'NOT_AVAILABLE',
    statusReason: '폴더 감시 작업(worker)이 아직 구현되지 않았습니다. 파일은 웹에서 직접 올려 주세요.',
    capabilities: [],
    channel: 'cloud_folder',
    docsRef: 'docs/integration-architecture.md §4.4',
    upgradeCondition: 'worker 폴링 작업 구현 + 저장소 경로 설정 (CLOUD_FOLDER_PATH 또는 CLOUD_FOLDER_S3_PREFIX) → FILE_BASED',
  },
  {
    key: 'ai_provider.heuristic',
    group: 'ai',
    name: 'AI 분류 (내장 규칙)',
    status: 'LIVE',
    statusReason: '로컬 규칙 기반 — 외부로 데이터를 보내지 않습니다.',
    capabilities: ['classify'],
    upgradeCondition: '-',
  },
  {
    key: 'ai_provider.anthropic',
    group: 'ai',
    name: 'AI 분류 (Anthropic)',
    status: 'NOT_AVAILABLE',
    statusReason: 'AI_PROVIDER=anthropic 과 ANTHROPIC_API_KEY 가 설정되지 않았습니다.',
    capabilities: [],
    docsRef: 'docs/integration-architecture.md §7',
    upgradeCondition: 'API 키 설정 + 개인정보 검토',
  },
  {
    key: 'third_party.popbill',
    group: 'third_party',
    name: '팝빌 홈택스수집 API (후보)',
    status: 'NOT_AVAILABLE',
    statusReason: '보류: 공식 벤더 API 는 있으나 비용·규제(사전협의) 검토 전입니다.',
    capabilities: [],
    docsRef: 'docs/research/02-wemembers.md §2.7',
    upgradeCondition: '비용·규제 검토 후 계약',
  },
  {
    key: 'third_party.codef',
    group: 'third_party',
    name: 'CODEF API (후보)',
    status: 'NOT_AVAILABLE',
    statusReason: '보류: 스크래핑 기반 벤더 — 비용·규제 검토 전입니다.',
    capabilities: [],
    docsRef: 'docs/research/02-wemembers.md §2.7',
    upgradeCondition: '비용·규제 검토 후 계약',
  },
];

/** 과제 명세·스키마 주석에서 쓰는 짧은 키 → 레지스트리 키 */
export const INTEGRATION_KEY_ALIASES: Record<string, string> = {
  wemembers_api: 'wemembers.api',
  wemembers_file: 'wemembers.file',
  hometax_file: 'hometax.file',
  wehago: 'wehago.purchase_sales_file',
  wehago_api: 'wehago.voucher_api',
  wehago_file: 'wehago.purchase_sales_file',
  hometax_filing: 'hometax.efiling',
  wetax_filing: 'wetax.local_tax_filing',
  ai_provider: 'ai_provider.anthropic',
};

export function findIntegration(key: string, list: readonly AdapterIntegrationDescriptor[] = INTEGRATIONS): AdapterIntegrationDescriptor | undefined {
  const k = INTEGRATION_KEY_ALIASES[key] ?? key;
  return list.find((d) => d.key === k);
}

export type IntegrationEnv = Readonly<Record<string, string | undefined>>;

function has(env: IntegrationEnv, k: string): boolean {
  return (env[k] ?? '').trim() !== '';
}

/** 환경변수를 반영한 현재 상태 (DB integration_connections 초기값·설정 화면용) */
export function getIntegrationStatuses(env: IntegrationEnv = {}): AdapterIntegrationDescriptor[] {
  return INTEGRATIONS.map((d) => {
    const out: AdapterIntegrationDescriptor = { ...d, capabilities: [...d.capabilities] };
    const set = (status: IntegrationStatus, reason: string, capabilities?: string[]) => {
      out.status = status;
      out.statusReason = reason;
      if (capabilities) out.capabilities = capabilities;
    };
    switch (d.key) {
      case 'wemembers.api':
        if (has(env, 'WEMEMBERS_API_BASE_URL') && has(env, 'WEMEMBERS_API_KEY')) {
          if (RESEARCH_CONFIRMED_APIS.wemembers) {
            set('MOCK', '[MOCK] API 설정이 있으나 실제 호출 클라이언트는 공식 문서 확보 후 구현합니다 — 현재는 모의 응답만 사용합니다.');
          } else {
            set('NOT_AVAILABLE', 'WEMEMBERS_API_* 환경변수가 설정되어 있지만, 위멤버스 공식 API 가 확인되지 않아 사용하지 않습니다. 파일 업로드를 사용하세요.');
          }
        }
        break;
      case 'wehago.voucher_api':
        if (RESEARCH_CONFIRMED_APIS.wehagoVoucher) set('MOCK', '[MOCK] 공식 API 문서 확보 — 클라이언트 구현 전');
        break;
      case 'cloud_folder': {
        const configured = has(env, 'CLOUD_FOLDER_PATH') || has(env, 'CLOUD_FOLDER_S3_PREFIX');
        if (!IMPLEMENTED_COMPONENTS.cloudFolderWatcher) {
          if (configured) set('NOT_AVAILABLE', '폴더 경로는 설정되어 있지만 폴더 감시 작업(worker)이 아직 구현되지 않아 파일을 가져가지 않습니다. 웹에서 직접 올려 주세요.');
        } else if (configured) {
          set('FILE_BASED', `설정된 폴더를 주기적으로 확인합니다 (${has(env, 'CLOUD_FOLDER_PATH') ? '로컬/NAS 경로' : 'S3 버킷 경로'}).`, ['folder_watch']);
        } else {
          set('NOT_AVAILABLE', '감시할 폴더(CLOUD_FOLDER_PATH) 또는 버킷 경로(CLOUD_FOLDER_S3_PREFIX)가 설정되지 않았습니다.');
        }
        break;
      }
      case 'desktop_bridge':
      case 'download_watch':
        if (IMPLEMENTED_COMPONENTS.desktopBridge) {
          if (has(env, 'BRIDGE_SHARED_SECRET')) {
            set('FILE_BASED', d.key === 'desktop_bridge' ? '사무소 PC 전용 폴더 ↔ 서버 파일 전달 (프로토타입).' : 'Bridge 가 PC 다운로드 폴더의 인식 가능한 파일만 올립니다 (프로토타입).', d.key === 'desktop_bridge' ? ['file_watch', 'file_delivery'] : ['file_watch']);
          } else {
            set('NOT_AVAILABLE', 'BRIDGE_SHARED_SECRET 미설정 — Bridge 연결 전입니다.');
          }
        }
        break;
      case 'ai_provider.anthropic': {
        const provider = (env.AI_PROVIDER ?? '').trim().toLowerCase();
        if (provider === 'anthropic' && has(env, 'ANTHROPIC_API_KEY')) {
          set('LIVE', `Anthropic API 사용 (모델: ${env.AI_MODEL?.trim() || '기본값'}). 개인정보(카드번호·주민번호)는 보내지 않습니다.`, ['classify']);
        } else if (provider === 'anthropic') {
          set('NOT_AVAILABLE', 'AI_PROVIDER=anthropic 이지만 ANTHROPIC_API_KEY 가 없습니다 — 내장 규칙으로 대체합니다.');
        }
        break;
      }
      default:
        break;
    }
    return out;
  });
}
