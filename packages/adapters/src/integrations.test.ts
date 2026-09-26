import { describe, expect, it } from 'vitest';
import { findIntegration, getIntegrationStatuses, IMPLEMENTED_COMPONENTS, INTEGRATIONS, RESEARCH_CONFIRMED_APIS } from './integrations';

const statusOf = (env: Record<string, string | undefined>, key: string) => getIntegrationStatuses(env).find((d) => d.key === key)!;

describe('연동 레지스트리', () => {
  it('정직한 기본 상태', () => {
    const s = Object.fromEntries(getIntegrationStatuses({}).map((d) => [d.key, d.status]));
    expect(s['wemembers.api']).toBe('NOT_AVAILABLE');
    expect(s['wemembers.file']).toBe('FILE_BASED');
    expect(s['hometax.file']).toBe('FILE_BASED');
    expect(s['hometax.scrape']).toBe('NOT_AVAILABLE');
    expect(s['hometax.efiling']).toBe('FILE_BASED');
    expect(s['wetax.local_tax_filing']).toBe('FILE_BASED');
    expect(s['wehago.voucher_api']).toBe('NOT_AVAILABLE');
    expect(s['wehago.purchase_sales_file']).toBe('FILE_BASED');
    expect(s['wehago.general_journal_file']).toBe('FILE_BASED');
    expect(s['wehago.payroll_file']).toBe('MOCK');
    // Bridge·폴더 감시는 아직 구현되지 않았다 → 정직하게 NOT_AVAILABLE
    expect(s['desktop_bridge']).toBe('NOT_AVAILABLE');
    expect(s['download_watch']).toBe('NOT_AVAILABLE');
    expect(s['cloud_folder']).toBe('NOT_AVAILABLE');
    expect(s['ai_provider.heuristic']).toBe('LIVE');
    expect(s['ai_provider.anthropic']).toBe('NOT_AVAILABLE');
    // LIVE 는 외부 전송 없는 내장 규칙뿐
    expect(getIntegrationStatuses({}).filter((d) => d.status === 'LIVE').map((d) => d.key)).toEqual(['ai_provider.heuristic']);
  });

  it('위멤버스 API 환경변수가 있어도 리서치로 확인되기 전에는 NOT_AVAILABLE', () => {
    expect(RESEARCH_CONFIRMED_APIS.wemembers).toBe(false);
    const d = statusOf({ WEMEMBERS_API_BASE_URL: 'https://example.invalid', WEMEMBERS_API_KEY: 'k' }, 'wemembers.api');
    expect(d.status).toBe('NOT_AVAILABLE');
    expect(d.statusReason).toContain('확인되지 않아');
  });

  it('AI Provider: anthropic + 키 → LIVE, 키 없으면 NOT_AVAILABLE', () => {
    expect(statusOf({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-x', AI_MODEL: 'm' }, 'ai_provider.anthropic').status).toBe('LIVE');
    const noKey = statusOf({ AI_PROVIDER: 'anthropic' }, 'ai_provider.anthropic');
    expect(noKey.status).toBe('NOT_AVAILABLE');
    expect(noKey.statusReason).toContain('ANTHROPIC_API_KEY');
    expect(statusOf({ AI_PROVIDER: 'heuristic', ANTHROPIC_API_KEY: 'sk-x' }, 'ai_provider.anthropic').status).toBe('NOT_AVAILABLE');
  });

  it('미구현 구성요소는 환경변수가 있어도 FILE_BASED 로 표시하지 않는다 (가짜 성공 금지)', () => {
    expect(IMPLEMENTED_COMPONENTS).toEqual({ desktopBridge: false, cloudFolderWatcher: false });
    const cf = statusOf({ CLOUD_FOLDER_PATH: '/mnt/nas/inbox' }, 'cloud_folder');
    expect(cf.status).toBe('NOT_AVAILABLE');
    expect(cf.statusReason).toContain('구현되지 않아');
    const br = statusOf({ BRIDGE_SHARED_SECRET: 's' }, 'desktop_bridge');
    expect(br.status).toBe('NOT_AVAILABLE');
    expect(br.statusReason).toContain('미구현');
    expect(br.capabilities).toEqual([]);
    // 어떤 환경에서도 '주기적으로 확인' 같은 동작 주장이 나오지 않는다
    const all = getIntegrationStatuses({ CLOUD_FOLDER_PATH: '/x', CLOUD_FOLDER_S3_PREFIX: 's3://b/p', BRIDGE_SHARED_SECRET: 's' });
    for (const d of all.filter((x) => x.group === 'bridge' || x.group === 'cloud')) expect(d.status).toBe('NOT_AVAILABLE');
  });

  it('원본 레지스트리는 변경되지 않는다 (복사본 반환)', () => {
    getIntegrationStatuses({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'x' });
    expect(INTEGRATIONS.find((d) => d.key === 'ai_provider.anthropic')!.status).toBe('NOT_AVAILABLE');
  });

  it('짧은 키 별칭 · 데이터 무결성', () => {
    expect(findIntegration('wemembers_api')?.key).toBe('wemembers.api');
    expect(findIntegration('wehago')?.key).toBe('wehago.purchase_sales_file');
    expect(findIntegration('hometax_filing')?.key).toBe('hometax.efiling');
    expect(findIntegration('nope')).toBeUndefined();
    const keys = INTEGRATIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of INTEGRATIONS) {
      expect(['LIVE', 'FILE_BASED', 'RPA', 'MOCK', 'NOT_AVAILABLE']).toContain(d.status);
      expect(d.statusReason).toMatch(/[가-힣]/);
      expect(d.status === 'RPA').toBe(false);
    }
  });
});
