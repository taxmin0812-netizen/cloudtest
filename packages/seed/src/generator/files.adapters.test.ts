import { detectFormat } from '@mintax/adapters/format/detect';
import { FORMAT_PROFILES } from '@mintax/adapters/format/profiles';
import { normalizeRows } from '@mintax/adapters/normalize/normalize-rows';
import { describe, expect, it } from 'vitest';
import { buildAllFiles } from './files';
import { generateDataset } from './index';
import { FILE_LAYOUTS } from './layouts';

/**
 * 계약 점검: 합성 파일 헤더가 adapters 형식 프로필(@mintax/adapters format/profiles)로 인식되는가.
 * 어댑터 프로필이 바뀌어 이 테스트가 깨지면 layouts.ts 의 헤더 상수와 프로필을 함께 맞춘다.
 */
const ds = generateDataset();
const files = buildAllFiles(ds);

describe('adapters 형식 판별과의 호환', () => {
  it('레이아웃에 적힌 프로필 id 가 adapters 에 실제로 있다', () => {
    const ids = new Set(FORMAT_PROFILES.map((p) => p.id));
    for (const l of Object.values(FILE_LAYOUTS)) if (l.profileId) expect(ids.has(l.profileId), l.profileId).toBe(true);
  });

  it('프로필이 있는 파일은 모두 해당 프로필·헤더 위치로 판별되고 필수 열이 빠지지 않는다', () => {
    const seen = new Set<string>();
    for (const f of files) {
      if (!f.profileId) continue;
      const key = `${f.kind}`;
      if (seen.has(key)) continue; // 종류별 대표 1개씩 (전부 같은 레이아웃)
      seen.add(key);
      const det = detectFormat(f.rows, { fileName: f.fileName });
      expect(det.profile.id, f.fileName).toBe(f.profileId);
      expect(det.headerRowIndex, f.fileName).toBe(f.headerRowIndex);
      expect(det.missingFields, f.fileName).toEqual([]);
    }
    expect(seen.size).toBeGreaterThanOrEqual(7);
  });

  it('세금계산서 파일은 매입/매출 방향 힌트를 준다', () => {
    const p = files.find((f) => f.kind === 'tax_invoice_purchase')!;
    const s = files.find((f) => f.kind === 'tax_invoice_sales')!;
    expect(detectFormat(p.rows, { fileName: p.fileName }).directionHint).toBe('purchase');
    expect(detectFormat(s.rows, { fileName: s.fileName }).directionHint).toBe('sales');
  });
});

describe('adapters normalizeRows 로 끝까지 읽기 (행 회계·금액)', () => {
  const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
  const pick = (code: string, kind: string) => files.find((f) => f.clientCode === code && f.kind === kind)!;
  const cases = [
    pick('C009', 'card_purchase'),
    pick('C001', 'card_purchase'),
    pick('C015', 'card_purchase'),
    pick('C015', 'cash_receipt_purchase'),
    pick('C004', 'tax_invoice_purchase'),
    pick('C004', 'tax_invoice_sales'),
    pick('C003', 'invoice_exempt_purchase'),
    pick('C017', 'invoice_exempt_sales'),
    pick('C013', 'card_sales'),
  ];

  it.each(cases.map((f) => [f.fileName, f] as const))('%s', (_name, f) => {
    const client = ds.clients.find((c) => c.code === f.clientCode)!;
    const det = detectFormat(f.rows, { fileName: f.fileName });
    const res = normalizeRows(det, f.rows, {
      clientId: CLIENT_ID,
      businessNumber: client.businessNumber,
      channel: 'hometax_file',
      clientVatType: client.vatType,
    });
    // 데이터 행 하나는 정확히 하나의 결과 (거래 또는 실패)
    expect(res.transactions.length + res.failures.length, JSON.stringify(res.failures.map((x) => x.reason))).toBe(f.dataRowCount);
    const byRow = new Map(f.rowIds.map((id, i) => [i, id]));
    const failedIds = res.failures.map((x) => byRow.get(x.sourceRowNumber - 1)!);
    // 실패해야 할 행: 파싱 실패 + 합계 불일치(부가세 오류) 카드 행
    const txById = new Map(ds.current.map((t) => [t.id, t]));
    const expectedFail = f.rowIds.filter(
      (id) => !txById.has(id) || (txById.get(id)!.anomalies.includes('vat_mismatch') && txById.get(id)!.evidenceType !== 'tax_invoice'),
    );
    expect(failedIds.sort()).toEqual(expectedFail.sort());
    // 정상 행 금액 합계 = 합성 거래 합계
    const okTotal = f.rowIds.filter((id) => !expectedFail.includes(id)).reduce((a, id) => a + txById.get(id)!.totalAmount, 0);
    expect(res.transactions.reduce((a, t) => a + t.totalAmount, 0)).toBe(okTotal);
    for (const t of res.transactions) expect(t.direction).toBe(f.kind.endsWith('sales') ? 'sales' : 'purchase');
  });
});

describe('파일 경로 중복 판정 (adapters normalizeRows → core fingerprint)', () => {
  const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
  const normalize = (code: string, kind: string, channel: 'hometax_file' | 'desktop_bridge') => {
    const f = files.find((x) => x.clientCode === code && x.kind === kind)!;
    const client = ds.clients.find((c) => c.code === code)!;
    const det = detectFormat(f.rows, { fileName: f.fileName });
    const res = normalizeRows(det, f.rows, { clientId: CLIENT_ID, businessNumber: client.businessNumber, channel, clientVatType: client.vatType });
    const fpById = new Map(res.transactions.map((t) => [f.rowIds[t.sourceRowNumber! - 1]!, t.fingerprint]));
    return { res, fpById };
  };

  const dupClients = [...new Set(ds.current.filter((t) => t.anomalies.includes('exact_duplicate')).map((t) => t.clientCode))];

  it.each(dupClients)('%s: 재전송 파일의 완전중복 행은 원본 파일의 원거래와 fingerprint 가 같다', (code) => {
    const orig = normalize(code, 'card_purchase', 'hometax_file');
    const resend = normalize(code, 'card_purchase_resend', 'desktop_bridge');
    expect(resend.fpById.size).toBeGreaterThan(0);
    for (const [id, fp] of resend.fpById) {
      const origId = ds.current.find((t) => t.id === id)!.truth.duplicateOf!;
      expect(orig.fpById.get(origId), `${id} → ${origId}`).toBe(fp);
    }
  });

  const possibleClients = [...new Set(ds.current.filter((t) => t.anomalies.includes('possible_duplicate')).map((t) => t.clientCode))];

  it.each(possibleClients)('%s: 중복 의심 행은 원거래와 fingerprint 가 달라 별개 거래로 남고, 경고가 붙는다', (code) => {
    const { res, fpById } = normalize(code, 'card_purchase', 'hometax_file');
    const fps = res.transactions.map((t) => t.fingerprint);
    expect(new Set(fps).size).toBe(fps.length);
    for (const t of ds.current.filter((x) => x.clientCode === code && x.anomalies.includes('possible_duplicate'))) {
      const a = fpById.get(t.id);
      const b = fpById.get(t.truth.possibleDuplicateOf!);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a).not.toBe(b);
    }
    expect(res.warnings.some((w) => w.code === 'possible_duplicate')).toBe(true);
  });
});
