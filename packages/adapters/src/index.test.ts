import { describe, expect, it } from 'vitest';
import * as adapters from './index';

describe('@mintax/adapters 공개 API', () => {
  it('주요 함수·데이터를 내보낸다', () => {
    for (const name of [
      'readTabularFile',
      'detectFormat',
      'detectFormatInFile',
      'normalizeRows',
      'detectClientFromFile',
      'writeWehagoExport',
      'verifyExportFile',
      'validateExportRows',
      'buildTemplateFromSample',
      'buildTemplateFromSampleFile',
      'writePayrollExport',
      'verifyPayrollExportFile',
      'getIntegrationStatuses',
      'buildErrorReportXlsx',
      'importTabularFile',
      'previewImport',
    ] as const) {
      expect(typeof adapters[name]).toBe('function');
    }
    expect(adapters.FORMAT_PROFILES.length).toBeGreaterThanOrEqual(7);
    expect(adapters.WEHAGO_TEMPLATES.map((t) => t.kind)).toEqual(['purchase_sales', 'general_journal', 'payroll_earned', 'payroll_business', 'payroll_daily']);
    expect(adapters.INTEGRATIONS.length).toBeGreaterThan(10);
    expect(adapters.LEGACY_XLS_MESSAGE).toBe('구형 .xls 형식입니다. Excel에서 .xlsx로 저장 후 올려주세요.');
  });
});
