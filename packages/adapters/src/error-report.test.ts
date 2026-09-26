import { describe, expect, it } from 'vitest';
import { cardPurchaseRows, CLIENT } from './__fixtures__/builders';
import { buildErrorReportXlsx, ERROR_REPORT_HEADERS } from './error-report';
import { readTabularFile } from './file/read';
import { detectFormat } from './format/detect';
import { normalizeRows } from './normalize/normalize-rows';

describe('buildErrorReportXlsx', () => {
  it('실패 행을 한국어 제목(행번호·사유·필드·원본데이터)으로 내려받는다', async () => {
    const rows = cardPurchaseRows();
    const res = normalizeRows(detectFormat(rows), rows, { clientId: CLIENT.id, businessNumber: CLIENT.businessNumber, channel: 'hometax_file' });
    const buf = await buildErrorReportXlsx(res.failures);
    const f = await readTabularFile(buf, 'errors.xlsx');
    const sheet = f.sheets[0]!;
    expect(sheet.name).toBe('오류 항목');
    expect(sheet.rows[0]).toEqual([...ERROR_REPORT_HEADERS]);
    expect(ERROR_REPORT_HEADERS).toEqual(['행번호', '사유', '필드', '원본데이터']);
    expect(sheet.rows.length).toBe(1 + res.failures.length);
    const first = sheet.rows[1]!;
    // 행번호는 원본 파일의 실제 엑셀 행 (요약 1행 + 헤더 1행 + 데이터 7번째 = 9행)
    expect(first[0]).toBe(9);
    expect(String(first[1])).toContain('금액 불일치');
    expect(first[2]).toBe('합계');
    expect(String(first[3])).toContain('가맹점명: ');
    expect(String(first[3])).not.toContain('__row');
    const text = JSON.stringify(sheet.rows);
    expect(text).not.toMatch(/5555-5555-5555-4444|5555555555554444/);
  });

  it('원본데이터에 남은 민감정보를 한 번 더 마스킹, 제목 옵션, 빈 목록', async () => {
    const buf = await buildErrorReportXlsx(
      [{ sourceRowNumber: 3, reason: '테스트', rawData: { 메모: '카드 4111 1111 1111 1111', 주민: '900101-1234567' } }],
      { title: '카드내역.xlsx 오류 항목' },
    );
    const f = await readTabularFile(buf, 'e.xlsx');
    expect(f.sheets[0]!.rows[0]).toEqual(['카드내역.xlsx 오류 항목']);
    expect(f.sheets[0]!.rows[2]).toEqual([...ERROR_REPORT_HEADERS]);
    const raw = String(f.sheets[0]!.rows[3]![3]);
    expect(raw).toContain('4111-****-****-1111');
    expect(raw).toContain('900101-1******');
    expect(f.sheets[0]!.rows[3]![0]).toBe(3);
    const empty = await readTabularFile(await buildErrorReportXlsx([]), 'x.xlsx');
    expect(empty.sheets[0]!.rows[1]![1]).toBe('오류 항목이 없습니다.');
  });

  it('긴 원본데이터는 엑셀 셀 한도 안으로 자르고, 사유 속 민감정보도 가린다', async () => {
    const buf = await buildErrorReportXlsx([
      { sourceRowNumber: 1, reason: '공급가액 금액 형식 오류: "900101-1234567"', rawData: { 메모: 'x'.repeat(40_000) } },
    ]);
    const f = await readTabularFile(buf, 'e.xlsx');
    const row = f.sheets[0]!.rows[1]!;
    expect(String(row[1])).toContain('900101-1******');
    expect(String(row[1])).not.toContain('1234567');
    expect(String(row[3]).length).toBeLessThan(32_767);
    expect(String(row[3])).toContain('생략');
  });
});
