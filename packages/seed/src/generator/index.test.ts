import { scrubSensitive } from '@mintax/core';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SEED, datasetChecksum, generateDataset } from './index';

const ds = generateDataset();
const RRN_RE = /(?<!\d)\d{6}[-\s]?[1-8]\d{6}(?!\d)/g;
const FULL_CARD_RE = /(?<!\d)\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}(?!\d)/g;

describe('generateDataset', () => {
  it('같은 seed → 같은 체크섬 (바이트 단위 결정성), 다른 seed → 다른 체크섬', () => {
    const again = generateDataset({ seed: DEFAULT_SEED });
    expect(datasetChecksum(again)).toBe(datasetChecksum(ds));
    expect(JSON.stringify(again.current.slice(0, 50))).toBe(JSON.stringify(ds.current.slice(0, 50)));
    const other = generateDataset({ seed: 7 });
    expect(datasetChecksum(other)).not.toBe(datasetChecksum(ds));
    expect(other.anomalies.counts).toEqual(ds.anomalies.counts);
  }, 60_000);

  it('기본 seed 20260926, 기간 2026-03~08 + 2026-09', () => {
    expect(ds.seed).toBe(20260926);
    expect(ds.historyMonths).toEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
    expect(ds.currentMonth).toBe('2026-09');
  });

  it('stats 가 실제 배열과 일치', () => {
    expect(ds.stats.clients).toBe(ds.clients.length);
    expect(ds.stats.clients).toBeGreaterThanOrEqual(20);
    expect(ds.stats.merchants).toBe(ds.merchants.length);
    expect(ds.stats.historyTransactions).toBe(ds.history.length);
    expect(ds.stats.currentTransactions).toBe(ds.current.length);
    expect(Object.values(ds.stats.historyByMonth).reduce((a, b) => a + b, 0)).toBe(ds.history.length);
    expect(Object.values(ds.stats.currentByClient).reduce((a, b) => a + b, 0)).toBe(ds.current.length);
    expect(ds.stats.employees).toBe(ds.payroll.employees.length);
    expect(ds.stats.payrollHistoryLines).toBe(ds.payroll.history.length);
    expect(ds.stats.failureRows).toBe(1);
  });

  it('당월 거래는 거래처 순서로 묶여 있다', () => {
    const order = ds.clients.map((c) => c.code);
    let last = 0;
    for (const t of ds.current) {
      const i = order.indexOf(t.clientCode);
      expect(i).toBeGreaterThanOrEqual(last);
      last = i;
    }
  });
});

describe('개인정보 유출 방지', () => {
  // sha256 fingerprint(16진수)와 전자(세금)계산서 승인번호(8-8-8)는 개인정보가 아니므로 검사 전에 지운다
  const stripIds = (s: string) => s.replace(/[0-9a-f]{64}/g, '#').replace(/\d{8}-\d{8}-\d{8}/g, '#');
  const withoutRrn = stripIds(
    JSON.stringify({
      ...ds,
      payroll: { ...ds.payroll, employees: ds.payroll.employees.map((e) => ({ ...e, residentNumber: null })) },
    }),
  );
  const full = stripIds(JSON.stringify(ds));

  it('주민번호 모양 값은 인건비 직원 객체의 residentNumber 에만 있다', () => {
    expect(withoutRrn.match(RRN_RE)).toBeNull();
    const found = new Set(full.match(RRN_RE) ?? []);
    const expected = new Set(ds.payroll.employees.map((e) => e.residentNumber).filter((x): x is string => x !== null));
    expect(found).toEqual(expected);
  });

  it('카드번호 전체(16자리)는 어디에도 없고, core scrubSensitive 로 바뀌는 문자열이 없다', () => {
    expect(full.match(FULL_CARD_RE)).toBeNull();
    expect(scrubSensitive(withoutRrn)).toBe(withoutRrn);
  });

  it('하이픈 사업자번호 표기는 모두 합성 표식(0xx)', () => {
    const dashed = JSON.stringify(ds).match(/(?<!\d)\d{3}-\d{2}-\d{5}(?!\d)/g) ?? [];
    expect(dashed.length).toBeGreaterThan(1000);
    for (const d of new Set(dashed)) expect(d.startsWith('0'), d).toBe(true);
  });

  it('이메일은 예약 도메인(example.com)만', () => {
    const emails = JSON.stringify(ds).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    for (const e of new Set(emails)) expect(e.endsWith('@example.com'), e).toBe(true);
  });
});

describe('소스 위생', () => {
  it('생성기 코드는 Math.random·Date.now·인자 없는 new Date() 를 쓰지 않는다', () => {
    const dirs = [__dirname, join(__dirname, '..', 'golden')];
    for (const dir of dirs) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts'))) {
        const src = readFileSync(join(dir, f), 'utf8');
        expect(/Math\.random|Date\.now|new Date\(\)/.test(src), f).toBe(false);
      }
    }
  });
});
